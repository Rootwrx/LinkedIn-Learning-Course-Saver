# LinkedIn Learning Video Saver

A small Chrome/Edge (Manifest V3) extension that adds a **Save lesson** button to LinkedIn Learning lesson pages. Instead of calling LinkedIn's old `learning-api/detailedCourses` endpoint (which now rejects the request), it captures the HLS stream the lesson player already fetches, remuxes it locally into a real `.mp4`, and saves the video and selected subtitles.

> Use this only for courses you are entitled to access (your own subscription / licence). Respect LinkedIn's terms and the course author's copyright — saved copies are for personal offline use.

## What it does

- Detects a lesson page (`linkedin.com/learning/<course>/<lesson>`).
- Uses `chrome.webRequest` to observe the player's real `dms.licdn.com` HLS playlists, init segments, and media segments, including requests made by HLS workers.
- Shows a floating **Save lesson** button plus a live "stream detected" indicator.
- If a master playlist is available, picks the preferred quality (highest / 720p / 540p / 360p). If only a single media playlist was captured, it saves that one.
- Handles both **MPEG-TS** HLS and **fragmented MP4** HLS (`#EXT-X-MAP`). MPEG-TS is remuxed from H.264/AAC; fragmented MP4 is assembled from its init segment and media segments. Neither path re-encodes the video or audio.
- Includes separate fragmented-MP4 audio renditions when LinkedIn provides them, and preserves the source audio/video offset.
- Saves every video as `.mp4` without ffmpeg, re-encoding, uploads, or external services.
- Downloads the selected subtitle tracks as `.srt` or `.vtt` files (your choice) next to the video: from the player's caption asset, HLS `#EXT-X-MEDIA:TYPE=SUBTITLES` metadata, or LinkedIn's transcript API as a fallback. Subtitles are never saved as `.txt`.
- Detects caption language from LinkedIn's own page metadata (authoritative locale codes) first, then from the cue text, so a caption asset without a language hint cannot be saved under the wrong language. English first uses the transcript embedded in the lesson page, then asks the page itself for LinkedIn's transcript (same-origin, authenticated), and only then tries the worker's endpoint.
- Checkboxes let you save **Video**, **Subtitles**, or both. **English** is selected by default; other languages appear when LinkedIn exposes them for the lesson.
- Names the file `NN - <Lesson>.mp4` and subtitles `NN - <Lesson>.<language>.srt` (or `.vtt`). Sidebar noise such as `(Viewed)` and `4m 30s video` is stripped from lesson titles. The course name is **not** in the filename — it is the top-level folder.
- Section folders come from LinkedIn's embedded course outline when available; the visible sidebar headings are used as a fallback. Numbering restarts at `01` inside every section.
- Skips chapter quizzes / assessments — only playable video lessons are collected.
- Works on single-page navigations — the button follows the current lesson without a reload.
- **Batch mode:** **Save whole course** walks every video lesson in the current course, auto-plays each lesson muted to capture its stream, saves the selected files in section order, then returns to the lesson you started from.

No signup, credits, accounts, or external servers. Everything runs locally in your browser.

## Documentation

- [User Guide](docs/USER_GUIDE.md) — install, single lessons, batch mode, settings, filenames, troubleshooting.
- [How it works](docs/HOW_IT_WORKS.md) — architecture, capture model, local MP4 remuxing, subtitles, batch internals, permissions.
- [Converters](docs/CONVERTERS.md) — optional ffmpeg scripts for legacy `.ts` files saved by older versions, including watch mode.

### About the file format

All video saves are real **`.mp4`** files. The extension no longer looks for LinkedIn's signed progressive MP4 URLs; it captures the HLS stream the player actually uses and converts it locally in the offscreen document.

- **MPEG-TS HLS** is remuxed from H.264 video and, when present, AAC audio. Frames are copied into an MP4 container with no re-encoding and no quality loss. The remuxer rebuilds the timeline (including segment timestamp resets and 33-bit wraparound) and converts start-code NAL units and ADTS headers into MP4's `avcC`/`esds` descriptions.
- **Fragmented MP4 HLS** with `#EXT-X-MAP` is assembled from its init segment and media segments into a regular MP4. The extension inspects init segments to find the video and audio tracks; when audio is a separate rendition, that playlist is downloaded too and muxed with the video while preserving the source A/V offset.
- Quality selection applies to the captured HLS master playlist.
- If a stream is encrypted, uses byte ranges, contains unsupported or damaged media, or is missing required video/audio, the save fails with a clear error instead of writing a broken file.

