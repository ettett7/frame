// library.js: ספריית הקליפים של FRAME בטלפון. הקליפים נשמרים ב־IndexedDB ושורדים סגירה של האפליקציה.
//
// ממשק עיקרי (הכול async):
//   library.save(clip, {id?, keepSource:'auto'|'always'|'never', onLowSpace?, extractSource?}) -> פריט (בלי blob)
//   library.list({sort:'newest'|'oldest'|'title'|'size'|'duration'|'updated', query?, limit?, offset?}) -> [פריט]
//   library.get(id) -> Clip מלא ({blob, url, state, needsSource, ...}) או null.  את clip.url צריך לשחרר: library.release(clip)
//   library.remove(id) / removeMany(ids), library.rename(id, title), library.relink(id, file)
//   library.usage() -> כמה מקום תפוס;  library.persist() -> בקשת שמירה קבועה
//   library.suggestCleanup({needBytes}) -> הצעת מחיקה של קליפים ישנים. הספרייה לא מוחקת לבד: רק מה שהמשתמש אישר.
//   library.exportAll({ids?, onProgress, signal}) -> {blob, file, name, count}  (ZIP), library.share(file)
//
// איך נשמר "מצב העריכה" (clip.state, מהצינור): הפונקציות של המצלמה (rectAt וכו') אינן ניתנות לשמירה ב־IndexedDB,
// לכן הן נדגמות (20 דגימות לשנייה, ועם דגימה משני צדי כל חיתוך) ומשוחזרות בקריאה כפונקציות אינטרפולציה.
// קובץ המקור (state.file):
//   • קטן (עד maxSourceBytes, ברירת מחדל 80MB): נשמר בעותק אחד לכל סרטון מקור, גם אם יצאו ממנו כמה קליפים.
//   • גדול: אם הועבר extractSource(file, [start, end]) -> Blob, נשמר רק הקטע הרלוונטי (וזמני המקור ב־state מוזזים בקריאה).
//     אחרת נשמרת רק הפניה (שם, גודל, lastModified, וגם FileSystemFileHandle כשיש), והקליפ מסומן needsSource:true.
//     אחרי שהמשתמש בוחר שוב את הסרטון, library.relink(id, file) מאמת שזה אותו קובץ.
//
// שכבת האחסון ניתנת להחלפה (backend): createIdbBackend() לדפדפן, createMemoryBackend() לבדיקות ב־node ולגיבוי
// כשאין IndexedDB (למשל גלישה פרטית ישנה). שניהם מממשים: get, getAll, batch(ops), close.
// batch הוא אטומי (הכול או כלום), והזכרון הדמה משכפל ב־structuredClone בדיוק כמו IndexedDB (פונקציה בתוך רשומה נכשלת).
//
// מגבלות אחסון שכדאי להכיר:
//  • המכסה נקבעת על ידי הדפדפן (לרוב חלק גדול מהדיסק הפנוי). navigator.storage.estimate גס, ובאייפון הוא לא תמיד מדויק, ולכן גם שגיאת QuotaExceeded מטופלת כמו "אין מקום".
//  • בטאב רגיל של Safari, מידע שהאתר כתב נמחק אחרי 7 ימים בלי שימוש (ITP). אפליקציה שהוספה למסך הבית פטורה. persist() עוזר בכרום ובדפדפנים אחרים, ובאייפון אין הבטחה.
//  • גלישה פרטית או מצב שבו IndexedDB נחסם: עוברים לאחסון בזיכרון (status().persistent === false), והקליפים נעלמים בסגירה. הממשק צריך להציג על כך אזהרה.
//  • Safari ישן (לפני 14) שומר Blob ב־IndexedDB בצורה לא אמינה. לכן כל שמירה מאומתת (הסרטון נקרא בחזרה ונבדק גודלו).
//  • אין מחיקה אוטומטית: גם כשחסר מקום, הספרייה רק מציעה, וה־callback onLowSpace מחזיר את המזהים שהמשתמש אישר.

// ------------------------------------------------------------------------------------------------ קבועים ועזרים

const KB = 1024; const MB = 1024 * KB; const GB = 1024 * MB;
export const DB_NAME = 'frame-library';
export const DB_VERSION = 1;
/** clips: מטא־דאטה ותמונה ממוזערת (קטן, לרשימה). blobs: הסרטון. states: מצב העריכה. sources: סרטוני מקור. jobs ו־inbox: התור (batch.js). */
export const STORES = ['clips', 'blobs', 'states', 'sources', 'jobs', 'inbox'];
export const DEFAULTS = {
  maxSourceBytes: 80 * MB,     // מקור גדול מזה לא נשמר במלואו
  lowFreeBytes: 200 * MB,      // מתחת לזה נחשב "עומד להיגמר"
  lowRatio: 0.9,               // או שהתפוסה מעל 90%
  minReserveBytes: 32 * MB,    // מרווח ביטחון שנשאר פנוי אחרי שמירה (הגדול מבין זה ל־reserveRatio מהמכסה)
  reserveRatio: 0,
  titleMax: 120,
};

export class LibraryFullError extends Error {
  constructor(message, info = {}) { super(message); this.name = 'LibraryFullError'; Object.assign(this, info); }
}
export class AbortError extends Error {
  constructor(message = 'הפעולה בוטלה') { super(message); this.name = 'AbortError'; }
}
const isAbort = (e) => !!e && (e.name === 'AbortError' || e.code === 20);
const errText = (e) => String((e && e.message) || e || 'שגיאה לא ידועה');
const isQuotaError = (e) => !!e && (e.name === 'LibraryFullError' || e.name === 'QuotaExceededError' || e.code === 22 || /quota/i.test(`${e.name} ${e.message}`));
const isCloneError = (e) => !!e && (e.name === 'DataCloneError' || e.code === 25);
const isConnLost = (e) => !!e && (e.name === 'UnknownError' || e.name === 'InvalidStateError' || /connection to indexed database server lost|database connection is closing/i.test(errText(e)));

