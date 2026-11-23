// Content script for www.youtube.com: thumbnail buttons, watch-page button, Shorts button and the
// quality menu. All injected UI lives in Shadow DOM so YouTube's CSS and ours never collide.
(() => {
  'use strict';
  if (window.__fytdContentLoaded) return;
  window.__fytdContentLoaded = true;

  const S = window.FYTD_SELECTORS;
  const {
    el, parseVideoId, formatBytes, formatDuration, optionTitle, pickDefault, statusText, isActive,
    DEFAULT_SETTINGS,
  } = window.FYTD;

  const SCAN_DELAY_MS = 250;
  const MENU_WIDTH = 300;
  const MENU_GAP = 6;
  const VIEWPORT_MARGIN = 8;
  const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z"/></svg>';

  let settings = { ...DEFAULT_SETTINGS };

  // ---------------------------------------------------------------- messaging

  async function send(message) {
    try {
      return (await chrome.runtime.sendMessage(message)) || { ok: false, error: 'No response from the extension.' };
    } catch (err) {
      const message = (err && err.message) || String(err);
      if (!chrome.runtime || !chrome.runtime.id || /context invalidated/i.test(message)) {
        return { ok: false, code: 'RELOAD', error: 'The extension was updated. Reload this page to continue.' };
      }
      return { ok: false, code: 'ERROR', error: message };
    }
  }

  async function readJobs() {
    try {
      const { jobs } = await chrome.storage.local.get('jobs');
      return Array.isArray(jobs) ? jobs : [];
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------- shared button helpers

  /** Keep clicks on our UI from reaching YouTube (which would open the video or fire shortcuts). */
  function shield(host) {
    for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'auxclick']) {
      host.addEventListener(type, (event) => {
        event.stopPropagation();
        event.preventDefault();
      });
    }
    for (const type of ['keydown', 'keyup', 'touchstart', 'touchend']) {
      host.addEventListener(type, (event) => event.stopPropagation());
    }
  }

  function createButtonHost(tagName, css, innerHtml, onActivate) {
    const host = document.createElement(tagName);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${css}</style>${innerHtml}`; // static markup only, no page data
    shield(host);
    host.addEventListener('click', () => onActivate(host));
    return host;
  }

  // Brand red on every injected button so it is never confused with YouTube's own (grey) buttons,
  // including YouTube Premium's download button that sits in the same row.
  const BRAND_CSS = `
    :host { --fytd-red: #e62117; --fytd-red-hover: #c4140c; --fytd-red-active: #a8110a; }
    button:focus-visible { outline: 2px solid #3ea6ff; outline-offset: 2px; }
    svg { fill: currentColor; flex: none; }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }`;

  const THUMB_CSS = BRAND_CSS + `
    :host { display: block; }
    button { display: flex; align-items: center; justify-content: center; width: 34px; height: 34px;
      padding: 0; border: 0; border-radius: 10px; background: var(--fytd-red); color: #fff; cursor: pointer;
      box-shadow: 0 2px 8px rgba(0,0,0,.35); transition: background .15s, transform .15s; }
    button:hover { background: var(--fytd-red-hover); transform: scale(1.06); }
    button:active { background: var(--fytd-red-active); transform: scale(.96); }
    svg { width: 20px; height: 20px; }`;

  const WATCH_CSS = BRAND_CSS + `
    :host { display: inline-flex; flex: none; margin-left: 8px; }
    button { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 16px 0 12px;
      border: 0; border-radius: 18px; cursor: pointer; white-space: nowrap;
      font: 500 14px/36px "Roboto", "Arial", sans-serif;
      background: var(--fytd-red); color: #fff; transition: background .15s; }
    button:hover { background: var(--fytd-red-hover); }
    button:active { background: var(--fytd-red-active); }
    svg { width: 24px; height: 24px; }`;

  const SHORTS_CSS = BRAND_CSS + `
    :host { display: flex; justify-content: center; margin-top: 16px; }
    button { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 0; border: 0;
      background: none; cursor: pointer; color: var(--yt-spec-text-primary, #0f0f0f);
      font: 500 12px/16px "Roboto", "Arial", sans-serif; }
    :host-context(html[dark]) button { color: var(--yt-spec-text-primary, #f1f1f1); }
    .circle { display: flex; align-items: center; justify-content: center; width: 48px; height: 48px;
      border-radius: 50%; background: var(--fytd-red); color: #fff; transition: background .15s, transform .15s; }
    button:hover .circle { background: var(--fytd-red-hover); transform: scale(1.05); }
    button:active .circle { background: var(--fytd-red-active); }
    button:focus-visible { outline: none; }
    button:focus-visible .circle { outline: 2px solid #3ea6ff; outline-offset: 2px; }
    svg { width: 24px; height: 24px; }`;

  // ---------------------------------------------------------------- thumbnails

  function videoIdFromAnchor(anchor) {
    return parseVideoId(anchor.getAttribute('href') || '', location.origin);
  }

  function createThumbButton(anchor) {
    return createButtonHost(
      'fytd-thumb-btn', THUMB_CSS,
      `<button type="button" aria-label="Download video" title="Download">${ICON}</button>`,
      (host) => {
        const id = videoIdFromAnchor(anchor); // read at click time: YouTube recycles thumbnail elements
        if (id) Menu.toggle(id, host);
      },
    );
  }

  function scanThumbnails() {
    if (!settings.showThumbButtons) return;
    for (const anchor of document.querySelectorAll(S.thumbnailAnchors)) {
      if (anchor.querySelector(':scope > fytd-thumb-btn')) continue; // already processed
      if (anchor.querySelector(S.playlistMarker) || !videoIdFromAnchor(anchor)) continue;
      anchor.setAttribute('data-fytd-thumb', '');
      if (getComputedStyle(anchor).position === 'static') anchor.style.position = 'relative';
      anchor.appendChild(createThumbButton(anchor));
    }
  }

  // ---------------------------------------------------------------- watch page + Shorts

  function firstMatch(selectors, root = document) {
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      if (node) return node;
    }
    return null;
  }

  function findWatchBar() {
    const bar = firstMatch(S.watchActionBar);
    if (bar) return bar;
    const like = document.querySelector(S.watchLikeButton);
    return like ? like.parentElement : null;
  }

  function ensureWatchButton() {
    const existing = [...document.querySelectorAll('fytd-watch-btn')];
    const bar = location.pathname === '/watch' ? findWatchBar() : null;
    if (bar && existing.length === 1 && existing[0].parentElement === bar) return;
    existing.forEach((node) => node.remove());
    if (!bar) return;
    bar.appendChild(createButtonHost(
      'fytd-watch-btn', WATCH_CSS,
      `<button type="button" aria-label="Download video">${ICON}<span>Download</span></button>`,
      (host) => {
        const id = parseVideoId(location.href);
        if (id) Menu.toggle(id, host);
      },
    ));
  }

  function ensureShortsButtons() {
    if (!location.pathname.startsWith('/shorts/')) return;
    for (const reel of document.querySelectorAll(S.shortsReel)) {
      const bar = firstMatch(S.shortsActionBar, reel);
      if (!bar || bar.querySelector('fytd-shorts-btn')) continue;
      const button = createButtonHost(
        'fytd-shorts-btn', SHORTS_CSS,
        `<button type="button" aria-label="Download Short"><span class="circle">${ICON}</span>Download</button>`,
        (host) => {
          const id = parseVideoId(location.href); // only the active (visible) Short can be clicked
          if (id) Menu.toggle(id, host);
        },
      );
      let anchorNode = bar.querySelector(S.shortsShareButton);
      while (anchorNode && anchorNode.parentElement !== bar) anchorNode = anchorNode.parentElement;
      bar.insertBefore(button, anchorNode ? anchorNode.nextSibling : null);
    }
  }

  // ---------------------------------------------------------------- quality menu

  const MENU_CSS = `
    :host { font-family: "Roboto", "Arial", sans-serif; }
    .panel { box-sizing: border-box; overflow-y: auto; padding: 8px 0; border-radius: 12px;
      font-size: 14px; line-height: 1.4; background: #fff; color: #0f0f0f;
      box-shadow: 0 4px 32px rgba(0,0,0,.28);
      --muted: #606060; --line: rgba(0,0,0,.1); --hover: rgba(0,0,0,.06); --chip: rgba(0,0,0,.06); --err: #c00; }
    :host([data-theme="dark"]) .panel { background: #282828; color: #f1f1f1;
      --muted: #aaa; --line: rgba(255,255,255,.14); --hover: rgba(255,255,255,.1); --chip: rgba(255,255,255,.1); --err: #ff7b7b; }
    .head { padding: 4px 16px 10px; border-bottom: 1px solid var(--line); }
    .title { font-weight: 500; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .meta { color: var(--muted); font-size: 12px; margin-top: 2px; }
    .section { padding: 10px 16px 4px; font-size: 11px; font-weight: 500; letter-spacing: .05em;
      text-transform: uppercase; color: var(--muted); }
    .row { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 12px;
      padding: 8px 16px; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
    .row:hover, .row:focus-visible { background: var(--hover); outline: none; }
    .size { color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
    .badge { margin-left: 6px; padding: 1px 6px; border-radius: 4px; font-size: 11px; background: #e62117; color: #fff; }
    .center { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 20px 16px; text-align: center; }
    .spinner { width: 28px; height: 28px; border-radius: 50%; border: 3px solid var(--line);
      border-top-color: #e62117; animation: spin .8s linear infinite; }
    .job { display: flex; flex-direction: column; gap: 8px; padding: 14px 16px 6px; }
    .job-label { font-weight: 500; }
    .bar { height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; }
    .bar > i { display: block; height: 100%; width: 0; background: #e62117; transition: width .3s; }
    .bar.indeterminate > i { width: 40% !important; animation: slide 1.2s ease-in-out infinite; }
    .status { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
    .error { color: var(--err); }
    .actions { display: flex; gap: 8px; justify-content: flex-end; padding: 8px 16px 4px; }
    .btn { border: 0; border-radius: 18px; padding: 8px 16px; cursor: pointer; font: 500 14px "Roboto", "Arial", sans-serif;
      background: var(--chip); color: inherit; }
    .btn:hover { filter: brightness(.95); }
    .btn[disabled] { opacity: .5; cursor: default; }
    .btn.primary { background: #e62117; color: #fff; }
    .btn:focus-visible { outline: 2px solid #3ea6ff; outline-offset: 2px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
    @media (prefers-reduced-motion: reduce) { .spinner, .bar.indeterminate > i { animation-duration: 3s; } }`;

  const Menu = (() => {
    let host = null;
    let panel = null;
    let state = null; // { videoId, opener, info, jobId }

    function build() {
      host = document.createElement('fytd-menu');
      host.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483646;'; // no inline display: `hidden` must win
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${MENU_CSS}</style>`;
      panel = el('div', { class: 'panel', role: 'dialog', 'aria-label': 'Download options' });
      root.appendChild(panel);
      shield(host);
      host.addEventListener('keydown', (e) => e.key === 'Escape' && close());
      document.addEventListener('mousedown', onOutsidePointer, true);
      document.addEventListener('keydown', (e) => e.key === 'Escape' && state && close(), true);
      document.addEventListener('scroll', () => state && position(), true);
      window.addEventListener('resize', () => state && position());
      document.documentElement.appendChild(host);
    }

    function onOutsidePointer(event) {
      if (!state) return;
      const path = event.composedPath();
      if (!path.includes(host) && !path.includes(state.opener)) close();
    }

    function toggle(videoId, opener) {
      if (state && state.opener === opener) close();
      else open(videoId, opener);
    }

    async function open(videoId, opener) {
      if (!host) build();
      if (state) state.opener.removeAttribute('data-open');
      state = { videoId, opener, info: null, jobId: null };
      opener.setAttribute('data-open', '');
      host.hidden = false;
      host.dataset.theme = document.documentElement.hasAttribute('dark') ? 'dark' : 'light';
      const job = (await readJobs()).find((j) => j.videoId === videoId && isActive(j));
      if (!state || state.videoId !== videoId) return;
      if (job) {
        state = { ...state, jobId: job.id };
        renderJob(job);
      } else {
        loadFormats(false);
      }
    }

    function close() {
      if (!state) return;
      state.opener.removeAttribute('data-open');
      state = null;
      host.hidden = true;
      panel.replaceChildren();
      delete panel.dataset.view;
    }

    function position() {
      if (!state) return;
      const rect = state.opener.getBoundingClientRect();
      if (!state.opener.isConnected || rect.bottom < 0 || rect.top > window.innerHeight) {
        close();
        return;
      }
      const width = Math.min(MENU_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
      const below = window.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
      const above = rect.top - MENU_GAP - VIEWPORT_MARGIN;
      const placeBelow = below >= Math.min(panel.scrollHeight, 320) || below >= above;
      const maxHeight = Math.max(160, Math.min(460, placeBelow ? below : above));
      panel.style.width = width + 'px';
      panel.style.maxHeight = maxHeight + 'px';
      const height = Math.min(panel.scrollHeight, maxHeight);
      const left = Math.min(Math.max(VIEWPORT_MARGIN, rect.right - width), window.innerWidth - width - VIEWPORT_MARGIN);
      const top = placeBelow ? rect.bottom + MENU_GAP : rect.top - MENU_GAP - height;
      host.style.transform = `translate(${Math.round(left)}px, ${Math.round(Math.max(VIEWPORT_MARGIN, top))}px)`;
    }

    function show(view, ...children) {
      panel.dataset.view = view;
      panel.replaceChildren(...children.flat().filter(Boolean));
      position();
    }

    function header(title, meta) {
      return el('div', { class: 'head' },
        el('div', { class: 'title', text: title }),
        meta && el('div', { class: 'meta', text: meta }));
    }

    async function loadFormats(force) {
      const { videoId } = state;
      show('loading', el('div', { class: 'center' },
        el('div', { class: 'spinner' }),
        el('div', { class: 'status', text: 'Fetching qualities and sizes…' })));
      const res = await send({ type: 'getFormats', videoId, force });
      if (!state || state.videoId !== videoId) return; // menu closed or reused meanwhile
      if (!res.ok) return renderError(res, () => loadFormats(true));
      state = { ...state, info: res.info };
      renderOptions();
    }

    function renderError(res, retry) {
      if (res.code === 'HOST_MISSING') {
        return show('setup', el('div', { class: 'center' },
          el('strong', { text: 'Setup required' }),
          el('div', { class: 'status', text: res.error }),
          el('div', { class: 'status', text: 'A small helper app (yt-dlp + ffmpeg) must be installed on your computer once.' }),
          el('button', {
            class: 'btn primary', type: 'button',
            onclick: () => { send({ type: 'openSetup' }); close(); },
          }, 'Show setup steps')));
      }
      return show('error', el('div', { class: 'center' },
        el('div', { class: 'error', text: res.error || 'Something went wrong.' }),
        res.code !== 'RELOAD' && retry && el('button', { class: 'btn', type: 'button', onclick: retry }, 'Try again')));
    }

    function optionRow(option, isDefault) {
      return el('button', { class: 'row', type: 'button', role: 'menuitem', onclick: () => startDownload(option) },
        el('span', {}, optionTitle(option), isDefault && el('span', { class: 'badge', text: 'default' })),
        el('span', { class: 'size', text: formatBytes(option.size, option.approx) }));
    }

    function renderOptions() {
      const { info } = state;
      const def = pickDefault(info.options, settings.defaultQuality);
      const videos = info.options.filter((o) => o.kind === 'video');
      const audios = info.options.filter((o) => o.kind === 'audio');
      show('options',
        header(info.title, [info.channel, formatDuration(info.duration)].filter(Boolean).join(' · ')),
        el('div', { role: 'menu' },
          def && el('div', { class: 'section', text: 'Default' }), def && optionRow(def, true),
          videos.length > 0 && el('div', { class: 'section', text: 'Video' }), videos.map((o) => optionRow(o, false)),
          audios.length > 0 && el('div', { class: 'section', text: 'Audio only' }), audios.map((o) => optionRow(o, false))));
      const first = panel.querySelector('.row');
      if (first) first.focus({ preventScroll: true });
    }

    async function startDownload(option) {
      const { videoId, info } = state;
      renderJob({ id: '', status: 'starting', label: optionTitle(option), percent: 0, title: info.title });
      const res = await send({ type: 'download', videoId, title: info.title, option });
      if (!state || state.videoId !== videoId) return;
      if (!res.ok) return renderError(res, renderOptions);
      state = { ...state, jobId: res.jobId };
      const job = (await readJobs()).find((j) => j.id === res.jobId);
      if (job && state && state.jobId === job.id) renderJob(job);
    }

    function jobActions(job) {
      if (isActive(job)) {
        return [el('button', {
          class: 'btn', type: 'button', disabled: !job.id,
          onclick: () => send({ type: 'cancel', jobId: job.id }),
        }, 'Cancel')];
      }
      const back = state.info && el('button', {
        class: 'btn', type: 'button',
        onclick: () => { state = { ...state, jobId: null }; renderOptions(); },
      }, 'Other qualities');
      if (job.status === 'done') {
        return [back, el('button', { class: 'btn primary', type: 'button', onclick: () => openFolder(job.filepath) }, 'Show in folder')];
      }
      return [back || el('button', { class: 'btn', type: 'button', onclick: () => loadFormats(false) }, 'Back')];
    }

    async function openFolder(path) {
      const res = await send({ type: 'openFolder', path });
      if (!res.ok) renderError(res, null);
    }

    function renderJob(job) {
      const view = `job:${job.id}:${job.status}`;
      const percent = job.status === 'done' ? 100 : Math.max(0, Math.min(100, job.percent || 0));
      if (panel.dataset.view === view) { // progress tick: update in place so buttons stay clickable
        panel.querySelector('.bar > i').style.width = percent + '%';
        panel.querySelector('.bar').setAttribute('aria-valuenow', Math.round(percent));
        panel.querySelector('.status').textContent = statusText(job);
        return;
      }
      const indeterminate = job.status === 'processing' || job.status === 'starting';
      const bar = el('div', {
        class: 'bar' + (indeterminate ? ' indeterminate' : ''), role: 'progressbar',
        'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(percent),
      }, el('i'));
      bar.firstChild.style.width = percent + '%';
      show(view,
        header((state.info && state.info.title) || job.title || '', ''),
        el('div', { class: 'job' },
          el('div', { class: 'job-label', text: job.label || '' }),
          bar,
          el('div', { class: 'status' + (job.status === 'error' ? ' error' : ''), text: statusText(job), 'aria-live': 'polite' })),
        el('div', { class: 'actions' }, jobActions(job)));
    }

    function onJobsChanged(jobs) {
      if (!state || !state.jobId) return;
      const job = jobs.find((j) => j.id === state.jobId);
      if (job) renderJob(job);
    }

    return { toggle, close, onJobsChanged };
  })();

  // ---------------------------------------------------------------- settings, scanning, navigation

  function applySettings(stored) {
    settings = { ...DEFAULT_SETTINGS, ...(stored || {}) };
    document.documentElement.toggleAttribute('data-fytd-hide-thumbs', !settings.showThumbButtons);
    scheduleScan();
  }

  function injectPageStyle() {
    if (document.getElementById('fytd-page-style')) return;
    const style = document.createElement('style');
    style.id = 'fytd-page-style';
    style.textContent = `
      fytd-thumb-btn { position: absolute; top: 6px; right: 6px; z-index: 2000; opacity: 0; transition: opacity .15s; }
      [data-fytd-thumb]:hover > fytd-thumb-btn, fytd-thumb-btn:focus-within, fytd-thumb-btn[data-open] { opacity: 1; }
      html[data-fytd-hide-thumbs] fytd-thumb-btn { display: none !important; }
      @media (hover: none) { fytd-thumb-btn { opacity: 1; } }`;
    (document.head || document.documentElement).appendChild(style);
  }

  function scanAll() {
    scanThumbnails();
    ensureWatchButton();
    ensureShortsButtons();
  }

  // Throttled rather than pure-debounced: YouTube mutates the DOM constantly, so a pure debounce
  // could postpone the scan forever during infinite scroll.
  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanAll();
    }, SCAN_DELAY_MS);
  }

  async function init() {
    injectPageStyle();
    try {
      const { settings: stored } = await chrome.storage.sync.get('settings');
      applySettings(stored);
    } catch {
      applySettings(null);
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.settings) applySettings(changes.settings.newValue);
      if (area === 'local' && changes.jobs) Menu.onJobsChanged(changes.jobs.newValue || []);
    });
    document.addEventListener('yt-navigate-start', () => Menu.close());
    document.addEventListener('yt-navigate-finish', scanAll);
    new MutationObserver(scheduleScan).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['href'],
    });
    scanAll();
  }

  init();
})();
