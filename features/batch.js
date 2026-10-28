// batch.js: תור עריכה. מעבד כמה סרטונים מהגלריה ברצף, אחד אחרי השני, ושומר כל קליפ בספרייה ברגע שהוא מוכן.
//
//   batch.run(files, options, {onItem, onProgress, signal, onLowSpace, save, keepFiles, notify, notifyWhen, wakeLock, stopOnError, keepPartial})
//     -> {jobId, status:'done'|'canceled'|'paused', items, clips, savedIds, counts, textHe, ...}   (ביטול: זורק AbortError עם .result)
//   batch.pending() -> תורים שנקטעו וניתן להמשיך    batch.resume(jobId, {files, ...})    batch.discard(jobId)
//   batch.enableNotifications() -> חייב להיקרא מתוך לחיצה של המשתמש. run() אף פעם לא מבקש הרשאה בעצמו.
//
// ביטול באמצע סרטון: הקליפים שכבר הושלמו מסרטונים קודמים נשארים בספרייה. את הסרטון שהיה באמצע מעבדים מחדש בהמשך, ולכן ברירת המחדל היא לא לשמור ממנו קליפים חלקיים
// (כדי שלא יהיו כפילויות). עם keepPartial:true הם נשמרים.
// onItem(item) נקרא בכל שינוי סטטוס של סרטון: running, done, error, canceled, needs-file. item = {index, total, name, status, clips, clipIds, error, ...}
// onProgress(fraction 0..1, textHe, info) לכל התור ("סרטון 2 מתוך 5 · מתמללים · נשארו כ־3 דקות").
// כל סרטון עובר דרך makeClips של engine/pipeline.js (נטען דינמית, ולכן נטען רק כשצריך).
// קליפים שנשמרו בספרייה לא נשארים בזיכרון (בלי blob), כדי לא לחרוג מ־1.5GB לטאב באייפון. עם save:false מקבלים קליפים מלאים.
//
// ---- המשך אחרי סגירת האפליקציה: מה אפשר ומה לא ----
// נשמר ב־IndexedDB (חנות jobs, בלי הסרטונים עצמם): רשימת הסרטונים, ההגדרות, מצב כל סרטון, ו"דופק" (heartbeat) כל ~4 שניות.
// אם נטען דף חדש ויש תור במצב running עם דופק ישן, הוא נחשב "נקטע" (interrupted) ומופיע ב־pending().
//  • קליפים שכבר הושלמו: בספרייה, והם לא יעובדו שוב.
//  • הסרטון שהיה באמצע: מתחיל מחדש מהתחלה (אין נקודת שמירה בתוך סרטון).
//  • קבצים: דפדפן בטלפון לא נותן לשמור הפניה לקובץ מהגלריה בין סשנים (File System Access API קיים רק בדסקטופ).
//    לכן keepFiles:'auto' (ברירת מחדל) שומר עותק של סרטונים קטנים (עד 150MB לקובץ ו־300MB בסך הכול, ורק אם יש מקום) בחנות inbox,
//    והעותק נמחק כשהסרטון מסתיים. עם עותק, ב־resume אין צורך לבחור את הסרטון שוב.
//    סרטונים גדולים: ב־resume צריך לבחור אותם שוב, ומזהים אותם לפי שם וגודל (ואם השם השתנה, לפי גודל חד־משמעי).
//  • ההגדרות (options) נשמרות כ־JSON, ולכן ערכים שאינם JSON (פונקציות, Blob) לא שורדים סגירה.
//  • תור שרץ מחזיק נעילת Web Locks (frame-batch:<id>) שהדפדפן משחרר מיד כשהדף נסגר, ולכן תור שנקטע מזוהה מיד ולא רק אחרי שהדופק מתיישן.
//
// ---- מגבלות באייפון (לפי התיעוד והניסיון עם WebKit; לא נבדק כאן על מכשיר אמיתי) ----
//  1. אין עיבוד ברקע. ברגע שהמסך ננעל או שעוברים לאפליקציה אחרת, iOS מקפיא את הדף (JS, ‏Workers, ‏WebCodecs ו־WebGPU נעצרים בתוך שניות),
//     ואין ב־Safari Background Sync או Background Fetch. התור מתקדם רק כשהאפליקציה פתוחה על המסך. צריך להשאיר אותה פתוחה ולא לנעול.
//  2. Wake Lock (navigator.wakeLock) נתמך מ־iOS 16.4. הוא משחרר את עצמו כשהדף עובר לרקע, ואנחנו מבקשים אותו שוב כשחוזרים.
//     ככל הידוע לנו, בגרסאות 16.4 עד 18.3 הוא לא פעל באפליקציה שהותקנה למסך הבית (תוקן בגרסאות החדשות). בלי תמיכה המסך עלול להיכבות לפי הגדרות הטלפון.
//  3. התראות (Notification): באייפון רק באפליקציה שהוספה למסך הבית, מ־iOS 16.4, ורק אחרי בקשת הרשאה מתוך לחיצה. אין שרת Push, ולכן ההתראה נשלחת
//     מהדף עצמו, כלומר רק אם הדף עוד רץ כשהעיבוד מסתיים. באייפון עם מסך נעול זה בדרך כלל לא יקרה, ולכן ההתראה שימושית בעיקר באנדרואיד ובדסקטופ.
//     ב־Chrome לאנדרואיד `new Notification()` לא עובד, ולכן משתמשים ב־registration.showNotification. לחיצה על ההתראה דורשת מטפל notificationclick ב־sw.js.
//  4. iOS יכול להרוג את הטאב כשהזיכרון נגמר (בערך 1.5GB לטאב). אפשר להמשיך בגלל מה שנשמר, אבל הסרטון הנוכחי יתחיל מחדש.
//  5. אחסון: בטאב רגיל של Safari, מידע שהאתר כתב נמחק אחרי 7 ימים בלי שימוש (ITP). אפליקציה שהוספה למסך הבית פטורה מזה. מומלץ library.persist().
//
// בדיקות: tests/library.test.mjs (node, עם שכבות אחסון וסביבה מדומות), dev/library.html (דפדפן).