const isBlob = (x) => !!x && typeof x === 'object' && typeof x.size === 'number' && typeof x.slice === 'function' && typeof x.arrayBuffer === 'function';
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
let idCounter = 0;
export const newId = () => `c${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function formatBytes(n) {
  if (!finite(n) || n < 0) return '';
  if (n < KB) return `${Math.round(n)}B`;
  if (n < MB) return `${Math.round(n / KB)}KB`;
  if (n < GB) return `${n < 10 * MB ? (n / MB).toFixed(1) : Math.round(n / MB)}MB`;
  return `${(n / GB).toFixed(n < 10 * GB ? 2 : 1)}GB`;
}

/** מזהה סרטון מקור: אותו שם, גודל וזמן שינוי = אותו קובץ. */
export const fingerprintOf = (f) => `${f?.name || ''}|${f?.size ?? 0}|${f?.lastModified || 0}`;

const EXT = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-m4v': 'm4v' };
const extOf = (mime) => EXT[String(mime || '').split(';')[0].trim().toLowerCase()] || 'mp4';

// ------------------------------------------------------------------------------------------------ שכבות אחסון

/** שכבת IndexedDB. כל החנויות עם keyPath:'id'. אם החיבור נפל (באג ידוע ב־Safari אחרי רקע) מנסים פעם אחת שוב. */
export function createIdbBackend({ name = DB_NAME, indexedDB: idb = globalThis.indexedDB } = {}) {
  if (!idb) throw new Error('IndexedDB לא זמין בדפדפן הזה');
  let dbp = null;
  const reset = () => { dbp = null; };
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      let req;
      try { req = idb.open(name, DB_VERSION); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); reset(); };
        db.onclose = reset;
        resolve(db);
      };
      req.onerror = () => reject(req.error || new Error('פתיחת מסד הנתונים נכשלה'));
      req.onblocked = () => reject(new Error('מסד הנתונים חסום על ידי לשונית אחרת של האפליקציה. סגרו אותה ונסו שוב'));
    }).catch((e) => { reset(); throw e; });
    return dbp;
  }
  async function attempt(stores, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let tx; const holder = {};
      try { tx = db.transaction(stores, mode); } catch (e) { reject(e); return; }
      tx.oncomplete = () => resolve(holder.value);
      tx.onerror = () => reject(tx.error || new Error('פעולת האחסון נכשלה'));
      tx.onabort = () => reject(tx.error || new Error('פעולת האחסון בוטלה'));
      try { fn(tx, holder); } catch (e) { try { tx.abort(); } catch (_) { /* כבר נסגרה */ } reject(e); }
    });
  }
  async function run(stores, mode, fn) {
    try { return await attempt(stores, mode, fn); } catch (e) {
      if (!isConnLost(e)) throw e;
      reset(); return attempt(stores, mode, fn);
    }
  }
  const req = (r, holder) => { r.onsuccess = () => { holder.value = r.result; }; };
  return {
    kind: 'idb', persistent: true,
    open,
    get: (store, key) => run([store], 'readonly', (tx, h) => req(tx.objectStore(store).get(key), h)),
    getAll: (store) => run([store], 'readonly', (tx, h) => req(tx.objectStore(store).getAll(), h)).then((x) => x || []),
    batch: (ops) => (ops.length ? run([...new Set(ops.map((o) => o.store))], 'readwrite', (tx) => {
      for (const op of ops) {
        const os = tx.objectStore(op.store);
        if (op.op === 'put') os.put(op.value); else if (op.op === 'delete') os.delete(op.key); else if (op.op === 'clear') os.clear();
      }
    }) : Promise.resolve()),
    close: async () => { if (dbp) { try { (await dbp).close(); } catch (_) { /* לא נפתח */ } reset(); } },
  };
}

/** שכבת זיכרון עם אותה התנהגות כמו IndexedDB: שכפול ב־structuredClone (ערכים לא ניתנים לשכפול נכשלים) ופעולת batch אטומית. */
export function createMemoryBackend({ persistent = false } = {}) {
  const stores = Object.fromEntries(STORES.map((s) => [s, new Map()]));
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  return {
    kind: 'memory', persistent, stores,
    get: async (store, key) => clone(stores[store].get(key)),
    getAll: async (store) => [...stores[store].values()].map(clone),
    batch: async (ops) => {
      const prepared = ops.map((op) => (op.op === 'put' ? { ...op, value: clone(op.value) } : op));   // נכשל לפני שמשנים משהו
      for (const op of prepared) {
        if (!stores[op.store]) throw new Error(`חנות לא קיימת: ${op.store}`);
        if (op.op === 'put') stores[op.store].set(op.value.id, op.value);
        else if (op.op === 'delete') stores[op.store].delete(op.key);
        else if (op.op === 'clear') stores[op.store].clear();
      }
    },
    close: async () => {},
  };
}

// ------------------------------------------------------------------------------------------------ שמירת state

const EPS = 1e-3;

/** דוגם פונקציה של זמן (שמחזירה מספר או אובייקט של מספרים) לטבלה קטנה, כולל שני צדי כל חיתוך. */
export function sampleFunction(fn, duration, { fps = 20, cuts = [] } = {}) {
  const D = finite(duration) && duration > 0 ? duration : 0;
  const set = new Set();
  const n = Math.max(1, Math.ceil(D * fps));
  for (let i = 0; i <= n; i++) set.add(Math.min(i / fps, D));
  for (const c of cuts || []) if (finite(c) && c > 0 && c < D) { set.add(Math.max(0, c - EPS)); set.add(c); }
  const times = Float64Array.from([...set].sort((a, b) => a - b));
  let last;
  const at = (t) => { try { const v = fn(t); if (v !== undefined && v !== null) last = v; } catch (_) { /* משתמשים בדגימה הקודמת */ } return last; };
  const first = at(times[0]);
  const keys = first && typeof first === 'object' ? Object.keys(first).filter((k) => finite(first[k])) : null;
  const constants = first && typeof first === 'object' ? Object.fromEntries(Object.entries(first).filter(([k, v]) => !finite(v) && ['string', 'boolean'].includes(typeof v))) : null;
  const width = keys ? keys.length : 1;
  const data = new Float32Array(times.length * width);
  for (let i = 0; i < times.length; i++) {
    const v = i === 0 ? first : at(times[i]);
    if (keys) keys.forEach((k, j) => { const x = v?.[k]; data[i * width + j] = finite(x) ? x : 0; });
    else data[i] = finite(v) ? v : 0;
  }
  return { __sampled: 1, times, keys, constants, data };
}

/** מחזיר פונקציה של זמן שמשחזרת טבלה מ־sampleFunction (אינטרפולציה ליניארית; מחוץ לטווח: הערך בקצה). */
export function sampledToFunction(rec) {
  const { times, keys, constants, data } = rec;
  const n = times.length; const width = keys ? keys.length : 1;
  return (t) => {
    let lo = 0; let hi = n - 1;
    if (!(t > times[0])) hi = lo = 0; else if (t >= times[n - 1]) lo = hi = n - 1;
    else {
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid; }
    }
    const span = times[hi] - times[lo];
    const f = hi === lo || span <= 0 ? 0 : (t - times[lo]) / span;
    if (!keys) return data[lo] + (data[hi] - data[lo]) * f;
    const out = constants ? { ...constants } : {};
    for (let j = 0; j < width; j++) out[keys[j]] = data[lo * width + j] + (data[hi * width + j] - data[lo * width + j]) * f;
    return out;
  };
}

const isAudioBufferLike = (v) => v && typeof v.getChannelData === 'function' && finite(v.sampleRate) && finite(v.numberOfChannels);

/** מנקה ערך לשמירה: מוריד פונקציות ואובייקטים שאינם ניתנים לשכפול, ומתעד מה ירד ב־ctx.dropped. */
function sanitize(v, ctx, path, stack) {
  const t = typeof v;
  if (v === null || t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint') return v;
  if (t === 'undefined') return undefined;
  if (t === 'function' || t === 'symbol') { ctx.dropped.push(path); return undefined; }
  if (isBlob(v) || ArrayBuffer.isView(v) || v instanceof ArrayBuffer || v instanceof Date) return v;
  if (isAudioBufferLike(v)) { ctx.dropped.push(`${path} (AudioBuffer: ענק, ומפענחים אותו מחדש מהמקור)`); return undefined; }
  if (stack.has(v)) { ctx.dropped.push(`${path} (מעגלי)`); return undefined; }
  stack.add(v);
  try {
    if (Array.isArray(v)) return v.map((x, i) => { const r = sanitize(x, ctx, `${path}[${i}]`, stack); return r === undefined ? null : r; });
    if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, sanitize(x, ctx, `${path}.${String(k)}`, stack)]));
    if (v instanceof Set) return new Set([...v].map((x) => sanitize(x, ctx, path, stack)));
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) { ctx.dropped.push(`${path} (${v.constructor?.name || 'אובייקט'})`); return undefined; }
    const out = {};
    for (const k of Object.keys(v)) { const r = sanitize(v[k], ctx, path ? `${path}.${k}` : k, stack); if (r !== undefined) out[k] = r; }
    return out;
  } finally { stack.delete(v); }
}

const planSeconds = (plan) => {
  if (finite(plan?.duration) && plan.duration > 0) return plan.duration;
  return (plan?.segments || []).reduce((s, seg) => s + Math.max(0, (seg?.[1] ?? 0) - (seg?.[0] ?? 0)), 0);
};

function cameraToData(cam, duration, ctx) {
  const { rectAt, split, cuts, ...rest } = cam;
  const cutList = Array.isArray(cuts) ? cuts.filter(finite) : [];
  const out = { __camera: 1, ...sanitize(rest, ctx, 'camera', new Set()), cuts: cutList, rect: sampleFunction(rectAt, duration, { cuts: cutList }) };
  if (split && typeof split === 'object') {
    const { topAt, bottomAt, ...sRest } = split;
    out.split = { ...sanitize(sRest, ctx, 'camera.split', new Set()) };
    if (typeof topAt === 'function') out.split.top = sampleFunction(topAt, duration, { cuts: cutList });
    if (typeof bottomAt === 'function') out.split.bottom = sampleFunction(bottomAt, duration, { cuts: cutList });
  }
  return out;
}

function dataToCamera(d) {
  const { __camera, rect, split, ...rest } = d;
  const cam = { ...rest, rectAt: sampledToFunction(rect) };
  if (split) {
    const { top, bottom, ...sRest } = split;
    cam.split = { ...sRest };
    if (top) cam.split.topAt = sampledToFunction(top);
    if (bottom) cam.split.bottomAt = sampledToFunction(bottom);
  }
  return cam;
}

/** state של קליפ -> נתונים שאפשר לשמור (בלי file). מחזיר {data, dropped}. */
export function serializeState(state, { duration } = {}) {
  const ctx = { dropped: [] };
  const D = planSeconds(state?.plan) || (finite(duration) ? duration : 0);
  const { file, fileHandle, camera, ...rest } = state || {};
  const data = sanitize(rest, ctx, '', new Set()) || {};
  if (camera && typeof camera.rectAt === 'function') data.camera = cameraToData(camera, D, ctx);
  else if (camera) { const c = sanitize(camera, ctx, 'camera', new Set()); if (c) data.camera = c; }
  return { data, dropped: ctx.dropped };
}

const shiftMoment = (m, d) => {
  const sh = (x) => (finite(x) ? x + d : x);
  const out = { ...m, start: sh(m.start), end: sh(m.end) };
  if (finite(m.peak)) out.peak = m.peak + d;
  if (Array.isArray(m.parts)) out.parts = m.parts.map((p) => shiftMoment(p, d));
  return out;
};

/** מזיז את כל השדות בזמני מקור (plan.segments, moment, transcript). אם נוספו ל־state שדות כאלה, יש להוסיף אותם כאן. */
export function shiftSourceTimes(state, delta) {
  if (!delta || !state) return state;
  const out = { ...state };
  if (Array.isArray(state.plan?.segments)) out.plan = { ...state.plan, segments: state.plan.segments.map(([a, b]) => [a + delta, b + delta]) };
  if (state.moment) out.moment = shiftMoment(state.moment, delta);
  if (state.transcript) {
    const sh = (x) => ({ ...x, start: x.start + delta, end: x.end + delta });
    out.transcript = { ...state.transcript, words: (state.transcript.words || []).map(sh), segments: (state.transcript.segments || []).map(sh) };
  }
  return out;
}

/** נתונים שנשמרו -> state חי (המצלמה חוזרת עם rectAt וכו'). */
export function reviveState(data, { file = null, offset = 0 } = {}) {
  if (!data) return null;
  const out = { ...data };
  if (data.camera?.__camera) out.camera = dataToCamera(data.camera);
  let state = offset ? shiftSourceTimes(out, -offset) : out;
  if (offset) state = { ...state, sourceOffset: offset };
  state.file = file;
  return state;
}

/** הקטע הרלוונטי בסרטון המקור, בשניות: [תחילה, סוף]. */
export function relevantRange(state) {
  const segs = state?.plan?.segments;
  if (Array.isArray(segs) && segs.length) {
    const a = Math.min(...segs.map((s) => s[0])); const b = Math.max(...segs.map((s) => s[1]));
    if (finite(a) && finite(b) && b > a) return [a, b];
  }
  const m = state?.moment;
  if (m && finite(m.start) && finite(m.end) && m.end > m.start) return [m.start, m.end];
  return null;
}

// ------------------------------------------------------------------------------------------------ ZIP

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

/** CRC32 של בתים. אפשר לשרשר: crc32(b, crc32(a)) שווה ל־crc32(a+b). */
export function crc32(bytes, seed = 0) {
  let c = (seed ^ 0xFFFFFFFF) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const CHUNK = 4 * MB;
async function blobCrc(blob, { signal, onBytes } = {}) {
  let crc = 0;
  for (let pos = 0; pos < blob.size; pos += CHUNK) {
    if (signal?.aborted) throw new AbortError('הייצוא בוטל');
    crc = crc32(new Uint8Array(await blob.slice(pos, Math.min(blob.size, pos + CHUNK)).arrayBuffer()), crc);
    onBytes?.(Math.min(CHUNK, blob.size - pos));
  }
  return crc;
}

const dosDateTime = (d) => {
  const y = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
};

/**
 * בונה קובץ ZIP (בלי דחיסה: הסרטונים כבר דחוסים). entries = [{name, data: Blob|Uint8Array|ArrayBuffer|string, date?}].
 * הקובץ מורכב מהפניות ל־Blob, כך שהזיכרון לא מחזיק את כל הסרטונים. שמות בעברית נשמרים כ־UTF-8.
 * מגבלה: בלי ZIP64, לכן עד 4GB ועד 65,535 קבצים.
 */
export async function makeZip(entries, { signal, onProgress } = {}) {
  const enc = new TextEncoder();
  const blobs = entries.map((e) => (isBlob(e.data) ? e.data : new Blob([typeof e.data === 'string' ? enc.encode(e.data) : e.data])));
  const totalBytes = blobs.reduce((s, b) => s + b.size, 0);
  if (entries.length > 0xFFFF || totalBytes > 0xFFFFFFFF - 1 * MB) throw new Error('קובץ ה־ZIP יהיה גדול מ־4GB, ולכן אי אפשר ליצור אותו בבת אחת. ייצאו חלק מהקליפים בכל פעם');
  const parts = []; const central = [];
  let offset = 0; let done = 0;
  for (let i = 0; i < entries.length; i++) {
    const name = enc.encode(String(entries[i].name).replace(/\\/g, '/').replace(/^\/+/, ''));
    const blob = blobs[i];
    const crc = await blobCrc(blob, { signal, onBytes: (n) => { done += n; onProgress?.(totalBytes ? done / totalBytes : 1, `אורזים: ${entries[i].name}`); } });
    const { time, date } = dosDateTime(entries[i].date instanceof Date ? entries[i].date : new Date());
    const lh = new DataView(new ArrayBuffer(30 + name.length));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, blob.size, true); lh.setUint32(22, blob.size, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    new Uint8Array(lh.buffer).set(name, 30);
    const ch = new DataView(new ArrayBuffer(46 + name.length));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, blob.size, true); ch.setUint32(24, blob.size, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    new Uint8Array(ch.buffer).set(name, 46);
    parts.push(lh.buffer, blob); central.push(ch.buffer);
    offset += lh.byteLength + blob.size;
  }
  const centralSize = central.reduce((s, b) => s + b.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  onProgress?.(1, 'הקובץ מוכן');
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

/** שם קובץ בטוח: בלי תווים אסורים, בלי נקודות בקצה, עד 80 תווים. */
export function safeFileName(s, fallback = 'clip') {
  const t = String(s ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '').slice(0, 80).trim();
  return t || fallback;
}

// ------------------------------------------------------------------------------------------------ הספרייה

const collator = (() => { try { return new Intl.Collator('he', { numeric: true }); } catch (_) { return { compare: (a, b) => String(a).localeCompare(String(b)) }; } })();
const SORTS = {
  newest: (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1),
  oldest: (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
  updated: (a, b) => b.updatedAt - a.updatedAt,
  title: (a, b) => collator.compare(a.title, b.title) || b.createdAt - a.createdAt,
  size: (a, b) => b.bytes - a.bytes,
  duration: (a, b) => b.duration - a.duration,
};
const SORT_ALIASES = { new: 'newest', date: 'newest', old: 'oldest', name: 'title', big: 'size', long: 'duration' };

/**
 * יוצר ספרייה. env מאפשר להחליף navigator/URL/document (לבדיקות); backend מאפשר להחליף את האחסון.
 */
export function createLibrary({ backend = null, env = {}, defaults = {}, now = () => Date.now() } = {}) {
  const cfg = { ...DEFAULTS, ...defaults };
  const nav = () => env.navigator ?? globalThis.navigator;
  const URLc = () => env.URL ?? globalThis.URL;
  const doc = () => env.document ?? globalThis.document;
  const listeners = new Set();
  const emit = (event) => { for (const fn of [...listeners]) { try { fn(event); } catch (_) { /* מאזין פגום לא מפיל */ } } };
  let be = backend; let beReady = backend ? Promise.resolve(backend) : null; let fallbackReason = null;
  let chain = Promise.resolve();
  let lastStamp = 0;
  const thumbUrls = new Map();

  /** פותח את האחסון בעצלתיים. אם IndexedDB לא זמין או לא נפתח, עוברים לזיכרון (ומדווחים על כך ב־status). */
  function B() {
    if (beReady) return beReady;
    beReady = (async () => {
      try {
        if (!(env.indexedDB ?? globalThis.indexedDB)) throw new Error('IndexedDB לא זמין בדפדפן הזה');
        const idb = createIdbBackend({ indexedDB: env.indexedDB ?? globalThis.indexedDB });
        await idb.open();
        be = idb;
      } catch (e) {
        fallbackReason = errText(e);
        be = createMemoryBackend();
      }
      return be;
    })();
    return beReady;
  }
  const exclusive = (fn) => { const run = chain.then(() => fn()); chain = run.catch(() => {}); return run; };
  const stamp = () => { lastStamp = Math.max(now(), lastStamp + 1); return lastStamp; };

  async function estimate() {
    try {
      const s = nav()?.storage;
      if (!s?.estimate) return null;
      const e = await s.estimate();
      // כרום במצב זמני/פרטי מחזיר quota == usage (גם כשכתיבה של עשרות MB מצליחה). זו הערכה חסרת משמעות, ולכן מתעלמים ממנה:
      // במקרה כזה לא חוסמים מראש, ואם הכתיבה באמת נכשלת (QuotaExceeded) מופעל אותו תהליך של הצעת מחיקה.
      if (!finite(e?.quota) || !finite(e?.usage) || e.quota <= 0 || e.quota <= e.usage) return null;
      return { usage: e.usage, quota: e.quota };
    } catch (_) { return null; }
  }

  const itemBytes = (m) => (m.bytes || 0) + (m.thumbBytes || 0);

  /** כמה בייטים ישוחררו אם נמחק את הקליפים האלה: הסרטונים והתמונות, ומקור רק אם כל הקליפים שמשתמשים בו נמחקים. */
  function freedBy(ids, metas) {
    const set = new Set(ids); let bytes = 0; const srcs = new Map();
    for (const m of metas) {
      if (!set.has(m.id)) continue;
      bytes += itemBytes(m);
      if (m.sourceKey && m.sourceStoredBytes) srcs.set(m.sourceKey, m.sourceStoredBytes);
    }
    for (const [key, n] of srcs) if (!metas.some((o) => !set.has(o.id) && o.sourceKey === key)) bytes += n;
    return bytes;
  }

  /** מציע קליפים למחיקה, מהישן לחדש, עד שמגיעים לכמות הנדרשת. הצעה בלבד: לא מוחקים כלום. */
  function buildSuggestion(metas, shortBy, est, needed) {
    const chosen = []; const candidates = []; let freeable = 0;
    for (const m of [...metas].sort(SORTS.oldest)) {
      chosen.push(m.id);
      const total = freedBy(chosen, metas);
      candidates.push({ id: m.id, title: m.title, createdAt: m.createdAt, bytes: total - freeable });
      freeable = total;
      if (freeable >= shortBy) break;
    }
    return { needed, shortBy, free: est ? est.quota - est.usage : null, quota: est?.quota ?? null, usage: est?.usage ?? null, candidates, freeable, enough: freeable >= shortBy };
  }

  async function removeInternal(ids) {
    const b = await B();
    const metas = await b.getAll('clips');
    const gone = new Set(ids);
    const victims = metas.filter((m) => gone.has(m.id));
    if (!victims.length) return 0;
    const ops = [];
    for (const m of victims) {
      ops.push({ op: 'delete', store: 'clips', key: m.id }, { op: 'delete', store: 'blobs', key: m.id }, { op: 'delete', store: 'states', key: m.id });
    }
    for (const key of new Set(victims.map((m) => m.sourceKey).filter(Boolean))) {
      if (!metas.some((o) => !gone.has(o.id) && o.sourceKey === key)) ops.push({ op: 'delete', store: 'sources', key });
    }
    await b.batch(ops);
    for (const m of victims) revokeThumb(m.id);
    return victims.length;
  }

  /** מוודא שיש מקום. כשאין: מציע מחיקה, ורק אם ה־callback מחזיר מזהים שהמשתמש אישר, מוחק אותם. */
  async function ensureSpace(needed, o, { force = false } = {}) {
    const est = await estimate();
    if (!est && !force) return;
    const reserve = est ? Math.max(cfg.minReserveBytes, est.quota * cfg.reserveRatio) : 0;
    const free = est ? est.quota - est.usage : 0;
    let shortBy = est ? needed + reserve - free : needed;
    if (shortBy <= 0 && !force) return;
    if (force) shortBy = Math.max(shortBy, needed);   // הדפדפן אמר "אין מקום" למרות שההערכה אמרה אחרת
    const b = await B();
    const metas = await b.getAll('clips');
    const suggestion = buildSuggestion(metas, shortBy, est, needed);
    if (typeof o?.onLowSpace === 'function') {
      const approved = await o.onLowSpace(suggestion);
      const ids = (Array.isArray(approved) ? approved : []).filter((id) => metas.some((m) => m.id === id));
      if (ids.length) {
        const freed = freedBy(ids, metas);
        if (freed >= shortBy) {                       // מוחקים רק אם זה באמת מפנה מספיק מקום לשמירה
          await removeInternal(ids);
          emit({ type: 'remove', ids });
          return;
        }
        suggestion.stillShort = shortBy - freed;      // לא מספיק: לא נמחק דבר, והממשק יבקש לסמן עוד
      }
    }
    throw new LibraryFullError('אין מספיק מקום פנוי בטלפון כדי לשמור את הקליפ. מחקו קליפים ישנים ונסו שוב.', { suggestion });
  }

  // ---------------------------------------------------------------------------------------------- מקור

  async function prepareSource(clip, o, b) {
    const file = clip.state?.file;
    if (!isBlob(file)) return null;
    const range = relevantRange(clip.state);
    const desc = { name: file.name || 'video', size: file.size, type: file.type || '', lastModified: file.lastModified || 0, range, offset: 0, stored: false, handle: false };
    let key = file.name ? fingerprintOf(file) : `anon|${newId()}`;   // בלי שם (Blob ולא File) אי אפשר לזהות כפילות, ולכן אין שיתוף
    let toStore = null;
    const policy = o.keepSource || 'auto';
    if (policy !== 'never') {
      const small = file.size <= (o.maxSourceBytes ?? cfg.maxSourceBytes);
      if (policy === 'always' || small) toStore = file;
      else if (typeof o.extractSource === 'function' && range) {
        try {
          const slice = await o.extractSource(file, range);
          if (isBlob(slice) && slice.size > 0 && slice.size < file.size) {
            toStore = slice; desc.offset = range[0]; desc.sliced = true;
            key = `${key}@${range[0]}-${range[1]}`;
          }
        } catch (_) { /* נשארים עם הפניה בלבד */ }
      }
    }
    const handle = clip.state?.fileHandle && typeof clip.state.fileHandle.getFile === 'function' ? clip.state.fileHandle : null;
    const existing = await b.get('sources', key);
    const reuse = !!existing?.blob;
    if (toStore || reuse) { desc.stored = true; desc.storedBytes = toStore ? toStore.size : existing.blob.size; }
    if (handle) desc.handle = true;
    return { key, desc, blob: reuse ? null : toStore, handle, reuse, newBytes: reuse || !toStore ? 0 : toStore.size };
  }

  async function loadSourceFile(item) {
    if (!item?.sourceKey) return null;
    const b = await B();
    const rec = await b.get('sources', item.sourceKey);
    if (!rec) return null;
    if (rec.blob) return new File([rec.blob], rec.name || 'video', { type: rec.type || rec.blob.type || '', lastModified: rec.lastModified || 0 });
    if (rec.handle) {
      try {
        const mode = { mode: 'read' };
        let perm = await rec.handle.queryPermission?.(mode);
        if (perm === 'prompt') perm = await rec.handle.requestPermission?.(mode);   // עובד רק בתוך לחיצה; אחרת נכשל והקליפ מסומן needsSource
        if (perm === 'granted') return await rec.handle.getFile();
      } catch (_) { /* ההפניה אבדה */ }
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------- save

  async function doSave(clip, o) {
    const b = await B();
    const metas = await b.getAll('clips');
    const prev = o.id ? metas.find((m) => m.id === o.id) : null;
    const id = o.id || newId();
    const src = await prepareSource(clip, o, b);
    const thumb = isBlob(clip.thumbnail) ? clip.thumbnail : null;
    const ctx = { dropped: [] };
    const plain = (x) => sanitize(x, ctx, '', new Set());
    let stateData = null; let stateDropped = [];
    if (clip.state) { const s = serializeState(clip.state, { duration: clip.duration }); stateData = s.data; stateDropped = s.dropped; }
    const created = prev?.createdAt ?? (finite(clip.createdAt) ? clip.createdAt : stamp());
    const item = {
      id, title: String(clip.title || clip.hook || 'קליפ ללא שם').slice(0, cfg.titleMax), hook: clip.hook ?? null, hooks: plain(clip.hooks) ?? [],
      duration: finite(clip.duration) ? clip.duration : 0, createdAt: created, updatedAt: stamp(),
      bytes: clip.blob.size, mime: clip.blob.type || 'video/mp4', thumbnail: thumb, thumbBytes: thumb ? thumb.size : 0,
      moment: plain(clip.moment) ?? null, options: plain(clip.options) ?? null, notes: plain(clip.notes) ?? [], template: clip.template ?? null,
      meta: plain(clip.meta) ?? null, batchId: o.batchId ?? prev?.batchId ?? null,
      hasState: !!stateData, source: src?.desc ?? null, sourceKey: src?.key ?? null, sourceStoredBytes: src?.desc.storedBytes ?? 0,
      needsSource: !!stateData && !src?.desc.stored && !src?.desc.handle,
    };
    const needed = clip.blob.size + item.thumbBytes + (src?.newBytes || 0) + 16 * KB;
    await ensureSpace(needed, o);

    const attempts = [{ handle: true, state: true }];
    if (src?.handle) attempts.push({ handle: false, state: true });
    if (stateData) attempts.push({ handle: false, state: false });
    let lastErr = null; let savedWith = null; let spaceRetried = false;
    for (let ai = 0; ai < attempts.length && !savedWith; ai++) {
      const at = attempts[ai];
      const it = { ...item };
      const ops = [{ op: 'put', store: 'clips', value: it }, { op: 'put', store: 'blobs', value: { id, blob: clip.blob } }];
      if (at.state && stateData) ops.push({ op: 'put', store: 'states', value: { id, version: 1, data: stateData, dropped: stateDropped } });
      else { ops.push({ op: 'delete', store: 'states', key: id }); it.hasState = false; it.needsSource = false; it.source = null; it.sourceKey = null; it.sourceStoredBytes = 0; }
      if (at.state && !at.handle && it.source) { it.source = { ...it.source, handle: false }; it.needsSource = !!stateData && !it.source.stored; }
      if (at.state && src && (src.blob || (at.handle && src.handle && !src.reuse))) {
        ops.push({ op: 'put', store: 'sources', value: { id: src.key, name: src.desc.name, size: src.desc.size, type: src.desc.type, lastModified: src.desc.lastModified, offset: src.desc.offset, blob: src.blob || undefined, handle: at.handle && src.handle ? src.handle : undefined, savedAt: now() } });
      }
      if (prev?.sourceKey && prev.sourceKey !== it.sourceKey && !metas.some((m) => m.id !== id && m.sourceKey === prev.sourceKey)) ops.push({ op: 'delete', store: 'sources', key: prev.sourceKey });
      for (;;) {
        try { await b.batch(ops); savedWith = { at, item: it }; break; } catch (e) {
          lastErr = e;
          if (isCloneError(e)) break;                                   // ננסה בלי ההפניה לקובץ, ואחר כך בלי state
          if (isQuotaError(e) && !spaceRetried) { spaceRetried = true; await ensureSpace(needed, o, { force: true }); continue; }   // זורק LibraryFullError אם לא אושרה מחיקה
          throw isQuotaError(e) && e.name !== 'LibraryFullError' ? new LibraryFullError('אין מספיק מקום פנוי בטלפון כדי לשמור את הקליפ. מחקו קליפים ישנים ונסו שוב.', { cause: e }) : e;
        }
      }
    }
    if (!savedWith) throw lastErr || new Error('השמירה נכשלה');
    // אימות: הדפדפן באמת שמר את כל הסרטון (יש דפדפנים שמחזירים Blob ריק)
    const back = await b.get('blobs', id);
    if (!back?.blob || back.blob.size !== clip.blob.size) {
      await removeInternal([id]).catch(() => {});
      throw new Error('השמירה נכשלה: הדפדפן לא שמר את הסרטון במלואו. נסו שוב או פנו מקום בטלפון');
    }
    const result = { ...savedWith.item };
    if (!savedWith.at.state && stateData) result.stateDropped = ['מצב העריכה לא נשמר: הקליפ נשמר, אבל אי אפשר יהיה לערוך אותו מחדש'];
    else if (stateDropped.length) result.stateDropped = stateDropped;
    if (prev) revokeThumb(id);
    emit({ type: 'save', id });
    try { const u = await usageInfo(); if (u.low) { result.lowSpace = true; emit({ type: 'lowspace', usage: u }); } } catch (_) { /* מידע בלבד */ }
    return result;
  }

  function save(clip, opts = {}) {
    if (!clip || !isBlob(clip.blob) || !(clip.blob.size > 0)) return Promise.reject(new Error('אין סרטון לשמירה בקליפ הזה'));
    return exclusive(() => doSave(clip, opts));
  }

  // ---------------------------------------------------------------------------------------------- קריאה

  async function list({ sort = 'newest', query = '', limit, offset = 0 } = {}) {
    const b = await B();
    let items = await b.getAll('clips');
    const q = String(query || '').trim().toLowerCase();
    if (q) items = items.filter((m) => `${m.title} ${m.hook || ''}`.toLowerCase().includes(q));
    const cmp = SORTS[SORT_ALIASES[sort] || sort] || SORTS.newest;
    items.sort(cmp);
    if (offset) items = items.slice(offset);
    if (limit) items = items.slice(0, limit);
    return items;
  }

  async function get(id) {
    const b = await B();
    const [item, blobRec, stateRec] = await Promise.all([b.get('clips', id), b.get('blobs', id), b.get('states', id)]);
    if (!item || !blobRec?.blob) return null;
    let file = null; let state = null;
    if (stateRec?.data) {
      file = await loadSourceFile(item);
      state = reviveState(stateRec.data, { file, offset: file ? (item.source?.offset || 0) : 0 });
    }
    const U = URLc();
    return { ...item, blob: blobRec.blob, url: U?.createObjectURL ? U.createObjectURL(blobRec.blob) : '', state, needsSource: !!stateRec?.data && !file };
  }

  function release(clip) { const U = URLc(); if (clip?.url && U?.revokeObjectURL) { try { U.revokeObjectURL(clip.url); } catch (_) { /* כבר שוחרר */ } clip.url = ''; } }

  function revokeThumb(id) {
    const u = thumbUrls.get(id);
    if (u) { try { URLc()?.revokeObjectURL?.(u.url); } catch (_) { /* בסדר */ } thumbUrls.delete(id); }
  }
  /** כתובת לתמונה הממוזערת של פריט מהרשימה (נשמרת בזיכרון ומשוחררת במחיקה). */
  function thumbUrl(item) {
    if (!item?.thumbnail) return '';
    const cur = thumbUrls.get(item.id);
    if (cur && cur.stamp === item.updatedAt) return cur.url;
    revokeThumb(item.id);
    const url = URLc()?.createObjectURL ? URLc().createObjectURL(item.thumbnail) : '';
    thumbUrls.set(item.id, { url, stamp: item.updatedAt });
    return url;
  }

  // ---------------------------------------------------------------------------------------------- שינוי ומחיקה

  const removeMany = (ids) => exclusive(async () => { const n = await removeInternal([...new Set(ids)]); if (n) emit({ type: 'remove', ids }); return n; });
  const remove = async (id) => (await removeMany([id])) > 0;

  function rename(id, title) {
    const t = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, cfg.titleMax);
    if (!t) return Promise.reject(new Error('שם הקליפ לא יכול להיות ריק'));
    return exclusive(async () => {
      const b = await B();
      const item = await b.get('clips', id);
      if (!item) throw new Error('הקליפ לא נמצא בספרייה');
      const next = { ...item, title: t, titleEdited: true, updatedAt: stamp() };
      await b.batch([{ op: 'put', store: 'clips', value: next }]);
      emit({ type: 'rename', id });
      return next;
    });
  }

  /** המשתמש בחר שוב את סרטון המקור. מאמתים שזה אותו קובץ (שם וגודל), ושומרים אותו אם הוא קטן מספיק. */
  function relink(id, file, { force = false } = {}) {
    return exclusive(async () => {
      const b = await B();
      const item = await b.get('clips', id);
      if (!item) throw new Error('הקליפ לא נמצא בספרייה');
      if (!isBlob(file)) throw new Error('לא נבחר קובץ');
      const s = item.source;
      let match = 'none';
      if (s && file.size === s.size) match = file.name === s.name ? ((file.lastModified || 0) === (s.lastModified || 0) ? 'exact' : 'same') : 'size';
      const ok = match === 'exact' || match === 'same' || (force && !!s);
      if (!ok) return { ok: false, match, clip: null };
      const key = fingerprintOf(file);
      const ops = []; const next = { ...item, updatedAt: stamp(), needsSource: false, sourceKey: key, source: { ...s, name: file.name || s.name, size: file.size, lastModified: file.lastModified || 0, offset: 0, sliced: false, stored: false, storedBytes: 0 } };
      if (file.size <= cfg.maxSourceBytes) {
        const existing = await b.get('sources', key);
        if (!existing?.blob) {
          await ensureSpace(file.size + 16 * KB, {});
          ops.push({ op: 'put', store: 'sources', value: { id: key, name: file.name || 'video', size: file.size, type: file.type || '', lastModified: file.lastModified || 0, offset: 0, blob: file, savedAt: now() } });
        }
        next.source.stored = true; next.source.storedBytes = file.size; next.sourceStoredBytes = file.size;
      } else next.needsSource = true;   // גדול מדי לשמירה: הקובץ חי רק בסשן הנוכחי
      ops.push({ op: 'put', store: 'clips', value: next });
      if (item.sourceKey && item.sourceKey !== key) {
        const metas = await b.getAll('clips');
        if (!metas.some((m) => m.id !== id && m.sourceKey === item.sourceKey)) ops.push({ op: 'delete', store: 'sources', key: item.sourceKey });
      }
      await b.batch(ops);
      emit({ type: 'relink', id });
      const clip = await get(id);
      if (clip?.state && !clip.state.file) clip.state = reviveState((await b.get('states', id)).data, { file, offset: 0 });
      if (clip) clip.needsSource = false;
      return { ok: true, match, clip };
    });
  }

  function clear({ confirmed = false } = {}) {
    if (confirmed !== true) return Promise.reject(new Error('מחיקת כל הספרייה דורשת אישור של המשתמש (clear({confirmed:true}))'));
    return exclusive(async () => {
      const b = await B();
      await b.batch(['clips', 'blobs', 'states', 'sources'].map((store) => ({ op: 'clear', store })));
      for (const id of [...thumbUrls.keys()]) revokeThumb(id);
      emit({ type: 'clear' });
    });
  }

  // ---------------------------------------------------------------------------------------------- מקום

  async function usageInfo() {
    const b = await B();
    const [metas, est, persisted] = await Promise.all([b.getAll('clips'), estimate(), persistedNow()]);
    const srcBytes = new Map(metas.filter((m) => m.sourceKey && m.sourceStoredBytes).map((m) => [m.sourceKey, m.sourceStoredBytes]));
    const libraryBytes = metas.reduce((s, m) => s + itemBytes(m), 0) + [...srcBytes.values()].reduce((s, n) => s + n, 0);
    const free = est ? est.quota - est.usage : null;
    const ratio = est ? est.usage / est.quota : null;
    const low = !!est && (free < cfg.lowFreeBytes || ratio > cfg.lowRatio);
    return {
      supported: !!est, usage: est?.usage ?? null, quota: est?.quota ?? null, free, ratio, low,
      libraryBytes, clips: metas.length, persisted, backend: be?.kind || 'unknown', persistent: be?.persistent !== false,
      textHe: est ? `תפוסים ${formatBytes(est.usage)} מתוך ${formatBytes(est.quota)}${low ? ' · המקום עומד להיגמר' : ''}` : `הספרייה תופסת ${formatBytes(libraryBytes)}`,
    };
  }
  async function persistedNow() { try { return !!(await nav()?.storage?.persisted?.()); } catch (_) { return false; } }

  /** בקשה מהדפדפן לא למחוק את הנתונים כשחסר מקום. הדפדפן לא חייב להסכים (כרום מחליט לפי שימוש והתקנה, ובאייפון לפי התקנה למסך הבית). */
  async function persist() {
    const s = nav()?.storage;
    if (!s?.persist) return { supported: false, persisted: false, already: false, textHe: 'הדפדפן הזה לא מאפשר לבקש שמירה קבועה. כדי להגן על הקליפים, הוסיפו את האפליקציה למסך הבית.' };
    if (await persistedNow()) return { supported: true, persisted: true, already: true, textHe: 'הקליפים מוגנים: הדפדפן לא ימחק אותם לבד.' };
    let granted = false;
    try { granted = !!(await s.persist()); } catch (_) { granted = false; }
    return { supported: true, persisted: granted, already: false, textHe: granted ? 'הקליפים מוגנים: הדפדפן לא ימחק אותם לבד.' : 'הדפדפן לא אישר שמירה קבועה. הוסיפו את האפליקציה למסך הבית ונסו שוב, וגבו את הקליפים ל־ZIP מדי פעם.' };
  }

  async function suggestCleanup({ needBytes } = {}) {
    const b = await B();
    const metas = await b.getAll('clips');
    const est = await estimate();
    const want = finite(needBytes) ? needBytes : (est ? Math.max(0, cfg.lowFreeBytes * 1.5 - (est.quota - est.usage)) : 0);
    return buildSuggestion(metas, Math.max(want, 1), est, want);
  }

  // ---------------------------------------------------------------------------------------------- ייצוא

  async function exportAll({ ids, onProgress, signal, includeThumbnails = false } = {}) {
    if (signal?.aborted) throw new AbortError('הייצוא בוטל');
    const b = await B();
    let items = await b.getAll('clips');
    if (Array.isArray(ids)) { const want = new Set(ids); items = items.filter((m) => want.has(m.id)); }
    items.sort(SORTS.oldest);
    if (!items.length) throw new Error('אין קליפים לייצוא');
    const entries = []; const used = new Set();
    const uniq = (base, ext) => { let n = 1; let name = `${base}.${ext}`; while (used.has(name.toLowerCase())) name = `${base} (${++n}).${ext}`; used.add(name.toLowerCase()); return name; };
    const index = [];
    for (let i = 0; i < items.length; i++) {
      const m = items[i];
      const rec = await b.get('blobs', m.id);
      if (!rec?.blob) continue;
      const file = uniq(`${String(i + 1).padStart(2, '0')} - ${safeFileName(m.title)}`, extOf(m.mime));
      entries.push({ name: file, data: rec.blob, date: new Date(m.createdAt) });
      let thumbFile = null;
      if (includeThumbnails && m.thumbnail) { thumbFile = uniq(`thumbnails/${String(i + 1).padStart(2, '0')} - ${safeFileName(m.title)}`, 'jpg'); entries.push({ name: thumbFile, data: m.thumbnail, date: new Date(m.createdAt) }); }
      index.push({ file, thumbnail: thumbFile, title: m.title, hook: m.hook, duration: m.duration, createdAt: new Date(m.createdAt).toISOString(), bytes: m.bytes });
    }
    entries.push({ name: 'index.json', data: JSON.stringify({ app: 'FRAME', exportedAt: new Date(now()).toISOString(), clips: index }, null, 2), date: new Date(now()) });
    const blob = await makeZip(entries, { signal, onProgress });
    const d = new Date(now());
    const name = `FRAME-clips-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.zip`;
    const file = typeof File === 'function' ? new File([blob], name, { type: 'application/zip' }) : blob;
    return { blob, file, name, count: index.length, bytes: blob.size };
  }

  /** שיתוף קובץ דרך גיליון השיתוף של הטלפון (חייב להיקרא מתוך לחיצה). בלי תמיכה: הורדה רגילה. */
  async function share(fileOrExport, { title = 'קליפים מ־FRAME' } = {}) {
    const file = fileOrExport?.file || fileOrExport;
    const n = nav();
    if (n?.share && n?.canShare?.({ files: [file] })) {
      try { await n.share({ files: [file], title }); return { method: 'share' }; } catch (e) {
        if (isAbort(e)) return { method: 'canceled' };
        // נכשל (למשל קובץ גדול מדי לשיתוף): ממשיכים להורדה
      }
    }
    const d = doc(); const U = URLc();
    if (!d || !U?.createObjectURL) throw new Error('אי אפשר לשתף או להוריד את הקובץ בדפדפן הזה');
    const url = U.createObjectURL(file);
    const a = d.createElement('a'); a.href = url; a.download = file.name || 'frame-clips.zip';
    d.body.appendChild(a); a.click(); a.remove();
    const timer = setTimeout(() => U.revokeObjectURL(url), 60000);
    timer?.unref?.();
    return { method: 'download' };
  }

  // ---------------------------------------------------------------------------------------------- תור (לשימוש batch.js)

  const store = (name) => ({
    put: async (value) => { const b = await B(); await b.batch([{ op: 'put', store: name, value }]); },
    get: async (id) => (await B()).get(name, id),
    list: async () => (await B()).getAll(name),
    remove: async (id) => { const b = await B(); await b.batch([{ op: 'delete', store: name, key: id }]); },
  });

  return {
    save, list, get, remove, removeMany, rename, relink, clear, release, thumbUrl,
    usage: usageInfo, persist, suggestCleanup, exportAll, share,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    status: async () => { await B(); return { backend: be.kind, persistent: be.persistent !== false, fallbackReason }; },
    close: async () => { for (const id of [...thumbUrls.keys()]) revokeThumb(id); if (be) await be.close(); beReady = backend ? Promise.resolve(backend) : null; be = backend; },
    jobs: store('jobs'), inbox: store('inbox'),
    config: cfg,
  };
}

/** הספרייה הרגילה של האפליקציה: IndexedDB בשם frame-library. */
export const library = createLibrary();
export default library;
