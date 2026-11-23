// Service worker: bridges the content scripts / popup and the native host (yt-dlp + ffmpeg).
'use strict';
importScripts('lib/common.js');

const { DEFAULT_SETTINGS, isVideoId, isActive, optionTitle } = FYTD;

const HOST_NAME = 'com.fardeen.ytdownloader';
const CACHE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 150 * 1000;
const IDLE_DISCONNECT_MS = 60 * 1000;
const MAX_FINISHED_JOBS = 25;

// ------------------------------------------------------------------ job store (chrome.storage.local "jobs")

let jobsCache = null;
let writeChain = Promise.resolve();

async function loadJobs() {
  if (!jobsCache) {
    const { jobs } = await chrome.storage.local.get('jobs');
    jobsCache = Array.isArray(jobs) ? jobs : [];
  }
  return jobsCache;
}

/** Serialize all writes so rapid progress events never overwrite each other. */
function updateJobs(transform) {
  writeChain = writeChain
    .then(async () => {
      const next = transform(await loadJobs());
      const finished = new Set(next.filter((j) => !isActive(j)).slice(0, MAX_FINISHED_JOBS));
      jobsCache = next.filter((j) => isActive(j) || finished.has(j));
      await chrome.storage.local.set({ jobs: jobsCache });
    })
    .catch((err) => console.error('[FYTD] failed to save jobs', err));
  return writeChain;
}

function patchJob(jobId, patch) {
  return updateJobs((jobs) => jobs.map((j) => (j.id === jobId ? { ...j, ...patch } : j)));
}

// A fresh service worker means the previous native host (and its downloads) is gone.
updateJobs((jobs) => jobs.map((j) => (isActive(j) ? { ...j, status: 'interrupted' } : j)));

// ------------------------------------------------------------------ native host connection

let port = null;
let nextRequestId = 1;
const pending = new Map();
let idleTimer = null;

function hostError(message) {
  const text = message || 'The helper app exited.';
  if (/forbidden/i.test(text)) {
    return {
      code: 'HOST_MISSING',
      error: `The helper app is registered for a different extension ID. Re-run the installer with this ID: ${chrome.runtime.id}`,
    };
  }
  if (/not found|not installed|invalid native messaging host|failed to start/i.test(text)) {
    return { code: 'HOST_MISSING', error: 'The Fardeen YT Downloader helper app is not installed yet.' };
  }
  return { code: 'HOST_CRASHED', error: `The helper app stopped unexpectedly (${text}). Try again.` };
}

function getPort() {
  if (port) return port;
  const newPort = chrome.runtime.connectNative(HOST_NAME);
  newPort.onMessage.addListener(onHostMessage);
  newPort.onDisconnect.addListener(() => {
    const err = hostError(chrome.runtime.lastError && chrome.runtime.lastError.message);
    if (port === newPort) port = null;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(err);
    }
    pending.clear();
    updateJobs((jobs) => jobs.map((j) => (isActive(j) ? { ...j, status: 'error', ...err } : j)));
  });
  port = newPort;
  return port;
}

function callHost(action, params = {}) {
  clearTimeout(idleTimer);
  return new Promise((resolve, reject) => {
    const id = nextRequestId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject({ code: 'TIMEOUT', error: 'The helper app did not respond in time. Try again.' });
      scheduleIdleDisconnect();
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      getPort().postMessage({ ...params, id, action });
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(hostError(err && err.message));
    }
  });
}

function onHostMessage(msg) {
  if (msg && pending.has(msg.id)) {
    const request = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(request.timer);
    if (msg.ok) request.resolve(msg.result);
    else request.reject({ code: msg.code || 'HOST_ERROR', error: msg.error || 'Unknown error.' });
  } else if (msg && typeof msg.job_id === 'string') {
    applyJobEvent(msg);
  }
  scheduleIdleDisconnect();
}

