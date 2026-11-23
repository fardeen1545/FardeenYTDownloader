// Shared helpers for the content script, service worker and popup.
// Loaded as a classic script; exposes globalThis.FYTD (and module.exports for tests).
(function (root) {
  'use strict';

  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
  const YT_HOST_RE = /(^|\.)(youtube\.com|youtube-nocookie\.com)$/;
  const PATH_ID_RE = /^\/(shorts|embed|live|v)\/([^/?#]+)/;

  const DEFAULT_SETTINGS = Object.freeze({
    folder: '',
    defaultQuality: '1080',
    filenameTemplate: '{title} [{id}]',
    showThumbButtons: true,
  });

  const QUALITY_CHOICES = Object.freeze([
    ['best', 'Best available'], ['2160', '2160p (4K)'], ['1440', '1440p'], ['1080', '1080p'],
    ['720', '720p'], ['480', '480p'], ['360', '360p'], ['mp3', 'MP3 audio'], ['m4a', 'M4A audio'],
  ]);

  const ACTIVE_STATUSES = Object.freeze(['starting', 'downloading', 'processing']);

  /** Extract an 11-char video ID from any YouTube link (or a bare ID). Returns null if invalid. */
  function parseVideoId(input, base) {
    if (typeof input !== 'string') return null;
    let text = input.trim();
    if (!text) return null;
    if (VIDEO_ID_RE.test(text)) return text;
    if (!base && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'https://' + text;
    let url;
    try {
      url = new URL(text, base);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname.toLowerCase();
    let id = null;
    if (host === 'youtu.be' || host === 'www.youtu.be') {
      id = url.pathname.split('/')[1];
    } else if (YT_HOST_RE.test(host)) {
      if (url.pathname === '/watch') id = url.searchParams.get('v');
      else {
        const match = url.pathname.match(PATH_ID_RE);
        id = match && match[2];
      }
    }
    return id && VIDEO_ID_RE.test(id) ? id : null;
  }

  function isVideoId(value) {
    return typeof value === 'string' && VIDEO_ID_RE.test(value);
  }

  /** 48234567 -> "48.2 MB"; approximate -> "~48 MB". */
  function formatBytes(bytes, approx) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes <= 0) return 'size unknown';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
      value /= 1000;
      unit += 1;
    }
    const digits = unit === 0 ? 0 : approx ? (value < 10 ? 1 : 0) : 1;
    return (approx ? '~' : '') + value.toFixed(digits) + ' ' + units[unit];
  }

  function formatSpeed(bytesPerSec) {
    return typeof bytesPerSec === 'number' && bytesPerSec > 0 ? formatBytes(bytesPerSec, false) + '/s' : '';
  }

  /** 65 -> "1:05", 3723 -> "1:02:03". */
  function formatDuration(seconds) {
    if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) return '';
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  /** Human label for an option, e.g. "1080p60 · MP4" or "MP3 · 192 kbps". */
  function optionTitle(option) {
    if (option.kind === 'audio') return option.label + (option.bitrate ? ` · ${option.bitrate} kbps` : '');
    return `${option.label} · ${option.ext.toUpperCase()}`;
  }

  /** The option matching the user's default-quality setting, or null. */
  function pickDefault(options, pref) {
    if (!Array.isArray(options) || !options.length) return null;
    if (pref === 'mp3' || pref === 'm4a') return options.find((o) => o.ext === pref) || null;
    const videos = options.filter((o) => o.kind === 'video');
    const mp4First = (list) => list.find((o) => o.ext === 'mp4') || list[0] || null;
    if (pref === 'best' || !pref) return mp4First(videos.filter((o) => o.height === (videos[0] || {}).height));
    const limit = Number(pref);
    const fitting = videos.filter((o) => o.height <= limit);
    if (!fitting.length) return mp4First(videos.slice(-1));
    return mp4First(fitting.filter((o) => o.height === fitting[0].height));
  }

  function statusText(job) {
    switch (job.status) {
      case 'starting': return 'Starting…';
      case 'downloading': {
        const bits = [`${(job.percent || 0).toFixed(0)}%`];
        if (job.speed) bits.push(formatSpeed(job.speed));
        if (typeof job.eta === 'number') bits.push(formatDuration(job.eta) + ' left');
        return bits.join(' · ');
      }
      case 'processing': return job.stage === 'ExtractAudio' ? 'Converting to MP3…' : 'Merging video and audio…';
      case 'done': return 'Saved';
      case 'cancelled': return 'Cancelled';
      case 'interrupted': return 'Interrupted (browser was closed)';
      default: return job.error || 'Failed';
    }
  }

  function isActive(job) {
    return ACTIVE_STATUSES.includes(job.status);
  }

  /** Tiny DOM builder: el('div', {class: 'x', onclick: fn}, 'text', child). Text is never parsed as HTML. */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : String(child));
    }
    return node;
  }

  const api = Object.freeze({
    DEFAULT_SETTINGS, QUALITY_CHOICES, parseVideoId, isVideoId, formatBytes, formatSpeed,
    formatDuration, optionTitle, pickDefault, statusText, isActive, el,
  });

  root.FYTD = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
