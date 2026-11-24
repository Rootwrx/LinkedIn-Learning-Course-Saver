# User Guide

This is the practical guide for everyday use. For the internal design, see [How it works](HOW_IT_WORKS.md). For conversion details, see [Converters](CONVERTERS.md).

## 1. Scope and safety

This extension is for **personal offline access to LinkedIn Learning lessons you are entitled to watch** (your own subscription or licence).

It does **not**:

- sign you in, create accounts, or bypass LinkedIn access controls;
- use credits, servers, or a remote download service;
- bundle ffmpeg or any other transcoder;
- download exercise files, quizzes, or assessments.

Respect LinkedIn's terms and the course author's copyright.

## 2. Requirements

- Chrome or Edge, version **111+**.
- The extension loaded unpacked from this folder.
- An active LinkedIn Learning session in the browser.
- A lesson page you can actually play: `https://www.linkedin.com/learning/<course>/<lesson>`.

Verified environment: Chrome/Edge MV3 on Windows. The converter scripts are Windows PowerShell scripts.

## 3. Install / update

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select `C:\Users\hex0r\Desktop\linkedIn`.
4. Pin the extension if you want quick access to its popup.
5. Open a LinkedIn Learning lesson and confirm a blue **Save lesson** button appears bottom-right.

After editing extension code, return to the extensions page and click the extension's **Reload** button. Open LinkedIn Learning tabs are refreshed automatically on install/update, but if a panel still shows a stale-context error, click **Reload this lesson page** in the panel or press **F5**.

## 4. The lesson panel

Click **Save lesson** to open the panel.

| Area | What it shows / does |
| --- | --- |
| Lesson title and course | The current lesson and course detected from the page. |
| Stream status | Whether the player has exposed a stream, for example `Stream detected (720p): 2 playlists ready.` |
| Course playlist | `Course playlist: N videos in M sections` when the outline is available. |
| Quality | Highest available, 720p, 540p, or 360p. Used when the lesson offers variants. |
| Download | **Video** and **Subtitles** checkboxes. |
| Subtitle languages | Scrollable list. **English** is selected by default; other languages appear when LinkedIn exposes them. |
| Subtitle format | **SubRip (.srt)** or **WebVTT (.vtt)**. Never plain text. |
| Save stream | Saves the current lesson only. |
| Save whole course | Starts the batch walk described below. |
| Stop batch | Cancels a running batch and returns to the original lesson. |
| Reload this lesson page | Shown only when the extension context was invalidated by a reload/update. |

## 5. Save one lesson

1. Open the lesson and **start the video**. The extension only sees URLs the player actually requests.
2. Click **Save lesson**.
3. Wait a few seconds until the stream status is positive.
4. Choose:
   - **Video** and/or **Subtitles**;
   - subtitle languages;
   - subtitle format;
   - preferred quality.
5. Click **Save stream**.
6. Read the status line. Files appear in the browser's Downloads folder.

A successful video save looks like:

```text
Saved MP4 (1080p): 01 - Overview of a network.mp4
```

If the fallback HLS path was used, the status includes the reason in brackets:

```text
Saved TS (720p): 01 - Overview of a network.ts [hls (none in lesson data)]
```

or:

```text
Saved TS: 01 - Overview of a network.ts [hls (no usable progressive MP4)]
```

Those two messages mean:

| Bracketed text | Meaning |
| --- | --- |
| `[hls (none in lesson data)]` | This lesson's embedded metadata did not publish a progressive MP4 URL. HLS assembly was the only option. |
| `[hls (no usable progressive MP4)]` | Progressive MP4 URLs exist but were expired, malformed, or rejected. HLS assembly was used. |

If subtitles fail but the video saved, the video file still remains and the status shows `Subtitle warning: ...`.

### Why you must start the video first

Signed `dms.licdn.com` playlist URLs and progressive MP4 URLs expire. The extension captures the URLs the player fetches; it does not guess or reuse old signed links. If you waited a long time after starting the lesson, reload the lesson page, start the video again, and save immediately.

