(() => {
  'use strict';

  // https://www.linkedin.com/learning/<course-slug>/<lesson-slug>
  const LESSON_RE = /^https?:\/\/www\.linkedin\.com\/learning\/([^/?#]+)\/([^/?#]+)/i;

  let lastHref = '';
  let current = null;
  let seq = 0;
  let activeRequestId = null;
  let captures = [];
  let batchState = null;
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

  function collectLessons() {
    if (!current) return [];
    const slug = escapeRegExp(current.courseSlug);
    const re = new RegExp('^https?://www\\.linkedin\\.com/learning/' + slug + '/([^/?#]+)', 'i');
    const seen = new Set();
    const out = [];

    document.querySelectorAll('a[href]').forEach((anchor) => {
      const href = anchor.href;
      const match = href.match(re);
      if (!match) return;

      let clean;
      try {
        const url = new URL(href);
        clean = url.origin + url.pathname;
      } catch (_) {
        clean = String(href).split(/[?#]/)[0];
      }
      if (seen.has(clean)) return;
      seen.add(clean);

      const label = (anchor.textContent || anchor.getAttribute('aria-label') || anchor.title || '')
        .trim().replace(/\s+/g, ' ');
      out.push({
        url: clean,
        title: label.slice(0, 110) || decodeURIComponent(match[1]).replace(/-/g, ' '),
        slug: decodeURIComponent(match[1]),
      });
    });

    const currentUrl = location.origin + location.pathname;
    if (!seen.has(currentUrl)) {
      out.unshift({ url: currentUrl, title: current.title, slug: current.videoSlug });
    }
    return out;
  }

  function updateCourseInfo() {
    if (!current) {
      courseEl.textContent = '';
      return;
    }
    const count = collectLessons().length;
    courseEl.textContent = 'Course playlist: ' + count + ' lesson' + (count === 1 ? '' : 's') + ' found.';
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
      order: batch.index + 1,
      title: lesson.title || (current && current.title) || 'lesson',
      courseTitle: batch.courseTitle || (current && current.courseTitle) || '',
      courseSlug: batch.courseSlug || (current && current.courseSlug) || '',
      resolution: batch.resolution || Number(qualityEl.value) || 0,
    }, (resp) => {
      activeRequestId = null;
      if (!resp || !resp.ok) {
        setStatus('Batch lesson failed: ' + ((resp && resp.error) || 'unknown error'), 'error');
      } else {
        setStatus('Batch saved: ' + resp.filename, 'ok');
      }
    });
  }

  function runBatchLesson(batch) {
    batchState = batch;
    stopBtn.hidden = false;
    dlBtn.disabled = true;
    batchBtn.disabled = true;

    const lesson = batch.lessons[batch.index] || { title: (current && current.title) || 'Lesson' };
    titleEl.textContent = lesson.title;
    metaEl.textContent = batch.courseTitle || (current && current.courseTitle) || 'LinkedIn Learning';
    setStatus('Batch ' + (batch.index + 1) + '/' + batch.lessons.length + ': ' + lesson.title, 'working');
    startAutoPlay();

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
    };
  }

  function refresh() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    captures = [];
    current = readPage();

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

  chrome.storage.sync.get(['resolution'], (s) => {
    const value = Number(s.resolution == null ? 0 : s.resolution);
    qualityEl.value = [0, 720, 540, 360].includes(value) ? String(value) : '0';
  });
  qualityEl.addEventListener('change', () => {
    chrome.storage.sync.set({ resolution: Number(qualityEl.value) });
  });

  dlBtn.addEventListener('click', () => {
    if (!current || (batchState && batchState.active)) return;

    const requestId = 'lls-' + Date.now() + '-' + (++seq);
    activeRequestId = requestId;
    dlBtn.disabled = true;
    setStatus('Reading captured stream…', 'working');

    requestCaptures(() => {
      const info = streamInfo();
      if (!info.playlists.length && !info.segments.length) {
        dlBtn.disabled = false;
        activeRequestId = null;
        setStatus('No stream captured yet. Start the video, wait a few seconds, then try again.', 'error');
        return;
      }

      chrome.runtime.sendMessage({
        type: 'lls:download',
        requestId: requestId,
        title: current.title,
        courseTitle: current.courseTitle,
        courseSlug: current.courseSlug,
        videoSlug: current.videoSlug,
        resolution: Number(qualityEl.value) || 0,
      }, (resp) => {
        dlBtn.disabled = false;
        activeRequestId = null;
        if (chrome.runtime.lastError) {
          setStatus('Extension error: ' + chrome.runtime.lastError.message, 'error');
          return;
        }
        if (resp && resp.ok) {
          const res = resp.resolution ? ' (' + resp.resolution + ')' : '';
          setStatus('Saved ' + String(resp.ext || 'video').toUpperCase() + res + ': ' + resp.filename, 'ok');
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
