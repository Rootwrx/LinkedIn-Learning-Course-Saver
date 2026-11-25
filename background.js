'use strict';

const MAX_CANDIDATES = 10;

// webRequest sees the player's real playlist URL, including requests made by
// HLS workers that a page-world fetch/XHR hook cannot observe.
const capturesByTab = new Map();
const pageKeyByTab = new Map();
// Multiple content scripts can survive extension reloads on the same tab.
// Only the first batch download claim for a lesson may proceed.
const batchDownloadClaims = new Set();

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
  const prefs = await chrome.storage.sync.get(['resolution', 'folderMode', 'subtitleFormat']);
  if (prefs.resolution == null) await chrome.storage.sync.set({ resolution: 0 });
  if (!prefs.folderMode) await chrome.storage.sync.set({ folderMode: 'course' });
  if (!prefs.subtitleFormat) await chrome.storage.sync.set({ subtitleFormat: 'srt' });

  // A reloaded extension invalidates already-injected content scripts. Refresh
  // open lesson tabs so they pick up the new script instead of throwing on
  // every chrome.* call and refusing to download.
  try {
    const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/learning/*' });
    for (const tab of tabs) {
      try { await chrome.tabs.reload(tab.id); } catch (_) { /* tab may have closed */ }
    }
  } catch (_) { /* tabs permission unavailable */ }
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
  ro: 'Romanian', uk: 'Ukrainian', te: 'Telugu', ta: 'Tamil', kn: 'Kannada',
  ml: 'Malayalam', bn: 'Bengali', gu: 'Gujarati', pa: 'Punjabi', si: 'Sinhala',
  tl: 'Tagalog', fil: 'Tagalog', sr: 'Serbian', hr: 'Croatian', bs: 'Bosnian',
  sv: 'Swedish',
};
const LANGUAGE_ALIASES = {
  eng: 'en', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', spa: 'es',
  ita: 'it', por: 'pt', nld: 'nl', dut: 'nl', swe: 'sv', dan: 'da',
  nor: 'no', fin: 'fi', pol: 'pl', rus: 'ru', tur: 'tr', jpn: 'ja',
  kor: 'ko', zho: 'zh', chi: 'zh', ara: 'ar', hin: 'hi', ind: 'id',
  vie: 'vi', tha: 'th', ces: 'cs', cze: 'cs', ell: 'el', gre: 'el',
  heb: 'he', ron: 'ro', rum: 'ro', ukr: 'uk', fil: 'tl', tag: 'tl',
  srp: 'sr', hrv: 'hr', bos: 'bs',
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

function normalizeLanguageCode(value) {
  const info = languageInfo(value);
  return info ? info.code : String(value || '').trim().toLowerCase().split(/[-_]/)[0];
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
  // Signed LinkedIn URLs can hang instead of failing. Bound every probe so a
  // single dead candidate cannot stall a download for tens of seconds.
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Request timed out')), 8000);
  });
  try {
    const response = await Promise.race([
      fetch(url, { credentials: 'include', cache: 'no-store' }),
      timeout,
    ]);
    if (!response.ok) {
      const error = new Error('HTTP ' + response.status);
      error.status = response.status;
      throw error;
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

// Probe playlists concurrently, but do not wait for a hung candidate: once one
// probe has succeeded, give the others a short grace period and carry on.
// Results keep candidate order so master/media selection stays deterministic.
function probeCandidates(candidates) {
  return new Promise((resolve) => {
    const results = new Array(candidates.length);
    let settled = 0;
    let finished = false;
    let graceTimer = null;
    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(graceTimer);
      resolve(results.filter(Boolean));
    }
    candidates.forEach((url, index) => {
      fetchText(url)
        .then((text) => ({ url: url, text: text }), (error) => ({ url: url, error: error }))
        .then((item) => {
          if (finished) return;
          results[index] = item;
          settled++;
          if (settled === candidates.length) {
            finish();
          } else if (!item.error && !graceTimer) {
            graceTimer = setTimeout(finish, 400);
          }
        });
    });
  });
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

  // Probe candidates concurrently. These signed URLs often expire, and
  // waiting for each one in turn made saves feel much slower than the
  // connection actually is.
  const probed = await probeCandidates(candidates);
  for (const item of probed) {
    if (item.error) {
      lastError = item.error;
      if (item.error.status === 401 || item.error.status === 403) sawExpired = true;
      continue;
    }
    let playlist;
    try {
      playlist = parsePlaylist(item.text, item.url);
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

function buildTranscriptSrt(lines, forceMs) {
  const prepared = (lines || []).map((line) => ({
    text: String(line.text == null ? (line.caption || '') : line.text).trim(),
    start: Number(line.start == null ? line.transcriptStartAt : line.start),
  })).filter((line) => line.text && Number.isFinite(line.start));
  const sorted = prepared.sort((a, b) => a.start - b.start);
  const last = sorted.length ? sorted[sorted.length - 1].start : 0;
  const alreadyMs = !!forceMs || last > 10000;
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

function toSrt(text) {
  let out = String(text || '').replace(/^\uFEFF/, '').trim();
  if (/^WEBVTT/i.test(out)) {
    out = out.replace(/^WEBVTT[^\n]*(?:\n|$)/i, '');
    // Normalize both sides of the arrow in one pass and drop VTT cue settings.
    out = out.replace(
      /^(\d{2}:\d{2}(?::\d{2})?)[.,](\d{3})\s*-->\s*(\d{2}:\d{2}(?::\d{2})?)[.,](\d{3})[^\n]*$/gm,
      (_all, start, startMs, end, endMs) => {
        const full = (value) => value.split(':').length === 2 ? '00:' + value : value;
        return full(start) + ',' + startMs + ' --> ' + full(end) + ',' + endMs;
      }
    );
    out = out.replace(/(\d{2}:\d{2}:\d{2})\.(\d{3})/g, '$1,$2');
    out = out.replace(/(\d{2}:\d{2})\.(\d{3})/g, '00:$1,$2');
    out = out.replace(/^\d+\s*\n/gm, '');
    let cue = 1;
    out = out.split(/\r?\n/).map((line) => {
      if (/^\d{2}:\d{2}(?::\d{2})?,\d{3}\s*-->/.test(line)) {
        return (cue++) + '\n' + line;
      }
      return line;
    }).join('\n');
  }
  return out.trim() ? out.trim() + '\n' : '';
}

function toVtt(text) {
  let out = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!/^WEBVTT/i.test(out)) {
    out = out.replace(/^\d+\s*\n/gm, '');
    out = out.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    out = out.replace(/(\d{2}:\d{2}),(\d{3})/g, '00:$1.$2');
    out = out.replace(/(-->\s*\d{2}:\d{2}(?::\d{2})?)[.,](\d{3})[^\n]*/g, '$1.$2');
    out = out.replace(/\{[^\n]*\}/g, '');
    out = 'WEBVTT\n\n' + out;
  }
  return out.trim() ? out.trim() + '\n' : '';
}

function normalizeSubtitleText(text, format) {
  return format === 'vtt' ? toVtt(text) : toSrt(text);
}

function plainCaptionText(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/^WEBVTT[^\n]*(?:\n|$)/i, ' ')
    .replace(/\d{2}:\d{2}(?::\d{2})?[.,]\d{3}\s*-->\s*\d{2}:\d{2}(?::\d{2})?[.,]\d{3}[^\n]*/g, ' ')
    .replace(/\{[^\}]*\}/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/[♪♫]/g, ' ')
    .toLowerCase();
}

// LinkedIn's caption assets do not always carry a language code in the URL.
// Detect the written language from the cue text so an English selection cannot
// silently save a Vietnamese (or other) track that was labelled "en".
function detectCaptionLanguage(text) {
  const plain = plainCaptionText(text);
  if (plain.length < 12) return '';

  const count = (pattern) => (plain.match(pattern) || []).length;
  if (count(/[\u3040-\u30ff]/g) > 2) return 'ja';
  if (count(/[\uac00-\ud7af]/g) > 2) return 'ko';
  if (count(/[\u0c00-\u0c7f]/g) > 2) return 'te';
  if (count(/[\u0c80-\u0cff]/g) > 2) return 'kn';
  if (count(/[\u0d00-\u0d7f]/g) > 2) return 'ml';
  if (count(/[\u0b80-\u0bff]/g) > 2) return 'ta';
  if (count(/[\u0a80-\u0aff]/g) > 2) return 'gu';
  if (count(/[\u0a00-\u0a7f]/g) > 2) return 'pa';
  if (count(/[\u0980-\u09ff]/g) > 2) return 'bn';
  if (count(/[\u0d80-\u0dff]/g) > 2) return 'si';
  if (count(/[\u4e00-\u9fff]/g) > 2) return 'zh';
  if (count(/[\u0600-\u06ff]/g) > 2) return 'ar';
  if (count(/[\u0590-\u05ff]/g) > 2) return 'he';
  if (count(/[\u0900-\u097f]/g) > 2) return 'hi';
  if (count(/[\u0e00-\u0e7f]/g) > 2) return 'th';

  const total = plain.length;
  const cyrillic = count(/[\u0400-\u04ff]/g);
  if (cyrillic > 2 && cyrillic / total > 0.02) {
    return /[іїєґ]/.test(plain) ? 'uk' : 'ru';
  }
  const greek = count(/[\u0370-\u03ff]/g);
  if (greek > 2 && greek / total > 0.02) return 'el';

  const vietnameseLetters = count(/[ăơưđ]/g);
  const vietnameseTones = count(
    /[àáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/g
  );
  if (vietnameseLetters >= 1 && vietnameseTones >= 2) return 'vi';

  const words = plain.split(/[^a-z\u00c0-\u024f\u1e00-\u1eff]+/).filter(Boolean);
  const hits = (...wanted) => wanted.filter((word) => words.includes(word)).length;

  // Strong markers first: these are frequently mislabelled by LinkedIn.
  if (/[đčćžš]/.test(plain) && hits('se', 'mogu', 'na', 'povezati', 'različite')) return 'sr';
  if (hits('ang', 'mga', 'ay', 'na', 'sa', 'ng') >= 3) return 'tl';
  if (/[ışğ]/.test(plain) || hits('ve', 'bir', 'için', 'olarak', 'şekillerde') >= 2) return 'tr';
  if (/[åäö]/.test(plain) && hits('och', 'att', 'som', 'kan', 'på', 'är', 'nätverk') >= 2) return 'sv';
  if (/[øæ]/.test(plain) && hits('og', 'at', 'som', 'kan', 'på', 'er', 'ikke') >= 2) return 'no';

  if (/[ñ¿¡]/.test(plain) || hits('que', 'para', 'los', 'las', 'una', 'está') >= 2) return 'es';
  if (/œ/.test(plain) || hits('les', 'des', 'une', 'dans', 'pour', 'être') >= 2) return 'fr';
  if (/ß/.test(plain) || hits('der', 'die', 'das', 'und', 'ist', 'nicht') >= 2) return 'de';
  if (/[ãõ]/.test(plain) || hits('não', 'uma', 'para', 'com', 'este') >= 2) return 'pt';
  if (hits('gli', 'che', 'non', 'una', 'della', 'nell') >= 2) return 'it';

  return '';
}

async function fetchTranscriptSrt(courseSlug, videoSlug, identity, transcriptLines, tabId) {
  // The lesson page embeds the English transcript in its course data. Prefer
  // that over the GraphQL fallback: it is tied to the exact video and does
  // not depend on a query id that LinkedIn can change.
  if (Array.isArray(transcriptLines) && transcriptLines.length) {
    const prepared = transcriptLines.map((line) => ({
      caption: line && line.caption,
      transcriptStartAt: line && (line.transcriptStartAt == null
        ? line.start : line.transcriptStartAt),
    }));
    const srt = buildTranscriptSrt(findTranscriptLines({ lines: prepared }) || [], true);
    if (srt) return srt;
  }
  if (!courseSlug || !videoSlug) return '';

  // Ask the content script to make the call from the lesson page's own origin.
  // The worker's cross-origin fetch is often blocked by CORS even with the
  // session cookies attached.
  if (tabId != null) {
    try {
      const page = await chrome.tabs.sendMessage(tabId, {
        type: 'lls:fetchTranscript',
        courseSlug: courseSlug,
        videoSlug: videoSlug,
        identity: identity,
      });
      if (page && page.ok && page.data) {
        const lines = findTranscriptLines(page.data);
        if (lines) return buildTranscriptSrt(lines);
      }
    } catch (_) { /* page may not have the handler (old content script) */ }
  }

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

async function inspectCaptionCandidates(msg) {
  const allTracks = msg.captionTracks || [];
  // Page metadata is authoritative, so examine it before generic captures.
  const ordered = allTracks.filter((track) => track && track.kind === 'page')
    .concat(allTracks.filter((track) => track && track.kind !== 'page'))
    .concat(msg.subtitles || []);
  const candidates = dedupeSubtitleTracks(ordered);
  for (const url of dedupe(msg.captions || [])) {
    const info = languageFromUrl(url);
    candidates.push({
      code: info.code,
      label: info.label,
      url: url,
      kind: 'captured',
    });
  }

  // Fetch caption assets in parallel; LinkedIn lessons can expose a dozen or
  // more, and doing them one at a time dominated the save time.
  const unique = dedupeSubtitleTracks(candidates);
  const fetched = await Promise.all(unique.map(async (track) => {
    try {
      return { track: track, text: await fetchText(track.url) };
    } catch (_) {
      return null;
    }
  }));

  const byCode = new Map();
  for (const item of fetched) {
    if (!item) continue;
    const track = item.track;
    const text = item.text;
    // A page-provided code comes from LinkedIn's own locale metadata. For
    // every other source, fall back to detection from the cue text.
    const code = (track.kind === 'page' && track.code)
      ? normalizeLanguageCode(track.code)
      : (detectCaptionLanguage(text) || track.code || 'en');
    const label = LANGUAGE_NAMES[code] || track.label || code;
    const existing = byCode.get(code);
    if (!existing || (track.kind !== 'captured' && existing.kind === 'captured')) {
      byCode.set(code, {
        code: code,
        label: label,
        url: track.url,
        kind: track.kind,
        text: text,
      });
    }
  }
  return byCode;
}

async function chooseSubtitleTracks(msg, requestId, tabId) {
  const wanted = dedupe((msg.subtitleLanguages || []).map((code) => String(code).toLowerCase()));
  if (!wanted.length) return [];

  const byCode = await inspectCaptionCandidates(msg);

  let transcriptSrt = '';
  async function transcriptFallback() {
    if (transcriptSrt) return transcriptSrt;
    transcriptSrt = await fetchTranscriptSrt(
      msg.courseSlug, msg.videoSlug, msg.identity, msg.transcriptLines, tabId
    );
    return transcriptSrt;
  }

  const out = [];
  for (const code of wanted) {
    const item = byCode.get(code);
    if (item) {
      notify(tabId, requestId, 'Fetching ' + item.label + ' subtitles…');
      out.push({
        track: {
          code: item.code,
          label: item.label,
          url: item.url,
          kind: item.kind,
        },
        text: item.text,
      });
      continue;
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

async function createTextBlobUrl(text, requestId, tabId, mime) {
  await ensureOffscreen();
  const assembled = await chrome.runtime.sendMessage({
    type: 'lls:assemble',
    requestId: requestId,
    tabId: tabId,
    text: text,
    mime: mime || 'application/x-subrip;charset=utf-8',
  });
  if (!assembled || !assembled.ok) {
    throw new Error((assembled && assembled.error) || 'Could not create the subtitle file.');
  }
  return assembled;
}

async function downloadSubtitle(item, msg, folderMode, requestId, tabId) {
  const format = msg.subtitleFormat === 'vtt' ? 'vtt' : 'srt';
  const filename = buildFilename(Object.assign({}, msg, {
    suffix: item.track.code,
  }), format, folderMode);
  const text = normalizeSubtitleText(item.text, format);
  if (!text) throw new Error('LinkedIn returned an empty ' + item.track.label + ' subtitle track.');

  const mime = format === 'vtt'
    ? 'text/vtt;charset=utf-8'
    : 'application/x-subrip;charset=utf-8';
  const assembled = await createTextBlobUrl(text, requestId, tabId, mime);
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
  const section = safeName(meta.section || '');
  const order = meta.order ? String(meta.order).padStart(2, '0') + ' - ' : '';
  const suffix = meta.suffix ? '.' + safeName(meta.suffix) : '';

  const folders = [];
  if (folderMode !== 'flat') {
    if (course) folders.push(course);
    if (section) folders.push(section);
  }
  const name = order + lesson + suffix + '.' + extension;
  return folders.length ? folders.join('/') + '/' + name : name;
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
    'Batch ' + (batch.index + 1) + '/' + batch.lessons.length + ': ' +
      (lesson.section ? lesson.section + ' — ' : '') + lesson.title,
    'working');
  try {
    await chrome.tabs.update(tabId, { url: lesson.url });
  } catch (_) {
    /* tab may have been closed */
  }
}

// Batch state lives in storage.session. Video jobs now finish in the background
// while the tab moves on, so every read-modify-write goes through one lock.
let batchLockChain = Promise.resolve();
function withBatchLock(fn) {
  const run = batchLockChain.then(fn);
  batchLockChain = run.catch(() => {});
  return run;
}

// Limit simultaneous video downloads so a fast batch cannot pile up memory.
const MAX_PARALLEL_VIDEO_JOBS = 3;
let activeVideoJobs = 0;
const videoSlotWaiters = [];
function acquireVideoSlot() {
  if (activeVideoJobs < MAX_PARALLEL_VIDEO_JOBS) {
    activeVideoJobs++;
    return Promise.resolve();
  }
  return new Promise((resolve) => videoSlotWaiters.push(resolve));
}
function releaseVideoSlot() {
  const next = videoSlotWaiters.shift();
  if (next) next();
  else activeVideoJobs--;
}

const pendingBatchJobs = new Map(); // tabId -> Set<Promise>
function trackBatchJob(tabId, promise) {
  let set = pendingBatchJobs.get(tabId);
  if (!set) {
    set = new Set();
    pendingBatchJobs.set(tabId, set);
  }
  set.add(promise);
  promise.then(() => set.delete(promise), () => set.delete(promise));
}
async function waitForBatchJobs(tabId) {
  const set = pendingBatchJobs.get(tabId);
  while (set && set.size) {
    await Promise.all(Array.from(set));
  }
}

async function finishBatch(tabId) {
  const done = await withBatchLock(async () => {
    const batch = await getBatch();
    if (!batch || !batch.active || batch.tabId !== tabId) return null;
    batch.active = false;
    batch.status = 'done';
    batch.finishedAt = Date.now();
    await setBatch(batch);
    return batch;
  });
  if (!done) return;

  notify(tabId, null, 'Batch complete: ' + batchSummary(done) + '.', 'ok');
  if (done.returnUrl) {
    try {
      await chrome.tabs.update(tabId, { url: done.returnUrl });
    } catch (_) {
      /* tab may have been closed */
    }
  }
}

// Store a lesson's outcome without moving the batch forward.
function recordBatchResult(tabId, result) {
  return withBatchLock(async () => {
    const batch = await getBatch();
    if (!batch || !batch.active || batch.tabId !== tabId) return;
    batch.results = batch.results || [];
    batch.results.push(result);
    await setBatch(batch);
  });
}

// Move to the next lesson (or finish once every background job is done).
async function advanceBatch(tabId) {
  const move = await withBatchLock(async () => {
    const batch = await getBatch();
    if (!batch || !batch.active || batch.tabId !== tabId) return null;
    const next = batch.index + 1;
    if (next >= batch.lessons.length) return { finish: true };
    batch.index = next;
    await setBatch(batch);
    return { batch: batch };
  });
  if (!move) return;

  if (move.finish) {
    if ((pendingBatchJobs.get(tabId) || { size: 0 }).size) {
      notify(tabId, null, 'Finishing downloads…', 'working');
    }
    await waitForBatchJobs(tabId);
    await finishBatch(tabId);
    return;
  }
  await goToBatchLesson(move.batch, tabId);
}

async function recordAndAdvance(tabId, result) {
  await recordBatchResult(tabId, result);
  await advanceBatch(tabId);
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

  if (msg.type === 'lls:inspectCaptions') {
    (async () => {
      try {
        const urls = tabId == null ? [] : getCaptureUrls(tabId).captions;
        const byCode = await inspectCaptionCandidates({
          captions: urls,
          captionTracks: msg.pageCaptionTracks || [],
        });
        const tracks = Array.from(byCode.values()).map((item) => ({
          code: item.code,
          label: item.label,
          url: item.url,
          kind: item.kind,
        }));
        sendResponse({
          ok: true,
          captionTracks: tracks,
          languages: dedupe(['en'].concat(tracks.map((track) => track.code))),
        });
      } catch (_) {
        sendResponse({ ok: false, languages: ['en'] });
      }
    })();
    return true;
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
        sendResponse({ ok: false, error: 'No course videos were found on this page.' });
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
        subtitleFormat: msg.subtitleFormat === 'vtt' ? 'vtt' : 'srt',
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
      await recordAndAdvance(tabId, {
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

  if (msg.batch) {
    const claim = [tabId, msg.batchStartedAt, msg.batchIndex, msg.videoSlug].join('|');
    if (batchDownloadClaims.has(claim)) {
      sendResponse({ ok: true, duplicate: true, filename: '', subtitleFiles: [] });
      return false;
    }
    batchDownloadClaims.add(claim);
    // Keep the set from growing across very long batch runs.
    if (batchDownloadClaims.size > 500) batchDownloadClaims.clear();
  }

  (async () => {
    let responded = false;
    let advanced = false;
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
        // Page metadata has authoritative language codes; keep it alongside
        // whatever webRequest captured instead of replacing it.
        captionTracks: dedupeSubtitleTracks(
          (msg.pageCaptionTracks || []).concat(fromTab.captionTracks || [])
        ),
      });

      let chosen = null;
      let filename = '';
      let extension = '';
      let downloadId = null;
      let bytes = 0;
      let resolution = '';
      let subtitleFiles = [];
      let subtitleError = '';
      let videoSource = '';
      let videoJob = null;

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
        if (playlist.mapUri) {
          throw new Error('This lesson uses fragmented MP4 segments, which this extension does not support. Only MPEG-TS streams can be saved.');
        }

        extension = 'ts';
        videoSource = 'hls';
        const urls = playlist.segments;
        if (!urls.length) {
          throw new Error('The captured playlist contains no video segments.');
        }

        filename = buildFilename(msg, extension, folderMode);
        // In a batch the tab moves on as soon as the stream is identified,
        // so progress notices would land on the wrong lesson page.
        const say = msg.batch ? () => {} : (text) => notify(tabId, msg.requestId, text);
        say('Found ' + (resolution ? resolution + ' ' : '') + 'stream. Fetching ' + urls.length + ' parts…');

        const runVideo = async () => {
          await ensureOffscreen();
          const assembled = await chrome.runtime.sendMessage({
            type: 'lls:assemble',
            requestId: msg.batch ? null : msg.requestId,
            tabId: msg.batch ? null : tabId,
            urls: urls,
            filename: filename,
            mime: 'video/mp2t',
          });
          if (!assembled || !assembled.ok) {
            throw new Error((assembled && assembled.error) || 'Could not assemble the video file.');
          }
          say('Starting video download…');
          const id = await chrome.downloads.download({
            url: assembled.blobUrl,
            filename: filename,
            conflictAction: 'uniquify',
          });
          return { downloadId: id, bytes: assembled.bytes };
        };

        if (msg.batch) {
          // Do not wait for the video: start it, then keep going. A free slot
          // is awaited first so at most a few videos download at once.
          await acquireVideoSlot();
          videoJob = runVideo().finally(releaseVideoSlot);
          videoJob.catch(() => {}); // handled when the job is awaited below
        } else {
          const result = await runVideo();
          downloadId = result.downloadId;
          bytes = result.bytes;
        }
      }

      if (downloadSubtitles) {
        try {
          // Reuse the playlist chosen for the video when there is one; only
          // probe here when saving subtitles alone.
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
            const wanted = dedupe((msg.subtitleLanguages || ['en']).map((c) => String(c)));
            const other = (request.captions || []).length +
              (request.subtitles || []).length + (request.captionTracks || []).length;
            throw new Error(
              'No ' + wanted.join('/') + ' subtitle track was available' +
              (other ? ' (' + other + ' other caption track' + (other === 1 ? '' : 's') +
                ' captured, in other languages)' : '') +
              '. Enable captions in the player, wait a few seconds, and retry.'
            );
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

      if (downloadId == null && !videoJob && !subtitleFiles.length) {
        const message = subtitleError || 'No file was saved.';
        responded = true;
        sendResponse({
          ok: false,
          error: message,
          subtitleFiles: [],
          subtitleError: message,
        });
        if (msg.batch) {
          advanced = true;
          await recordAndAdvance(tabId, {
            title: msg.title || 'lesson',
            ok: false,
            error: message,
            order: msg.order || null,
          });
        }
        return;
      }

      if (videoJob) {
        // Batch: the video keeps downloading in the background while the tab
        // moves to the next lesson. Subtitles above already finished, since
        // they may need this page.
        responded = true;
        sendResponse({
          ok: true,
          queued: true,
          filename: filename,
          extension: extension,
          ext: extension,
          videoSource: videoSource,
          bytes: 0,
          resolution: resolution,
          subtitleFiles: subtitleFiles,
          subtitleError: subtitleError,
        });

        const finished = (async () => {
          let jobError = '';
          try {
            await videoJob;
          } catch (error) {
            jobError = error && error.message ? error.message : String(error);
          }
          await recordBatchResult(tabId, {
            title: msg.title || 'lesson',
            ok: !jobError,
            filename: filename,
            subtitleFiles: subtitleFiles,
            error: jobError || subtitleError || null,
            order: msg.order || null,
          });
        })();
        trackBatchJob(tabId, finished);

        advanced = true;
        await advanceBatch(tabId);
        return;
      }

      responded = true;
      sendResponse({
        ok: true,
        downloadId: downloadId,
        filename: filename,
        extension: extension,
        ext: extension,
        videoSource: videoSource,
        bytes: bytes,
        resolution: resolution,
        subtitleFiles: subtitleFiles,
        subtitleError: subtitleError,
      });

      if (msg.batch) {
        advanced = true;
        await recordAndAdvance(tabId, {
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
      if (!responded) sendResponse({ ok: false, error: message });

      if (msg.batch && !advanced) {
        await recordAndAdvance(tabId, {
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
