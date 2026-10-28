// אחסון מקומי: הגדרות ב־localStorage, ולוגו המותג ב־IndexedDB (קובץ בינארי).
// כל קריאה עטופה, כי במצב גלישה פרטית ובטאבים מסוימים האחסון חסום.
import { normalizeSettings } from './model.js';

const KEY = 'frame-settings';
const DISMISS_KEY = 'frame-install-dismissed';

export function loadSettings() {
  try { return normalizeSettings(JSON.parse(localStorage.getItem(KEY) || 'null')); } catch { return normalizeSettings(null); }
}
export function saveSettings(settings) {
  try { localStorage.setItem(KEY, JSON.stringify(normalizeSettings(settings))); return true; } catch { return false; }
}
export function installDismissedAt() {
  try { return Number(localStorage.getItem(DISMISS_KEY)) || 0; } catch { return 0; }
}
export function dismissInstall(now = Date.now()) {
  try { localStorage.setItem(DISMISS_KEY, String(now)); } catch { /* אין אחסון */ }
}

// ---- IndexedDB: מפתח אחד ללוגו
function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('אין אחסון במכשיר')); return; }
    const req = indexedDB.open('frame-app', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('kv'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('האחסון במכשיר לא נפתח'));
  });
}
async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', mode), store = tx.objectStore('kv');
      const result = fn(store);
      tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
export async function getLogo() {
  try { return (await withStore('readonly', (s) => s.get('logo'))) || null; } catch { return null; }
}
export async function setLogo(blob) {
  try { await withStore('readwrite', (s) => s.put(blob, 'logo')); return true; } catch { return false; }
}
export async function clearLogo() {
  try { await withStore('readwrite', (s) => s.delete('logo')); return true; } catch { return false; }
}
