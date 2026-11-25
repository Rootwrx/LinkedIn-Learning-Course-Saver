'use strict';

// Offscreen document: a real DOM context, so it can create blob URLs for large files.
// Per Chrome's offscreen API restrictions, chrome.runtime is the only extension
// API available here. The service worker performs the actual download.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'lls:assemble') return false;

  (async () => {
    if (typeof msg.text === 'string') {
      try {
        const blob = new Blob([msg.text], { type: msg.mime || 'application/x-subrip' });
        const blobUrl = URL.createObjectURL(blob);
        setTimeout(() => {
          try { URL.revokeObjectURL(blobUrl); } catch (_) { /* already gone */ }
        }, 60000);
        sendResponse({ ok: true, blobUrl: blobUrl, bytes: blob.size });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error && error.message ? error.message : String(error),
        });
      }
      return;
    }

    const urls = Array.isArray(msg.urls) ? msg.urls : [];
    if (!urls.length) {
      sendResponse({ ok: false, error: 'No stream parts were provided.' });
      return;
    }

    // Segments are small, so latency (not bandwidth) is the bottleneck.
    // Many parallel requests keep the connection saturated.
    const CONCURRENCY = 16;
    const MAX_RETRIES = 3;
    const SEGMENT_TIMEOUT_MS = 30000;

    const parts = new Array(urls.length);
    let next = 0;
    let done = 0;
    let loadedBytes = 0;
    let failure = null;
    let lastReport = 0;

    function report(message, state) {
      try {
        const result = chrome.runtime.sendMessage({
          type: 'lls:assemble-progress',
          requestId: msg.requestId,
          tabId: msg.tabId,
          message: message,
          state: state || 'working',
        });
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch (_) {
        /* worker may be restarting */
      }
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function fetchPart(url) {
      let lastError = null;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SEGMENT_TIMEOUT_MS);
        try {
          const response = await fetch(url, {
            credentials: 'include',
            signal: controller.signal,
          });
          if (!response.ok) {
            const error = new Error('HTTP ' + response.status);
            error.status = response.status;
            // Expired/forbidden links will not recover by retrying.
            if (response.status === 401 || response.status === 403 || response.status === 404) {
              error.fatal = true;
            }
            throw error;
          }
          // Blob lets the browser keep data off the JS heap.
          return await response.blob();
        } catch (error) {
          lastError = error;
          if (error.fatal) break;
          if (attempt < MAX_RETRIES) await sleep(300 * Math.pow(2, attempt));
        } finally {
          clearTimeout(timer);
        }
      }
      throw lastError || new Error('Segment download failed');
    }

    async function worker() {
      while (!failure) {
        const index = next++;
        if (index >= urls.length) return;
        try {
          const part = await fetchPart(urls[index]);
          parts[index] = part;
          loadedBytes += part.size;
        } catch (error) {
          failure = error;
          return;
        }
        done++;
        const now = Date.now();
        if (done === urls.length || now - lastReport > 500) {
          lastReport = now;
          const mb = (loadedBytes / 1048576).toFixed(1);
          report('Downloading stream (' + done + '/' + urls.length + ', ' + mb + ' MB)…');
        }
      }
    }

    try {
      const workers = [];
      const count = Math.min(CONCURRENCY, urls.length);
      for (let i = 0; i < count; i++) workers.push(worker());
      await Promise.all(workers);

      if (failure) {
        const status = failure.status ? ' HTTP ' + failure.status : '';
        throw new Error('Stream download failed.' + status + ' Reload the lesson page and retry.');
      }

      const blob = new Blob(parts, { type: msg.mime || 'application/octet-stream' });
      const blobUrl = URL.createObjectURL(blob);

      // Keep the blob alive long enough for the download manager to read it.
      setTimeout(() => {
        try { URL.revokeObjectURL(blobUrl); } catch (_) { /* already gone */ }
      }, 600000);

      sendResponse({ ok: true, blobUrl: blobUrl, bytes: blob.size });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error && error.message ? error.message : String(error),
      });
    }
  })();

  return true; // async response
});