function applyJobEvent(msg) {
  switch (msg.event) {
    case 'progress':
      return patchJob(msg.job_id, {
        status: msg.status === 'processing' ? 'processing' : 'downloading',
        percent: typeof msg.percent === 'number' ? msg.percent : 0,
        speed: msg.speed || null,
        eta: typeof msg.eta === 'number' ? msg.eta : null,
        stage: msg.stage || null,
      });
    case 'done':
      return patchJob(msg.job_id, { status: 'done', percent: 100, filepath: msg.filepath, speed: null, eta: null });
    case 'cancelled':
      return patchJob(msg.job_id, { status: 'cancelled', speed: null, eta: null });
    case 'error':
      return patchJob(msg.job_id, { status: 'error', code: msg.code, error: msg.error, speed: null, eta: null });
    default:
      return undefined;
  }
}

/** The open port keeps this worker and the host process alive; release both when idle. */
function scheduleIdleDisconnect() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const jobs = await loadJobs();
    if (port && pending.size === 0 && !jobs.some(isActive)) {
      port.disconnect();
      port = null;
    }
  }, IDLE_DISCONNECT_MS);
}

// ------------------------------------------------------------------ request handlers

async function getSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

function requireVideoId(videoId) {
  if (!isVideoId(videoId)) throw { code: 'BAD_REQUEST', error: 'Invalid video ID.' };
  return videoId;
}

const handlers = {
  async getFormats({ videoId, force }) {
    const key = 'fmt:' + requireVideoId(videoId);
    if (!force) {
      const cached = (await chrome.storage.session.get(key))[key];
      if (cached && Date.now() - cached.t < CACHE_TTL_MS) return { info: cached.info, cached: true };
    }
    const info = await callHost('get_formats', { video_id: videoId });
    await chrome.storage.session.set({ [key]: { t: Date.now(), info } });
    return { info };
  },

  async download({ videoId, title, option }) {
    requireVideoId(videoId);
    if (!option || typeof option !== 'object' || typeof option.format !== 'string') {
      throw { code: 'BAD_REQUEST', error: 'Invalid download option.' };
    }
    const settings = await getSettings();
    const jobId = crypto.randomUUID();
    const job = {
      id: jobId, videoId, title: String(title || videoId).slice(0, 200), label: optionTitle(option),
      ext: option.ext, size: option.size || null, approx: !!option.approx,
      status: 'starting', percent: 0, createdAt: Date.now(),
    };
    await updateJobs((jobs) => [job, ...jobs]);
    try {
      await callHost('download', {
        job_id: jobId, video_id: videoId, option,
        folder: settings.folder, template: settings.filenameTemplate,
      });
    } catch (err) {
      await patchJob(jobId, { status: 'error', code: err.code, error: err.error });
      throw err;
    }
    return { jobId };
  },

  async cancel({ jobId }) {
    const result = port ? await callHost('cancel', { job_id: String(jobId) }) : { cancelled: false };
    if (!result.cancelled) { // host no longer has it: only mark stale active jobs, never a finished one
      await updateJobs((jobs) => jobs.map((j) => (
        j.id === jobId && isActive(j) ? { ...j, status: 'cancelled', speed: null, eta: null } : j)));
    }
    return {};
  },

  async openFolder({ path }) {
    await callHost('open_folder', { path: String(path || '') });
    return {};
  },

  async check() {
    return { deps: await callHost('check_dependencies') };
  },

  async clearFinished() {
    await updateJobs((jobs) => jobs.filter(isActive));
    return {};
  },

  async openSetup() {
    await chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html?view=tab') });
    return {};
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || !Object.hasOwn(handlers, msg.type)) return false;
  Promise.resolve()
    .then(() => handlers[msg.type](msg))
    .then(
      (result) => sendResponse({ ok: true, ...result }),
      (err) => sendResponse({
        ok: false,
        code: (err && err.code) || 'ERROR',
        error: (err && (err.error || err.message)) || String(err),
      }),
    );
  return true; // async response
});
