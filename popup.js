'use strict';

const quality = document.getElementById('q');
const folder = document.getElementById('folder');
const video = document.getElementById('video');
const subs = document.getElementById('subs');
const subtitleFormat = document.getElementById('subtitle-format');
const status = document.getElementById('status');

chrome.storage.sync.get([
  'resolution', 'folderMode', 'downloadVideo', 'downloadSubtitles', 'subtitleLanguages',
  'subtitleFormat',
], (prefs) => {
  const value = Number(prefs.resolution == null ? 0 : prefs.resolution);
  quality.value = [0, 720, 540, 360].includes(value) ? String(value) : '0';
  folder.value = prefs.folderMode || 'course';
  subtitleFormat.value = prefs.subtitleFormat === 'vtt' ? 'vtt' : 'srt';
  video.checked = prefs.downloadVideo !== false;
  subs.checked = prefs.downloadSubtitles !== false;
  if (!Array.isArray(prefs.subtitleLanguages) || !prefs.subtitleLanguages.length) {
    chrome.storage.sync.set({ subtitleLanguages: ['en'] });
  }
});

function save(key, value) {
  chrome.storage.sync.set({ [key]: value }, () => {
    status.textContent = 'Saved.';
    setTimeout(() => { status.textContent = ''; }, 1500);
  });
}

quality.addEventListener('change', () => save('resolution', Number(quality.value)));
folder.addEventListener('change', () => save('folderMode', folder.value));
video.addEventListener('change', () => save('downloadVideo', video.checked));
subs.addEventListener('change', () => {
  save('downloadSubtitles', subs.checked);
  if (subs.checked) {
    chrome.storage.sync.get(['subtitleLanguages'], (prefs) => {
      if (!Array.isArray(prefs.subtitleLanguages) || !prefs.subtitleLanguages.length) {
        save('subtitleLanguages', ['en']);
      }
    });
  }
});
subtitleFormat.addEventListener('change', () => save('subtitleFormat', subtitleFormat.value));
