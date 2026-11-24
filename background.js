'use strict';

const MAX_CANDIDATES = 10;

// webRequest sees the player's real playlist URL, including requests made by
// HLS workers that a page-world fetch/XHR hook cannot observe.
const capturesByTab = new Map();
const pageKeyByTab = new Map();

function lessonKey(href) {
  const match = String(href || '').match(/^https?:\/\/www\.linkedin\.com\/learning\/([^/?#]+)\/([^/?#]+)/i);
  return match ? match[1] + '/' + match[2] : '';
}

function captureKind(url) {
  try {
    const u = new URL(url);
    if (/\.m3u8($|\?)/i.test(u.href)) return 'playlist';
    // LinkedIn playlists are served from a path like /hls-720p.../<id>/0/<ts>
    // with no .m3u8 suffix. Treat index 0 as a possible playlist until the
    // response Content-Type confirms it.
    if (/\/0\/\d+(?:\/|$|\?)/.test(u.pathname)) return 'candidate';
    if (/\/\d+\/\d+(?:\/|$|\?)/.test(u.pathname)) return 'segment';
    return 'other';
  } catch (_) {
    return 'other';
  }
}

function isCaptureUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (host !== 'dms.licdn.com' && !host.endsWith('.licdn.com')) return false;
    return /\/playlist\/vid\//i.test(u.pathname) || /\.m3u8($|\?)/i.test(u.href);
  } catch (_) {
    return false;
  }
}

function rememberCapture(tabId, url, kind) {
  if (tabId == null || tabId < 0 || !url || !isCaptureUrl(url)) return;

  let list = capturesByTab.get(tabId);
  if (!list) {
    list = [];
    capturesByTab.set(tabId, list);
  }

  const existing = list.find((item) => item.url === url);
  if (existing) {
    if (kind === 'playlist' && existing.kind !== 'playlist') existing.kind = 'playlist';
    return;
  }

  list.push({ url: url, kind: kind, ts: Date.now() });
  if (list.length > 240) list.splice(0, list.length - 240);
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => rememberCapture(details.tabId, details.url, captureKind(details.url)),
  { urls: ['https://dms.licdn.com/*', 'https://*.licdn.com/*'] },
  []
);

function headerValue(headers, name) {
  if (!Array.isArray(headers)) return '';
  const wanted = name.toLowerCase();
  for (const header of headers) {
    if (header && String(header.name).toLowerCase() === wanted) return String(header.value || '');
  }
  return '';
}

// This is the reliable signal: LinkedIn's HLS playlists have no .m3u8 suffix,
// but they are returned as application/vnd.apple.mpegURL.
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const type = headerValue(details.responseHeaders, 'content-type');
    if (/mpegurl|m3u8/i.test(type)) rememberCapture(details.tabId, details.url, 'playlist');
  },
  { urls: ['https://dms.licdn.com/*', 'https://*.licdn.com/*'] },
  ['responseHeaders']
);

function onLessonNavigation(details) {
  if (details.tabId == null || details.tabId < 0) return;
  const key = lessonKey(details.url);
  if (!pageKeyByTab.has(details.tabId)) {
    pageKeyByTab.set(details.tabId, key);
    return;
  }
  if (pageKeyByTab.get(details.tabId) !== key) {
    pageKeyByTab.set(details.tabId, key);
    capturesByTab.delete(details.tabId);
  }
}

const lessonNavFilter = {
  url: [{ hostEquals: 'www.linkedin.com', pathPrefix: '/learning/' }],
};
chrome.webNavigation.onCommitted.addListener(onLessonNavigation, lessonNavFilter);
chrome.webNavigation.onHistoryStateUpdated.addListener(onLessonNavigation, lessonNavFilter);

function getCaptureUrls(tabId) {
  const items = (capturesByTab.get(tabId) || []).slice().sort((a, b) => b.ts - a.ts);
  const confirmed = items.filter((item) => item.kind === 'playlist').map((item) => item.url);
  const candidates = items.filter((item) => item.kind === 'candidate').map((item) => item.url);
  return {
    // Confirmed playlists first; index-0 URLs are tried as a fallback.
    playlists: dedupe(confirmed.concat(candidates)).slice(0, MAX_CANDIDATES),
    segments: dedupe(items
      .filter((item) => item.kind === 'segment' || item.kind === 'candidate')
      .map((item) => item.url)).slice(0, 12),
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  const prefs = await chrome.storage.sync.get(['resolution', 'folderMode']);
  if (prefs.resolution == null) await chrome.storage.sync.set({ resolution: 0 });
  if (!prefs.folderMode) await chrome.storage.sync.set({ folderMode: 'course' });
});