import { library as defaultLibrary } from './library.js';

// ------------------------------------------------------------------------------------------------ עזרים

const MB = 1024 * 1024;
export const SETTINGS = { inboxFileMax: 150 * MB, inboxTotalMax: 300 * MB };
const RESUMABLE = ['pending', 'running', 'canceled', 'needs-file'];
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const isBlob = (x) => !!x && typeof x === 'object' && typeof x.size === 'number' && typeof x.slice === 'function';
const isAbort = (e) => !!e && (e.name === 'AbortError' || e.code === 20);
const errText = (e) => String((e && e.message) || e || 'שגיאה לא ידועה');
const clamp01 = (x) => Math.max(0, Math.min(1, finite(x) ? x : 0));

class AbortError extends Error { constructor(message = 'התור בוטל') { super(message); this.name = 'AbortError'; } }

export const fingerprint = (f) => `${f?.name || ''}|${f?.size ?? 0}|${f?.lastModified || 0}`;

/** "סרטון אחד" / "3 סרטונים" (שם עצם בזכר). */
export const countHe = (n, one, many) => (n === 1 ? `${one} אחד` : `${n} ${many}`);

export function formatEtaHe(sec) {
  if (!finite(sec)) return '';
  if (sec < 45) return 'נשארה פחות מדקה';
  const min = Math.round(sec / 60);
  if (min < 60) return min === 1 ? 'נשארה כדקה' : `נשארו כ־${min} דקות`;
  const h = Math.floor(min / 60); const m = min % 60;
  return `נשארו כ־${h === 1 ? 'שעה' : `${h} שעות`}${m ? ` ו־${m} דקות` : ''}`;
}

/** חלק התור שהושלם: pos סרטונים הסתיימו, והנוכחי בשלב f (0..1), מתוך count. */
export const overallFraction = (pos, count, f) => (count > 0 ? Math.min(1, (pos + clamp01(f)) / count) : 1);

/** הערכת זמן שנותר: לפי הסרטונים שכבר הסתיימו, או (בסרטון הראשון) לפי הקצב עד כה. */
export function etaSeconds({ doneDurations = [], pos, count, f, currentElapsed }) {
  let avg;
  if (doneDurations.length) avg = doneDurations.reduce((s, x) => s + x, 0) / doneDurations.length;
  else if (f > 0.05 && currentElapsed > 0) avg = currentElapsed / f;
  else return null;
  return Math.max(0, avg * (1 - clamp01(f)) + avg * Math.max(0, count - pos - 1));
}

/**
 * התאמת קבצים שנבחרו מחדש לסרטונים שחסרים בתור. התאמה מלאה (שם, גודל, lastModified), ואז שם וגודל, ואז גודל יחיד (אם שם הקובץ השתנה).
 * מחזיר Map: index -> {file, by}.
 */
