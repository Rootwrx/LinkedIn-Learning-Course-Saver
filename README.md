# LinkedIn Learning Video Saver

A small Chrome/Edge (Manifest V3) extension that adds a **Save lesson** button to LinkedIn Learning lesson pages. Instead of calling LinkedIn's old `learning-api/detailedCourses` endpoint (which now rejects the request), it captures the HLS stream the lesson player already fetches and saves the video and selected subtitles locally.

> Use this only for courses you are entitled to access (your own subscription / licence). Respect LinkedIn's terms and the course author's copyright — saved copies are for personal offline use.

## What it does

- Detects a lesson page (`linkedin.com/learning/<course>/<lesson>`).
- Uses `chrome.webRequest` to observe the player's real `dms.licdn.com` HLS playlist and segment URLs, including requests made by HLS workers.
- Shows a floating **Save lesson** button plus a live "stream detected" indicator.
- If a master playlist is available, picks the preferred quality (highest / 720p / 540p / 360p). If only a single media playlist was captured, it saves that one.
- Downloads the playlist's parts in the background and assembles one local video file.
- Downloads the selected subtitle tracks as `.srt` files next to the video: from the player's caption asset, HLS `#EXT-X-MEDIA:TYPE=SUBTITLES` metadata, or LinkedIn's transcript API as a fallback.
- Checkboxes let you save **Video**, **Subtitles**, or both. **English** is selected by default; other languages appear when LinkedIn exposes them for the lesson.
- Names the file `NN - <Lesson>.ts` (or `.mp4` when the stream is fragmented MP4) and subtitles `NN - <Lesson>.<language>.srt`. The course name is **not** in the filename — it is the top-level folder.
- When LinkedIn exposes course sections, each section becomes its own subfolder and numbering restarts at `01` inside it.
- Skips chapter quizzes / assessments — only playable video lessons are collected.
- Works on single-page navigations — the button follows the current lesson without a reload.
- **Batch mode:** **Save whole course** walks every video lesson link in the current course playlist, auto-plays each lesson muted to capture its stream, saves the selected files in section order, then returns to the lesson you started from.

No signup, credits, accounts, or external servers. Everything runs locally in your browser.

### About the file format

LinkedIn serves these lessons as HLS, not as a single progressive MP4. The extension concatenates the stream exactly as the player receives it:

- **`.ts`** for regular MPEG-TS HLS. Play it with VLC, mpv, or another player that supports transport streams. Windows Media Player may not open it.
- **`.mp4`** for fragmented HLS containing `#EXT-X-MAP` (an init segment). These are playable in more apps.

LinkedIn's HLS playlists do **not** end in `.m3u8` — they look like `/hls-720p…/<id>/0/<timestamp>`. The extension identifies them by `Content-Type: application/vnd.apple.mpegURL`, not by the URL suffix.

Converting `.ts` to a normal `.mp4` needs a local transcoder/remuxer (for example ffmpeg); that is not bundled in v2.

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
5. Choose a preferred quality (only used when a master playlist is available), then click **Save stream**.
6. Watch the status line for progress. Files land in `Downloads/<Course>/<Section>/` (or flat in `Downloads` if you chose that).

> Timing matters: signed `dms.licdn.com` URLs expire. Click **Save stream** soon after the video starts. If you waited a long time, reload the lesson page and start the video again.

### Batch download a whole course

1. Open any lesson in the course.
2. Click **Save lesson** → check the `Course playlist: N videos in M sections` line.
3. Click **Save whole course**. The tab will walk the lessons automatically.
4. Use **Stop batch** at any time to cancel and return to the original lesson.
5. When it finishes, the status shows `Batch complete: X saved, Y failed` and the tab returns to where you started.

Batch files are prefixed in playlist order (`01 - …`, `02 - …`) so they stay sorted. With sections, the layout is `Downloads/<Course>/<Section>/01 - <Lesson>.ts`, and the next section starts again at `01`. Quizzes are omitted. Subtitle-only batches wait briefly for the player to expose a caption track before saving.

If LinkedIn does not render section headings in the sidebar, the extension falls back to one course folder with continuous numbering.

The popup (toolbar icon) holds the preferred quality, default download choices, and save-structure setting.

## Optional: change settings via popup

- **Download by default** – Video and Subtitles (English). These are pre-checked on lesson pages too.
- **Preferred quality** – highest available, or 720p / 540p / 360p when the master playlist lists variants.
- **Save structure** – course/section folders, or everything flat in `Downloads`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "No stream captured yet" | Start the video and wait a few seconds. The button only sees URLs the player actually requests. Subtitles-only still needs the player to load so it can expose its caption track. |
| "Stream detected" but save says the URL expired | Reload the lesson page, start the video again, and click Save immediately. |
| "Could not open the captured playlist" | The player may use a different request mechanism. Reload the page while signed in, play for a few seconds, then retry. |
| "This lesson stream is encrypted" | LinkedIn enabled HLS encryption for that asset; local saving is not supported. |
| "byte-range segments" | This playlist style is not supported yet. Try another lesson or a future version. |
| "No subtitle track was available" | Play the lesson with captions turned on, wait a few seconds, then retry. If LinkedIn exposes only a transcript, the extension builds an `.srt` from it. |
| Button doesn't appear | Make sure the URL is `www.linkedin.com/learning/<course>/<lesson>` and that you're on the main frame, not an embedded preview. |
| Downloaded `.ts` won't play in Windows Media Player | Open it with VLC or mpv, or remux it locally to `.mp4` with ffmpeg. |
| Saved file has no audio | Some HLS streams split audio into a separate track. This version saves only the video variant. |
| Download starts but stops | Reload the lesson page to get fresh signed URLs, then retry. |
| Batch says `0 videos found` | Scroll the course sidebar so LinkedIn renders its lesson links, then reopen the panel. |
| A quiz was saved / counted | Reload the lesson page; quizzes and assessments are skipped by title and URL. |
| Batch reports a failed lesson | The player did not expose a stream within 45 seconds for that lesson. Reload it and save it individually, then retry the batch. |

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest: permissions, host access, content script, background worker. |
| `background.js` | `webRequest` listener records the player's real HLS/caption URLs per tab, fetches/parses playlists and subtitle tracks, picks the requested quality/languages, and delegates assembly to the offscreen document. |
| `content.js` | Injects the shadow-DOM button/panel and download/language checkboxes, collects course lesson links, drives batch playback, asks for captured URLs, and sends save requests. |
| `offscreen.html` / `offscreen.js` | Hidden DOM context that fetches the segments or subtitle text and creates the blob URL. Offscreen documents only expose `chrome.runtime`, so the service worker starts the download. |
| `popup.html` / `popup.js` | Toolbar settings. |
| `icons/` | Extension icons (regenerate with `tools/make-icons.ps1`). |

## Roadmap (not in v2)

- Optional local `.ts` → `.mp4` remux/transcode.
- Exercise files and a per-course manifest.