## 6. Save a whole course

1. Open any lesson in the course.
2. Click **Save lesson** and check the course playlist count.
3. Click **Save whole course**.
4. The tab walks the course automatically. Leave the tab open.
5. Click **Stop batch** at any time to cancel.
6. When finished, the status shows `Batch complete: X saved, Y failed` and the tab returns to the lesson you started from.

What happens per lesson:

1. The batch state is stored in `chrome.storage.session`, so it survives navigation and worker restarts.
2. The tab navigates to the lesson.
3. The lesson is autoplayed muted, or the Play button is clicked, to trigger stream capture.
4. For video batches, the panel waits up to **45 seconds** for a playlist. For subtitle-only batches, it waits up to **6 seconds** for a caption asset.
5. The lesson is saved with the same options you selected.
6. The next lesson starts.

The fixed wait while each lesson page loads and the player fetches a fresh signed stream is the main reason batch downloads take time. It is not usually a bandwidth problem. Since v2.5.4, playlist probes and caption fetches run in parallel and every probe has an 8-second timeout.

### Batch lesson collection

The extension prefers LinkedIn's embedded course outline. If that is unavailable, it falls back to links in the visible sidebar.

It handles:

- lesson links with query strings and trailing slashes;
- section folders, including the `Introduction` section;
- relative numbering that restarts at `01` in each section.

It skips:

- chapter quizzes;
- assessments and knowledge checks;
- non-video items.

Duplicate batch downloads from stale content scripts are rejected by the service worker, so a lesson is saved once.

## 7. Settings

Open the toolbar popup.

| Setting | Default | Effect |
| --- | --- | --- |
| Preferred quality | Highest available | For HLS master playlists, picks that variant or the closest one. For progressive MP4s, picks the closest available height. |
| Download by default: Video | On | Pre-checks **Video** on lesson panels. |
| Download by default: Subtitles | On | Pre-checks **Subtitles**, with English selected. |
| Subtitle format | `.srt` | `.vtt` is also available. Subtitles are never written as `.txt`. |
| Save structure | Course / section folders | `Downloads/<Course>/<Section>/...`. The other option puts everything directly in `Downloads`. |

Settings are stored with `chrome.storage.sync`; active batch state is stored with `chrome.storage.session`.

## 8. File names and folders

With the default **Course / section folders** setting:

```text
Downloads/
  <Course>/
    <Section>/
      01 - Lesson title.mp4
      01 - Lesson title.en.srt
      02 - Another lesson.mp4
      02 - Another lesson.en.srt
    1. Next section/
      01 - First lesson in this section.mp4
      01 - First lesson in this section.en.srt
```

Notes:

- The course name is the folder, not part of the filename.
- Numbering restarts inside each section.
- The order prefix is two digits (`01`, `02`, ...).
- Subtitles add a language suffix, for example `.en.srt` or `.fr.vtt`.
- Titles are sanitized for Windows filenames and trimmed to 110 characters.
- Sidebar noise such as `(Viewed)` and `4m 30s video` is stripped.
- If a file with the same name already exists, Chrome's `uniquify` behavior creates `(1)`, `(2)`, etc. Those are duplicates; the converter scripts skip them by default.

## 9. Video formats

The extension prefers LinkedIn's own signed progressive MP4 when the lesson metadata provides one:

- saved directly as `.mp4`;
- no remuxing or transcoding;
- no ffmpeg needed.

If no usable progressive MP4 exists, it assembles the HLS stream the player used:

- `.ts` for normal MPEG-TS HLS;
- `.mp4` for fragmented HLS that contains `#EXT-X-MAP`.

LinkedIn HLS playlists usually do **not** end in `.m3u8`. They are detected by the response `Content-Type: application/vnd.apple.mpegURL`.