export function matchFiles(items, files) {
  const pool = (files || []).map((f) => f?.file ?? f).filter(isBlob);
  const used = new Set(); const out = new Map();
  const passes = [
    ['exact', (it, f) => f.name === it.name && f.size === it.size && (f.lastModified || 0) === (it.lastModified || 0)],
    ['name', (it, f) => f.name === it.name && f.size === it.size],
    ['size', (it, f, unique) => f.size === it.size && unique],
  ];
  for (const [by, test] of passes) {
    for (const it of items) {
      if (out.has(it.index)) continue;
      const cands = pool.filter((f) => !used.has(f) && test(it, f, true));
      if (by === 'size') {
        // התאמה לפי גודל בלבד רק כשהיא חד־משמעית: גם בין הסרטונים החסרים וגם בין הקבצים
        const sameSizeItems = items.filter((x) => !out.has(x.index) && x.size === it.size);
        if (cands.length !== 1 || sameSizeItems.length !== 1) continue;
      }
      if (cands.length) { used.add(cands[0]); out.set(it.index, { file: cands[0], by }); }
    }
  }
  return out;
}

const plainJson = (o) => { try { return JSON.parse(JSON.stringify(o ?? {})); } catch (_) { return {}; } };
const newJobId = () => `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const inboxKey = (jobId, index) => `${jobId}:${index}`;

// ------------------------------------------------------------------------------------------------ Wake Lock

/** שומר את המסך דלוק בזמן העבודה. הדפדפן משחרר אותו כשהדף עובר לרקע, ולכן מבקשים שוב כשחוזרים. */
export function createWakeLock({ navigator: nav, document: doc } = {}) {
  const state = { supported: !!nav?.wakeLock?.request, held: false, requests: 0, error: null };
  let sentinel = null; let want = false;
  async function acquire() {
    if (!want || !state.supported || sentinel) return;
    if (doc && doc.visibilityState && doc.visibilityState !== 'visible') return;
    try {
      const s = await nav.wakeLock.request('screen');
      if (!want) { try { await s.release(); } catch (_) { /* בסדר */ } return; }
      sentinel = s; state.held = true; state.requests++;
      s.addEventListener?.('release', () => { if (sentinel === s) { sentinel = null; state.held = false; } });
    } catch (e) { state.error = errText(e); state.held = false; }   // למשל חיסכון בסוללה: ממשיכים בלי
  }
  const onVisible = () => { if (!doc || doc.visibilityState === 'visible') acquire(); };
  return {
    state,
    async start() { want = true; doc?.addEventListener?.('visibilitychange', onVisible); await acquire(); },
    async stop() {
      want = false; doc?.removeEventListener?.('visibilitychange', onVisible);
      const s = sentinel; sentinel = null; state.held = false;
      try { await s?.release?.(); } catch (_) { /* כבר שוחרר */ }
    },
  };
}

// ------------------------------------------------------------------------------------------------ התור

/**
 * יוצר תור. env מאפשר להחליף navigator/document/Notification/window (בדיקות), ו־loadPipeline להחליף את טעינת הצינור.
 */
export function createBatch({
  library: lib = defaultLibrary, env = {}, loadPipeline = () => import('../engine/pipeline.js'),
  now = () => Date.now(), heartbeatMs = 4000, staleMs = 15000, sessionId = `s${Math.random().toString(36).slice(2, 9)}`,
} = {}) {
  const nav = () => env.navigator ?? globalThis.navigator;
  const doc = () => env.document ?? globalThis.document;
  const win = () => env.window ?? globalThis;
  const NotificationC = () => ('Notification' in env ? env.Notification : globalThis.Notification);
  const timers = () => ({ set: env.setInterval ?? globalThis.setInterval.bind(globalThis), clear: env.clearInterval ?? globalThis.clearInterval.bind(globalThis) });
  let active = null;

  // ---------------------------------------------------------------------------------------------- נעילה (Web Locks)
  // הדף שמריץ תור מחזיק נעילה על התור. הדפדפן משחרר אותה מיד כשהדף נסגר או קורס, ולכן אפשר לזהות תור שנקטע בלי לחכות שהדופק יתיישן.
  // בדפדפן בלי navigator.locks (ישן) מסתמכים על הדופק בלבד.
  const lockName = (jobId) => `frame-batch:${jobId}`;
  async function holdLock(jobId) {
    const L = nav()?.locks;
    if (!L?.request) return () => {};
    let release; const held = new Promise((res) => { release = res; });
    const got = await new Promise((resolve) => {
      L.request(lockName(jobId), { mode: 'exclusive', ifAvailable: true }, (lock) => { if (!lock) { resolve(false); return undefined; } resolve(true); return held; }).catch(() => resolve(true));
    });
    if (!got) throw new Error('התור הזה כבר רץ בלשונית או בחלון אחר של האפליקציה.');
    return () => release();
  }
  async function lockHeld(jobId) {
    try { const q = await nav()?.locks?.query?.(); return q ? q.held.some((h) => h.name === lockName(jobId)) : null; } catch (_) { return null; }
  }

  // ---------------------------------------------------------------------------------------------- התראות

  async function enableNotifications() {
    const N = NotificationC();
    if (!N) return { supported: false, permission: 'unsupported', asked: false, textHe: 'הדפדפן הזה לא תומך בהתראות. באייפון הן זמינות רק אחרי הוספת האפליקציה למסך הבית (iOS 16.4 ומעלה).' };
    if (N.permission === 'granted') return { supported: true, permission: 'granted', asked: false, textHe: 'ההתראות פעילות.' };
    if (N.permission === 'denied') return { supported: true, permission: 'denied', asked: false, textHe: 'ההתראות חסומות. אפשר לאשר אותן בהגדרות הדפדפן או הטלפון.' };
    const ua = nav()?.userActivation;
    if (ua && !ua.isActive) throw new Error('אפשר לבקש הרשאה להתראות רק מתוך לחיצה על כפתור.');
    const permission = await new Promise((resolve) => {
      let r; try { r = N.requestPermission(resolve); } catch (_) { resolve('denied'); return; }
      r?.then?.(resolve, () => resolve('denied'));
    });
    return { supported: true, permission, asked: true, textHe: permission === 'granted' ? 'ההתראות פעילות.' : 'לא אושרו התראות. אפשר לשנות זאת בהגדרות.' };
  }

  async function notifyDone(result, settings) {
    const N = NotificationC();
    if (!N || N.permission !== 'granted' || settings.notify === false) return false;   // בלי הרשאה לא מציגים, ולא מבקשים אותה כאן
    const d = doc();
    const hidden = d ? d.visibilityState !== 'visible' : true;
    if (settings.notifyWhen !== 'always' && !hidden) return false;
    const c = result.counts;
    const body = [`הסתיימה העריכה של ${countHe(c.doneNow, 'סרטון', 'סרטונים')}.`, result.clipsTotal === 1 ? 'נוצר קליפ אחד.' : result.clipsTotal ? `נוצרו ${result.clipsTotal} קליפים.` : 'לא נוצרו קליפים.', c.failed ? `${countHe(c.failed, 'סרטון', 'סרטונים')} לא ${c.failed === 1 ? 'עובד' : 'עובדו'}.` : ''].filter(Boolean).join(' ');
    let icon; try { icon = new URL('../icons/icon-192.png', import.meta.url).href; } catch (_) { icon = undefined; }
    const options = { body, tag: 'frame-batch', lang: 'he', dir: 'rtl', icon, data: { type: 'frame-batch', jobId: result.jobId } };
    const title = 'FRAME · הקליפים מוכנים';
    try {
      const reg = await nav()?.serviceWorker?.getRegistration?.();
      if (reg?.showNotification) { await reg.showNotification(title, options); return true; }
    } catch (_) { /* ננסה בבנאי */ }
    try {
      const n = new N(title, options);
      n.onclick = () => { try { win().focus?.(); n.close?.(); } catch (_) { /* בסדר */ } };
      return true;
    } catch (_) { return false; }   // באנדרואיד הבנאי זורק
  }

  // ---------------------------------------------------------------------------------------------- שמירה של מצב

  let jobWrite = Promise.resolve();
  const snapshot = (job) => JSON.parse(JSON.stringify(job, (k, v) => (k === 'clips' ? undefined : v)));   // בלי הקליפים עצמם (הם בספרייה)
  function persist(job) {
    const snap = snapshot(job);
    jobWrite = jobWrite.then(() => lib.jobs.put(snap)).catch(() => { job.persistFailed = true; });   // כשל בשמירת המצב לא מפיל את העבודה
    return jobWrite;
  }

  async function dropJob(job) {
    await jobWrite;
    try { await lib.jobs.remove(job.id); } catch (_) { /* בסדר */ }
    for (const it of job.items) { try { await lib.inbox.remove(inboxKey(job.id, it.index)); } catch (_) { /* בסדר */ } }
  }

  async function stashPolicy(job, files) {
    const mode = job.settings.keepFiles;
    if (mode === false || mode === 'never') return [];
    let total = 0; const plan = [];
    let free = Infinity;
    try { const u = await lib.usage(); if (u.supported) free = u.free; } catch (_) { /* בלי הערכה */ }
    for (const it of job.items) {
      const f = files.get(it.index)?.file;
      if (!f || it.hasStoredFile || it.status === 'done' || it.status === 'skipped') continue;
      const fits = mode === 'always' || (f.size <= SETTINGS.inboxFileMax && total + f.size <= SETTINGS.inboxTotalMax);
      if (!fits || total + f.size * 2 > free) continue;
      total += f.size; plan.push(it);
    }
    return plan;
  }

  // ---------------------------------------------------------------------------------------------- ההרצה

  const publicItem = (job, it) => ({ index: it.index, total: job.items.length, name: it.name, size: it.size, status: it.status, error: it.error || null, warnings: it.warnings || [], clipIds: it.clipIds || [], clips: it.clips || [], saveError: it.saveError || null, seconds: it.seconds ?? null, hasStoredFile: !!it.hasStoredFile });

  async function start(job, files /* Map index -> {file, by} */, cb, { liveOptions } = {}) {
    if (active) throw new Error('כבר רץ תור עריכה. המתינו שיסתיים, או בטלו אותו.');
    const { onItem, onProgress, signal } = cb;
    if (signal?.aborted) throw new AbortError();
    active = { jobId: job.id };
    let pipeline;
    try {
      try { pipeline = await loadPipeline(); } catch (e) { throw new Error(`מנוע העריכה לא נטען. בדקו חיבור לאינטרנט ונסו שוב. (${errText(e)})`); }
      if (typeof pipeline?.makeClips !== 'function') throw new Error('מנוע העריכה לא נטען: חסרה הפונקציה makeClips');
    } catch (e) { active = null; throw e; }
    const settings = job.settings;
    let releaseLock = () => {};
    try { releaseLock = await holdLock(job.id); } catch (e) { active = null; throw e; }
    const t0 = now();
    const wl = createWakeLock({ navigator: nav(), document: doc() });
    const { set: setTimer, clear: clearTimer } = timers();
    let hb = null; let aborted = false; let stashChain = Promise.resolve(); let doneNow = 0;
    const out = { clips: [], savedIds: [] };
    const tell = (it) => { try { onItem?.(publicItem(job, it)); } catch (_) { /* באג בממשק לא מפיל את התור */ } };
    const flush = () => { job.heartbeat = now(); job.updatedAt = job.heartbeat; return persist(job); };
    const onHide = () => { if (doc()?.visibilityState === 'hidden') flush(); };
    try {
      // סרטונים בלי קובץ זמין ממתינים לבחירה מחדש; השאר ירוצו לפי הסדר
      for (const it of job.items) {
        if (it.status === 'skipped' && !it.told) { it.told = true; tell(it); }
        else if (RESUMABLE.includes(it.status) && !files.has(it.index)) { it.status = 'needs-file'; tell(it); }
        else if (it.status === 'needs-file' || it.status === 'canceled' || it.status === 'running') it.status = 'pending';
      }
      const todo = job.items.filter((it) => it.status === 'pending');
      job.status = 'running'; job.sessionId = sessionId; job.heartbeat = now(); job.updatedAt = job.heartbeat;
      await persist(job);
      if (settings.wakeLock !== false) await wl.start();
      if (heartbeatMs > 0) hb = setTimer(flush, heartbeatMs);
      win().addEventListener?.('pagehide', flush);
      doc()?.addEventListener?.('visibilitychange', onHide);

      // עותקים של הקבצים להמשך אחרי סגירה: ברקע, לפי הסדר, בלי לעכב את העיבוד
      stashChain = (async () => {
        for (const it of await stashPolicy(job, files)) {
          if (aborted || it.status === 'done') continue;
          const f = files.get(it.index).file;
          try {
            await lib.inbox.put({ id: inboxKey(job.id, it.index), jobId: job.id, index: it.index, name: it.name, type: it.type, lastModified: it.lastModified, blob: f });
            it.hasStoredFile = true;
            if (it.status === 'done') await lib.inbox.remove(inboxKey(job.id, it.index)); else await persist(job);
          } catch (_) { /* אין מקום או שהדפדפן סירב: נשארים בלי עותק */ }
        }
      })().catch(() => {});

      const doneDurations = [];
      const emitProgress = (pos, f, text, info = {}) => {
        if (!onProgress) return;
        const cur = job.items[todo[pos]?.index ?? 0];
        const elapsed = cur?.startedAt ? (now() - cur.startedAt) / 1000 : 0;
        const eta = etaSeconds({ doneDurations, pos, count: todo.length, f, currentElapsed: elapsed });
        const etaHe = eta === null || eta < 1 ? '' : formatEtaHe(eta);
        const frac = Math.max(emitProgress.last || 0, overallFraction(pos, todo.length, f));
        emitProgress.last = frac;
        const label = todo.length > 1 ? `סרטון ${pos + 1} מתוך ${todo.length}` : 'מעבדים את הסרטון';
        const full = [label, text, etaHe].filter(Boolean).join(' · ');
        try { onProgress(frac, full, { index: cur?.index ?? null, position: pos + 1, count: todo.length, etaSec: eta, etaHe, stage: info.stage || null, inner: info }); } catch (_) { /* בסדר */ }
      };
      emitProgress.last = 0;
      emitProgress(0, 0, todo.length ? 'מתחילים' : 'אין סרטונים לעיבוד');

      for (let pos = 0; pos < todo.length; pos++) {
        const it = todo[pos];
        if (signal?.aborted) { aborted = true; break; }
        const file = files.get(it.index).file;
        it.status = 'running'; it.startedAt = now(); it.error = null; it.clipIds = []; it.clips = []; it.warnings = [];
        await persist(job); tell(it);
        let clips = null; let partial = null; let failure = null;
        try {
          clips = await pipeline.makeClips(file, liveOptions ?? job.options, {
            signal, etaInText: false, ...(cb.quality ? { quality: cb.quality } : {}), ...(cb.modules ? { modules: cb.modules } : {}),
            onProgress: (f, text, info) => emitProgress(pos, f, text, info),
          });
        } catch (e) {
          if (isAbort(e) || signal?.aborted) { aborted = true; partial = Array.isArray(e?.partial) ? e.partial : []; } else failure = e;
        }
        if (clips?.errors?.length) it.warnings = clips.errors.map((x) => x.message);
        const produced = clips || (settings.keepPartial ? partial : null) || [];
        if (produced.length) await saveItemClips(job, it, produced, settings, cb, out);
        it.finishedAt = now(); it.seconds = Math.round((it.finishedAt - it.startedAt) / 100) / 10;
        if (aborted) it.status = 'canceled';
        else if (failure) { it.status = 'error'; it.error = errText(failure); }
        else { it.status = 'done'; doneNow++; doneDurations.push(it.seconds); }
        await persist(job); tell(it);
        if (it.status === 'done' && it.hasStoredFile) { try { await lib.inbox.remove(inboxKey(job.id, it.index)); it.hasStoredFile = false; } catch (_) { /* בסדר */ } }
        if (aborted || (failure && settings.stopOnError)) break;
        emitProgress(pos + 1 < todo.length ? pos + 1 : pos, pos + 1 < todo.length ? 0 : 1, '');
      }
      if (aborted) for (const it of job.items) if (it.status === 'pending') { it.status = 'canceled'; tell(it); }
    } catch (e) {
      // כשל כללי לא צפוי: התור נשמר כדי שאפשר יהיה להמשיך
      job.status = 'paused'; await persist(job);
      active = null; await stopAll();
      throw e;
    }
    return finish();

    async function stopAll() {
      aborted = true;
      if (hb) clearTimer(hb);
      win().removeEventListener?.('pagehide', flush);
      doc()?.removeEventListener?.('visibilitychange', onHide);
      await wl.stop();
      await stashChain;
      releaseLock();
    }

    async function finish() {
      const items = job.items;
      const wasAborted = items.some((i) => i.status === 'canceled');
      aborted = true; await stopAll();
      const remaining = items.some((i) => RESUMABLE.includes(i.status));
      job.status = wasAborted ? 'canceled' : remaining ? 'paused' : 'done';
      if (remaining) { await persist(job); await jobWrite; } else await dropJob(job);
      const count = (s) => items.filter((i) => i.status === s).length;
      const counts = { done: count('done'), doneNow, failed: count('error'), canceled: count('canceled'), needsFile: count('needs-file'), skipped: count('skipped'), total: items.length };
      const clipsTotal = out.clips.length;
      const result = {
        jobId: job.id, status: job.status, items: items.map((i) => publicItem(job, i)), clips: out.clips, savedIds: out.savedIds, clipsTotal,
        counts, seconds: Math.round((now() - t0) / 100) / 10, wakeLock: { ...wl.state }, resumable: remaining, notified: false,
        missing: items.filter((i) => i.status === 'needs-file').map((i) => ({ index: i.index, name: i.name, size: i.size })),
      };
      result.textHe = summaryHe(result);
      active = null;
      if (job.status === 'done') result.notified = await notifyDone(result, settings);
      if (wasAborted) { const err = new AbortError(); err.result = result; err.partial = out.clips; throw err; }
      return result;
    }
  }

  /** שומר את הקליפים של סרטון אחד בספרייה ומשחרר אותם מהזיכרון. קליפ שנכשל בשמירה נשאר בזיכרון ומדווח. */
  async function saveItemClips(job, it, produced, settings, cb, out) {
    for (const clip of produced) {
      if (settings.save === false) { out.clips.push(clip); it.clips.push(clip); continue; }
      try {
        const meta = await lib.save(clip, { batchId: job.id, onLowSpace: cb.onLowSpace, ...(cb.saveOptions || {}) });
        it.clipIds.push(meta.id); out.savedIds.push(meta.id);
        const brief = { id: meta.id, title: meta.title, duration: meta.duration, thumbnail: meta.thumbnail, bytes: meta.bytes, needsSource: meta.needsSource };
        it.clips.push(brief); out.clips.push(brief);
        try { if (clip.url && typeof URL !== 'undefined') URL.revokeObjectURL(clip.url); } catch (_) { /* בסדר */ }
      } catch (e) {
        it.saveError = errText(e);
        out.clips.push(clip); it.clips.push(clip);   // לא מאבדים: הקליפ נשאר בזיכרון כדי שאפשר יהיה להוריד אותו ידנית
      }
    }
  }

  function summaryHe(r) {
    const c = r.counts;
    const parts = [];
    if (c.doneNow) parts.push(`הסתיימה העריכה של ${countHe(c.doneNow, 'סרטון', 'סרטונים')}`);
    parts.push(r.clipsTotal === 1 ? 'נוצר קליפ אחד' : r.clipsTotal ? `נוצרו ${r.clipsTotal} קליפים` : 'לא נוצרו קליפים');
    if (c.failed) parts.push(`${countHe(c.failed, 'סרטון', 'סרטונים')} נכשל${c.failed === 1 ? '' : 'ו'}`);
    if (c.canceled) parts.push(`${countHe(c.canceled, 'סרטון', 'סרטונים')} ${c.canceled === 1 ? 'ממתין' : 'ממתינים'} להמשך`);
    if (c.needsFile) parts.push(`${countHe(c.needsFile, 'סרטון', 'סרטונים')} ${c.needsFile === 1 ? 'דורש' : 'דורשים'} בחירה מחדש`);
    return `${parts.join('. ')}.`;
  }

  // ---------------------------------------------------------------------------------------------- ממשק ציבורי

  async function run(files, options = {}, cb = {}) {
    const list = Array.from(files || []).map((f) => (f && f.file && !isBlob(f) ? f.file : f)).filter((f) => f !== null && f !== undefined);
    if (!list.length) throw new Error('לא נבחרו סרטונים.');
    const settings = {
      save: cb.save !== false, keepFiles: cb.keepFiles ?? 'auto', notify: cb.notify !== false, notifyWhen: cb.notifyWhen || 'hidden',
      wakeLock: cb.wakeLock !== false, stopOnError: !!cb.stopOnError, keepPartial: cb.keepPartial === true,
    };
    const t = now();
    const job = {
      id: newJobId(), version: 1, status: 'pending', createdAt: t, updatedAt: t, heartbeat: t, sessionId, options: plainJson(options), settings,
      items: list.map((f, i) => {
        const video = isBlob(f) && (!f.type || /^video\//i.test(f.type));
        return { index: i, name: (isBlob(f) && f.name) || `סרטון ${i + 1}`, size: isBlob(f) ? f.size : 0, type: (isBlob(f) && f.type) || '', lastModified: (isBlob(f) && f.lastModified) || 0, status: video ? 'pending' : 'skipped', error: video ? null : 'הקובץ הזה אינו סרטון', clipIds: [], hasStoredFile: false };
      }),
    };
    const files2 = new Map(list.map((f, i) => [i, { file: f, by: 'given' }]).filter(([i]) => job.items[i].status === 'pending'));
    if (!files2.size) throw new Error('אף אחד מהקבצים שנבחרו אינו סרטון.');
    return start(job, files2, cb, { liveOptions: options });
  }

  /** ממשיך תור שנקטע. files = קבצים שהמשתמש בחר מחדש (לסרטונים שאין להם עותק שמור). */
  async function resume(jobId, cb = {}) {
    if (active) throw new Error('כבר רץ תור עריכה. המתינו שיסתיים, או בטלו אותו.');
    const job = await lib.jobs.get(jobId);
    if (!job) throw new Error('התור לא נמצא. ייתכן שהוא כבר הסתיים או נמחק.');
    if (cb.retryFailed) for (const it of job.items) if (it.status === 'error') { it.status = 'pending'; it.error = null; }
    const need = job.items.filter((it) => RESUMABLE.includes(it.status));
    const files = new Map();
    const rest = [];
    for (const it of need) {
      let rec = null;
      try { rec = await lib.inbox.get(inboxKey(job.id, it.index)); } catch (_) { rec = null; }
      if (rec?.blob) {
        const f = typeof File === 'function' ? new File([rec.blob], rec.name || it.name, { type: rec.type || it.type, lastModified: rec.lastModified || 0 }) : rec.blob;
        files.set(it.index, { file: f, by: 'stored' }); it.hasStoredFile = true;
      } else { it.hasStoredFile = false; rest.push(it); }
    }
    for (const [idx, m] of matchFiles(rest, cb.files)) files.set(idx, m);
    if (cb.options) job.options = plainJson(cb.options);
    job.settings = { ...job.settings, ...(cb.keepFiles !== undefined ? { keepFiles: cb.keepFiles } : {}), ...(cb.notify !== undefined ? { notify: cb.notify } : {}), ...(cb.notifyWhen ? { notifyWhen: cb.notifyWhen } : {}), ...(cb.wakeLock !== undefined ? { wakeLock: cb.wakeLock } : {}), ...(cb.stopOnError !== undefined ? { stopOnError: !!cb.stopOnError } : {}), ...(cb.save !== undefined ? { save: cb.save !== false } : {}) };
    return start(job, files, cb, { liveOptions: cb.options });
  }

  /** התורים שנקטעו וניתן להמשיך. תור שרץ כרגע בדף הזה, או בלשונית אחרת עם דופק טרי, לא נכלל. */
  async function pending() {
    const jobs = await lib.jobs.list();
    const t = now(); const out = [];
    for (const j of jobs) {
      if (active?.jobId === j.id) continue;
      if (!j.items.some((it) => RESUMABLE.includes(it.status))) continue;
      let status = j.status;
      if (j.status === 'running') {
        const held = await lockHeld(j.id);
        const fresh = t - (j.heartbeat || 0) <= staleMs;
        if (held === true || (held === null && j.sessionId !== sessionId && fresh)) continue;   // רץ עכשיו בלשונית אחרת
        status = 'interrupted';
      }
      const remaining = j.items.filter((it) => RESUMABLE.includes(it.status));
      const needFiles = remaining.filter((it) => !it.hasStoredFile).length;
      out.push({
        id: j.id, status, createdAt: j.createdAt, updatedAt: j.updatedAt, total: j.items.length,
        done: j.items.filter((it) => it.status === 'done').length, failed: j.items.filter((it) => it.status === 'error').length,
        remaining: remaining.length, needFiles,
        items: j.items.map((it) => ({ index: it.index, name: it.name, size: it.size, status: it.status, hasStoredFile: !!it.hasStoredFile })),
        textHe: `${remaining.length === 1 ? 'נשאר' : 'נשארו'} ${countHe(remaining.length, 'סרטון', 'סרטונים')} מתוך ${j.items.length}${needFiles ? `. צריך לבחור שוב ${countHe(needFiles, 'סרטון', 'סרטונים')}` : ''}`,
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** מוחק תור שנקטע (וגם את העותקים השמורים של הסרטונים). הקליפים שכבר נשמרו בספרייה לא נמחקים. */
  async function discard(jobId) {
    const job = await lib.jobs.get(jobId);
    if (!job) return false;
    await dropJob(job);
    return true;
  }

  return { run, resume, pending, discard, enableNotifications, isRunning: () => !!active, current: () => (active ? { ...active } : null), createWakeLock };
}

/** התור הרגיל של האפליקציה. */
export const batch = createBatch();
export default batch;
