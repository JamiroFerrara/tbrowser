// Seed Vimium's synced settings from tbrowser-settings.json the first time the
// extension runs in this browser. Later user changes live in chrome.storage
// and are never overwritten.
export async function seed() {
  let data;
  try {
    const response = await fetch(chrome.runtime.getURL('tbrowser-settings.json'));
    if (!response.ok) return;
    data = await response.json();
  } catch {
    return;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  try {
    const current = await chrome.storage.sync.get(null);
    if (current && current.settingsVersion) return;
    await chrome.storage.sync.set(data);
  } catch (err) {
    console.warn('tbrowser: could not seed vimium settings:', err);
  }
}
