#!/usr/bin/env python3
"""Fardeen YT Downloader - Chrome native messaging host.

Runs yt-dlp and ffmpeg on the user's machine on behalf of the extension.
Only the Python standard library is required.

    python fardeen_host.py --install <EXTENSION_ID>   register with Chrome/Edge/Brave
    python fardeen_host.py --uninstall                remove registration
    python fardeen_host.py --check                    print dependency report
"""
import collections
import importlib.util
import json
import os
import re
import shutil
import signal
import struct
import subprocess
import sys
import threading
import time

HOST_NAME = "com.fardeen.ytdownloader"
HOST_VERSION = "1.0.0"
MP3_KBPS = 192
PROGRESS_INTERVAL_S = 0.5
FORMATS_TIMEOUT_S = 120
MAX_MESSAGE_BYTES = 1024 * 1024
DEFAULT_TEMPLATE = "{title} [{id}]"
IS_WINDOWS = os.name == "nt"

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
JOB_ID_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")
EXT_ID_RE = re.compile(r"^[a-p]{32}$")
FORMAT_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}(\+[A-Za-z0-9_-]{1,32})?$")
VIDEO_EXTS = ("mp4", "webm")
AUDIO_EXTS = ("m4a", "mp3")

MSG_LIVE = "Live streams and upcoming premieres can't be downloaded until they have finished."
MSG_FFMPEG = "ffmpeg is not installed. It is needed to merge HD video with audio and to convert to MP3."
MSG_DISK = "Your disk is full. Free up some space and try again."

# (code, regex on lower-cased yt-dlp output, friendly message). First match wins.
ERROR_PATTERNS = [
    ("PRIVATE", r"private video", "This video is private."),
    ("AGE_RESTRICTED", r"confirm your age|age.restricted|inappropriate for some users",
     "This video is age-restricted and needs a signed-in account, which this extension doesn't use."),
    ("MEMBERS_ONLY", r"members.only|join this channel", "This video is for channel members only."),
    ("LIVE", r"live event will begin|premieres in|is live|live stream|this live event", MSG_LIVE),
    ("REGION_BLOCKED", r"not available in your country|geo.?restrict|blocked it in your country|"
                       r"not made this video available in your country",
     "This video isn't available in your region."),
    ("REMOVED", r"video (is )?unavailable|has been removed|account associated with this video has been terminated|"
                r"does not exist|no longer available",
     "This video is unavailable or has been removed."),
    ("FFMPEG_MISSING", r"ffmpeg[^\n]*not (found|installed)|ffprobe and ffmpeg not found|you have requested merging",
     MSG_FFMPEG),
    ("DISK_FULL", r"no space left|errno 28|disk full|not enough space", MSG_DISK),
    ("BOT_CHECK", r"not a bot",
     "YouTube asked to confirm you're not a bot. Update yt-dlp (yt-dlp -U) or try again later."),
    ("FORBIDDEN", r"http error 403|403: forbidden",
     "YouTube refused the download (HTTP 403). Update yt-dlp with: pip install -U yt-dlp, then try again."),
    ("FORMAT_UNAVAILABLE", r"requested format is not available",
     "That quality is no longer available. Refresh the list and pick another."),
    ("NETWORK", r"unable to download webpage|getaddrinfo|timed out|connection (reset|refused|aborted)|"
                r"network is unreachable",
     "Network error. Check your internet connection and try again."),
]


class HostError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


# --------------------------------------------------------------------------- messaging

_out_lock = threading.Lock()


def send(msg):
    data = json.dumps(msg, ensure_ascii=False).encode("utf-8")
    if len(data) > MAX_MESSAGE_BYTES:
        data = json.dumps({"id": msg.get("id"), "ok": False, "code": "TOO_LARGE",
                           "error": "Response too large."}).encode("utf-8")
    with _out_lock:
        sys.stdout.buffer.write(struct.pack("<I", len(data)))
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    length = struct.unpack("<I", raw)[0]
    body = sys.stdin.buffer.read(length)
    if len(body) < length:
        return None
    return json.loads(body.decode("utf-8"))


# --------------------------------------------------------------------------- environment

