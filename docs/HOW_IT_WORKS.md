# How It Works

This document explains the internal design. For step-by-step usage, see [User Guide](USER_GUIDE.md). For the `.ts` to `.mp4` scripts, see [Converters](CONVERTERS.md).

## 1. Design goals

- Chrome/Edge Manifest V3, loaded unpacked.
- Local-only: no server, account, credits, signup, or bundled transcoder.
- Save only content the user is already entitled to play.
- Capture what the lesson player really requests instead of calling LinkedIn's deprecated `detailedCourses` endpoint.
- Save videos and subtitles with clean, sortable names.
- Support single lessons and whole-course batches.
- Prefer genuine MP4 URLs; fall back to local HLS assembly when necessary.

## 2. Component map

| File | Role |
| --- | --- |
| `manifest.json` | MV3 declaration: permissions, host access, content script, service worker, popup, icons. |
| `background.js` | Service worker. Captures network requests, stores per-tab captures, parses playlists/captions, selects video/subtitles, starts downloads, manages batch state. |
| `content.js` | Injected into lesson pages. Builds the shadow-DOM button/panel, reads embedded LinkedIn metadata and sidebar links, autoplays batch lessons, sends save requests, displays status. |
| `offscreen.html` / `offscreen.js` | Hidden DOM context used to fetch HLS parts or subtitle text and create blob URLs. It only has `chrome.runtime`, so the worker performs the actual `chrome.downloads.download`. |
| `popup.html` / `popup.js` | Toolbar settings UI backed by `chrome.storage.sync`. |
| `convert-to-mp4.ps1` / `.cmd` | Optional one-folder ffmpeg remux helper. |
| `convert-all-to-mp4.ps1` / `.cmd` | Optional dynamic scanner / watcher for `.ts` files. |
| `icons/` | Extension icons. |
| `tools/make-icons.ps1` | Regenerates icons. |

## 3. Permissions and why they exist

| Permission | Why |
| --- | --- |
| `downloads` | Save video and subtitle files to the browser's Downloads folder. |
| `storage` | Persist preferences (`sync`) and active batch state (`session`). |
| `tabs` | Refresh tabs after install/update and navigate the batch tab between lessons. |
| `offscreen` | Create large blob URLs from HLS parts in a DOM context. |
| `webRequest` | Observe the player's real playlist, segment, and caption requests, including worker-initiated ones. |
| `webNavigation` | Clear captured URLs when the user or batch navigates to a different lesson. |
| `https://www.linkedin.com/*` | Lesson pages, embedded metadata, transcript endpoint, tab refresh. |
| `https://*.licdn.com/*` | `dms.licdn.com` video/caption assets. |

No other hosts are requested by the extension itself.

## 4. Capture model

The worker keeps three in-memory maps:

| Map | Purpose |
| --- | --- |
| `capturesByTab` | URLs seen for each tab, classified as playlist, candidate, segment, caption, or other. Capped at 240 entries per tab. |
| `pageKeyByTab` | Last lesson key (`courseSlug/lessonSlug`) seen for each tab, used to clear stale captures on navigation. |
| `batchDownloadClaims` | Prevents duplicate batch download requests from stale content scripts after an extension reload. |

### How requests are classified

`captureKind(url)` checks, in order:

1. Caption/transcript/`.srt`/`.vtt` URLs become `caption`. They are never treated as video playlists or segments.
2. `.m3u8` URLs become `playlist`.
3. LinkedIn's index-zero URLs such as `/hls-720p.../<id>/0/<timestamp>` become `candidate`.
4. Other numbered media paths become `segment`.
5. Everything else is `other`.

`rememberCapture()` only stores HTTPS URLs on `dms.licdn.com` or another `*.licdn.com` host that look like playlists/videos/captions.

### Confirming playlists

LinkedIn HLS playlists usually have **no `.m3u8` suffix**. They are served with:

```text
Content-Type: application/vnd.apple.mpegURL
```

The worker's `webRequest.onHeadersReceived` listener checks that MIME type and promotes the URL to `playlist`.

### Navigation cleanup

`webNavigation.onCommitted` and `onHistoryStateUpdated` call `onLessonNavigation()`. When the lesson key changes, that tab's captures are discarded. The content script sends `lls:page` messages for the same purpose on single-page navigations.

## 5. Page-side metadata

`content.js` scans the lesson page's embedded data before falling back to visible DOM headings. It extracts:

- current lesson title, course slug, course title, and video slug;
- the digitalmedia asset ID shared by HLS URLs and progressive MP4 URLs;
- section outline data (`toc.section` / `learningApiTocSection:`);
- lesson links, including links with query strings;
- caption tracks with authoritative `locale.language`;
- transcript lines linked to the current video;
- progressive MP4 streams with URL, height, size, priority, and expiry.

It also calls `cleanText()` on titles so sidebar noise such as `(Viewed)` and `4m 30s video` does not appear in filenames.

### Lesson collection

Embedded outline data is preferred because it is more reliable than sidebar scraping. The sidebar remains the fallback.

Quizzes and assessments are filtered by title and outline type using patterns such as `quiz`, `assessment`, `knowledge check`, and `exam`.

## 6. Video save decision

When `lls:download` arrives, the worker:

1. Reads current preferences (`folderMode`).
2. Merges worker captures with page-provided caption metadata.
3. If **Video** is selected, tries `pickProgressiveStream()`:
   - URL must be HTTPS on `linkedin.com/dms/`;
   - `expiresAt`, when present, must be in the future;
   - if captured HLS URLs expose a digitalmedia asset ID, only MP4s with the same ID are eligible;
   - candidates are sorted by priority, then by closeness to the requested quality and size.
4. If a progressive MP4 is found:
   - extension is `.mp4`;
   - `videoSource` is `progressive`;
   - `chrome.downloads.download()` receives the signed URL directly;
   - no ffmpeg, remux, or blob assembly is involved.
5. If no progressive MP4 is usable:
   - the worker calls `choosePlaylist()`;
   - encrypted playlists and byte-range playlists are rejected with explicit errors;
   - fragmented playlists containing `#EXT-X-MAP` produce `.mp4`;
   - ordinary HLS produces `.ts`.

### Playlist selection

`choosePlaylist()`:

- takes up to **10** confirmed/candidate playlists;
- only derives guessed playlist paths when no real candidate was observed, because signed LinkedIn paths are often token-specific;
- fetches all candidates in parallel;
- bounds each request with an **8-second timeout**;
- parses `#EXT-X-STREAM-INF` variants and `#EXT-X-MEDIA:TYPE=SUBTITLES`;
- if a master playlist is found, fetches the chosen variant in parallel with subtitle discovery;
- selects the exact requested height when possible, otherwise the closest variant.

This parallelization replaced an older sequential probe that added many seconds per lesson.

### HLS assembly

For HLS fallback:

1. The worker calls `ensureOffscreen()`.
2. It sends `lls:assemble` with the init segment (if any) plus all media segments.
3. `offscreen.js` fetches parts using up to **4 concurrent workers**.
4. Parts are concatenated in original order into a `Blob` with MIME `video/mp2t` or `video/mp4`.
5. A blob URL is created and revoked after 60 seconds.
6. The worker calls `chrome.downloads.download()` with `conflictAction: 'uniquify'`.

Progress messages (`Downloading stream (n/total)…`) are relayed from the offscreen document through the worker to the panel.

## 7. Subtitle selection

`chooseSubtitleTracks()` receives:

- page-provided caption tracks;
- worker-captured caption tracks;
- captured caption URLs;
- HLS subtitle tracks;
- requested language codes;
- embedded transcript lines and identity metadata.

`inspectCaptionCandidates()`:

1. Puts page metadata tracks first because `locale.language` is authoritative.
2. Adds captured tracks and caption URLs.
3. Fetches unique candidates in parallel.
4. Uses page-provided codes over URL guessing.
5. Uses cue-text detection only as a secondary signal for opaque URLs.

For each requested language:

- a real track of that language is used;
- otherwise, English falls back to transcript text:
  1. embedded page transcript;
  2. authenticated page-origin GraphQL request;
  3. worker-side GraphQL request.

`normalizeSubtitleText()` converts the text to the selected format:

- SubRip: `application/x-subrip;charset=utf-8`, `.srt`;
- WebVTT: `text/vtt;charset=utf-8`, `.vtt`.

That explicit MIME/extension mapping is why subtitles are not saved as `.txt`.

## 8. Filename construction

`buildFilename(meta, extension, folderMode)` builds a path relative to the Downloads folder:

```text
<Course>/<Section>/<NN> - <Lesson>.<extension>
<Course>/<Section>/<NN> - <Lesson>.<language>.<srt|vtt>
```

- `NN` is `order` padded to two digits.
- `safeName()` removes Windows-invalid characters, collapses whitespace, and caps length at 110 characters.
- If `folderMode === 'flat'`, no course/section folders are added.
- Subtitle files pass `suffix: <language>`, producing `.en.srt`, `.fr.vtt`, etc.
- `conflictAction: 'uniquify'` lets Chrome create `(1)`, `(2)` names rather than overwriting.

