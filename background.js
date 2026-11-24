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
    // Caption assets live on the same CDN but must never be treated as an
    // HLS playlist/segment candidate.
    if (/caption|transcript|\.srt($|\?)/i.test(u.pathname) || /\.vtt($|\?)/i.test(u.href)) {
      return 'caption';
    }
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
    return /\/playlist\/vid\//i.test(u.pathname) ||
      /\.m3u8($|\?)/i.test(u.href) ||
      /caption|transcript|\.srt|\.vtt/i.test(u.pathname);
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
  const captions = dedupe(items
    .filter((item) => item.kind === 'caption')
    .map((item) => item.url)).slice(0, 12);
  const tracks = captionTracksFromCaptures(tabId);
  return {
    // Confirmed playlists first; index-0 URLs are tried as a fallback.
    playlists: dedupe(confirmed.concat(candidates)).slice(0, MAX_CANDIDATES),
    segments: dedupe(items
      .filter((item) => item.kind === 'segment' || item.kind === 'candidate')
      .map((item) => item.url)).slice(0, 12),
    captions: captions,
    captionTracks: tracks,
    languages: dedupe(['en'].concat(tracks.map((track) => track.code))),
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

const LANGUAGE_NAMES = {
  en: 'English', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian',
  pt: 'Portuguese', nl: 'Dutch', sv: 'Swedish', da: 'Danish', no: 'Norwegian',
  fi: 'Finnish', pl: 'Polish', ru: 'Russian', tr: 'Turkish', ja: 'Japanese',
  ko: 'Korean', zh: 'Chinese', ar: 'Arabic', hi: 'Hindi', id: 'Indonesian',
  vi: 'Vietnamese', th: 'Thai', cs: 'Czech', el: 'Greek', he: 'Hebrew',
  ro: 'Romanian', uk: 'Ukrainian',
};
const LANGUAGE_ALIASES = {
  eng: 'en', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', spa: 'es',
  ita: 'it', por: 'pt', nld: 'nl', dut: 'nl', swe: 'sv', dan: 'da',
  nor: 'no', fin: 'fi', pol: 'pl', rus: 'ru', tur: 'tr', jpn: 'ja',
  kor: 'ko', zho: 'zh', chi: 'zh', ara: 'ar', hin: 'hi', ind: 'id',
  vie: 'vi', tha: 'th', ces: 'cs', cze: 'cs', ell: 'el', gre: 'el',
  heb: 'he', ron: 'ro', rum: 'ro', ukr: 'uk',
};

function languageInfo(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  const base = raw.split(/[-_]/)[0];
  const code = LANGUAGE_ALIASES[base] || base;
  if (!LANGUAGE_NAMES[code]) return null;
  const region = raw.match(/[-_]([a-z]{2,4})$/);
  return {
    code: code,
    label: LANGUAGE_NAMES[code] + (region ? ' (' + region[1].toUpperCase() + ')' : ''),
  };
}

function languageFromUrl(url) {
  try {
    const u = new URL(url);
    const hints = [];
    for (const key of ['lang', 'language', 'locale', 'hl']) {
      const value = u.searchParams.get(key);
      if (value) hints.push(value);
    }
    const parts = u.pathname.split('/').map((part) => {
      try { return decodeURIComponent(part); } catch (_) { return part; }
    });
    for (const part of parts.reverse()) {
      const match = part.match(/(?:^|[-_.])([a-z]{2,3}(?:[-_][a-z]{2,4})?)(?:$|[-_.])/i);
      if (match) hints.push(match[1]);
    }
    for (const hint of hints) {
      const info = languageInfo(hint);
      if (info) return info;
    }
  } catch (_) {
    /* ignore malformed URLs */
  }
  return { code: 'en', label: 'English' };
}

function dedupeSubtitleTracks(tracks) {
  const seen = new Set();
  const out = [];
  for (const track of tracks || []) {
    if (!track || !track.url) continue;
    const key = track.code + '|' + track.url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(track);
  }
  return out;
}

function captionTracksFromCaptures(tabId) {
  const items = (capturesByTab.get(tabId) || [])
    .filter((item) => item.kind === 'caption')
    .slice()
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const info = languageFromUrl(item.url);
    if (seen.has(info.code)) continue;
    seen.add(info.code);
    out.push({
      code: info.code,
      label: info.label,
      url: item.url,
      kind: 'captured',
    });
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
    subtitles: [],
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
    if (line.startsWith('#EXT-X-MEDIA')) {
      const attrs = parseAttrs(line.slice(line.indexOf(':') + 1));
      if (String(attrs.TYPE || '').toUpperCase() === 'SUBTITLES' && attrs.URI) {
        const info = languageInfo(attrs.LANGUAGE || attrs.NAME || '') || languageFromUrl(attrs.URI);
        result.subtitles.push({
          code: info.code,
          label: String(attrs.NAME || info.label || 'Subtitles'),
          url: resolveUrl(attrs.URI, url),
          kind: 'hls',
        });
      }
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
  let subtitles = [];
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
      if (playlist.subtitles && playlist.subtitles.length) {
        subtitles = subtitles.concat(playlist.subtitles);
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
        if (playlist.subtitles && playlist.subtitles.length) {
          subtitles = subtitles.concat(playlist.subtitles);
        }
        return {
          playlist: playlist,
          resolution: variant.height ? variant.height + 'p' : detectResolution(variant.url),
          subtitles: dedupeSubtitleTracks(subtitles),
        };
      } catch (error) {
        lastError = error;
        if (error.status === 401 || error.status === 403) sawExpired = true;
        // A captured media playlist may still be usable if the master variant expired.
        if (media) {
          return {
            playlist: media,
            resolution: detectResolution(media.url),
            subtitles: dedupeSubtitleTracks(subtitles),
          };
        }
      }
    }
  }

  if (media) {
    return {
      playlist: media,
      resolution: detectResolution(media.url),
      subtitles: dedupeSubtitleTracks(subtitles),
    };
  }

  if (sawExpired) {
    throw new Error('The captured stream URL expired. Reload the lesson page and click Save while the video is playing.');
  }
  throw new Error('Could not open the captured playlist' +
    (lastError ? ' (' + lastError.message + ')' : '') + '. Reload the lesson page and let the video start again.');
}