Play `.ts` files with VLC, mpv, or another player that supports transport streams. Windows Media Player may not open them. If you want normal `.mp4` files for those fallbacks, use a converter script below.

## 10. Subtitles

Selected subtitle languages are downloaded next to the video with matching base names.

Sources, in order of preference:

1. Caption metadata embedded in the lesson page. Its `locale.language` is authoritative.
2. Caption assets captured from the player.
3. `#EXT-X-MEDIA:TYPE=SUBTITLES` tracks in HLS playlists.
4. Transcript lines embedded in the lesson page.
5. LinkedIn's authenticated transcript endpoint, called from the lesson page origin.
6. The same endpoint as a worker-side fallback.

Language handling is deliberately conservative:

- English will not silently save a different-language caption file.
- Captions are classified as captions, never as HLS playlists or segments.
- If no track in the requested language exists, English uses the transcript fallback instead of saving the wrong language under `.en`.

## 11. Converters: when and which one

The extension itself does **not** convert files and does **not** launch ffmpeg.

Use a converter only when you have `.ts` fallback files:

| Goal | Use |
| --- | --- |
| Convert existing `.ts` files in one course folder | `convert-to-mp4.cmd` |
| Find `.ts` files anywhere under Downloads and convert them once | `convert-all-to-mp4.cmd` |
| Convert `.ts` files as they finish downloading during a batch | `convert-all-to-mp4.cmd ... -Watch` |

If your videos are already `.mp4`, you do not need a converter.

Full commands and options are in [Converters](CONVERTERS.md).

Quick start in PowerShell from this repository:

```powershell
.\convert-all-to-mp4.cmd
```

Watch a specific course folder:

```powershell
.\convert-all-to-mp4.cmd "C:\Users\hex0r\Downloads\complete guide to supporting and troubleshooting windows 11 for admins by microsoft press" -Watch
```

PowerShell requires the `.\` prefix for commands in the current directory. Plain `convert-all-to-mp4.cmd` produces a "term is not recognized" error even though the file is there.

## 12. Troubleshooting

| Symptom | What to do |
| --- | --- |
| `No stream captured yet` | Start the video, wait a few seconds, then save. Subtitles-only still needs the player to load. |
| `Stream detected` but the URL expired | Reload the lesson page, start the video again, and save immediately. |
| `Could not open the captured playlist` | Reload the page while signed in, play for a few seconds, retry. |
| `This lesson stream is encrypted` | Not supported locally by this extension. |
| `byte-range segments` | Not supported by this version. |
| No requested subtitle language | Turn captions on in the player, wait, retry. English transcript fallback is used when available. |
| Panel says reload the lesson page | Click **Reload this lesson page**, or press F5. |
| Batch says `0 videos found` | Reload the lesson page and reopen the panel so embedded course data is available. |
| Batch reports a failed lesson | The player did not expose a stream within 45 seconds. Save that lesson individually, then retry. |
| Duplicate `(1)` / `(2)` files | Old repeated saves or stale content scripts. Converter scripts skip these by default. |
| `.ts` will not play | Use VLC/mpv, or remux to `.mp4` with a converter script. |
| Saved video has no audio | Some HLS streams put audio on a separate track; this version saves the video variant only. |
| Saves feel slow | Each lesson must load and fetch a fresh signed stream. Batch mode is inherently sequential per lesson. Network probes are already parallel with timeouts. |

## 13. Quick reference

```text
Install:       Load unpacked from C:\Users\hex0r\Desktop\linkedIn
Save lesson:   Open lesson -> play -> Save lesson -> Save stream
Save course:   Open lesson -> Save lesson -> Save whole course
Stop batch:    Stop batch
Reload UI:     Reload this lesson page / F5
Convert once:  .\convert-all-to-mp4.cmd
Convert live:  .\convert-all-to-mp4.cmd "<course folder>" -Watch
```

Version history is in [CHANGELOG.md](../CHANGELOG.md). Technical details are in [How it works](HOW_IT_WORKS.md).