def augment_path():
    """Browsers launch hosts with a minimal PATH (notably on macOS). Add common tool dirs."""
    home = os.path.expanduser("~")
    extra = [os.path.join(home, ".deno", "bin"), os.path.join(home, ".local", "bin")]
    if IS_WINDOWS:
        local = os.environ.get("LOCALAPPDATA", "")
        extra += [os.path.join(local, "Microsoft", "WinGet", "Links"), r"C:\ffmpeg\bin"]
    else:
        extra += ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/snap/bin"]
    current = os.environ.get("PATH", "").split(os.pathsep)
    os.environ["PATH"] = os.pathsep.join(current + [p for p in extra if p not in current])


def ytdlp_exe():
    exe = shutil.which("yt-dlp")
    if exe:
        return [exe]
    if importlib.util.find_spec("yt_dlp"):
        return [sys.executable, "-m", "yt_dlp"]
    raise HostError("YTDLP_MISSING", "yt-dlp is not installed. Run: pip install -U yt-dlp")


def ytdlp_base():
    base = ytdlp_exe() + ["--no-update", "--no-playlist", "--no-warnings", "--ignore-config"]
    if not shutil.which("deno") and shutil.which("node"):
        base += ["--js-runtimes", "node"]
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        base += ["--ffmpeg-location", os.path.dirname(ffmpeg)]
    return base


def child_env():
    return dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")


def popen_kwargs():
    if IS_WINDOWS:
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {"start_new_session": True}


def video_url(video_id):
    return "https://www.youtube.com/watch?v=" + video_id


def classify_error(text):
    text = text or ""
    low = text.lower()
    for code, pattern, message in ERROR_PATTERNS:
        if re.search(pattern, low):
            return code, message
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    errors = [ln[6:].strip() for ln in lines if ln.startswith("ERROR:")]
    return "YTDLP_ERROR", (errors or lines or ["Unknown error from yt-dlp."])[-1]


# --------------------------------------------------------------------------- formats

def size_of(fmt, duration):
    """Return (bytes, approximate) using filesize, filesize_approx, then bitrate x duration."""
    if fmt.get("filesize"):
        return int(fmt["filesize"]), False
    if fmt.get("filesize_approx"):
        return int(fmt["filesize_approx"]), True
    tbr = fmt.get("tbr") or ((fmt.get("vbr") or 0) + (fmt.get("abr") or 0))
    if tbr and duration:
        return int(tbr * 1000 / 8 * duration), True
    return None, True


def add_sizes(a, b):
    if a[0] is None or b[0] is None:
        return None, True
    return a[0] + b[0], a[1] or b[1]


def audio_rank(fmt):
    lang_pref = fmt.get("language_preference")
    return (
        lang_pref if lang_pref is not None else 0,
        "drc" not in str(fmt.get("format_id", "")),
        (fmt.get("audio_channels") or 2) <= 2,  # stereo plays everywhere; 5.1 AAC often doesn't
        fmt.get("protocol") == "https",
        fmt.get("abr") or fmt.get("tbr") or 0,
    )


def best_audio(audios, ext=None):
    candidates = [a for a in audios if a.get("ext") == ext] if ext else audios
    candidates = candidates or audios
    return max(candidates, key=audio_rank) if candidates else None


def video_rank(fmt):
    vcodec = str(fmt.get("vcodec", ""))
    return (
        (fmt.get("dynamic_range") or "SDR") == "SDR",
        vcodec.startswith(("avc1", "vp9", "vp09")),  # most compatible codec per container
        fmt.get("protocol") == "https",
        fmt.get("tbr") or 0,
    )


QUALITY_NOTE_RE = re.compile(r"^(\d{3,4})p")


def quality_label(fmt):
    """Use YouTube's own quality name ('1080p' for a 1920x804 film); else the frame's short side,
    so a vertical 1080x1920 Short is also '1080p'."""
    fps = round(fmt.get("fps") or 0)
    note = QUALITY_NOTE_RE.match(str(fmt.get("format_note") or ""))
    if note:
        short_side = int(note.group(1))
    else:
        height, width = fmt.get("height") or 0, fmt.get("width") or 0
        short_side = min(height, width) if width else height
    return f"{short_side}p{fps if fps > 30 else ''}", short_side, fps


def usable(fmt):
    return fmt.get("format_id") and fmt.get("ext") != "mhtml" and not fmt.get("has_drm")