function findTranscriptLines(value) {
  let best = null;

  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (Array.isArray(node.lines)) {
      const lines = [];
      for (const line of node.lines) {
        if (!line || typeof line !== 'object') continue;
        const text = String(line.caption == null ? (line.text || '') : line.caption).trim();
        const start = Number(line.transcriptStartAt == null ? line.start : line.transcriptStartAt);
        if (!text || !Number.isFinite(start)) continue;
        lines.push({ text: text, start: start });
      }
      if (lines.length >= 2 && (!best || lines.length > best.length)) best = lines;
    }
    for (const key of Object.keys(node)) visit(node[key]);
  }

  visit(value);
  return best;
}

function srtTime(ms) {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor(total / 60000) % 60;
  const seconds = Math.floor(total / 1000) % 60;
  const millis = total % 1000;
  return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0') + ':' +
    String(seconds).padStart(2, '0') + ',' + String(millis).padStart(3, '0');
}

function buildTranscriptSrt(lines) {
  const prepared = (lines || []).map((line) => ({
    text: String(line.text == null ? (line.caption || '') : line.text).trim(),
    start: Number(line.start == null ? line.transcriptStartAt : line.start),
  })).filter((line) => line.text && Number.isFinite(line.start));
  const sorted = prepared.sort((a, b) => a.start - b.start);
  const last = sorted.length ? sorted[sorted.length - 1].start : 0;
  const alreadyMs = last > 10000;
  const normalized = sorted.map((line) => ({
    text: line.text,
    start: alreadyMs ? Math.round(line.start) : Math.round(line.start * 1000),
  }));

  let srt = '';
  for (let i = 0; i < normalized.length; i++) {
    const start = normalized[i].start;
    let end = i + 1 < normalized.length ? normalized[i + 1].start : start + 4000;
    if (end <= start) end = start + 1000;
    srt += (i + 1) + '\n' + srtTime(start) + ' --> ' + srtTime(end) + '\n' +
      normalized[i].text + '\n\n';
  }
  return srt;
}

function normalizeSubtitleText(text) {
  let out = String(text || '').replace(/^\uFEFF/, '').trim();
  if (/^WEBVTT/i.test(out)) {
    out = out.replace(/^WEBVTT[^\n]*\n/i, '');
    out = out.replace(/(\d{2}:\d{2}:\d{2})\.(\d{3})/g, '$1,$2');
    out = out.replace(/(\d{2}:\d{2})\.(\d{3})/g, '00:$1,$2');
    out = out.trim();
  }
  return out ? out + '\n' : '';
}

