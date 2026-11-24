# Changelog

## v2.2.0
- Added subtitle downloads as `.srt`, with **Video** and **Subtitles** checkboxes in the lesson panel and toolbar popup.
- English is selected by default; any additional languages exposed by the player or HLS playlist appear as checkboxes.
- Captures LinkedIn's `video-auto-caption-srt-acs-singleton` assets without treating them as HLS playlists or segments.
- Reads `#EXT-X-MEDIA:TYPE=SUBTITLES` tracks and falls back to LinkedIn's transcript API for English when no caption file is available.
- Subtitle choices are saved in `chrome.storage.sync` and carried through single-lesson and whole-course batch downloads.
- Subtitle-only batches wait briefly for the player's caption track before saving.

## v2.1.0
- Added **Save whole course** batch mode: walks every lesson link found in the current course playlist.
- Batch state is stored in `chrome.storage.session`, so it survives navigation and service-worker restarts.
- Lessons are auto-played muted (or the Play button is clicked) to trigger the HLS stream capture.
- Added batch progress, failure tracking, a Stop button, automatic return to the original lesson, and ordered filenames (`01 - …`, `02 - …`).

## v2.0.3
- Moved the final `chrome.downloads.download` call from the offscreen document back to the service worker.
- Offscreen documents now only fetch stream parts and create the blob URL, matching Chrome's `chrome.runtime`-only API restriction.
- Added progress relay from offscreen document to the content script.

## v2.0.2
- Detects real LinkedIn HLS playlists by `Content-Type: application/vnd.apple.mpegURL` instead of `.m3u8` suffix.
- Treats `/0/<timestamp>` URLs as playlist candidates.
- Stops guessing playlist paths when a real candidate was observed.

## v2.0.1
- Replaced the page-world capture hook with `chrome.webRequest` so worker-initiated playlist requests are captured.
- Added `chrome.webNavigation` to clear captures on lesson/SPA navigation.
- Removed `hook.js`.

## v2.0.0
- Replaced the failing `learning-api/detailedCourses` MP4 lookup with captured-player-stream approach.
- Added HLS playlist parsing, quality selection, and local stream assembly.
- Added offscreen blob assembly for MV3 compatibility.

## v1.0.0
- Initial extension: floating **Save lesson** button using LinkedIn's `detailedCourses` API and `progressiveUrl`.
