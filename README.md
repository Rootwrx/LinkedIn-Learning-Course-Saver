# LinkedIn Learning Video Saver

A small Chrome/Edge (Manifest V3) extension that adds a **Save lesson** button to LinkedIn Learning lesson pages. Instead of calling LinkedIn's old `learning-api/detailedCourses` endpoint (which now rejects the request), it captures the HLS stream the lesson player already fetches and saves that stream locally.

> Use this only for courses you are entitled to access (your own subscription / licence). Respect LinkedIn's terms and the course author's copyright — saved copies are for personal offline use.

## What it does

- Detects a lesson page (`linkedin.com/learning/<course>/<lesson>`).
- Uses `chrome.webRequest` to observe the player's real `dms.licdn.com` HLS playlist and segment URLs, including requests made by HLS workers.
- Shows a floating **Save lesson** button plus a live "stream detected" indicator.
- If a master playlist is available, picks the preferred quality (highest / 720p / 540p / 360p). If only a single media playlist was captured, it saves that one.
- Downloads the playlist's parts in the background and assembles one local video file.
- Names the file `<Course> - <Lesson>.ts` (or `.mp4` when the stream is fragmented MP4) into a per-course folder by default.
- Works on single-page navigations — the button follows the current lesson without a reload.

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
4. Choose a preferred quality (only used when a master playlist is available), then click **Save stream**.
5. Watch the status line for progress. The file lands in your Downloads folder (or a subfolder named after the course).

> Timing matters: signed `dms.licdn.com` URLs expire. Click **Save stream** soon after the video starts. If you waited a long time, reload the lesson page and start the video again.

The popup (toolbar icon) holds the preferred quality and the save-structure setting.

## Optional: change settings via popup

- **Preferred quality** – highest available, or 720p / 540p / 360p when the master playlist lists variants.
- **Save structure** – one folder per course, or everything flat in `Downloads`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "No stream captured yet" | Start the video and wait a few seconds. The button only sees URLs the player actually requests. |
| "Stream detected" but save says the URL expired | Reload the lesson page, start the video again, and click Save immediately. |
| "Could not open the captured playlist" | The player may use a different request mechanism. Reload the page while signed in, play for a few seconds, then retry. |
| "This lesson stream is encrypted" | LinkedIn enabled HLS encryption for that asset; local saving is not supported. |
| "byte-range segments" | This playlist style is not supported yet. Try another lesson or a future version. |
| Button doesn't appear | Make sure the URL is `www.linkedin.com/learning/<course>/<lesson>` and that you're on the main frame, not an embedded preview. |
| Downloaded `.ts` won't play in Windows Media Player | Open it with VLC or mpv, or remux it locally to `.mp4` with ffmpeg. |
| Saved file has no audio | Some HLS streams split audio into a separate track. This version saves only the video variant. |
| Download starts but stops | Reload the lesson page to get fresh signed URLs, then retry. |

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest: permissions, host access, content script, background worker. |
| `background.js` | `webRequest` listener records the player's real HLS URLs per tab, fetches/parses playlists, picks the requested quality, and delegates assembly to the offscreen document. |
| `content.js` | Injects the shadow-DOM button/panel, asks the background for captured URLs, and sends the save request. |
| `offscreen.html` / `offscreen.js` | Hidden DOM context that fetches the segments and creates the blob URL. Offscreen documents only expose `chrome.runtime`, so the service worker starts the download. |
| `popup.html` / `popup.js` | Toolbar settings. |
| `icons/` | Extension icons (regenerate with `tools/make-icons.ps1`). |

## Roadmap (not in v2)

- Optional local `.ts` → `.mp4` remux/transcode.
- Captions / transcripts as `.srt`.
- Exercise files and a per-course manifest.
