(() => {
  'use strict';

  // https://www.linkedin.com/learning/<course-slug>/<lesson-slug>
  const LESSON_RE = /^https?:\/\/www\.linkedin\.com\/learning\/([^/?#]+)\/([^/?#]+)/i;

  let lastHref = '';
  let current = null;
  let seq = 0;
  let activeRequestId = null;
  let captures = [];
  let availableLanguages = ['en'];
  let pageIdentity = '';
  let batchState = null;
  let activeBatchKey = '';
  let playTimer = null;
  let batchTimer = null;

  const host = document.createElement('div');
  host.id = 'lls-host';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>
  :host { all: initial; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .fab {
    position: fixed; right: 24px; bottom: 24px; z-index: 2147483000;
    display: flex; align-items: center; gap: 8px;
    padding: 11px 16px; border: 0; border-radius: 26px;
    background: #0a66c2; color: #fff; font-size: 14px; font-weight: 600;
    cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.28);
  }
  .fab:hover { background: #004182; }
  .fab svg { width: 18px; height: 18px; fill: currentColor; }
  .panel {
    position: fixed; right: 24px; bottom: 78px; z-index: 2147483000;
    width: 330px; box-sizing: border-box; padding: 16px;
    border-radius: 12px; background: #fff; color: #1d2226;
    box-shadow: 0 10px 34px rgba(0,0,0,.3); border: 1px solid #e0e0e0;
  }
  .panel[hidden] { display: none; }
  h2 { margin: 0 22px 4px 0; font-size: 15px; line-height: 1.35; }
  .meta { margin: 0 0 10px; font-size: 12px; color: #6b7280; word-break: break-word; }
  .stream {
    margin: 0 0 14px; padding: 8px 10px; border-radius: 6px;
    background: #f3f6f9; font-size: 11px; line-height: 1.4; color: #415563;
  }
  label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px; }
  select {
    width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px;
    background: #fff; font-size: 13px; margin-bottom: 12px;
  }
  .dl {
    width: 100%; padding: 10px; border: 0; border-radius: 6px;
    background: #0a66c2; color: #fff; font-weight: 600; cursor: pointer; font-size: 13px;
  }
  .dl:hover { background: #004182; }
  .dl:disabled { opacity: .6; cursor: wait; }
  .batch {
    width: 100%; margin-top: 8px; padding: 10px; border: 1px solid #0a66c2;
    border-radius: 6px; background: #fff; color: #0a66c2; font-weight: 600;
    cursor: pointer; font-size: 13px;
  }
  .batch:hover { background: #eef6fd; }
  .batch:disabled { opacity: .6; cursor: wait; }
  .stop {
    width: 100%; margin-top: 8px; padding: 9px; border: 0;
    border-radius: 6px; background: #b91c1c; color: #fff;
    font-weight: 600; cursor: pointer; font-size: 12px;
  }
  .options {
    margin: 0 0 12px; padding: 10px; border: 1px solid #e5e7eb;
    border-radius: 6px; background: #fafafa;
  }
  .options-title { margin: 0 0 7px; font-size: 11px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: .04em; }
  .check { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; font-size: 12px; font-weight: 500; color: #374151; cursor: pointer; }
  .check input { width: 14px; height: 14px; margin: 0; accent-color: #0a66c2; }
  .langs { margin: 8px 0 0 21px; padding-top: 8px; border-top: 1px dashed #d1d5db; }
  .langs:empty { display: none; }
  .status { margin-top: 10px; font-size: 12px; line-height: 1.45; color: #4b5563; }
  .status.error { color: #b91c1c; }
  .status.ok { color: #047857; }
  .status.working { color: #0a66c2; }
  .close {
    position: absolute; top: 8px; right: 10px; border: 0;
    background: none; font-size: 18px; cursor: pointer; color: #9ca3af;
  }
  .hint { margin-top: 12px; font-size: 11px; color: #9ca3af; }
</style>
<div class="fab" title="Save the stream this lesson is playing">
  <svg viewBox="0 0 24 24"><path d="M12 3v10.6l3.3-3.3 1.4 1.4-5.7 5.7-5.7-5.7 1.4-1.4 3.3 3.3V3h2zm-7 16h14v2H5v-2z"/></svg>
  <span>Save lesson</span>
</div>
<div class="panel" hidden>
  <button class="close" title="Close">×</button>
  <h2 class="title">Lesson</h2>
  <p class="meta">LinkedIn Learning</p>
  <p class="stream">Waiting for the player…</p>
  <p class="course">Course playlist: scanning…</p>
  <div class="options">
    <p class="options-title">Download</p>
    <label class="check"><input type="checkbox" class="opt-video" checked> Video</label>
    <label class="check"><input type="checkbox" class="opt-subs" checked> Subtitles</label>
    <div class="langs"></div>
  </div>
  <label for="q">Preferred quality (master playlist only)</label>
  <select id="q">
    <option value="0">Highest available</option>
    <option value="720">720p</option>
    <option value="540">540p</option>
    <option value="360">360p</option>
  </select>
  <button class="dl">Save stream</button>
  <button class="batch">Save whole course</button>
  <button class="stop" hidden>Stop batch</button>
  <div class="status"></div>
  <div class="hint">Start the video first. For your own subscribed courses only.</div>
</div>`;

  const fab = root.querySelector('.fab');
  const panel = root.querySelector('.panel');
  const titleEl = root.querySelector('.title');
  const metaEl = root.querySelector('.meta');
  const streamEl = root.querySelector('.stream');
  const courseEl = root.querySelector('.course');
  const videoOpt = root.querySelector('.opt-video');
  const subsOpt = root.querySelector('.opt-subs');
  const langsEl = root.querySelector('.langs');
  const qualityEl = root.querySelector('#q');
  const dlBtn = root.querySelector('.dl');
  const batchBtn = root.querySelector('.batch');
  const stopBtn = root.querySelector('.stop');
  const statusEl = root.querySelector('.status');
  const closeBtn = root.querySelector('.close');

  (document.body || document.documentElement).appendChild(host);

  function setStatus(text, kind) {
    statusEl.textContent = text || '';
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  function requestCaptures(callback) {
    try {
      chrome.runtime.sendMessage({ type: 'lls:getCaptures' }, (resp) => {
        if (chrome.runtime.lastError) {
          captures = [];
        } else if (resp && resp.ok) {
          captures = resp.items || [];
          const languages = dedupeList(['en'].concat(resp.languages || []));
          if (languages.join('|') !== availableLanguages.join('|')) {
            const previous = downloadOptions().subtitleLanguages;
            availableLanguages = languages;
            renderLanguages(previous);
          }
        }
        updateStreamStatus();
        if (callback) callback();
      });
    } catch (_) {
      captures = [];
      updateStreamStatus();
      if (callback) callback();
    }
  }

  function streamInfo() {
    const playlists = captures.filter((item) => item.kind === 'playlist' || item.kind === 'candidate')
      .slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const segments = captures.filter((item) => item.kind === 'segment')
      .slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
    let resolution = '';
    for (const item of playlists.concat(segments)) {
      const match = String(item.url).match(/hls-(\d+)p/i);
      if (match) {
        resolution = match[1] + 'p';
        break;
      }
    }
    return { playlists, segments, resolution };
  }

  function updateStreamStatus() {
    const info = streamInfo();
    if (info.playlists.length) {
      streamEl.textContent = 'Stream detected' + (info.resolution ? ' (' + info.resolution + ')' : '') +
        ': ' + info.playlists.length + ' playlist' + (info.playlists.length === 1 ? '' : 's') + ' ready.';
    } else if (info.segments.length) {
      streamEl.textContent = 'Video segments seen (' + info.segments.length + '). Let the video start to capture its playlist.';
    } else {
      streamEl.textContent = 'Waiting for the player… Start the lesson video.';
    }
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function safeDecode(value) {
    try { return decodeURIComponent(value || ''); } catch (_) { return String(value || ''); }
  }

  function isNonVideoLesson(slug, label) {
    const raw = safeDecode(slug).toLowerCase();
    const text = (raw + ' ' + String(label || '')).toLowerCase();
    return /(^|[^a-z])(quiz|quizzes|assessment|knowledge[ -]?check|exam)([^a-z]|$)/.test(text) ||
      /(^|[-_])(quiz|assessment|knowledge-check|exam)([-_]|$)/.test(raw);
  }

  function cleanSectionText(element) {
    return String(element.textContent || element.getAttribute('aria-label') || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
  }

  function isSectionHeader(element, courseSlug) {
    if (!element || element === document.body || element === document.documentElement) return false;

    const explicitHeading = /^H[1-6]$/.test(element.tagName) ||
      element.getAttribute('role') === 'heading' ||
      element.hasAttribute('aria-expanded');
    if (!explicitHeading) {
      const hint = String(element.className || '') + ' ' +
        String(element.getAttribute('data-test') || '') + ' ' +
        String(element.getAttribute('data-test-id') || '');
      if (!/(section|module|chapter|courseitemgroup)/i.test(hint)) return false;
    }

    const text = cleanSectionText(element);
    if (!text || text.length > 80) return false;
    if (/^(course content|table of contents|contents?|lessons?|videos?)$/i.test(text)) return false;

    const lessonRe = new RegExp('^https?://www\\.linkedin\\.com/learning/' +
      escapeRegExp(courseSlug) + '/[^/?#]+/?$', 'i');
    for (const anchor of element.querySelectorAll('a[href]')) {
      if (lessonRe.test(anchor.href)) return false;
    }
    return true;
  }

  function sectionForAnchor(anchor, courseSlug) {
    let node = anchor;
    for (let depth = 0; depth < 8 && node; depth++) {
      let sibling = node.previousElementSibling;
      while (sibling) {
        if (isSectionHeader(sibling, courseSlug)) return cleanSectionText(sibling);

        const nested = sibling.querySelectorAll(
          'h2,h3,h4,h5,h6,[role="heading"],button[aria-expanded],' +
          '[class*="section" i],[class*="module" i],[class*="chapter" i],' +
          '[data-test*="section" i],[data-test*="module" i]'
        );
        for (let i = nested.length - 1; i >= 0; i--) {
          if (isSectionHeader(nested[i], courseSlug)) return cleanSectionText(nested[i]);
        }
        sibling = sibling.previousElementSibling;
      }
      node = node.parentElement;
    }
    return '';
  }

  function collectLessons() {
    if (!current) return [];
    const slug = escapeRegExp(current.courseSlug);
    const re = new RegExp('^https?://www\\.linkedin\\.com/learning/' + slug + '/([^/?#]+)/?$', 'i');
    const seen = new Set();
    const out = [];
    const counters = new Map();

    document.querySelectorAll('a[href]').forEach((anchor) => {
      const href = anchor.href;
      const match = href.match(re);
      if (!match) return;

      let clean;
      try {
        const url = new URL(href);
        clean = url.origin + url.pathname.replace(/\/+$/, '');
      } catch (_) {
        clean = String(href).split(/[?#]/)[0].replace(/\/+$/, '');
      }
      if (seen.has(clean)) return;

      const lessonSlug = safeDecode(match[1]);
      const label = (anchor.textContent || anchor.getAttribute('aria-label') || anchor.title || '')
        .trim().replace(/\s+/g, ' ');
      if (isNonVideoLesson(lessonSlug, label)) return;
      seen.add(clean);

      const section = sectionForAnchor(anchor, current.courseSlug);
      const key = section || '__unsectioned__';
      const order = (counters.get(key) || 0) + 1;
      counters.set(key, order);
      out.push({
        url: clean,
        title: label.slice(0, 110) || lessonSlug.replace(/-/g, ' '),
        slug: lessonSlug,
        section: section,
        order: order,
      });
    });

    const currentUrl = location.origin + location.pathname.replace(/\/+$/, '');
    if (!seen.has(currentUrl) && !isNonVideoLesson(current.videoSlug, current.title)) {
      out.unshift({
        url: currentUrl,
        title: current.title,
        slug: current.videoSlug,
        section: current.section || '',
        order: current.order || 1,
      });
    }
    return out;
  }

  function annotateCurrent() {
    if (!current) return;
    const mine = collectLessons().find((lesson) => {
      try {
        return new URL(lesson.url).pathname.replace(/\/+$/, '') ===
          location.pathname.replace(/\/+$/, '');
      } catch (_) {
        return false;
      }
    });
    if (mine) {
      current.section = mine.section;
      current.order = mine.order;
    }
  }

  function updateCourseInfo() {
    if (!current) {
      courseEl.textContent = '';
      return;
    }
    const lessons = collectLessons();
    const sections = new Set(lessons.map((lesson) => lesson.section).filter(Boolean));
    const noun = lessons.length === 1 ? 'video' : 'videos';
    const sectionText = sections.size
      ? ' in ' + sections.size + ' section' + (sections.size === 1 ? '' : 's')
      : '';
    courseEl.textContent = 'Course playlist: ' + lessons.length + ' ' + noun + sectionText + '.';
  }

  const LANG_LABELS = {
    en: 'English', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian',
    pt: 'Portuguese', nl: 'Dutch', sv: 'Swedish', da: 'Danish', no: 'Norwegian',
    fi: 'Finnish', pl: 'Polish', ru: 'Russian', tr: 'Turkish', ja: 'Japanese',
    ko: 'Korean', zh: 'Chinese', ar: 'Arabic', hi: 'Hindi', id: 'Indonesian',
    vi: 'Vietnamese', th: 'Thai', cs: 'Czech', el: 'Greek', he: 'Hebrew',
    ro: 'Romanian', uk: 'Ukrainian',
  };

  function dedupeList(list) {
    const seen = new Set();
    const out = [];
    for (const value of list || []) {
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
    return out;
  }

  function downloadOptions() {
    return {
      downloadVideo: videoOpt.checked,
      downloadSubtitles: subsOpt.checked,
      subtitleLanguages: Array.from(langsEl.querySelectorAll('input:checked'))
        .map((input) => input.value),
    };
  }

  function renderLanguages(preferred) {
    const codes = dedupeList(['en'].concat(availableLanguages || []));
    const checked = new Set(preferred && preferred.length ? preferred : ['en']);
    langsEl.textContent = '';
    codes.forEach((code) => {
      const label = document.createElement('label');
      label.className = 'check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = code;
      input.checked = checked.has(code);
      input.addEventListener('change', savePrefs);
      label.appendChild(input);
      label.appendChild(document.createTextNode(' ' + (LANG_LABELS[code] || code)));
      langsEl.appendChild(label);
    });
  }

  function savePrefs() {
    const options = downloadOptions();
    chrome.storage.sync.set({
      downloadVideo: options.downloadVideo,
      downloadSubtitles: options.downloadSubtitles,
      subtitleLanguages: options.subtitleLanguages,
    });
  }

  function extractIdentity() {
    let decoded = '';
    try {
      const decoder = document.createElement('textarea');
      decoder.innerHTML = document.documentElement.outerHTML;
      decoded = decoder.value;
    } catch (_) {
      decoded = document.documentElement.outerHTML;
    }
    let match = decoded.match(/"enterpriseProfileHash"\s*:\s*"([^"]+)"/i) ||
      decoded.match(/enterpriseProfileHash[^A-Za-z0-9+/=_-]{0,24}([A-Za-z0-9+/=_-]{20,})/i);
    if (match) return match[1];
    match = decoded.match(/"enterpriseProfile"\s*:\s*"(urn:li:enterpriseProfile:[^"\\]+)"/i);
    if (match) {
      try { return btoa(match[1]); } catch (_) { return ''; }
    }
    return '';
  }

  function sendRuntime(message, callback) {
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        if (chrome.runtime.lastError) {
          if (callback) callback(null);
          return;
        }
        if (callback) callback(resp);
      });
    } catch (_) {
      if (callback) callback(null);
    }
  }

  function tryAutoPlay() {
    const video = document.querySelector('video');
    if (video) {
      video.muted = true;
      video.defaultMuted = true;
      try {
        const playing = video.play();
        if (playing && typeof playing.catch === 'function') playing.catch(() => {});
      } catch (_) {
        /* ignore */
      }
      if (!video.paused) {
        stopAutoPlay();
        return;
      }
    }

    const buttons = Array.from(document.querySelectorAll('button,[role="button"]'));
    const playButton = buttons.find((element) => {
      const text = ((element.getAttribute('aria-label') || '') + ' ' +
        (element.title || '') + ' ' + (element.textContent || '')).toLowerCase();
      return /\bplay\b/.test(text);
    });
    if (playButton) {
      try { playButton.click(); } catch (_) { /* ignore */ }
    }
  }

  function startAutoPlay() {
    if (playTimer) return;
    tryAutoPlay();
    playTimer = setInterval(tryAutoPlay, 900);
  }

  function stopAutoPlay() {
    if (playTimer) {
      clearInterval(playTimer);
      playTimer = null;
    }
  }

  function showNormalButtons() {
    stopBtn.hidden = true;
    dlBtn.disabled = false;
    batchBtn.disabled = false;
    activeBatchKey = '';
  }

  function sendBatchDownload(batch, lesson) {
    const requestId = 'lls-' + Date.now() + '-' + (++seq);
    activeRequestId = requestId;
    setStatus('Batch ' + (batch.index + 1) + '/' + batch.lessons.length + ': saving stream…', 'working');

    sendRuntime({
      type: 'lls:download',
      requestId: requestId,
      batch: true,
      batchIndex: batch.index,
      section: lesson.section || (current && current.section) || '',
      order: lesson.order || batch.index + 1,
      title: lesson.title || (current && current.title) || 'lesson',
      courseTitle: batch.courseTitle || (current && current.courseTitle) || '',
      courseSlug: batch.courseSlug || (current && current.courseSlug) || '',
      videoSlug: lesson.slug || (current && current.videoSlug) || '',
      resolution: batch.resolution || Number(qualityEl.value) || 0,
      identity: batch.identity || pageIdentity,
      downloadVideo: batch.downloadVideo !== false,
      downloadSubtitles: !!batch.downloadSubtitles,
      subtitleLanguages: (batch.subtitleLanguages || []).slice(),
    }, (resp) => {
      activeRequestId = null;
      if (!resp || !resp.ok) {
        setStatus('Batch lesson failed: ' + ((resp && resp.error) || 'unknown error'), 'error');
      } else {
        const saved = resp.filename || (resp.subtitleFiles || [])
          .map((file) => file.label).join(', ') || 'lesson';
        setStatus('Batch saved: ' + saved + (resp.subtitleError ? ' (' + resp.subtitleError + ')' : ''),
          resp.subtitleError ? 'working' : 'ok');
      }
    });
  }

  function runBatchLesson(batch) {
    const batchKey = batch.tabId + ':' + batch.index + ':' + batch.startedAt;
    if (activeBatchKey === batchKey) return;
    activeBatchKey = batchKey;

    batchState = batch;
    stopBtn.hidden = false;
    dlBtn.disabled = true;
    batchBtn.disabled = true;

    const lesson = batch.lessons[batch.index] || { title: (current && current.title) || 'Lesson' };
    titleEl.textContent = lesson.title;
    metaEl.textContent = batch.courseTitle || (current && current.courseTitle) || 'LinkedIn Learning';
    setStatus('Batch ' + (batch.index + 1) + '/' + batch.lessons.length + ': ' + lesson.title, 'working');
    startAutoPlay();

    if (batch.downloadVideo === false) {
      // Subtitle-only batches still need the player to load, so wait for a
      // caption asset (or fall back to the transcript API after a short wait).
      const captionStarted = Date.now();
      const captionTimer = setInterval(() => {
        if (batchState !== batch || !batch.active) {
          clearInterval(captionTimer);
          return;
        }
        requestCaptures(() => {
          const ready = captures.some((item) => item.kind === 'caption');
          if (!ready && Date.now() - captionStarted < 6000) return;
          clearInterval(captionTimer);
          stopAutoPlay();
          if (batchState === batch) sendBatchDownload(batch, lesson);
        });
      }, 1000);
      return;
    }

    const started = Date.now();
    if (batchTimer) clearInterval(batchTimer);
    batchTimer = setInterval(() => {
      requestCaptures(() => {
        const info = streamInfo();
        if (info.playlists.length) {
          clearInterval(batchTimer);
          batchTimer = null;
          stopAutoPlay();
          sendBatchDownload(batch, lesson);
        } else if (Date.now() - started > 45000) {
          clearInterval(batchTimer);
          batchTimer = null;
          stopAutoPlay();
          sendRuntime({
            type: 'lls:batch-failed',
            title: lesson.title,
            error: 'No stream was detected for this lesson.',
          });
        }
      });
    }, 1000);
  }

  function checkBatchState() {
    sendRuntime({ type: 'lls:getBatch' }, (resp) => {
      const batch = resp && resp.batch;
      if (!batch) {
        batchState = null;
        showNormalButtons();
        return;
      }

      if (batch.status === 'done') {
        const ok = (batch.results || []).filter((item) => item.ok).length;
        const failed = (batch.results || []).length - ok;
        setStatus('Batch complete: ' + ok + ' saved, ' + failed + ' failed.', ok ? 'ok' : 'error');
        batchState = null;
        showNormalButtons();
        sendRuntime({ type: 'lls:batch-clear' });
        return;
      }

      if (batch.active) runBatchLesson(batch);
      else {
        batchState = null;
        showNormalButtons();
      }
    });
  }

  function readPage() {
    const match = location.href.match(LESSON_RE);
    if (!match) return null;

    const parts = document.title.split('|').map((s) => s.trim()).filter(Boolean);
    const h1 = document.querySelector('h1') && document.querySelector('h1').textContent.trim();
    const title = h1 || parts[0] || 'Lesson';
    let courseTitle = parts.length > 2 ? parts[1] : '';
    if (!courseTitle && parts.length === 2 && !/learning/i.test(parts[1])) courseTitle = parts[1];

    return {
      courseSlug: decodeURIComponent(match[1]),
      videoSlug: decodeURIComponent(match[2]),
      title: title,
      courseTitle: courseTitle || match[1].replace(/-/g, ' '),
      section: '',
      order: null,
    };
  }

  function refresh() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    captures = [];
    current = readPage();
    pageIdentity = extractIdentity();
    annotateCurrent();

    try {
      chrome.runtime.sendMessage({ type: 'lls:page', url: location.href }, () => {
        if (chrome.runtime.lastError) return;
      });
    } catch (_) {
      /* background not ready yet */
    }

    const visible = !!current;
    fab.style.display = visible ? 'flex' : 'none';
    if (!visible) {
      panel.hidden = true;
      return;
    }

    titleEl.textContent = current.title;
    metaEl.textContent = current.courseTitle;
    setStatus('');
    updateStreamStatus();
    updateCourseInfo();
    requestCaptures();
    checkBatchState();
  }

  fab.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      requestCaptures();
      updateCourseInfo();
    }
  });
  closeBtn.addEventListener('click', () => { panel.hidden = true; });

  // Show English immediately, then let saved preferences replace it.
  renderLanguages(['en']);
  chrome.storage.sync.get([
    'resolution', 'downloadVideo', 'downloadSubtitles', 'subtitleLanguages',
  ], (s) => {
    const value = Number(s.resolution == null ? 0 : s.resolution);
    qualityEl.value = [0, 720, 540, 360].includes(value) ? String(value) : '0';
    videoOpt.checked = s.downloadVideo !== false;
    subsOpt.checked = s.downloadSubtitles !== false;
    availableLanguages = dedupeList(['en'].concat(s.subtitleLanguages || []));
    renderLanguages(s.subtitleLanguages || ['en']);
  });
  qualityEl.addEventListener('change', () => {
    chrome.storage.sync.set({ resolution: Number(qualityEl.value) });
  });
  videoOpt.addEventListener('change', savePrefs);
  subsOpt.addEventListener('change', savePrefs);

  dlBtn.addEventListener('click', () => {
    if (!current || (batchState && batchState.active)) return;

    const requestId = 'lls-' + Date.now() + '-' + (++seq);
    activeRequestId = requestId;
    dlBtn.disabled = true;
    setStatus('Reading captured stream…', 'working');

    requestCaptures(() => {
      const info = streamInfo();
      const options = downloadOptions();
      if (!options.downloadVideo && !options.downloadSubtitles) {
        dlBtn.disabled = false;
        activeRequestId = null;
        setStatus('Select Video or Subtitles to download.', 'error');
        return;
      }
      if (options.downloadVideo && !info.playlists.length && !info.segments.length) {
        dlBtn.disabled = false;
        activeRequestId = null;
        setStatus('No stream captured yet. Start the video, wait a few seconds, then try again.', 'error');
        return;
      }

      chrome.runtime.sendMessage(Object.assign({
        type: 'lls:download',
        requestId: requestId,
        title: current.title,
        courseTitle: current.courseTitle,
        courseSlug: current.courseSlug,
        videoSlug: current.videoSlug,
        section: current.section || '',
        order: current.order || '',
        resolution: Number(qualityEl.value) || 0,
        identity: pageIdentity,
      }, options), (resp) => {
        dlBtn.disabled = false;
        activeRequestId = null;
        if (chrome.runtime.lastError) {
          setStatus('Extension error: ' + chrome.runtime.lastError.message, 'error');
          return;
        }
        if (resp && resp.ok) {
          const parts = [];
          if (resp.filename) {
            parts.push('Saved ' + String(resp.ext || 'video').toUpperCase() +
              (resp.resolution ? ' (' + resp.resolution + ')' : '') + ': ' + resp.filename);
          }
          if (resp.subtitleFiles && resp.subtitleFiles.length) {
            parts.push('Subtitles: ' + resp.subtitleFiles
              .map((file) => file.label).join(', '));
          }
          if (resp.subtitleError) parts.push('Subtitle warning: ' + resp.subtitleError);
          setStatus(parts.join(' · ') || 'Saved.', resp.subtitleError ? 'working' : 'ok');
        } else {
          setStatus((resp && resp.error) || 'Download failed.', 'error');
        }
      });
    });
  });

  batchBtn.addEventListener('click', () => {
    if (!current || (batchState && batchState.active)) return;

    const lessons = collectLessons();
    if (!lessons.length) {
      setStatus('No course lessons were found on this page.', 'error');
      return;
    }

    batchBtn.disabled = true;
    sendRuntime({
      type: 'lls:batch-start',
      lessons: lessons,
      courseSlug: current.courseSlug,
      courseTitle: current.courseTitle,
      returnUrl: location.href,
      resolution: Number(qualityEl.value) || 0,
      identity: pageIdentity,
      downloadVideo: videoOpt.checked,
      downloadSubtitles: subsOpt.checked,
      subtitleLanguages: downloadOptions().subtitleLanguages,
    }, (resp) => {
      batchBtn.disabled = false;
      if (!resp || !resp.ok) {
        setStatus((resp && resp.error) || 'Could not start the batch.', 'error');
        return;
      }
      setStatus('Starting batch: ' + resp.count + ' lessons…', 'working');
    });
  });

  stopBtn.addEventListener('click', () => {
    setStatus('Stopping batch…', 'working');
    sendRuntime({ type: 'lls:batch-stop' });
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'lls:progress') return;
    if (msg.requestId && msg.requestId !== activeRequestId) return;
    setStatus(msg.message, msg.state);
  });

  setInterval(() => {
    refresh();
    if (!panel.hidden) requestCaptures();
  }, 1200);
  refresh();
})();
