"""Unit tests for the native host's pure logic. Run:  python -m unittest discover -s tests"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "host"))
import fardeen_host as host  # noqa: E402

DURATION = 100


def fmt(fid, ext, vcodec="none", acodec="none", **extra):
    return dict(format_id=fid, ext=ext, vcodec=vcodec, acodec=acodec, protocol="https", **extra)


INFO = {
    "duration": DURATION,
    "formats": [
        fmt("sb0", "mhtml", vcodec="none", format_note="storyboard"),
        fmt("140", "m4a", acodec="mp4a.40.2", abr=129, filesize=1_600_000),
        fmt("140-drc", "m4a", acodec="mp4a.40.2", abr=129, filesize=1_600_000),
        fmt("251", "webm", acodec="opus", abr=130, filesize_approx=1_500_000),
        fmt("18", "mp4", vcodec="avc1.42001E", acodec="mp4a.40.2", height=360, width=640, fps=30, tbr=500),
        fmt("137", "mp4", vcodec="avc1.640028", height=1080, width=1920, fps=30, tbr=4000, filesize=40_000_000),
        fmt("399", "mp4", vcodec="av01.0.08M.08", height=1080, width=1920, fps=30, tbr=2500, filesize=25_000_000),
        fmt("248", "webm", vcodec="vp9", height=1080, width=1920, fps=30, tbr=2600, filesize_approx=26_000_000),
        fmt("299", "mp4", vcodec="avc1.64002a", height=1080, width=1920, fps=60, tbr=6000, filesize=60_000_000),
        fmt("313", "webm", vcodec="vp9", height=2160, width=3840, fps=30, tbr=18000),
        fmt("hdr", "webm", vcodec="vp09.02", height=2160, width=3840, fps=30, tbr=20000, dynamic_range="HDR10"),
    ],
}


class BuildOptionsTest(unittest.TestCase):
    def setUp(self):
        self.options = host.build_options(INFO)
        self.by_key = {o["key"]: o for o in self.options}

    def test_order_and_dedup(self):
        keys = [o["key"] for o in self.options]
        self.assertEqual(keys, ["v-2160p-webm", "v-1080p60-mp4", "v-1080p-mp4", "v-1080p-webm",
                                "v-360p-mp4", "a-m4a", "a-mp3"])

    def test_prefers_sdr_and_avc1(self):
        self.assertEqual(self.by_key["v-2160p-webm"]["format"], "313+251")
        self.assertEqual(self.by_key["v-1080p-mp4"]["format"], "137+140")  # avc1 over av01

    def test_combined_size_exact_when_both_exact(self):
        option = self.by_key["v-1080p-mp4"]
        self.assertEqual(option["size"], 41_600_000)
        self.assertFalse(option["approx"])

    def test_approx_flag_propagates(self):
        option = self.by_key["v-1080p-webm"]
        self.assertEqual(option["size"], 27_500_000)
        self.assertTrue(option["approx"])

    def test_bitrate_fallback_is_approx(self):
        option = self.by_key["v-2160p-webm"]  # 18000 kbps x 100 s + opus approx
        self.assertEqual(option["size"], 18000 * 125 * DURATION + 1_500_000)
        self.assertTrue(option["approx"])
        muxed = self.by_key["v-360p-mp4"]
        self.assertEqual(muxed["format"], "18")
        self.assertEqual(muxed["size"], 500 * 125 * DURATION)

    def test_audio_options(self):
        self.assertEqual(self.by_key["a-m4a"]["format"], "140")  # non-DRC preferred
        mp3 = self.by_key["a-mp3"]
        self.assertEqual(mp3["size"], DURATION * host.MP3_KBPS * 125)
        self.assertTrue(mp3["approx"])

    def test_vertical_short_labelled_by_short_side(self):
        info = {"duration": 30, "formats": [
            fmt("140", "m4a", acodec="mp4a", abr=128, filesize=1),
            fmt("137", "mp4", vcodec="avc1", height=1920, width=1080, fps=30, filesize=1)]}
        self.assertEqual(host.build_options(info)[0]["label"], "1080p")

    def test_widescreen_film_uses_youtube_quality_name(self):
        info = {"duration": 30, "formats": [
            fmt("140", "m4a", acodec="mp4a", abr=128, filesize=1),
            fmt("137", "mp4", vcodec="avc1", height=804, width=1920, fps=24, filesize=1, format_note="1080p"),
            fmt("299", "mp4", vcodec="avc1", height=804, width=1920, fps=60, filesize=1, format_note="1080p60")]}
        labels = [o["label"] for o in host.build_options(info) if o["kind"] == "video"]
        self.assertEqual(labels, ["1080p60", "1080p"])


class ProgressTest(unittest.TestCase):
    def test_two_stream_progress_is_combined(self):
        tracker = host.ProgressTracker([{"id": "137", "size": 900}, {"id": "140", "size": 100}])
        self.assertEqual(tracker.update("137", 450, 900, 100, 5)["percent"], 45.0)
        self.assertEqual(tracker.update("137", 900, 900, 100, 0)["percent"], 90.0)
        stats = tracker.update("140", 50, 100, 10, 5)
        self.assertEqual(stats["percent"], 95.0)
        self.assertEqual(stats["eta"], 5)

    def test_parse_progress_line(self):
        self.assertEqual(host.parse_progress_line("FYTD_DL 137 1024 NA 4096 2000.5 3"),
                         ("137", 1024.0, 4096.0, 2000.5, 3.0))
        self.assertIsNone(host.parse_progress_line("[download] 5%"))


class ValidationTest(unittest.TestCase):
    def test_rejects_injection_in_format(self):
        for bad in ["137 --exec calc", "137;rm", "-o/etc/passwd", "", None]:
            with self.assertRaises(host.HostError):
                host.validate_option({"format": bad, "kind": "video", "ext": "mp4"})

    def test_rejects_unknown_ext(self):
        with self.assertRaises(host.HostError):
            host.validate_option({"format": "137", "kind": "video", "ext": "exe"})

    def test_rejects_bad_video_id(self):
        with self.assertRaises(host.HostError):
            host.require_video_id({"video_id": "--exec=calc"})

    def test_outtmpl(self):
        self.assertEqual(host.build_outtmpl("{title} [{id}]", "1080p60"), "%(title)s [%(id)s].%(ext)s")
        self.assertEqual(host.build_outtmpl("../{title} 100%", ""), ".._%(title)s 100%%.%(ext)s")
        self.assertEqual(host.build_outtmpl("{title} {quality}", "1080p60"), "%(title)s 1080p60.%(ext)s")
        self.assertEqual(host.build_outtmpl("", ""), "%(title)s [%(id)s].%(ext)s")


class ClassifyErrorTest(unittest.TestCase):
    def test_known_errors(self):
        cases = {
            "ERROR: [youtube] x: Private video. Sign in if you've been granted access": "PRIVATE",
            "ERROR: [youtube] x: Sign in to confirm your age. This video may be inappropriate": "AGE_RESTRICTED",
            "ERROR: [youtube] x: Join this channel to get access to members-only content": "MEMBERS_ONLY",
            "ERROR: [youtube] x: This live event will begin in 3 hours.": "LIVE",
            "ERROR: [youtube] x: The uploader has not made this video available in your country": "REGION_BLOCKED",
            "ERROR: [youtube] x: This video is unavailable": "REMOVED",
            "ERROR: You have requested merging of multiple formats but ffmpeg is not installed": "FFMPEG_MISSING",
            "ERROR: unable to write data: [Errno 28] No space left on device": "DISK_FULL",
        }
        for text, code in cases.items():
            self.assertEqual(host.classify_error(text)[0], code, text)

    def test_unknown_error_keeps_message(self):
        self.assertEqual(host.classify_error("ERROR: something odd"), ("YTDLP_ERROR", "something odd"))


if __name__ == "__main__":
    unittest.main()
