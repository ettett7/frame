// FRAME לטלפון: Service Worker.
// - קבצי האפליקציה נשמרים בהתקנה (כולל סריקה של import סטטיים), ואחר כך מוגשים מהמטמון ומתעדכנים ברקע.
// - כשקובץ השתנה בשרת, האפליקציה מקבלת הודעה "גרסה חדשה מוכנה, לחצו לרענון".
// - ספריות מ־CDN (jsdelivr, Google Fonts): מהמטמון, עם עדכון ברקע.
// - מודלים גדולים (huggingface, onnx, wasm ועוד): מהמטמון קודם, ונשמרים בין גרסאות כדי לא להוריד אותם שוב.
// - מצב לא מקוון: פתיחת האפליקציה נופלת חזרה ל־index.html השמור.
'use strict';

const VERSION = '1.0.0';
const SHELL_CACHE = `frame-shell-${VERSION}`;
const CDN_CACHE = 'frame-cdn-v1';
const MODEL_CACHE = 'frame-models-v1'; // לא נמחק בעדכון גרסה
const KEEP = [SHELL_CACHE, CDN_CACHE, MODEL_CACHE];

// קבצי הליבה. כל השאר (engine/*, features/*) נאסף בסריקת import ובשמירה בזמן שימוש.
const CORE = [
  './', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest',
  'ui/dom.js', 'ui/model.js', 'ui/texts.js', 'ui/store.js', 'ui/engine.js', 'ui/stub.js', 'ui/stubs.js', 'ui/backgrounds.js',
  'ui/screens.js', 'ui/extras.js', 'ui/features-ui.js', 'ui/library-ui.js', 'ui/editor-ui.js', 'ui/post-ui.js', 'ui/overlay.js', 'ui/lowspace-ui.js',
  'icons/frame-mark.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
];
// נקודות כניסה של מודולים שנטענים בשם דינמי (אי אפשר לגלות אותם בסריקה). קובץ שחסר מדולג.
const ENTRIES = [
  'engine/pipeline.js', 'engine/turbo.js', 'engine/fx.js', 'engine/background.js',
  'features/library.js', 'features/batch.js', 'features/quick-editor.js', 'features/post-kit.js', 'features/cover.js',
  'features/teleprompter.js', 'features/reaction.js', 'features/voice-edit.js',
  'engine/fonts/Heebo.ttf', 'engine/fonts/Rubik.ttf', 'assets/music/index.json', 'assets/sfx/index.json',
];

// מודלים: huggingface, וגם storage.googleapis.com (face_landmarker.task וקובצי הרקע של MediaPipe)
const MODEL_HOSTS = /(^|\.)(huggingface\.co|hf\.co|storage\.googleapis\.com)$/i;
const MODEL_EXT = /\.(onnx|wasm|bin|task|tflite|gguf|safetensors|ort|data)(\?.*)?$/i;
const CDN_HOSTS = /(^|\.)(cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com|unpkg\.com)$/i;

// ------------------------------------------------------------------ ניתוב (פונקציה טהורה, נבדקת ב־node)
// מחזירה: 'skip' | 'navigate' | 'models' | 'cdn' | 'shell'
function route({ url, method = 'GET', mode = 'cors', hasRange = false, origin = '' }) {
  let u;
  try { u = new URL(url); } catch { return 'skip'; }
  if (method !== 'GET' || hasRange) return 'skip';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'skip';
  const same = u.origin === origin;
  if (same) {
    if (/^\/api\//.test(u.pathname)) return 'skip'; // ה־API של המק לא נשמר
    if (mode === 'navigate') return 'navigate';
    return 'shell';
  }
  if (u.port === '18775') return 'skip'; // מצב טורבו: המק בבית
  if (MODEL_HOSTS.test(u.hostname) || MODEL_EXT.test(u.pathname)) return 'models';
  if (CDN_HOSTS.test(u.hostname)) return 'cdn';
  return 'skip';
}

// ------------------------------------------------------------------ עזרים

const absolute = (p) => new URL(p, self.registration ? self.registration.scope : self.location.href).href;
const cacheable = (res) => !!res && (res.ok || res.type === 'opaque') && res.status !== 206;

// האם התוכן השתנה? משווים ETag, ואם אין אז Last-Modified ואורך
function changed(a, b) {
  if (!a || !b) return false;
  for (const h of ['etag', 'last-modified', 'content-length']) {
    const x = a.headers.get(h), y = b.headers.get(h);
    if (x && y) return x !== y;
  }
  return false;
}

async function notifyClients(msg) {
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  list.forEach((c) => c.postMessage(msg));
}

let notifyTimer = null;
function announceUpdate(url) {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => { notifyTimer = null; notifyClients({ type: 'UPDATE_AVAILABLE', url }); }, 1200);
}