def build_options(info):
    """Turn yt-dlp -J output into a clean, de-duplicated list of download options."""
    duration = info.get("duration") or 0
    formats = [f for f in info.get("formats") or [] if usable(f)]
    audios = [f for f in formats if f.get("vcodec") == "none" and f.get("acodec") not in (None, "none")]
    videos = [f for f in formats if f.get("vcodec") not in (None, "none") and f.get("height")
              and f.get("ext") in VIDEO_EXTS]

    groups = {}
    for v in videos:
        key = (quality_label(v)[0], v["ext"])
        if key not in groups or video_rank(v) > video_rank(groups[key]):
            groups[key] = v

    options = [o for o in (video_option(v, audios, duration) for v in groups.values()) if o]
    options.sort(key=lambda o: (-o["height"], -o["fps"], VIDEO_EXTS.index(o["ext"])))
    return options + audio_options(audios, duration)


def video_option(v, audios, duration):
    label, short_side, fps = quality_label(v)
    size = size_of(v, duration)
    parts = [{"id": v["format_id"], "size": size[0]}]
    fmt_spec = v["format_id"]
    if v.get("acodec") in (None, "none"):  # video-only: pair with best matching audio
        audio = best_audio(audios, "m4a" if v["ext"] == "mp4" else "webm")
        if not audio:
            return None
        a_size = size_of(audio, duration)
        parts.append({"id": audio["format_id"], "size": a_size[0]})
        fmt_spec = f"{v['format_id']}+{audio['format_id']}"
        size = add_sizes(size, a_size)
    return {"key": f"v-{label}-{v['ext']}", "kind": "video", "label": label, "ext": v["ext"],
            "format": fmt_spec, "height": short_side, "fps": fps,
            "size": size[0], "approx": size[1], "parts": parts}


def audio_options(audios, duration):
    options = []
    m4a = best_audio([a for a in audios if a.get("ext") == "m4a"])
    if m4a:
        size = size_of(m4a, duration)
        options.append({"key": "a-m4a", "kind": "audio", "label": "M4A", "ext": "m4a",
                        "format": m4a["format_id"], "height": 0, "fps": 0,
                        "bitrate": round(m4a.get("abr") or m4a.get("tbr") or 0),
                        "size": size[0], "approx": size[1],
                        "parts": [{"id": m4a["format_id"], "size": size[0]}]})
    source = best_audio(audios)
    if source:
        mp3_size = int(duration * MP3_KBPS * 1000 / 8) if duration else None
        options.append({"key": "a-mp3", "kind": "audio", "label": "MP3", "ext": "mp3",
                        "format": source["format_id"], "height": 0, "fps": 0, "bitrate": MP3_KBPS,
                        "size": mp3_size, "approx": True,
                        "parts": [{"id": source["format_id"], "size": size_of(source, duration)[0]}]})
    return options


def get_formats(params):
    video_id = require_video_id(params)
    proc = subprocess.run(ytdlp_base() + ["-J", video_url(video_id)], stdin=subprocess.DEVNULL,
                          capture_output=True, env=child_env(), timeout=FORMATS_TIMEOUT_S, **popen_kwargs())
    out = proc.stdout.decode("utf-8", "replace")
    if proc.returncode != 0 or not out.strip():
        raise HostError(*classify_error(proc.stderr.decode("utf-8", "replace")))
    info = json.loads(out)
    if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming", "post_live"):
        raise HostError("LIVE", MSG_LIVE)
    options = build_options(info)
    if not options:
        raise HostError("NO_FORMATS", "No downloadable formats were found for this video.")
    return {"id": video_id, "title": info.get("title") or video_id,
            "channel": info.get("channel") or info.get("uploader") or "",
            "duration": info.get("duration") or 0,
            "thumbnail": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
            "options": options}


# --------------------------------------------------------------------------- downloads

class ProgressTracker:
    """Combines per-stream yt-dlp progress (video, then audio) into one overall figure."""

    def __init__(self, parts):
        self.totals = {p["id"]: int(p.get("size") or 0) for p in parts}
        self.done = {}

    def update(self, fid, downloaded, total, speed, eta):
        if total:
            self.totals[fid] = int(total)
        self.done[fid] = int(downloaded or 0)
        got = sum(self.done.values())
        grand = max(sum(self.totals.values()), got)
        percent = min(99.9, got / grand * 100) if grand else 0.0
        eta_all = (grand - got) / speed if speed else eta
        return {"percent": round(percent, 1), "speed": speed,
                "eta": round(eta_all) if eta_all is not None else None,
                "downloaded": got, "total": grand}