async function fetchTranscriptSrt(courseSlug, videoSlug, identity) {
  if (!courseSlug || !videoSlug) return '';
  const url = new URL('https://www.linkedin.com/learning-api/graphql');
  url.searchParams.set('includeWebMetadata', 'true');
  url.searchParams.set('variables', '(courseSlug:' + courseSlug + ',videoSlug:' + videoSlug + ')');
  url.searchParams.set('queryId', 'videos.eb0cecfaa25dcd83d23769c32e492c1e');

  const headers = {
    'Accept': 'application/vnd.linkedin.normalized+json+2.1',
    'x-restli-protocol-version': '2.0.0',
  };
  if (identity) headers['x-li-identity'] = String(identity);

  try {
    const response = await fetch(url.href, {
      credentials: 'include',
      headers: headers,
      cache: 'no-store',
    });
    if (!response.ok) return '';
    const lines = findTranscriptLines(await response.json());
    return lines ? buildTranscriptSrt(lines) : '';
  } catch (_) {
    return '';
  }
}

async function chooseSubtitleTracks(msg, requestId, tabId) {
  const wanted = dedupe((msg.subtitleLanguages || []).map((code) => String(code).toLowerCase()));
  if (!wanted.length) return [];

  const available = dedupeSubtitleTracks((msg.subtitles || []).concat(msg.captionTracks || []));
  const byCode = new Map();
  for (const track of available) {
    if (!byCode.has(track.code)) byCode.set(track.code, track);
  }

  let transcriptSrt = '';
  async function transcriptFallback() {
    if (transcriptSrt) return transcriptSrt;
    transcriptSrt = await fetchTranscriptSrt(msg.courseSlug, msg.videoSlug, msg.identity);
    return transcriptSrt;
  }

  const out = [];
  for (const code of wanted) {
    const track = byCode.get(code);
    if (track) {
      try {
        notify(tabId, requestId, 'Fetching ' + track.label + ' subtitles…');
        const text = await fetchText(track.url);
        out.push({ track: track, text: text });
        continue;
      } catch (_) {
        if (code !== 'en') continue;
      }
    }
    if (code === 'en') {
      const text = await transcriptFallback();
      if (text) {
        out.push({
          track: { code: 'en', label: 'English (transcript)', kind: 'transcript' },
          text: text,
        });
      }
    }
  }
  return out;
}

async function createTextBlobUrl(text, requestId, tabId) {
  await ensureOffscreen();
  const assembled = await chrome.runtime.sendMessage({
    type: 'lls:assemble',
    requestId: requestId,
    tabId: tabId,
    text: text,
    mime: 'text/plain;charset=utf-8',
  });
  if (!assembled || !assembled.ok) {
    throw new Error((assembled && assembled.error) || 'Could not create the subtitle file.');
  }
  return assembled;
}

async function downloadSubtitle(item, msg, folderMode, requestId, tabId) {
  const filename = buildFilename(Object.assign({}, msg, {
    suffix: item.track.code,
  }), 'srt', folderMode);
  const text = normalizeSubtitleText(item.text);
  if (!text) throw new Error('LinkedIn returned an empty ' + item.track.label + ' subtitle track.');

  const assembled = await createTextBlobUrl(text, requestId, tabId);
  const downloadId = await chrome.downloads.download({
    url: assembled.blobUrl,
    filename: filename,
    conflictAction: 'uniquify',
  });
  return {
    filename: filename,
    downloadId: downloadId,
    bytes: assembled.bytes,
    language: item.track.code,
    label: item.track.label,
  };
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
  const order = meta.order ? String(meta.order).padStart(2, '0') + ' - ' : '';
  const suffix = meta.suffix ? '.' + safeName(meta.suffix) : '';
  const base = course && course.toLowerCase() !== lesson.toLowerCase()
    ? course + ' - ' + lesson
    : lesson;
  const subfolder = folderMode === 'course' && course ? course + '/' : '';
  return subfolder + order + base + suffix + '.' + extension;
}

async function getBatch() {
  const data = await chrome.storage.session.get(['llsBatch']);
  return data.llsBatch || null;
}

async function setBatch(batch) {
  await chrome.storage.session.set({ llsBatch: batch });
}

async function clearBatch() {
  await chrome.storage.session.remove(['llsBatch']);
}

