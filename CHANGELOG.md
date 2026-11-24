# Changelog

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