function safeName(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 110);
}

function notify(tabId, requestId, message, state) {
  if (tabId == null) return;
  try {
    const result = chrome.tabs.sendMessage(tabId, {
      type: 'lls:progress',
      requestId: requestId,
      message: message,
      state: state || 'working',
    });
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (_) {
    /* tab may have been closed */
  }
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const value of list) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function isLicdn(raw) {
  try {
    const u = new URL(String(raw));
    return u.protocol === 'https:' && (u.hostname === 'dms.licdn.com' || u.hostname.endsWith('.licdn.com'));
  } catch (_) {
    return false;
  }
}

function stripQuotes(value) {
  return String(value || '').replace(/^"|"$/g, '').trim();
}

function parseAttrs(fragment) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  let match;
  while ((match = re.exec(fragment))) out[match[1].toUpperCase()] = stripQuotes(match[2]);
  return out;
}

function resolveUrl(uri, baseHref) {
  const u = new URL(uri, baseHref);
  const base = new URL(baseHref);
  // Signed LinkedIn URLs often put the token in the query string only on the
  // parent playlist. Child URIs need to inherit it.
  if (!u.search && base.search) u.search = base.search;
  return u.href;
}

function detectResolution(url) {
  const match = String(url || '').match(/hls-(\d+)p/i);
  return match ? match[1] + 'p' : '';
}

function parsePlaylist(text, url) {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.some((line) => line === '#EXTM3U')) throw new Error('Not an HLS playlist');

  const result = {
    url: url,
    variants: [],
    segments: [],
    mapUri: '',
    encrypted: false,
    byteRange: false,
    isMaster: false,
  };

  let pendingVariant = null;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const attrs = parseAttrs(line.slice(line.indexOf(':') + 1));
      const size = String(attrs.RESOLUTION || '').split('x');
      pendingVariant = {
        bandwidth: Number(attrs.BANDWIDTH || attrs.AVERAGE_BANDWIDTH || 0),
        width: Number(size[0]) || 0,
        height: Number(size[1]) || 0,
      };
      continue;
    }
    if (line.startsWith('#EXT-X-MAP')) {
      const attrs = parseAttrs(line.slice(line.indexOf(':') + 1));
      if (attrs.URI) result.mapUri = resolveUrl(attrs.URI, url);
      continue;
    }
    if (line.startsWith('#EXT-X-KEY')) {
      const attrs = parseAttrs(line.slice(line.indexOf(':') + 1));
      if (attrs.METHOD && attrs.METHOD.toUpperCase() !== 'NONE') result.encrypted = true;
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE')) {
      result.byteRange = true;
      continue;
    }
    if (line.startsWith('#')) continue;

    if (pendingVariant) {
      pendingVariant.url = resolveUrl(line, url);
      result.variants.push(pendingVariant);
      pendingVariant = null;
    } else {
      result.segments.push(resolveUrl(line, url));
    }
  }

  result.isMaster = result.variants.length > 0;
  return result;
}

function pickVariant(variants, wanted) {
  if (!variants.length) return null;
  const withResolution = variants.filter((variant) => variant.height > 0);
  const pool = withResolution.length ? withResolution : variants.slice();

  if (wanted > 0) {
    const exact = pool.filter((variant) => variant.height === wanted);
    if (exact.length) return exact.sort((a, b) => b.bandwidth - a.bandwidth)[0];
    if (withResolution.length) {
      return pool.slice().sort((a, b) => {
        const delta = Math.abs(a.height - wanted) - Math.abs(b.height - wanted);
        return delta || b.bandwidth - a.bandwidth;
      })[0];
    }
  }

  return pool.slice().sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth))[0];
}