// קובץ מהמטמון מיד, ובמקביל בדיקה ברשת. אם השתנה, מעדכנים ומודיעים
async function staleWhileRevalidate(request, cacheName, { notify = false } = {}) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreSearch: false });
  const refresh = fetch(request, notify ? { cache: 'no-cache' } : undefined).then(async (res) => {
    if (cacheable(res)) {
      if (notify && hit && changed(hit, res)) announceUpdate(request.url);
      await cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  });
  if (hit) { refresh.catch(() => {}); return hit; }
  return refresh;
}

// תשובה opaque (נשמרה מבקשת no-cors) אינה תקפה לבקשת CORS: הדפדפן היה דוחה אותה, ולכן מתעלמים ממנה ומורידים מחדש
const usable = (hit, request) => !!hit && !(hit.type === 'opaque' && request.mode === 'cors');

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (usable(hit, request)) return hit;
  const res = await fetch(request);
  if (cacheable(res)) cache.put(request, res.clone()).catch(() => {}); // נכשל בשקט כשנגמר המקום
  return res;
}

async function navigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await Promise.race([fetch(request, { cache: 'no-cache' }), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 4000))]);
    if (cacheable(res)) { cache.put(absolute('index.html'), res.clone()).catch(() => {}); }
    return res;
  } catch {
    return (await cache.match(absolute('index.html'))) || (await cache.match(absolute('./'))) || Response.error();
  }
}

// ------------------------------------------------------------------ התקנה: שמירת הקבצים

const IMPORT_RE = [
  /\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g,
  /\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  /new\s+URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url/g,
];

async function precache() {
  const cache = await caches.open(SHELL_CACHE);
  const seen = new Set();
  const queue = [...CORE, ...ENTRIES].map(absolute);
  const MAX = 240;
  while (queue.length && seen.size < MAX) {
    const batch = queue.splice(0, 8).filter((u) => !seen.has(u));
    batch.forEach((u) => seen.add(u));
    await Promise.all(batch.map(async (u) => {
      try {
        const res = await fetch(u, { cache: 'reload' });
        if (!res.ok) return;
        await cache.put(u, res.clone());
        if (!/\.m?js$/i.test(new URL(u).pathname)) return;
        const text = await res.text();
        for (const re of IMPORT_RE) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(text))) { const next = new URL(m[1], u).href; if (!seen.has(next) && next.startsWith(self.location.origin)) queue.push(next); }
        }
      } catch { /* קובץ שחסר או רשת שנפלה: מדלגים, והוא יישמר בזמן שימוש */ }
    }));
  }
}

if (typeof self.addEventListener === 'function') {
  self.addEventListener('install', (event) => { event.waitUntil(precache().catch(() => {})); });

  self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
      for (const k of await caches.keys()) if (k.startsWith('frame-') && !KEEP.includes(k)) await caches.delete(k);
      await self.clients.claim();
    })());
  });

  self.addEventListener('message', (event) => {
    const d = event.data || {};
    if (d.type === 'SKIP_WAITING') self.skipWaiting();
    else if (d.type === 'GET_VERSION' && event.source) event.source.postMessage({ type: 'VERSION', version: VERSION });
  });

  self.addEventListener('fetch', (event) => {
    const req = event.request;
    const kind = route({ url: req.url, method: req.method, mode: req.mode, hasRange: req.headers.has('range'), origin: self.location.origin });
    if (kind === 'skip') return;
    const dev = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(self.location.hostname);
    if (kind === 'navigate') event.respondWith(navigation(req));
    else if (kind === 'models') event.respondWith(cacheFirst(req, MODEL_CACHE));
    else if (kind === 'cdn') event.respondWith(staleWhileRevalidate(req, CDN_CACHE));
    else event.respondWith(dev ? networkFirst(req) : staleWhileRevalidate(req, SHELL_CACHE, { notify: true }));
  });

  // לחיצה על התראה ("הקליפים מוכנים"): מעבירים לחלון הפתוח של האפליקציה ופותחים בו את הספרייה, ואם אין כזה פותחים חלון חדש
  self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil((async () => {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of list) {
        if ('focus' in c) { await c.focus(); c.postMessage({ type: 'OPEN_TAB', tab: 'library' }); return; }
      }
      if (self.clients.openWindow) await self.clients.openWindow('./?tab=library');
    })());
  });
}

// בפיתוח (localhost) תמיד הגרסה העדכנית מהרשת, והמטמון רק גיבוי
async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(request, { cache: 'no-cache' });
    if (cacheable(res)) cache.put(request, res.clone()).catch(() => {});
    return res;
  } catch {
    return (await cache.match(request)) || Response.error();
  }
}

// לבדיקות ב־node
if (typeof self !== 'undefined') self.__frameSW = { route, changed, usable, cacheable, VERSION, CORE, ENTRIES, IMPORT_RE };