def parse_number(text):
    try:
        return float(text)
    except (TypeError, ValueError):
        return None


def parse_progress_line(line):
    """'FYTD_DL <fid> <downloaded> <total> <estimate> <speed> <eta>' -> args for ProgressTracker.update."""
    parts = line.split()
    if len(parts) != 7 or parts[0] != "FYTD_DL":
        return None
    _, fid, downloaded, total, estimate, speed, eta = parts
    return (fid, parse_number(downloaded) or 0, parse_number(total) or parse_number(estimate),
            parse_number(speed), parse_number(eta))


TEMPLATE_FIELDS = {"title": "%(title)s", "id": "%(id)s", "channel": "%(channel)s",
                   "date": "%(upload_date>%Y-%m-%d)s"}


def build_outtmpl(user_template, quality):
    """'{title} [{id}]' -> yt-dlp output template. Path separators are not allowed."""
    tmpl = (user_template or "").strip() or DEFAULT_TEMPLATE
    tmpl = re.sub(r'[\\/:*?"<>|]', "_", tmpl).replace("%", "%%")
    fields = dict(TEMPLATE_FIELDS, quality=re.sub(r"[^A-Za-z0-9]", "", quality or ""))
    return re.sub(r"\{(\w+)\}", lambda m: fields.get(m.group(1), m.group(0)), tmpl) + ".%(ext)s"


def resolve_folder(folder):
    folder = os.path.expandvars(os.path.expanduser((folder or "").strip()))
    folder = folder or os.path.join(os.path.expanduser("~"), "Downloads")
    if not os.path.isabs(folder):
        raise HostError("BAD_FOLDER", "The download folder must be a full path, e.g. C:\\Users\\you\\Videos.")
    try:
        os.makedirs(folder, exist_ok=True)
    except OSError as exc:
        raise HostError("BAD_FOLDER", f"Can't create the download folder: {exc.strerror}") from exc
    if not os.access(folder, os.W_OK):
        raise HostError("BAD_FOLDER", "The download folder isn't writable.")
    return folder


def number_or(value, default):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0 else default


def validate_option(option):
    """The option comes from the extension; never pass unchecked values to yt-dlp."""
    if not isinstance(option, dict):
        raise HostError("BAD_REQUEST", "Missing download option.")
    fmt, ext, kind = option.get("format"), option.get("ext"), option.get("kind")
    if not isinstance(fmt, str) or not FORMAT_RE.match(fmt):
        raise HostError("BAD_REQUEST", "Invalid format.")
    if not ((kind == "video" and ext in VIDEO_EXTS) or (kind == "audio" and ext in AUDIO_EXTS)):
        raise HostError("BAD_REQUEST", "Invalid format type.")
    parts = option.get("parts") or [{"id": fmt.split("+")[0]}]
    if not isinstance(parts, list) or not all(
            isinstance(p, dict) and FORMAT_RE.match(str(p.get("id", ""))) for p in parts):
        raise HostError("BAD_REQUEST", "Invalid format parts.")
    return {"format": fmt, "ext": ext, "kind": kind, "label": str(option.get("label", ""))[:16],
            "height": int(number_or(option.get("height"), 0)),
            "size": number_or(option.get("size"), None),
            "parts": [{"id": str(p["id"]), "size": number_or(p.get("size"), 0)} for p in parts]}


def needs_ffmpeg(option):
    return (option["kind"] == "video" and "+" in option["format"]) or option["ext"] == "mp3"


def check_free_space(folder, option):
    if not option["size"]:
        return
    factor = 2 if needs_ffmpeg(option) else 1.2  # merging keeps both parts until it finishes
    if shutil.disk_usage(folder).free < option["size"] * factor + 50 * 1024 * 1024:
        raise HostError("DISK_FULL", MSG_DISK)


def format_selector(option):
    """Exact format first; fall back if YouTube changed the format list since it was fetched."""
    fmt, height = option["format"], option["height"]
    if option["kind"] == "audio":
        return f"{fmt}/bestaudio[ext=m4a]/bestaudio" if option["ext"] == "m4a" else f"{fmt}/bestaudio"
    if height:
        return f"{fmt}/bestvideo[height<={height}]+bestaudio/best[height<={height}]"
    return f"{fmt}/bestvideo+bestaudio/best"


