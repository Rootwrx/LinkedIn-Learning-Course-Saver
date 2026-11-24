'use strict';

const quality = document.getElementById('q');
const folder = document.getElementById('folder');
const status = document.getElementById('status');

chrome.storage.sync.get(['resolution', 'folderMode'], (prefs) => {
  const value = Number(prefs.resolution == null ? 0 : prefs.resolution);
  quality.value = [0, 720, 540, 360].includes(value) ? String(value) : '0';
  folder.value = prefs.folderMode || 'course';
});

function save(key, value) {
  chrome.storage.sync.set({ [key]: value }, () => {
    status.textContent = 'Saved.';
    setTimeout(() => { status.textContent = ''; }, 1500);
  });
}

quality.addEventListener('change', () => save('resolution', Number(quality.value)));
folder.addEventListener('change', () => save('folderMode', folder.value));