function derivePlaylistCandidates(segmentUrls) {
  const out = [];
  for (const raw of segmentUrls.slice(0, 6)) {
    let u;
    try {
      u = new URL(String(raw));
    } catch (_) {
      continue;
    }
    if (!isLicdn(u.href)) continue;

    const parts = u.pathname.split('/').filter(Boolean);
    let cut = parts.length;
    while (cut > 0 && /^\d+$/.test(parts[cut - 1]) && parts.length - cut < 3) cut--;
    if (cut === parts.length) cut = Math.max(0, parts.length - 1);
    const baseParts = parts.slice(0, cut);
    if (!baseParts.length) continue;

    const profile = baseParts.find((part) => /^hls-\d+p/i.test(part)) || '';
    const names = ['playlist.m3u8', 'master.m3u8', 'index.m3u8', 'hls.m3u8'];
    if (profile) names.push(profile + '.m3u8');

    const addCandidate = (pathParts) => {
      if (!pathParts.length) return;
      for (const name of names) {
        const candidate = new URL('/' + pathParts.join('/') + '/' + name, u.origin);
        candidate.search = u.search;
        out.push(candidate.href);
      }
    };

    addCandidate(baseParts);
    if (baseParts.length > 1) addCandidate(baseParts.slice(0, -1));
  }
  return dedupe(out).slice(0, MAX_CANDIDATES);
}

async function fetchText(url) {
  const response = await fetch(url, { credentials: 'include', cache: 'no-store' });
  if (!response.ok) {
    const error = new Error('HTTP ' + response.status);
    error.status = response.status;
    throw error;
  }
  return response.text();
}

async function choosePlaylist(msg, tabId, requestId) {
  const provided = dedupe((msg.playlists || []).filter(isLicdn)).slice(0, MAX_CANDIDATES);
  // Only guess from segments when no real playlist/candidate was observed;
  // LinkedIn's signed tokens are path-specific, so guessed paths 403.
  const derived = provided.length ? [] : derivePlaylistCandidates(msg.segments || []);
  const candidates = dedupe(provided.concat(derived)).slice(0, MAX_CANDIDATES);

  if (!candidates.length) {
    throw new Error('No lesson stream was captured. Start the video, wait a few seconds, then try again.');
  }

  let master = null;
  let media = null;
  let lastError = null;
  let sawExpired = false;

  for (const url of candidates) {
    try {
      const text = await fetchText(url);
      let playlist;
      try {
        playlist = parsePlaylist(text, url);
      } catch (_) {
        continue;
      }
      if (playlist.isMaster) {
        if (!master) master = playlist;
      } else if (!media && playlist.segments.length) {
        media = playlist;
      }
    } catch (error) {
      lastError = error;
      if (error.status === 401 || error.status === 403) sawExpired = true;
    }
  }

  if (master) {
    const variant = pickVariant(master.variants, Number(msg.resolution) || 0);
    if (variant) {
      try {
        notify(tabId, requestId, 'Found ' + (variant.height ? variant.height + 'p ' : '') + 'stream…');
        const text = await fetchText(variant.url);
        const playlist = parsePlaylist(text, variant.url);
        return {
          playlist: playlist,
          resolution: variant.height ? variant.height + 'p' : detectResolution(variant.url),
        };
      } catch (error) {
        lastError = error;
        if (error.status === 401 || error.status === 403) sawExpired = true;
        // A captured media playlist may still be usable if the master variant expired.
        if (media) return { playlist: media, resolution: detectResolution(media.url) };
      }
    }
  }

  if (media) return { playlist: media, resolution: detectResolution(media.url) };

  if (sawExpired) {
    throw new Error('The captured stream URL expired. Reload the lesson page and click Save while the video is playing.');
  }
  throw new Error('Could not open the captured playlist' +
    (lastError ? ' (' + lastError.message + ')' : '') + '. Reload the lesson page and let the video start again.');
}

let offscreenReady = false;
let offscreenCreating = null;