## 9. Batch mode internals

Batch state is stored under `chrome.storage.session` as `llsBatch`:

| Field | Meaning |
| --- | --- |
| `active`, `status` | Running, stopped, or done. |
| `tabId` | Only the originating tab may act on the batch. |
| `lessons` | Ordered lesson list with title, URL, slug, section, and order. |
| `index` | Current lesson. |
| `results` | Per-lesson success/failure records. |
| `returnUrl` | Lesson to restore at the end. |
| `resolution`, `downloadVideo`, `downloadSubtitles`, `subtitleLanguages`, `subtitleFormat`, `identity` | Snapshot of chosen options. |
| `startedAt` | Used in the duplicate-download claim key. |

Flow:

1. `lls:batch-start` stores the batch and navigates to lesson 0.
2. Each new lesson page calls `checkBatchState()` and then `runBatchLesson()`.
3. `startAutoPlay()` mutes the `<video>` element and calls `play()`; if needed it clicks a Play button every 900 ms.
4. For video batches, the panel polls captures every second until a playlist appears or 45 seconds elapse.
5. For subtitle-only batches, it waits up to 6 seconds for a caption asset.
6. `sendBatchDownload()` sends `lls:download` with `batch: true`, index, start time, and lesson slug.
7. The worker rejects duplicate claims matching the same tab/start/index/slug.
8. `recordBatchResult()` appends the result, advances the index, and navigates to the next lesson.
9. `finishBatch()` restores `returnUrl` and clears the batch.
10. `lls:batch-stop` marks the batch stopped and also restores `returnUrl`.

A lesson counts as successful if either a video or at least one subtitle file saved. A subtitle warning can coexist with `ok: true`.

## 10. Message map

| Message | Direction | Purpose |
| --- | --- | --- |
| `lls:page` | content -> worker | Report current lesson URL; clear captures if the lesson changed. |
| `lls:getCaptures` | content -> worker | Ask for playlists, captions, caption tracks, and detected languages. |
| `lls:inspectCaptions` | content -> worker | Inspect caption assets before showing language checkboxes. |
| `lls:getBatch` | content -> worker | Restore active batch after navigation. |
| `lls:batch-start` | content -> worker | Start a course batch. |
| `lls:batch-failed` | content -> worker | Record a lesson that produced no stream. |
| `lls:batch-stop` | content -> worker | Stop the batch and return to the original lesson. |
| `lls:batch-clear` | content -> worker | Remove finished batch state. |
| `lls:download` | content -> worker | Save the current lesson (single or batch). |
| `lls:assemble` | worker -> offscreen | Fetch and concatenate HLS parts or create a text blob. |
| `lls:assemble-progress` | offscreen -> worker -> content | Relay part progress to the panel. |

## 11. Stale-context handling

Reloading an extension invalidates already-injected content scripts. Old scripts can throw on `chrome.storage.*` calls and appear to break the UI.

The extension handles this by:

- detecting invalidated contexts in `content.js` and showing **Reload this lesson page**;
- guarding preference loads, button handlers, and storage writes;
- refreshing open LinkedIn Learning tabs in `chrome.runtime.onInstalled`;
- rejecting duplicate batch download claims from stale scripts.

## 12. Performance notes

- Caption assets are fetched in parallel.
- HLS playlist candidates are probed in parallel, capped at 10.
- Each network probe has an 8-second timeout.
- Redundant playlist probing is skipped when a progressive MP4 was already downloaded.
- HLS parts are fetched with 4 concurrent workers.
- Batch mode is still sequential by lesson because each page must load and the player must fetch fresh signed URLs.

## 13. Known limitations

- Encrypted HLS streams are rejected.
- Byte-range HLS segments are not supported.
- Separate audio-only HLS tracks are not merged; some `.ts` files may have no audio.
- Saving depends on the player actually requesting the stream.
- Signed URLs expire; waiting too long requires a page reload.
- Exercise files and course collateral are not downloaded.
- The extension does not transcode or launch ffmpeg.
- `.ts` fallback files need VLC/mpv or the optional converter scripts to become normal `.mp4`.

## 14. Developer verification

Checks used during development:

```powershell
node --check background.js
node --check content.js
node --check offscreen.js
node --check popup.js
```

Mock suites exercised context invalidation, embedded outline/query-string links, subtitle conversion/filenames, language selection, and progressive MP4 selection. Those test harnesses live in the local temp workspace and are not part of the shipped extension.

Current shipped version: see `manifest.json`. Change history: see [CHANGELOG.md](../CHANGELOG.md).