function batchSummary(batch) {
  const ok = (batch.results || []).filter((item) => item.ok).length;
  const failed = (batch.results || []).length - ok;
  return ok + ' saved, ' + failed + ' failed';
}

async function goToBatchLesson(batch, tabId) {
  const lesson = batch.lessons[batch.index];
  if (!lesson) return;
  notify(tabId, null,
    'Batch ' + (batch.index + 1) + '/' + batch.lessons.length + ': ' + lesson.title,
    'working');
  try {
    await chrome.tabs.update(tabId, { url: lesson.url });
  } catch (_) {
    /* tab may have been closed */
  }
}

async function finishBatch(tabId) {
  const batch = await getBatch();
  if (!batch || !batch.active || batch.tabId !== tabId) return;

  batch.active = false;
  batch.status = 'done';
  batch.finishedAt = Date.now();
  await setBatch(batch);

  notify(tabId, null, 'Batch complete: ' + batchSummary(batch) + '.', 'ok');
  if (batch.returnUrl) {
    try {
      await chrome.tabs.update(tabId, { url: batch.returnUrl });
    } catch (_) {
      /* tab may have been closed */
    }
  }
}

async function recordBatchResult(tabId, result) {
  const batch = await getBatch();
  if (!batch || !batch.active || batch.tabId !== tabId) return;

  batch.results = batch.results || [];
  batch.results.push(result);
  await setBatch(batch);

  const next = batch.index + 1;
  if (next >= batch.lessons.length) {
    await finishBatch(tabId);
    return;
  }

  batch.index = next;
  await setBatch(batch);
  await goToBatchLesson(batch, tabId);
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
    const captured = tabId == null
      ? { playlists: [], segments: [], captions: [], captionTracks: [], languages: ['en'] }
      : getCaptureUrls(tabId);
    sendResponse({
      ok: true,
      items: tabId == null ? [] : (capturesByTab.get(tabId) || []).slice(),
      captions: captured.captions,
      captionTracks: captured.captionTracks,
      languages: captured.languages,
    });
    return false;
  }

  if (msg.type === 'lls:assemble-progress') {
    notify(msg.tabId, msg.requestId, msg.message, msg.state);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'lls:getBatch') {
    (async () => {
      const batch = await getBatch();
      sendResponse({ ok: true, batch: batch && batch.tabId === tabId ? batch : null });
    })();
    return true;
  }

  if (msg.type === 'lls:batch-start') {
    (async () => {
      const lessons = (msg.lessons || []).filter((lesson) => lesson && lesson.url);
      if (tabId == null || !lessons.length) {
        sendResponse({ ok: false, error: 'No course lessons were found on this page.' });
        return;
      }

      const batch = {
        active: true,
        status: 'running',
        tabId: tabId,
        courseSlug: msg.courseSlug || '',
        courseTitle: msg.courseTitle || '',
        returnUrl: msg.returnUrl || '',
        resolution: Number(msg.resolution) || 0,
        identity: msg.identity || '',
        downloadVideo: msg.downloadVideo !== false,
        downloadSubtitles: !!msg.downloadSubtitles,
        subtitleLanguages: (msg.subtitleLanguages || []).slice(),
        index: 0,
        lessons: lessons,
        results: [],
        startedAt: Date.now(),
      };
      await setBatch(batch);
      sendResponse({ ok: true, count: lessons.length });
      await goToBatchLesson(batch, tabId);
    })();
    return true;
  }

  if (msg.type === 'lls:batch-failed') {
    (async () => {
      await recordBatchResult(tabId, {
        title: msg.title || 'lesson',
        ok: false,
        error: msg.error || 'No stream was detected.',
      });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'lls:batch-stop') {
    (async () => {
      const batch = await getBatch();
      if (batch && batch.tabId === tabId) {
        batch.active = false;
        batch.status = 'stopped';
        await setBatch(batch);
        notify(tabId, null, 'Batch stopped: ' + batchSummary(batch) + '.', 'working');
        if (batch.returnUrl) {
          try { await chrome.tabs.update(tabId, { url: batch.returnUrl }); } catch (_) { /* ignore */ }
        }
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'lls:batch-clear') {
    (async () => {
      await clearBatch();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type !== 'lls:download') return false;

  (async () => {
    try {
      const downloadVideo = msg.downloadVideo !== false;
      const downloadSubtitles = !!msg.downloadSubtitles;
      if (!downloadVideo && !downloadSubtitles) {
        throw new Error('Select Video or Subtitles before saving.');
      }
      if (!chrome.downloads || typeof chrome.downloads.download !== 'function') {
        throw new Error('Downloads API unavailable. Reload the extension and make sure the Downloads permission is enabled.');
      }

      const prefs = await chrome.storage.sync.get(['folderMode']);
      const folderMode = prefs.folderMode || 'course';
      const fromTab = getCaptureUrls(tabId);
      const request = Object.assign({}, msg, {
        playlists: fromTab.playlists,
        segments: fromTab.segments,
        captions: fromTab.captions,
        captionTracks: fromTab.captionTracks,
      });

      let chosen = null;
      let filename = '';
      let extension = '';
      let downloadId = null;
      let bytes = 0;
      let resolution = '';
      let subtitleFiles = [];
      let subtitleError = '';

      if (downloadVideo) {
        notify(tabId, msg.requestId, 'Reading captured stream…');
        chosen = await choosePlaylist(request, tabId, msg.requestId);
        const playlist = chosen.playlist;
        resolution = chosen.resolution || detectResolution(playlist.url);

        if (playlist.encrypted) {
          throw new Error('This lesson stream is encrypted and cannot be saved locally by this extension.');
        }
        if (playlist.byteRange) {
          throw new Error('This lesson uses byte-range segments, which this extension does not support yet.');
        }

        extension = playlist.mapUri ? 'mp4' : 'ts';
        const mime = extension === 'mp4' ? 'video/mp4' : 'video/mp2t';
        const urls = (playlist.mapUri ? [playlist.mapUri] : []).concat(playlist.segments);
        if (!urls.length) {
          throw new Error('The captured playlist contains no video segments.');
        }

        filename = buildFilename(msg, extension, folderMode);
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

        notify(tabId, msg.requestId, 'Starting video download…');
        downloadId = await chrome.downloads.download({
          url: assembled.blobUrl,
          filename: filename,
          conflictAction: 'uniquify',
        });
        bytes = assembled.bytes;
      }

      if (downloadSubtitles) {
        try {
          if (!chosen && request.playlists.length) {
            try {
              chosen = await choosePlaylist(request, tabId, msg.requestId);
            } catch (_) {
              chosen = null;
            }
          }
          const subtitleRequest = Object.assign({}, request, {
            subtitles: chosen && chosen.subtitles ? chosen.subtitles : [],
          });
          const tracks = await chooseSubtitleTracks(subtitleRequest, msg.requestId, tabId);
          if (!tracks.length) {
            throw new Error('No subtitle track was available for this lesson. Enable captions in the player and retry.');
          }
          for (const item of tracks) {
            subtitleFiles.push(await downloadSubtitle(item, msg, folderMode, msg.requestId, tabId));
          }
          notify(tabId, msg.requestId,
            'Saved ' + subtitleFiles.map((file) => file.label).join(', ') + ' subtitles.', 'ok');
        } catch (error) {
          subtitleError = error && error.message ? error.message : String(error);
        }
      }

      if (downloadId == null && !subtitleFiles.length) {
        const message = subtitleError || 'No file was saved.';
        sendResponse({
          ok: false,
          error: message,
          subtitleFiles: [],
          subtitleError: message,
        });
        if (msg.batch) {
          await recordBatchResult(tabId, {
            title: msg.title || 'lesson',
            ok: false,
            error: message,
            order: msg.order || null,
          });
        }
        return;
      }

      sendResponse({
        ok: true,
        downloadId: downloadId,
        filename: filename,
        extension: extension,
        ext: extension,
        bytes: bytes,
        resolution: resolution,
        subtitleFiles: subtitleFiles,
        subtitleError: subtitleError,
      });

      if (msg.batch) {
        await recordBatchResult(tabId, {
          title: msg.title || 'lesson',
          ok: true,
          filename: filename,
          subtitleFiles: subtitleFiles,
          error: subtitleError || null,
          order: msg.order || null,
        });
      }
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      sendResponse({ ok: false, error: message });

      if (msg.batch) {
        await recordBatchResult(tabId, {
          title: msg.title || 'lesson',
          ok: false,
          error: message,
          order: msg.order || null,
        });
      }
    }
  })();

  return true; // keep the message channel open for the async response
});
