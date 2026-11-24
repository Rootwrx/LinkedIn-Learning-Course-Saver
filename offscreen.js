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

    const buffers = new Array(urls.length);
    let next = 0;
    let done = 0;
    let failure = null;

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

    async function worker() {
      while (!failure) {
        const index = next++;
        if (index >= urls.length) return;
        try {
          const response = await fetch(urls[index], { credentials: 'include', cache: 'no-store' });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          buffers[index] = await response.arrayBuffer();
        } catch (error) {
          failure = error;
          return;
        }
        done++;
        if (done % 10 === 0 || done === urls.length) {
          report('Downloading stream (' + done + '/' + urls.length + ')…');
        }
      }
    }

    try {
      const workers = [];
      const count = Math.min(4, urls.length);
      for (let i = 0; i < count; i++) workers.push(worker());
      await Promise.all(workers);

      if (failure) {
        const status = failure.status ? ' HTTP ' + failure.status : '';
        throw new Error('Stream download failed.' + status + ' Reload the lesson page and retry.');
      }

      const blob = new Blob(buffers, { type: msg.mime || 'application/octet-stream' });
      const blobUrl = URL.createObjectURL(blob);

      // Keep the blob alive long enough for the download manager to read it.
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
  })();

  return true; // async response
});