def build_download_cmd(job):
    opt = job["option"]
    cmd = ytdlp_base() + [
        "--newline", "--progress", "--trim-filenames", "180",
        "--print", "after_move:FYTD_FILE %(filepath)s",
        "--progress-template", "download:FYTD_DL %(info.format_id)s %(progress.downloaded_bytes)s "
                               "%(progress.total_bytes)s %(progress.total_bytes_estimate)s "
                               "%(progress.speed)s %(progress.eta)s",
        "--progress-template", "postprocess:FYTD_PP %(progress.status)s %(progress.postprocessor)s",
        "-P", "home:" + job["folder"], "-P", "temp:" + job["temp"],
        "-o", build_outtmpl(job["template"], opt["label"]),
        "-f", format_selector(opt),
    ]
    if opt["kind"] == "video":
        cmd += ["--merge-output-format", opt["ext"]]
    elif opt["ext"] == "mp3":
        cmd += ["-x", "--audio-format", "mp3", "--audio-quality", f"{MP3_KBPS}K"]
    return cmd + [video_url(job["video_id"])]


JOBS = {}
_jobs_lock = threading.Lock()


def download(params, reply):
    video_id = require_video_id(params)
    job_id = str(params.get("job_id", ""))
    if not JOB_ID_RE.match(job_id):
        raise HostError("BAD_REQUEST", "Invalid job id.")
    option = validate_option(params.get("option"))
    folder = resolve_folder(params.get("folder"))
    check_free_space(folder, option)
    if needs_ffmpeg(option) and not shutil.which("ffmpeg"):
        raise HostError("FFMPEG_MISSING", MSG_FFMPEG)
    ytdlp_exe()  # fail fast with YTDLP_MISSING before accepting the job
    job = {"id": job_id, "video_id": video_id, "option": option, "folder": folder,
           "temp": os.path.join(folder, ".fytd-tmp-" + job_id),
           "template": str(params.get("template") or DEFAULT_TEMPLATE)[:200],
           "proc": None, "cancelled": False}
    with _jobs_lock:
        JOBS[job_id] = job
    reply({"job_id": job_id})
    threading.Thread(target=run_job, args=(job,), daemon=True).start()


def run_job(job):
    event = {"job_id": job["id"]}
    try:
        filepath, code, tail = stream_job(job)
        if job["cancelled"]:
            send(dict(event, event="cancelled"))
        elif code == 0 and filepath:
            send(dict(event, event="done", filepath=filepath))
        else:
            err_code, message = classify_error("\n".join(tail))
            send(dict(event, event="error", code=err_code, error=message))
    except HostError as exc:
        send(dict(event, event="error", code=exc.code, error=exc.message))
    except Exception as exc:  # report anything unexpected instead of dying silently
        send(dict(event, event="error", code="HOST_ERROR", error=str(exc)))
    finally:
        shutil.rmtree(job["temp"], ignore_errors=True)  # removes .part files on cancel/failure
        with _jobs_lock:
            JOBS.pop(job["id"], None)


def stream_job(job):
    proc = subprocess.Popen(build_download_cmd(job), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, env=child_env(), **popen_kwargs())
    job["proc"] = proc
    if job["cancelled"]:
        kill_tree(proc)
    tracker = ProgressTracker(job["option"]["parts"])
    tail = collections.deque(maxlen=60)
    filepath, last_sent = None, 0.0
    for raw in proc.stdout:
        line = raw.decode("utf-8", "replace").strip()
        progress = parse_progress_line(line)
        if progress:
            stats = tracker.update(*progress)
            now = time.monotonic()
            if now - last_sent >= PROGRESS_INTERVAL_S:
                last_sent = now
                send(dict(stats, event="progress", job_id=job["id"], status="downloading"))
        elif line.startswith("FYTD_PP started") and "MoveFiles" not in line:
            send({"event": "progress", "job_id": job["id"], "status": "processing",
                  "stage": line.split()[-1], "percent": 100})
        elif line.startswith("FYTD_FILE "):
            filepath = line[len("FYTD_FILE "):]
        elif line:
            tail.append(line)
    return filepath, proc.wait(), tail