async function ensureOffscreen() {
  if (offscreenReady) return;
  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }

  offscreenCreating = (async () => {
    try {
      if (!chrome.offscreen || typeof chrome.offscreen.createDocument !== 'function') {
        throw new Error('Offscreen documents are unavailable. Use Chrome or Edge 111+.');
      }
      if (typeof chrome.offscreen.hasDocument === 'function') {
        if (await chrome.offscreen.hasDocument()) {
          offscreenReady = true;
          return;
        }
      }
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification: 'Assemble the captured lesson stream into a local video file',
      });
      offscreenReady = true;
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      if (/already exist|only one|offscreen document/i.test(message)) {
        offscreenReady = true;
        return;
      }
      throw new Error('Could not start the local file assembler: ' + message);
    }
  })();

  try {
    await offscreenCreating;
  } finally {
    offscreenCreating = null;
  }
}

function buildFilename(meta, extension, folderMode) {
  const lesson = safeName(meta.title || 'lesson');
  const course = safeName(meta.courseTitle || meta.courseSlug || '');
  const base = course && course.toLowerCase() !== lesson.toLowerCase()
    ? course + ' - ' + lesson
    : lesson;
  const subfolder = folderMode === 'course' && course ? course + '/' : '';
  return subfolder + base + '.' + extension;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;

  const tabId = sender.tab ? sender.tab.id : null;

  if (msg.type === 'lls:page') {
    if (tabId != null) {
      const key = lessonKey(msg.url);
      // On the first message of a tab, keep anything webRequest already saw.
      if (!pageKeyByTab.has(tabId)) {
        pageKeyByTab.set(tabId, key);
      } else if (pageKeyByTab.get(tabId) !== key) {
        pageKeyByTab.set(tabId, key);
        capturesByTab.delete(tabId);
      }
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'lls:getCaptures') {
    sendResponse({
      ok: true,
      items: tabId == null ? [] : (capturesByTab.get(tabId) || []).slice(),
    });
    return false;
  }

  if (msg.type === 'lls:assemble-progress') {
    notify(msg.tabId, msg.requestId, msg.message, msg.state);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type !== 'lls:download') return false;

  (async () => {
    try {
      notify(tabId, msg.requestId, 'Reading captured stream…');

      const prefs = await chrome.storage.sync.get(['folderMode']);
      const fromTab = getCaptureUrls(tabId);
      const request = Object.assign({}, msg, {
        playlists: fromTab.playlists,
        segments: fromTab.segments,
      });
      const chosen = await choosePlaylist(request, tabId, msg.requestId);
      const playlist = chosen.playlist;
      const resolution = chosen.resolution || detectResolution(playlist.url);

      if (playlist.encrypted) {
        throw new Error('This lesson stream is encrypted and cannot be saved locally by this extension.');
      }
      if (playlist.byteRange) {
        throw new Error('This lesson uses byte-range segments, which this extension does not support yet.');
      }

      const extension = playlist.mapUri ? 'mp4' : 'ts';
      const mime = extension === 'mp4' ? 'video/mp4' : 'video/mp2t';
      const urls = (playlist.mapUri ? [playlist.mapUri] : []).concat(playlist.segments);

      if (!urls.length) {
        throw new Error('The captured playlist contains no video segments.');
      }

      const filename = buildFilename(msg, extension, prefs.folderMode || 'course');

      notify(tabId, msg.requestId,
        'Found ' + (resolution ? resolution + ' ' : '') + 'stream. Fetching ' + urls.length + ' parts…');

      await ensureOffscreen();
      const assembled = await chrome.runtime.sendMessage({
        type: 'lls:assemble',
        requestId: msg.requestId,
        tabId: tabId,
        urls: urls,
        filename: filename,
        mime: mime,
      });

      if (!assembled || !assembled.ok) {
        throw new Error((assembled && assembled.error) || 'Could not assemble the video file.');
      }

      if (!chrome.downloads || typeof chrome.downloads.download !== 'function') {
        throw new Error('Downloads API unavailable. Reload the extension and make sure the Downloads permission is enabled.');
      }

      notify(tabId, msg.requestId, 'Starting download…');
      const downloadId = await chrome.downloads.download({
        url: assembled.blobUrl,
        filename: filename,
        conflictAction: 'uniquify',
      });

      sendResponse({
        ok: true,
        downloadId: downloadId,
        filename: filename,
        extension: extension,
        ext: extension,
        bytes: assembled.bytes,
        resolution: resolution,
      });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error && error.message ? error.message : String(error),
      });
    }
  })();

  return true; // keep the message channel open for the async response
});
