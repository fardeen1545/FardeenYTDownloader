// Popup: paste-a-link flow, downloads list, settings, and the "Setup required" screen.
(() => {
  'use strict';

  const {
    el, parseVideoId, formatBytes, formatDuration, optionTitle, pickDefault, statusText, isActive,
    DEFAULT_SETTINGS, QUALITY_CHOICES,
  } = FYTD;

  const SAVED_FLASH_MS = 1800;
  const ABSOLUTE_PATH_RE = /^([A-Za-z]:[\\/]|\\\\|\/|~|%[A-Za-z_]+%|\$HOME)/;
  const $ = (id) => document.getElementById(id);

  let settings = { ...DEFAULT_SETTINGS };
  let current = null; // { videoId, info }
  const jobRows = new Map(); // jobId -> { li, status }

  async function send(message) {
    try {
      return (await chrome.runtime.sendMessage(message)) || { ok: false, error: 'No response from the extension.' };
    } catch (err) {
      return { ok: false, code: 'ERROR', error: err.message || String(err) };
    }
  }

  function showView(view) {
    for (const id of ['checking', 'setup', 'app']) $(id).hidden = id !== view;
  }

  // ---------------------------------------------------------------- host check / setup screen

  async function checkHost() {
    showView('checking');
    const res = await send({ type: 'check' });
    if (!res.ok) {
      $('setup-reason').textContent = res.error || '';
      $('ext-id').textContent = chrome.runtime.id;
      showView('setup');
      return false;
    }
    const { deps } = res;
    const missing = [];
    if (!deps.ytdlp) missing.push('yt-dlp is missing — run: pip install -U yt-dlp');
    if (!deps.ffmpeg) missing.push('ffmpeg is missing — needed for 720p and above and for MP3');
    $('warning').textContent = missing.join('. ');
    $('warning').hidden = missing.length === 0;
    $('s-folder').placeholder = deps.default_folder || '';
    showView('app');
    return true;
  }

  async function copyExtensionId() {
    try {
      await navigator.clipboard.writeText(chrome.runtime.id);
      $('copy-id').textContent = 'Copied ✓';
    } catch {
      $('copy-id').textContent = 'Select & copy';
    }
  }

  // ---------------------------------------------------------------- paste-a-link flow

  function showUrlError(message) {
    $('url-error').textContent = message;
    $('url-error').hidden = !message;
  }

  function renderResult(...children) {
    $('result').replaceChildren(...children.flat().filter(Boolean));
  }

  async function onFetchSubmit(event) {
    event.preventDefault();
    const videoId = parseVideoId($('url').value);
    if (!videoId) {
      showUrlError('That isn\'t a YouTube video link. Examples: https://www.youtube.com/watch?v=…, https://youtu.be/…, https://www.youtube.com/shorts/…');
      return;
    }
    showUrlError('');
    await fetchFormats(videoId, false);
  }

  async function fetchFormats(videoId, force) {
    $('fetch-btn').disabled = true;
    current = null;
    renderResult(el('div', { class: 'center' }, el('div', { class: 'spinner' }), el('p', { class: 'muted' }, 'Fetching qualities and sizes…')));
    const res = await send({ type: 'getFormats', videoId, force });
    $('fetch-btn').disabled = false;
    if (!res.ok) {
      if (res.code === 'HOST_MISSING') return checkHost();
      return renderResult(el('div', { class: 'result-error' },
        el('p', { class: 'error', text: res.error }),
        el('button', { class: 'btn small', type: 'button', onclick: () => fetchFormats(videoId, true) }, 'Try again')));
    }
    current = { videoId, info: res.info };
    renderInfo();
  }

  function optionItem(option, isDefault) {
    const button = el('button', { class: 'btn small primary', type: 'button' }, 'Download');
    button.addEventListener('click', () => startDownload(option, button));
    return el('li', { class: 'option' + (isDefault ? ' default' : '') },
      el('span', { class: 'q' }, optionTitle(option), isDefault && el('span', { class: 'badge', text: 'default' })),
      el('span', { class: 'size', text: formatBytes(option.size, option.approx) }),
      button);
  }

  function renderInfo() {
    const { info } = current;
    const def = pickDefault(info.options, settings.defaultQuality);
    const videos = info.options.filter((o) => o.kind === 'video');
    const audios = info.options.filter((o) => o.kind === 'audio');
    renderResult(
      el('div', { class: 'card' },
        el('img', { class: 'thumb', src: info.thumbnail, alt: '', width: 128, height: 72 }),
        el('div', { class: 'card-text' },
          el('div', { class: 'card-title', text: info.title, title: info.title }),
          el('div', { class: 'card-meta', text: info.channel }),
          el('div', { class: 'card-meta', text: formatDuration(info.duration) }))),
      el('ul', { class: 'options' },
        videos.length > 0 && el('li', { class: 'group', text: 'Video' }),
        videos.map((o) => optionItem(o, o === def)),
        audios.length > 0 && el('li', { class: 'group', text: 'Audio only' }),
        audios.map((o) => optionItem(o, o === def))),
    );
  }

  async function startDownload(option, button) {
    if (!current) return;
    button.disabled = true;
    const res = await send({ type: 'download', videoId: current.videoId, title: current.info.title, option });
    button.disabled = false;
    if (res.ok) {
      $('downloads-title').scrollIntoView({ behavior: 'smooth', block: 'start' }); // show the new progress row
      return;
    }
    if (res.code === 'HOST_MISSING') return checkHost();
    showUrlError(res.error);
  }

  // ---------------------------------------------------------------- downloads list

  function jobAction(job) {
    if (isActive(job)) {
      return el('button', { class: 'link', type: 'button', onclick: () => send({ type: 'cancel', jobId: job.id }) }, 'Cancel');
    }
    if (job.status === 'done' && job.filepath) {
      return el('button', { class: 'link', type: 'button', onclick: () => openFolder(job) }, 'Show in folder');
    }
    return null;
  }

  async function openFolder(job) {
    const res = await send({ type: 'openFolder', path: job.filepath });
    if (!res.ok) {
      const row = jobRows.get(job.id);
      if (row) row.li.querySelector('.job-status').textContent = res.error;
    }
  }

  function buildJobRow(job) {
    const indeterminate = job.status === 'processing' || job.status === 'starting';
    const li = el('li', { class: 'job ' + job.status },
      el('div', { class: 'job-top' },
        el('span', { class: 'job-title', text: job.title, title: job.title }),
        el('span', { class: 'job-label', text: job.label })),
      el('div', {
        class: 'bar' + (indeterminate ? ' indeterminate' : ''),
        role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100,
      }, el('i')),
      el('div', { class: 'job-bottom' },
        el('span', { class: 'job-status' + (job.status === 'error' ? ' error' : ''), text: statusText(job) }),
        jobAction(job)));
    updateJobRow(li, job);
    return li;
  }

  function updateJobRow(li, job) {
    const percent = job.status === 'done' ? 100 : Math.max(0, Math.min(100, job.percent || 0));
    li.querySelector('.bar > i').style.width = percent + '%';
    li.querySelector('.bar').setAttribute('aria-valuenow', String(Math.round(percent)));
    li.querySelector('.job-status').textContent = statusText(job);
  }

  /** Update rows in place on progress ticks so Cancel never moves under the cursor. */
  function renderJobs(jobs) {
    const list = $('jobs');
    const seen = new Set();
    const rows = jobs.map((job) => {
      seen.add(job.id);
      const existing = jobRows.get(job.id);
      if (existing && existing.status === job.status) {
        updateJobRow(existing.li, job);
        return existing.li;
      }
      const li = buildJobRow(job);
      jobRows.set(job.id, { li, status: job.status });
      return li;
    });
    for (const id of [...jobRows.keys()]) if (!seen.has(id)) jobRows.delete(id);
    const sameOrder = rows.length === list.children.length && rows.every((li, i) => list.children[i] === li);
    if (!sameOrder) list.replaceChildren(...rows);
    $('no-jobs').hidden = jobs.length > 0;
    $('clear').hidden = !jobs.some((j) => !isActive(j));
  }

  async function loadJobs() {
    const { jobs } = await chrome.storage.local.get('jobs');
    renderJobs(Array.isArray(jobs) ? jobs : []);
  }

  // ---------------------------------------------------------------- settings

  function fillSettingsForm() {
    $('s-quality').replaceChildren(...QUALITY_CHOICES.map(([value, label]) => el('option', { value }, label)));
    $('s-folder').value = settings.folder;
    $('s-quality').value = settings.defaultQuality;
    $('s-template').value = settings.filenameTemplate;
    $('s-thumbs').checked = settings.showThumbButtons;
  }

  function readSettingsForm() {
    const folder = $('s-folder').value.trim();
    const template = $('s-template').value.trim() || DEFAULT_SETTINGS.filenameTemplate;
    if (folder && !ABSOLUTE_PATH_RE.test(folder)) {
      return { error: 'Use a full folder path, e.g. C:\\Users\\you\\Videos or /home/you/Videos.' };
    }
    if (/[\\/]/.test(template)) return { error: 'The filename template cannot contain / or \\.' };
    if (template.length > 200) return { error: 'The filename template is too long.' };
    return {
      value: {
        folder,
        defaultQuality: $('s-quality').value,
        filenameTemplate: template,
        showThumbButtons: $('s-thumbs').checked,
      },
    };
  }

  async function onSettingsSubmit(event) {
    event.preventDefault();
    const { value, error } = readSettingsForm();
    $('s-error').textContent = error || '';
    $('s-error').hidden = !error;
    if (error) return;
    await chrome.storage.sync.set({ settings: value });
    settings = value;
    $('s-saved').hidden = false;
    setTimeout(() => { $('s-saved').hidden = true; }, SAVED_FLASH_MS);
    if (current) renderInfo();
  }

  // ---------------------------------------------------------------- init

  async function prefillFromActiveTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const videoId = tab && tab.url ? parseVideoId(tab.url) : null;
      if (!videoId) return;
      $('url').value = tab.url;
      await fetchFormats(videoId, false);
    } catch {
      // No access to the tab URL (not a YouTube tab): leave the field empty.
    }
  }

  async function init() {
    if (new URLSearchParams(location.search).get('view') === 'tab') document.body.classList.add('as-tab');
    const { settings: stored } = await chrome.storage.sync.get('settings');
    settings = { ...DEFAULT_SETTINGS, ...(stored || {}) };
    fillSettingsForm();

    $('fetch-form').addEventListener('submit', onFetchSubmit);
    $('settings-form').addEventListener('submit', onSettingsSubmit);
    $('recheck').addEventListener('click', async () => { if (await checkHost()) prefillFromActiveTab(); });
    $('copy-id').addEventListener('click', copyExtensionId);
    $('clear').addEventListener('click', () => send({ type: 'clearFinished' }));
    $('url').addEventListener('input', () => showUrlError(''));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.jobs) renderJobs(changes.jobs.newValue || []);
    });

    await loadJobs();
    if (await checkHost()) {
      $('url').focus();
      await prefillFromActiveTab();
    }
  }

  init();
})();