def kill_tree(proc):
    """yt-dlp spawns ffmpeg; kill the whole tree so no orphan keeps writing."""
    if proc.poll() is not None:
        return
    try:
        if IS_WINDOWS:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True,
                           creationflags=subprocess.CREATE_NO_WINDOW)
        else:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except OSError:
        proc.kill()


def cancel(params):
    with _jobs_lock:
        job = JOBS.get(str(params.get("job_id", "")))
    if not job:
        return {"cancelled": False}
    job["cancelled"] = True
    if job["proc"]:
        kill_tree(job["proc"])
    return {"cancelled": True}


def cancel_all():
    with _jobs_lock:
        jobs = list(JOBS.values())
    for job in jobs:
        job["cancelled"] = True
        if job["proc"]:
            kill_tree(job["proc"])


# --------------------------------------------------------------------------- misc actions

def open_folder(params):
    path = str(params.get("path") or "")
    if not path or not os.path.exists(path):
        raise HostError("NOT_FOUND", "That file no longer exists. It may have been moved or deleted.")
    path = os.path.normpath(path)
    if IS_WINDOWS:
        if os.path.isdir(path):
            os.startfile(path)
        else:
            subprocess.Popen(["explorer", "/select,", path])
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", path])
    else:
        subprocess.Popen(["xdg-open", path if os.path.isdir(path) else os.path.dirname(path)])
    return {"opened": True}


def tool_version(cmd):
    try:
        out = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, timeout=20,
                             env=child_env(), **popen_kwargs())
        lines = out.stdout.decode("utf-8", "replace").strip().splitlines()
        return lines[0] if out.returncode == 0 and lines else None
    except (OSError, subprocess.SubprocessError):
        return None


def check_dependencies():
    try:
        ytdlp = tool_version(ytdlp_exe() + ["--version"])
    except HostError:
        ytdlp = None
    ffmpeg = shutil.which("ffmpeg")
    return {"host_version": HOST_VERSION, "python": sys.version.split()[0], "ytdlp": ytdlp,
            "ffmpeg": tool_version([ffmpeg, "-version"]) if ffmpeg else None,
            "js_runtime": "deno" if shutil.which("deno") else ("node" if shutil.which("node") else None),
            "default_folder": os.path.join(os.path.expanduser("~"), "Downloads")}


def require_video_id(params):
    video_id = str(params.get("video_id", ""))
    if not VIDEO_ID_RE.match(video_id):
        raise HostError("BAD_REQUEST", "Invalid video id.")
    return video_id


# --------------------------------------------------------------------------- dispatch

def handle(msg):
    msg_id = msg.get("id")

    def reply(result):
        send({"id": msg_id, "ok": True, "result": result})

    try:
        action = msg.get("action")
        if action == "get_formats":
            reply(get_formats(msg))
        elif action == "download":
            download(msg, reply)
        elif action == "cancel":
            reply(cancel(msg))
        elif action == "open_folder":
            reply(open_folder(msg))
        elif action == "check_dependencies":
            reply(check_dependencies())
        else:
            raise HostError("BAD_REQUEST", f"Unknown action: {action}")
    except HostError as exc:
        send({"id": msg_id, "ok": False, "code": exc.code, "error": exc.message})
    except subprocess.TimeoutExpired:
        send({"id": msg_id, "ok": False, "code": "TIMEOUT", "error": "YouTube took too long to respond."})
    except Exception as exc:
        send({"id": msg_id, "ok": False, "code": "HOST_ERROR", "error": str(exc)})


def serve():
    if IS_WINDOWS:
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    while True:
        msg = read_message()
        if msg is None:
            break
        if msg.get("action") in ("get_formats", "check_dependencies"):  # slow: don't block the reader
            threading.Thread(target=handle, args=(msg,), daemon=True).start()
        else:
            handle(msg)
    cancel_all()  # browser closed the port: don't leave orphaned downloads behind


# --------------------------------------------------------------------------- install

