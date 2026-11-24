# Changelog

## v2.5.1
- Fixed progressive MP4 detection for courses where the embedded metadata is keyed differently: MP4 URLs are now matched to the playing lesson by the digitalmedia asset id shared with the captured HLS playlist.
- Cleaned lesson titles used for filenames: sidebar noise such as `(Viewed)` and `4m 30s video` is stripped, so files are named `01 - Overview of a network.mp4` instead of `01 - Overview of a network (Viewed) 4m 30s video.ts`.

## v2.5.0
- Videos are now saved as real **`.mp4`** files whenever LinkedIn exposes a signed progressive MP4 in the lesson metadata. No remuxing, transcoding, or extra software is needed.
- The quality selector picks the closest available progressive resolution; expired signed links are skipped.
- Falls back to the existing HLS assembly (`.ts`, or `.mp4` for fragmented streams) only when no usable progressive MP4 is present.

## v2.4.7
- The subtitle language list in the lesson panel is now scrollable (capped height) instead of pushing the save buttons off-screen when a lesson exposes many caption languages.
- The panel itself now scrolls if it is taller than the browser window, so every control stays reachable on short screens.

## v2.4.6
- English subtitles now use LinkedIn's own language metadata: caption files embedded in the lesson page carry an authoritative `locale.language`, which is preferred over guessing from opaque URLs or cue text. This fixes lessons where all captured caption assets were foreign-language but an English track was actually available.
- Caption inspection now prioritises these page-provided tracks, so a translated asset can no longer be saved under the wrong language code.
- Expanded language labels for Telugu, Tamil, Kannada, Malayalam, Bengali, Gujarati, Punjabi, Sinhala, Tagalog, Serbian/Croatian, and other locales.

## v2.4.5
- English subtitles now try the lesson page's own authenticated GraphQL endpoint (same-origin, with CSRF token) before giving up, so a captionless lesson can still produce an English transcript.
- The service worker falls back to its direct fetch only if the page-side request is unavailable.
- Subtitle failures now report which language was requested and how many other-language caption tracks were captured.

## v2.4.4
- Added a **Reload this lesson page** button directly in the panel when the extension context is invalidated, so recovery is one click instead of hunting through browser UI.
- Guarded the initial preference load (`chrome.storage.sync.get`) so a stale page cannot abort the whole content script before the download handlers are registered.
- Open LinkedIn Learning tabs are now refreshed automatically when the extension is updated/reloaded, preventing stale content scripts from lingering.

## v2.4.3
- Fixed an error at `content.js:720` (`chrome.storage.sync.set`) after reloading the extension: the old content script no longer throws when its Chrome APIs are invalidated.
- The panel now detects an invalidated extension context and shows a clear **reload this lesson page** message instead of silently failing to download.
- Download/option/batch buttons and storage writes are now guarded so a stale page cannot break the download flow.
- Caption inspection in the worker now always replies, so a translation lookup can never hang a pending download.

## v2.4.2
- Fixed caption languages that LinkedIn mislabels: a Telugu asset saved as `.en`, Tagalog as `.es`, Turkish as `.fr`, Serbian/Croatian as `.pt`, and Swedish as `.de` are now detected correctly from the cue text.
- English fallback now uses the transcript embedded in the lesson page itself (linked to the current video URN) before trying the GraphQL transcript endpoint.
- Lesson titles no longer fall back to the generic `LinkedIn Learning` string when the embedded video metadata has the real title.
- Added detection for Telugu, Tamil, Kannada, Malayalam, Bengali, Gujarati, Punjabi, Sinhala, Tagalog, Serbian/Croatian, Swedish, Turkish, and Vietnamese.

## v2.4.1
- Fixed a case where a Vietnamese caption asset was saved as English because LinkedIn's caption URL had no language code.
- Caption language is now detected from the cue text, including Vietnamese, Chinese, Japanese, Korean, Cyrillic, Arabic, Hebrew, Thai, Hindi, and common Latin languages.
- If the selected language is not actually available, the English transcript fallback is used instead of saving the wrong-language file.
- Language checkboxes now reflect detected caption languages.

## v2.4.0
- Fixed batch lesson collection: links with query strings and trailing slashes are recognized again instead of reporting only the current video.
- Section folders now come from LinkedIn's embedded course outline first; sidebar headings remain a fallback. The `Introduction` section is detected from the course's TOC data.
- Added an explicit **Subtitle format** choice: SubRip (`.srt`, default) or WebVTT (`.vtt`). Subtitle files are no longer written with a plain-text MIME/extension.
- Subtitle downloads use the proper `application/x-subrip` or `text/vtt` MIME type so browsers do not append `.txt`.

## v2.3.0
- Filenames no longer include the course name: they are now `NN - <Lesson>.<ext>` (and `NN - <Lesson>.<language>.srt` for subtitles).
- Course sidebar sections are detected and used as subfolders; numbering restarts at `01` in each section.
- Falls back to one course folder with continuous numbering when no section headings are exposed.
- Chapter quizzes and assessments are skipped when collecting lessons.
- Renamed the save-structure option to **Course / section folders**.

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