LinkedIn's HLS playlists do **not** end in `.m3u8` — they look like `/hls-720p…/<id>/0/<timestamp>`. The extension identifies them by `Content-Type: application/vnd.apple.mpegURL`, not by the URL suffix.

### Optional: convert older `.ts` files to `.mp4`

New saves are already `.mp4` and do not need ffmpeg. These scripts are only for `.ts` files saved by older versions of the extension. If you have ffmpeg installed, they can remux those legacy files losslessly (`-c copy`, no re-encoding, no quality loss).

Recommended dynamic scanner — scans all of Downloads:

```powershell
.\convert-all-to-mp4.cmd
```

Watch a course folder while a batch download runs:

```powershell
.\convert-all-to-mp4.cmd "C:\Users\hex0r\Downloads\My course" -Watch
```

One folder, one pass:

```powershell
.\convert-to-mp4.cmd "C:\Users\hex0r\Downloads\My course"
```

Subtitles are untouched, existing `.mp4` files are skipped, and Chrome's `(1)`/`(2)` duplicates are skipped by default. Add `-DeleteOriginals` to remove `.ts` files after a successful remux.

> In PowerShell, use the `.\` prefix for local commands. See [Converters](docs/CONVERTERS.md) for every option, watch-mode behavior, ffmpeg setup, and troubleshooting.

## Install (unpacked / developer mode)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (`C:\Users\hex0r\Desktop\linkedIn`).
4. Pin the extension if you like (puzzle icon → pin).
5. Confirm there is no red **Errors** badge on the extension card.

If you edit the code later, come back here and click the **reload** icon on the extension card.

## Use

1. Sign in to LinkedIn Learning with your paid subscription.
2. Open a lesson you can play and **let the video start** — the player must fetch its HLS playlist before the button can save anything.
3. Click **Save lesson** in the bottom-right. The panel shows what was detected, for example `Stream detected (720p): 2 playlists ready.`
4. Under **Download**, keep **Video** and/or **Subtitles** checked. English is checked by default; check any additional languages LinkedIn lists for that lesson.
5. Choose a preferred quality (used when the captured master HLS playlist lists variants) and a subtitle format (**SRT** by default, or **VTT**), then click **Save stream**.
6. Watch the status line for progress, including `Converting to MP4 (…)` and the saved `.mp4` filename. Files land in `Downloads/<Course>/<Section>/` (or flat in `Downloads` if you chose that).

> Timing matters: signed `dms.licdn.com` HLS URLs expire. Click **Save stream** soon after the video starts. If you waited a long time, reload the lesson page and start the video again.

### Batch download a whole course

1. Open any lesson in the course.
2. Click **Save lesson** → check the `Course playlist: N videos in M sections` line.
3. Click **Save whole course**. The tab will walk the lessons automatically.
4. Use **Stop batch** at any time to cancel and return to the original lesson.
5. When it finishes, the status shows `Batch complete: X saved, Y failed` and the tab returns to where you started.

Batch files are prefixed in outline order (`01 - …`, `02 - …`) so they stay sorted. With sections, the layout is `Downloads/<Course>/<Section>/01 - <Lesson>.mp4`, and the next section starts again at `01`. Quizzes are omitted. Subtitle-only batches wait briefly for the player to expose a caption track before saving.

Lesson links with query strings are handled, and LinkedIn's embedded course outline is preferred over sidebar scraping. If neither exposes sections, the extension falls back to one course folder with continuous numbering.

The popup (toolbar icon) holds the preferred quality, default download choices, subtitle format, and save-structure setting.

## Optional: change settings via popup

- **Download by default** – Video and Subtitles (English). These are pre-checked on lesson pages too.
- **Preferred quality** – highest available, or 720p / 540p / 360p when the master playlist lists variants.
- **Subtitle format** – SubRip (`.srt`) or WebVTT (`.vtt`); never plain text.
- **Save structure** – course/section folders, or everything flat in `Downloads`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "No stream captured yet" | Start the video and wait a few seconds. The button only sees URLs the player actually requests. Subtitles-only still needs the player to load so it can expose its caption track. |
| "Stream detected" but save says the URL expired | Reload the lesson page, start the video again, and click Save immediately. |
| "Could not open the captured playlist" | The player may use a different request mechanism. Reload the page while signed in, play for a few seconds, then retry. |
| "This lesson stream is encrypted" | LinkedIn enabled HLS encryption for that asset; local saving is not supported. |
| "byte-range segments" | This playlist style is not supported yet. Try another lesson or a future version. |
| "MP4 conversion failed" | The captured stream may use unsupported codecs, encrypted fragments, or damaged parts. Reload the lesson, play it again, and retry. If it persists, this lesson's format is not supported. |
| "No subtitle track was available" | Play the lesson with captions turned on, wait a few seconds, then retry. If only a different-language caption asset is captured, it will not be saved as another language; the English transcript fallback is used when available. |
| Button doesn't appear | Make sure the URL is `www.linkedin.com/learning/<course>/<lesson>` and that you're on the main frame, not an embedded preview. |
| "Saved MP4 won't play" | A successful save is a standard MP4; try VLC or another player. If the status showed an MP4 conversion error, this version supports H.264/AAC MPEG-TS and fragmented MP4 only. |
| "Saved file has no audio" | Fragmented MP4 lessons with separate audio renditions now combine audio with the video. If audio is still missing, reload the lesson, play it, and retry. MPEG-TS streams require AAC audio in the captured stream. |
| Download starts but stops | Reload the lesson page to get fresh signed URLs, then retry. |
| Panel says "reload this lesson page" | You reloaded the extension in `chrome://extensions`. Click the **Reload this lesson page** button in the panel (or press **F5**). Open lesson tabs are also refreshed automatically after an extension reload. |
| Batch says `0 videos found` | Reload the lesson page and reopen the panel. LinkedIn's embedded outline is used first; sidebar links are a fallback. |
| Only the current video is listed | Reload the lesson page so its embedded course data is available, then reopen the panel. Links with query strings are supported. |
| Saved subtitles are in the wrong language | Reload the lesson page; caption language is detected from LinkedIn's page metadata first, then from cue text, including Telugu, Tagalog, Turkish, Serbian, Swedish, and Vietnamese. If no track in the selected language exists, English uses the page's embedded transcript rather than saving the wrong file. |
| A quiz was saved / counted | Reload the lesson page; quizzes and assessments are skipped by title and outline type. |
| Batch reports a failed lesson | The player did not expose a stream within 45 seconds for that lesson. Reload it and save it individually, then retry the batch. |

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest: permissions, host access, content script, background worker. |
| `background.js` | `webRequest` listener records the player's real HLS/caption URLs per tab, fetches/parses playlists and subtitle tracks, picks the requested quality/languages, detects fragmented-MP4 video and audio renditions, and delegates assembly to the offscreen document. |
| `content.js` | Injects the shadow-DOM button/panel and download/language checkboxes, collects course lesson links, drives batch playback, asks for captured URLs, and sends save requests. |
| `offscreen.html` / `offscreen.js` | Hidden DOM context that fetches stream parts or subtitle text, converts video to MP4, and creates the blob URL. Offscreen documents only expose `chrome.runtime`, so the service worker starts the download. |
| `mp4remux.js` | Dependency-free MPEG-TS (H.264/AAC) and fragmented-MP4 to MP4 remuxer. It rebuilds the timeline and MP4 sample tables without re-encoding. |
| `popup.html` / `popup.js` | Toolbar settings. |
| `convert-to-mp4.ps1` / `.cmd` | One-folder ffmpeg remux helper for legacy `.ts` files saved by older versions. |
| `convert-all-to-mp4.ps1` / `.cmd` | Legacy `.ts` scanner with optional `-Watch` mode. |
| `docs/` | User guide, architecture guide, and converter reference. |
| `icons/` | Extension icons (regenerate with `tools/make-icons.ps1`). |

## Not included

- Exercise files and a per-course manifest.
- Bundled ffmpeg or any re-encoding/transcoding. The in-extension conversion is a local, lossless remux/assembly into MP4; the external scripts are only for legacy `.ts` files and use an ffmpeg you already have.