WINDOWS_KEYS = [r"Software\Google\Chrome\NativeMessagingHosts", r"Software\Microsoft\Edge\NativeMessagingHosts",
                r"Software\Chromium\NativeMessagingHosts",
                r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts"]
FFMPEG_HINT = ("winget install Gyan.FFmpeg" if IS_WINDOWS else
               "brew install ffmpeg" if sys.platform == "darwin" else "sudo apt install ffmpeg")
DENO_HINT = ("winget install DenoLand.Deno" if IS_WINDOWS else
             "brew install deno" if sys.platform == "darwin" else "curl -fsSL https://deno.land/install.sh | sh")


def browser_dirs():
    """Chrome's folder always; other Chromium browsers only if installed."""
    home = os.path.expanduser("~")
    if sys.platform == "darwin":
        base = os.path.join(home, "Library", "Application Support")
        names = ["Google/Chrome", "Chromium", "Microsoft Edge", "BraveSoftware/Brave-Browser"]
    else:
        base = os.path.join(home, ".config")
        names = ["google-chrome", "chromium", "microsoft-edge", "BraveSoftware/Brave-Browser"]
    dirs = [os.path.join(base, n) for n in names]
    return [os.path.join(d, "NativeMessagingHosts") for i, d in enumerate(dirs) if i == 0 or os.path.isdir(d)]


def write_wrapper(here):
    """Chrome needs an executable; point it at this exact Python interpreter."""
    script = os.path.join(here, "fardeen_host.py")
    if IS_WINDOWS:
        wrapper = os.path.join(here, "fardeen_host.bat")
        with open(wrapper, "w", newline="\r\n") as fh:
            fh.write(f'@echo off\n"{sys.executable}" -u "{script}" %*\n')
    else:
        wrapper = os.path.join(here, "fardeen_host.sh")
        with open(wrapper, "w") as fh:
            fh.write(f'#!/bin/sh\nexec "{sys.executable}" -u "{script}" "$@"\n')
        os.chmod(wrapper, 0o755)
    return wrapper


def install(ext_id):
    if not EXT_ID_RE.match(ext_id or ""):
        print("ERROR: the extension ID must be 32 letters a-p (copy it from chrome://extensions).")
        return 1
    here = os.path.dirname(os.path.abspath(__file__))
    manifest = {"name": HOST_NAME, "description": "Fardeen YT Downloader native host",
                "path": write_wrapper(here), "type": "stdio",
                "allowed_origins": [f"chrome-extension://{ext_id}/"]}
    manifest_path = os.path.join(here, HOST_NAME + ".json")
    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
    if IS_WINDOWS:
        import winreg
        for key in WINDOWS_KEYS:
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key + "\\" + HOST_NAME) as reg:
                winreg.SetValueEx(reg, "", 0, winreg.REG_SZ, manifest_path)
            print(f"Registered: HKCU\\{key}\\{HOST_NAME}")
    else:
        for d in browser_dirs():
            os.makedirs(d, exist_ok=True)
            shutil.copyfile(manifest_path, os.path.join(d, HOST_NAME + ".json"))
            print(f"Registered: {d}")
    print("\nNative host installed for extension", ext_id)
    return print_check()


def uninstall():
    if IS_WINDOWS:
        import winreg
        for key in WINDOWS_KEYS:
            try:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key + "\\" + HOST_NAME)
            except OSError:
                pass  # key was never created for this browser
    else:
        for d in browser_dirs():
            path = os.path.join(d, HOST_NAME + ".json")
            if os.path.exists(path):
                os.remove(path)
    print("Native host unregistered.")
    return 0


def print_check():
    deps = check_dependencies()
    print(f"\nPython   : {deps['python']}")
    print(f"yt-dlp   : {deps['ytdlp'] or 'MISSING  -> pip install -U yt-dlp'}")
    print(f"ffmpeg   : {'found' if deps['ffmpeg'] else 'MISSING  -> ' + FFMPEG_HINT}")
    print(f"JS engine: {deps['js_runtime'] or 'MISSING (recommended) -> ' + DENO_HINT}")
    if not (deps["ytdlp"] and deps["ffmpeg"]):
        print("\nInstall the missing tools above, then restart the browser.")
        return 2
    print("\nAll set. Restart the browser, then open YouTube.")
    return 0


def main():
    augment_path()
    args = sys.argv[1:]
    if args[:1] == ["--install"]:
        return install(args[1] if len(args) > 1 else "")
    if args[:1] == ["--uninstall"]:
        return uninstall()
    if args[:1] == ["--check"]:
        return print_check()
    serve()
    return 0


if __name__ == "__main__":
    sys.exit(main())
