// FRAME לטלפון: נקודת הכניסה. מחזיק את המצב, הניווט, העבודה מול המנוע, ה־Service Worker וההתקנה.
// המסכים עצמם נמצאים ב־ui/*, והלוגיקה הטהורה ב־ui/model.js (נבדקת ב־node).
import { h, clear, icon } from './ui/dom.js';
import { T } from './ui/texts.js';
import * as M from './ui/model.js';
import * as store from './ui/store.js';
import { loadEngine, turboStatus, loadFeature, loadLibrary, loadBatch, loadBatchModule, peekLibrary } from './ui/engine.js';
import { lowSpaceDialog } from './ui/lowspace-ui.js';
import { openModal } from './ui/overlay.js';
import { createBatchStub } from './ui/stubs.js';
import { sceneBlob } from './ui/backgrounds.js';
import { homeScreen, optionsScreen, progressScreen, resultsScreen } from './ui/screens.js';
import { templatesScreen, smartScreen, installScreen, settingsScreen } from './ui/extras.js';
import { teleprompterScreen, reactionScreen, voiceScreen } from './ui/features-ui.js';
import { libraryScreen } from './ui/library-ui.js';
import { editorScreen } from './ui/editor-ui.js';

export const VERSION = '1.0.0';
const FEATURES = ['library', 'batch', 'quick-editor', 'post-kit', 'cover'];

const SCREENS = {
  home: homeScreen, options: optionsScreen, progress: progressScreen, results: resultsScreen,
  templates: templatesScreen, smart: smartScreen, settings: settingsScreen, install: installScreen,
  teleprompter: teleprompterScreen, reaction: reactionScreen, voice: voiceScreen, library: libraryScreen, editor: editorScreen,
};
const ROOTS = ['home', 'library', 'templates', 'smart', 'settings'];
const TAB_ICONS = { home: 'home', library: 'film', templates: 'grid', smart: 'wand', settings: 'gear' };

// ------------------------------------------------------------------ מצב

let state = M.initialState();
let settings = store.loadSettings();
let files = [];            // קבצי המקור (File) של הבחירה הנוכחית
let fileUrl = '';          // כתובת התצוגה של הסרטון הראשון
let clips = [];            // הקליפים שנוצרו (עם blob ו־url)
let thumbUrls = [];
let bgGalleryFile = null;
let turbo = { where: M.turboContext(location), connected: false, turbo: null };
let abort = null;
let deferredPrompt = null;
let swReg = null;
const has = Object.fromEntries(FEATURES.map((f) => [f, false]));
let featuresReady = Promise.resolve();
const postCache = new WeakMap();
let engineP = null;

const getEngine = () => (engineP || (engineP = loadEngine()));
const view = document.getElementById('view');
const tabsEl = document.getElementById('tabs');
const toastsEl = document.getElementById('toasts');
const badgeEl = document.getElementById('badge');

let current = null, currentKey = '', skipPush = false;

function dispatch(action) {
  const prev = state;
  const next = M.reduce(state, { now: Date.now(), ...action });
  if (next === state) return;
  state = next;
  if (!state.file && files.length) setFiles([]);
  syncHistory(prev);
  render(prev);
}

// ------------------------------------------------------------------ ניווט והיסטוריה (כפתור "חזרה" באנדרואיד)

function syncHistory(prev) {
  if (prev.screen === state.screen) return;
  if (skipPush) { skipPush = false; return; }
  const root = ROOTS.includes(prev.screen) && ROOTS.includes(state.screen);
  try { (root ? history.replaceState : history.pushState).call(history, { screen: state.screen }, ''); } catch { /* אין היסטוריה */ }
}
window.addEventListener('popstate', () => {
  const s = state.screen;
  if (s === 'progress') { try { history.pushState({ screen: 'progress' }, ''); } catch { /* */ } return; }
  skipPush = true;
  const before = state;
  if (s === 'results') dispatch({ type: 'editAgain' });
  else if (s === 'editor') dispatch({ type: 'closeEditor' });
  else if (s === 'options') dispatch({ type: 'clearFile' });
  else if (['teleprompter', 'reaction', 'voice'].includes(s)) dispatch({ type: 'go', screen: 'smart' });
  else if (s === 'install') dispatch({ type: 'go', screen: 'settings' });
  else if (s !== 'home') dispatch({ type: 'go', screen: 'home' });
  if (state === before) skipPush = false;
});

// ------------------------------------------------------------------ תצוגה

function applyChrome() {
  document.body.dataset.screen = state.screen;
  const showTabs = M.showTabs(state.screen);
  tabsEl.hidden = !showTabs;
  document.body.classList.toggle('no-tabs', !showTabs);
  const active = M.tabOf(state.screen);
  tabsEl.querySelectorAll('button').forEach((b) => {
    const on = b.dataset.tab === active;
    b.classList.toggle('is-on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
}

function mount(key) {
  if (current && current.destroy) { try { current.destroy(); } catch { /* מסך שנסגר */ } }
  const make = SCREENS[key] || homeScreen;
  const wasKey = currentKey;
  current = make(ctx);
  currentKey = key;
  clear(view);
  view.append(current.el);
  if (wasKey !== key) {
    view.scrollTop = 0; window.scrollTo(0, 0);
    view.classList.remove('enter'); void view.offsetWidth; view.classList.add('enter');
    const head = current.el.querySelector('h1');
    if (head) { head.setAttribute('tabindex', '-1'); try { head.focus({ preventScroll: true }); } catch { /* */ } }
  }
}

function render() {
  applyChrome();
  if (!current || state.screen !== currentKey) mount(state.screen);
  else if (current.update) current.update(state);
  else { const top = view.scrollTop; mount(state.screen); view.scrollTop = top; }
}

// ------------------------------------------------------------------ הודעות קצרות

function toast(message, { action = null, sticky = false } = {}) {
  const el = h('div', { class: 'toast', role: 'status' }, h('span', {}, message));
  const remove = () => { el.classList.add('is-out'); setTimeout(() => el.remove(), 200); };
  if (action) el.append(h('button', { type: 'button', class: 'toast-action', onClick: () => { action.onClick(); remove(); } }, action.label));
  if (sticky) el.append(h('button', { type: 'button', class: 'toast-x', 'aria-label': T.update.later, onClick: remove }, icon('close', 16)));
  toastsEl.append(el);
  while (toastsEl.children.length > 3) toastsEl.firstChild.remove();
  if (!sticky) setTimeout(remove, 3800);
  return remove;
}

// ------------------------------------------------------------------ ערכת נושא

const lightQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
function applyTheme() {
  const resolved = M.resolveTheme(settings.theme, !!(lightQuery && lightQuery.matches));
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', M.themeColor(resolved));
}
if (lightQuery && lightQuery.addEventListener) lightQuery.addEventListener('change', applyTheme);

function saveSettings(patch) {
  settings = M.normalizeSettings({ ...settings, ...patch });
  store.saveSettings(settings);
  applyTheme();
}

// ------------------------------------------------------------------ קבצים

function setFiles(list) {
  if (fileUrl) URL.revokeObjectURL(fileUrl);
  files = list;
  fileUrl = list.length ? URL.createObjectURL(list[0]) : '';
}
// הקובץ נשמר לפני שהמסך מצויר, כדי שהתצוגה המקדימה תקבל כתובת
function pickFile(f) {
  if (M.validateFile(M.fileMeta(f)).ok) setFiles([f]);
  dispatch({ type: 'pickFile', file: f });
}
function pickFiles(list) {
  const valid = list.filter((f) => M.validateFile(M.fileMeta(f)).ok).slice(0, M.LIMITS.maxBatch);
  if (valid.length) setFiles(valid);
  dispatch({ type: 'pickFiles', files: list });
}
function setBgGallery(f) {
  if (!f || !/^image\//.test(f.type || '')) { toast(T.bg.notImage); return; }
  bgGalleryFile = f;
  dispatch({ type: 'setBgGallery', name: f.name });
}
async function logoBlob() { return store.getLogo(); }
let brandKnown = !!settings.brandName;
logoBlob().then((b) => { if (b && !brandKnown) { brandKnown = true; if (current && state.screen === 'options') mount('options'); } });

// ------------------------------------------------------------------ מניעת כיבוי מסך וההתראות

let wakeLock = null, wakeWanted = false;
async function keepAwake(on) {
  wakeWanted = on;
  try {
    if (on) {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } else if (wakeLock) { const l = wakeLock; wakeLock = null; await l.release(); }
  } catch { wakeLock = null; }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && wakeWanted && !wakeLock) keepAwake(true); });

const notifyStatus = () => M.notifyState({ supported: typeof Notification !== 'undefined', permission: typeof Notification !== 'undefined' ? Notification.permission : 'default' });
async function askNotify() {
  let text = '';
  try {
    const batch = await loadBatchModule();
    if (batch && batch.enableNotifications) { const res = await batch.enableNotifications(); text = res && res.textHe; }
    else if (typeof Notification !== 'undefined') await Notification.requestPermission();
  } catch (e) { text = e && e.message; }
  const st = notifyStatus();
  toast(text || (st === 'on' ? T.batch.notifyOn : st === 'denied' ? T.batch.notifyDenied : T.batch.notifyUnsupported));
  if (current && state.screen === 'progress' && current.update) current.update(state);
}
async function notifyDone(n) {
  if (notifyStatus() !== 'on') return;
  const opts = { body: T.batch.doneBody(n), tag: 'frame-batch', icon: './icons/icon-192.png', dir: 'rtl', lang: 'he' };
  try {
    const reg = swReg || (await navigator.serviceWorker.getRegistration());
    if (reg && reg.showNotification) { await reg.showNotification(T.batch.doneTitle, opts); return; }
  } catch { /* ננסה בלי ה־SW */ }
  try { new Notification(T.batch.doneTitle, opts); } catch { /* אין התראות */ }
}

// ------------------------------------------------------------------ עבודה מול המנוע

function releaseClips() {
  const lib = peekLibrary();
  for (const c of clips) {
    if (!c || !c.url) continue;
    try { if (c.fromLibrary && lib && lib.release) lib.release(c); else URL.revokeObjectURL(c.url); } catch { /* כבר שוחרר */ }
  }
  thumbUrls.forEach((u) => u && URL.revokeObjectURL(u));
  clips = []; thumbUrls = [];
}
const qualityOf = () => (settings.quality === 'high' ? 'high' : 'standard');

function throttle(fn, ms = 90) {
  let last = 0;
  return (...a) => { const now = Date.now(); if (now - last >= ms || a[0] >= 1) { last = now; fn(...a); } };
}

async function start() {
  requestPersist(); // נקרא מתוך לחיצה על "ערכו לי": הדפדפן מאשר שמירה קבועה רק ממחווה של המשתמש
  if (!M.canStart(state)) { if (state.screen === 'options' && !M.backgroundReady(state)) toast(T.bg.need); return; }
  if (!files.length) { toast(T.options.noFile); dispatch({ type: 'clearFile' }); return; }
  const assets = {};
  try {
    if (state.background === 'replace') assets.bgImage = state.bgScene === 'gallery' ? bgGalleryFile : await sceneBlob(state.bgScene);
    if (state.brand) assets.logo = (await logoBlob()) || undefined;
  } catch { /* בלי נכסים נוספים */ }
  const options = M.buildOptions(state, settings, assets);
  const sources = files.slice();
  const isBatch = !!state.batch;
  await runJob(async (signal) => {
    const engine = await getEngine();
    const useTurbo = turbo.connected && turbo.turbo && typeof turbo.turbo.makeClips === 'function';
    const make = useTurbo ? turbo.turbo.makeClips : engine.makeClips;
    const extra = { signal, quality: qualityOf() };
    if (!isBatch) {
      const onProgress = throttle((f, text) => dispatch({ type: 'progress', fraction: f, text }));
      return make(sources[0], options, { ...extra, onProgress });
    }
    const api = useTurbo || engine.kind === 'stub' ? createBatchStub(make) : await loadBatch(make);
    const live = batchCallbacks(signal);
    const result = await api.run(sources, options, live.callbacks);
    return hydrateBatch(api, result, live);
  }, isBatch);
}

// התקדמות התור לפי אירועי המודול (או תור הדמה)
function batchCallbacks(signal) {
  const collected = [], idToIndex = new Map();
  const overall = () => (state.batchRun ? M.batchFraction(state.batchRun.items) : 0);
  const paint = throttle((f, text) => dispatch({ type: 'progress', fraction: f, text }), 120);
  return {
    collected, idToIndex,
    callbacks: {
      signal,
      onLowSpace: lowSpaceDialog, // רק מציע מחיקה, והמשתמש בוחר
      onItem: (a, b) => {
        const ev = M.normalizeBatchEvent(a, b);
        if (ev.index < 0) return;
        if (ev.clips) { ev.clips.forEach((c) => { if (c && c.sourceIndex === undefined) c.sourceIndex = ev.index; }); collected.push(...ev.clips); }
        ev.clipIds.forEach((id) => idToIndex.set(id, ev.index));
        dispatch({ type: 'batchItem', index: ev.index, status: ev.status, fraction: ev.fraction, error: ev.error });
        paint(overall(), state.batchRun ? T.batch.summary(state.batchRun.doneCount, state.batchRun.items.length) : '');
      },
      onProgress: (a, b) => {
        if (a && typeof a === 'object') {
          if (Number.isInteger(a.index) && Number.isFinite(a.itemFraction)) dispatch({ type: 'batchItem', index: a.index, status: 'working', fraction: a.itemFraction });
          paint(Number.isFinite(a.overall) ? a.overall : overall(), a.text || '');
        } else if (Number.isFinite(a)) paint(a, typeof b === 'string' ? b : '');
      },
    },
  };
}
// התור האמיתי שומר בספרייה ולא מחזיק את הקליפים בזיכרון: טוענים אותם משם לתצוגה
async function hydrateBatch(api, result, live) {
  if (api.kind === 'real' && result && Array.isArray(result.savedIds) && result.savedIds.length) {
    const lib = await libraryP(), list = [];
    for (const id of result.savedIds) {
      const c = await lib.get(id);
      if (c) { c.savedId = id; c.fromLibrary = true; c.sourceIndex = live.idToIndex.get(id); list.push(c); }
    }
    if (list.length) return list;
  }
  const flat = M.flattenBatch(result);
  return flat.length ? flat : live.collected;
}

// מריץ משימה כללית (עריכה רגילה, תור, תגובה) עם ביטול, מניעת כיבוי מסך וסיום אחיד
async function runJob(work, isBatch = false, begin = { type: 'start' }) {
  releaseClips();
  dispatch(begin);
  if (state.screen !== 'progress') return;
  abort = new AbortController();
  const signal = abort.signal;
  keepAwake(true);
  try {
    const list = await work(signal);
    if (signal.aborted) return;
    await featuresReady;
    clips = (Array.isArray(list) ? list : []).filter((c) => c && (c.blob || c.url));
    clips.forEach((c) => { if (!c.url && c.blob) c.url = URL.createObjectURL(c.blob); });
    dispatch({ type: 'progress', fraction: 1, text: T.progress.done });
    dispatch({ type: 'done', clips });
    if (state.screen === 'results') { saveToLibrary(clips.filter((c) => !c.savedId)); if (isBatch && !(await batchIsReal())) notifyDone(clips.length); }
  } catch (e) {
    if (signal.aborted) return;
    if (!(e && e.name === 'AbortError')) console.warn('FRAME:', e);
    dispatch({ type: 'fail', error: e });
  } finally {
    if (abort && abort.signal === signal) abort = null;
    keepAwake(false);
  }
}
function runTask(fn, meta) {
  files = [];
  dispatch({ type: 'pickFile', file: meta });
  if (!state.file) return;
  runJob((signal) => fn({ signal, onProgress: throttle((f, text) => dispatch({ type: 'progress', fraction: f, text })) }));
}
function cancel() {
  if (abort) abort.abort();
  dispatch({ type: 'cancel' });
}

// ------------------------------------------------------------------ ספרייה

const libraryP = () => loadLibrary();
const batchIsReal = async () => !!(await loadBatchModule());
async function saveToLibrary(list) {
  if (!list.length) return;
  let failed = false, full = false;
  try {
    const lib = await libraryP();
    for (const c of list) {
      try { const saved = await lib.save(c, { onLowSpace: lowSpaceDialog }); if (saved && saved.id) c.savedId = saved.id; } catch (e) { if (e && e.name === 'LibraryFullError') full = true; else failed = true; }
    }
  } catch { failed = true; }
  if (full) toast(T.library.full); else if (failed) toast(T.library.saveFailed);
}
// בקשה לשמירה קבועה: רק מתוך לחיצה של המשתמש, בלי להמתין לתשובה
function requestPersist() {
  libraryP().then((lib) => { if (lib.persist) lib.persist().catch(() => {}); }).catch(() => {});
}

// ------------------------------------------------------------------ תור שנקטע: "יש תור שנעצר, להמשיך?"

let pendingJob = null;
async function checkPending() {
  try {
    const batch = await loadBatchModule();
    if (!batch || !batch.pending) return;
    const list = await batch.pending();
    pendingJob = (Array.isArray(list) ? list.map(M.normalizePending).filter(Boolean) : [])[0] || null;
  } catch { pendingJob = null; }
  if (pendingJob && state.screen === 'home') render();
}
function resumeWith(picked) {
  const info = pendingJob;
  if (!info) return;
  pendingJob = null;
  files = [];
  runJob(async (signal) => {
    const batch = await loadBatchModule();
    const live = batchCallbacks(signal);
    try {
      const result = await batch.resume(info.id, { ...live.callbacks, files: picked });
      return hydrateBatch(batch, result, live);
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw new Error(e && /[֐-׿]/.test(e.message || '') ? e.message : T.batch.resumeFailed);
    }
  }, true, { type: 'resumeBatch', items: info.items });
}
function discardPending() {
  const info = pendingJob;
  if (!info) return;
  const m = openModal({ label: T.batch.discardTitle, content: [h('h2', {}, T.batch.discardTitle), h('p', { class: 'lede' }, T.batch.discardText),
    h('div', { class: 'sheet-row' },
      h('button', { type: 'button', class: 'cta cta-sm danger-btn', onClick: async () => { m.close(); try { const batch = await loadBatchModule(); await batch.discard(info.id); } catch { /* כבר נמחק */ } pendingJob = null; toast(T.batch.discarded); if (state.screen === 'home') render(); } }, T.batch.pendingDiscard),
      h('button', { type: 'button', class: 'ghost-btn', onClick: () => m.close() }, T.library.cancel))] });
}
function pendingBanner() {
  if (!pendingJob) return null;
  const info = pendingJob;
  const picker = h('input', { type: 'file', accept: 'video/*', multiple: true, class: 'sr-only', onChange: (e) => { const list = [...(e.target.files || [])]; e.target.value = ''; if (list.length) resumeWith(list); } });
  const go = info.needFiles > 0 ? () => picker.click() : () => resumeWith([]); // הלחיצה פותחת את הבוחר ישירות, כדי לשמור על המחווה
  return h('div', { class: 'pending-banner rise' },
    h('b', {}, T.batch.pendingTitle), h('small', {}, info.text), info.needFiles > 0 ? h('small', {}, T.batch.pendingPickHint(info.needFiles)) : null,
    h('div', { class: 'sheet-row' },
      h('button', { type: 'button', class: 'cta cta-sm', onClick: go }, icon('refresh', 20), h('span', {}, info.needFiles > 0 ? T.batch.pendingPick : T.batch.pendingResume)),
      h('button', { type: 'button', class: 'ghost-btn small', onClick: discardPending }, T.batch.pendingDiscard)),
    picker);
}

// ------------------------------------------------------------------ שיתוף, הורדה, תמונת שער ופוסט

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, class: 'sr-only' });
  document.body.append(a); a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 4000);
}
async function shareBlob(blob, name, title) {
  const type = blob.type || (/\.jpe?g$/.test(name) ? 'image/jpeg' : 'video/mp4');
  let file = null;
  try { file = new File([blob], name, { type }); } catch { file = null; }
  const can = !!(file && navigator.canShare && navigator.canShare({ files: [file] }));
  if (M.shareStrategy({ hasShare: typeof navigator.share === 'function', canShareFiles: can }) === 'share') {
    try { await navigator.share({ files: [file], title: title || 'FRAME' }); toast(T.results.shared); return; } catch (e) {
      if (e && e.name === 'AbortError') { toast(T.results.shareCancelled); return; }
      toast(T.results.shareFailed); return;
    }
  }
  downloadBlob(blob, name); toast(T.results.downloadStarted);
}
const hookNow = (i) => M.hookOf(state.results && state.results.clips[i], clips[i]);
function shareClip(i) { const c = clips[i]; if (c && c.blob) shareBlob(c.blob, M.clipFileName({ ...c, hook: hookNow(i) }, i), hookNow(i)); }
function downloadClip(i) { const c = clips[i]; if (c && c.blob) { downloadBlob(c.blob, M.clipFileName({ ...c, hook: hookNow(i) }, i)); toast(T.results.downloadStarted); } }
function thumbUrl(i) {
  if (!thumbUrls[i] && clips[i] && clips[i].thumbnail instanceof Blob) thumbUrls[i] = URL.createObjectURL(clips[i].thumbnail);
  return thumbUrls[i] || '';
}

function transcriptOf(clip) {
  const t = clip.transcript || (clip.state && clip.state.transcript);
  if (t) return t;
  const m = clip.moment || {};
  return { text: String(m.text || clip.hook || ''), words: Array.isArray(m.words) ? m.words : [], language: settings.language === 'en' ? 'en' : 'he' };
}
async function postInfo(i) {
  const clip = clips[i];
  if (!clip) return null;
  if (postCache.has(clip)) return postCache.get(clip);
  const p = (async () => {
    await featuresReady;
    let post = M.normalizePost(clip.post);
    const kit = has['post-kit'] ? await loadFeature('post-kit') : null;
    if (!post && kit && typeof kit.makePost === 'function') {
      try { post = M.normalizePost(await kit.makePost(transcriptOf(clip), clip.moment || {}, { lang: settings.language === 'en' ? 'en' : 'he', genre: (clip.options && clip.options.genre) || 'auto', platform: 'reels' })); } catch { post = null; }
    }
    const cover = clip.cover instanceof Blob ? clip.cover : null;
    const canCover = !cover && has.cover && !!sourceOf(clip);
    return { post, cover, canCover };
  })();
  postCache.set(clip, p);
  return p;
}
const sourceOf = (clip) => (Number.isInteger(clip.sourceIndex) ? files[clip.sourceIndex] : files.length === 1 ? files[0] : null) || null;
async function makeCoverFor(i) {
  const clip = clips[i], src = clip && sourceOf(clip);
  if (!clip || !src) return false;
  try {
    const mod = await loadFeature('cover');
    if (!mod || typeof mod.makeCover !== 'function') return false;
    const blob = await mod.makeCover(src, clip.moment || {}, { title: hookNow(i) || clip.title || '', style: 'bold' });
    if (!(blob instanceof Blob)) return false;
    clip.cover = blob; postCache.delete(clip);
    return true;
  } catch { return false; }
}
function saveCover(i) { const c = clips[i]; if (c && c.cover) { downloadBlob(c.cover, M.coverFileName(c, i)); toast(T.post.coverSaved); } }
function shareCover(i) { const c = clips[i]; if (c && c.cover) shareBlob(c.cover, M.coverFileName(c, i), hookNow(i)); }

// ------------------------------------------------------------------ כותרת (hook) ועורך מהיר

let hookChain = Promise.resolve();
function pickHook(i, j) {
  dispatch({ type: 'selectHook', clip: i, index: j });
  const hook = state.results && state.results.clips[i] && state.results.clips[i].hooks[j];
  hookChain = hookChain.then(async () => {
    const engine = await getEngine();
    if (!hook || !engine.rehook || !clips[i] || clips[i].hook === hook) return;
    const done = toast(T.results.rendering || '…', { sticky: true });
    try {
      const old = clips[i];
      const next = await engine.rehook(old, hook, { signal: abort ? abort.signal : undefined });
      if (next && next.blob) {
        clips[i] = { ...old, ...next, url: next.url || URL.createObjectURL(next.blob) };
        if (old.url && old.url !== clips[i].url) setTimeout(() => URL.revokeObjectURL(old.url), 1500);
        postCache.delete(old);
        dispatch({ type: 'selectHook', clip: i, index: j }); // מרענן את הנגן
        if (current && current.update) current.update(state);
      }
    } catch { toast(T.errors.generic); } finally { done(); }
  });
}
const canEdit = (i) => !!(has['quick-editor'] && clips[i] && clips[i].state);
function openEditor(i) { dispatch({ type: 'openEditor', clip: i }); }
async function exportEdit(i, arg, onProgress, signal) {
  const engine = await getEngine();
  abort = new AbortController();
  const sig = signal || abort.signal;
  let out = null;
  try {
    if (arg && arg.blob instanceof Blob) out = arg;
    else if (arg instanceof Blob) out = { ...clips[i], blob: arg, url: '' };
    else if (engine.renderState) out = await engine.renderState(arg, { onProgress, signal: sig });
    else throw new Error(T.editor.noRender);
  } finally { abort = null; }
  if (!out || !(out.blob instanceof Blob)) throw new Error(T.errors.generic);
  const old = clips[i];
  const merged = { ...old, ...out, state: out.state || (arg && !(arg instanceof Blob) && !arg.blob ? arg : old.state), url: out.url || URL.createObjectURL(out.blob) };
  clips[i] = merged; postCache.delete(old);
  if (old.url && old.url !== merged.url) setTimeout(() => URL.revokeObjectURL(old.url), 1500);
  dispatch({ type: 'clipUpdated', clip: i, data: merged });
  dispatch({ type: 'closeEditor' });
  saveToLibrary([merged]);
}

// ------------------------------------------------------------------ התקנה

function installInfo() {
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const mode = M.installMode({ standalone, ua: navigator.userAgent, touchPoints: navigator.maxTouchPoints || 0, canPrompt: !!deferredPrompt });
  return {
    mode, canPrompt: !!deferredPrompt, iosSafari: M.isIOSSafari(navigator.userAgent),
    async prompt() {
      if (!deferredPrompt) { dispatch({ type: 'go', screen: 'install' }); return; }
      const p = deferredPrompt; deferredPrompt = null;
      try { await p.prompt(); await p.userChoice; } catch { /* נסגר */ }
      render();
    },
  };
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; if (state.screen === 'home' || state.screen === 'settings' || state.screen === 'install') render(); });
window.addEventListener('appinstalled', () => { deferredPrompt = null; toast(T.settings.installed); render(); });

function installBanner() {
  const info = installInfo();
  if (!M.showInstallBanner(info.mode, store.installDismissedAt(), Date.now())) return null;
  const box = h('div', { class: 'install-banner rise' },
    h('span', { class: 'ib-icon' }, icon('plus', 22)),
    h('span', { class: 'ib-text' }, h('b', {}, T.install.banner), h('small', {}, T.install.bannerHint)),
    h('button', { type: 'button', class: 'ghost-btn small', onClick: () => (info.canPrompt ? info.prompt() : dispatch({ type: 'go', screen: 'install' })) }, info.canPrompt ? T.settings.installNow : T.install.how),
    h('button', { type: 'button', class: 'chip-x', 'aria-label': T.install.dismiss, onClick: () => { store.dismissInstall(); box.remove(); } }, icon('close', 16)));
  return box;
}

// ------------------------------------------------------------------ Service Worker

let reloading = false;
async function clearCache() {
  try {
    if ('caches' in window) for (const k of await caches.keys()) await caches.delete(k);
    if ('serviceWorker' in navigator) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  } catch { /* */ }
  toast(T.settings.cacheCleared);
  setTimeout(() => location.reload(), 900);
}
function showUpdate(worker) {
  toast(T.update.ready, { sticky: true, action: { label: T.update.action, onClick: () => {
    if (state.screen === 'progress') { toast(T.update.busy); return; }
    reloading = true; worker.postMessage({ type: 'SKIP_WAITING' });
  } } });
}
async function registerSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  try {
    const hadController = !!navigator.serviceWorker.controller;
    const reg = await navigator.serviceWorker.register('./sw.js');
    swReg = reg;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloading) location.reload(); });
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (w) w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdate(w); });
    });
    if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
    // קבצי האפליקציה השתנו בשרת, וה־SW כבר שמר אותם: מספיק לרענן
    let fileUpdateShown = false;
    navigator.serviceWorker.addEventListener('message', (e) => {
      // לחיצה על התראה "הקליפים מוכנים": עוברים לספרייה, אלא אם עריכה רצה עכשיו
      if (e.data && e.data.type === 'OPEN_TAB' && ROOTS.includes(e.data.tab)) { if (state.screen !== 'progress') dispatch({ type: 'go', screen: e.data.tab }); return; }
      if (!e.data || e.data.type !== 'UPDATE_AVAILABLE' || fileUpdateShown) return;
      fileUpdateShown = true;
      toast(T.update.ready, { sticky: true, action: { label: T.update.action, onClick: () => { if (state.screen === 'progress') { toast(T.update.busy); fileUpdateShown = false; } else location.reload(); } } });
    });
    if (!hadController) {
      navigator.serviceWorker.ready.then(() => {
        let seen = false; try { seen = localStorage.getItem('frame-offline-seen') === '1'; localStorage.setItem('frame-offline-seen', '1'); } catch { /* */ }
        if (!seen) toast(T.offline.ready);
      });
    }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  } catch { /* בלי SW האפליקציה ממשיכה לעבוד, רק בלי מצב לא מקוון */ }
}
window.addEventListener('offline', () => toast(T.offline.off));

// ------------------------------------------------------------------ ctx: מה שהמסכים מקבלים

const ctx = {
  get state() { return state; },
  get settings() { return settings; },
  get clips() { return clips; },
  get fileUrl() { return fileUrl; },
  get install() { return installInfo(); },
  get turbo() { return turbo; },
  location, version: VERSION,
  pendingBanner, dispatch, toast, pickFile, pickFiles, setBgGallery, start, cancel, runTask, clearCache, installBanner,
  shareClip, downloadClip, shareBlob, thumbUrl, pickHook, saveCover, shareCover, makeCoverFor, postInfo,
  canEdit, openEditor, exportEdit, notifyStatus, askNotify,
  hasBrand: () => brandKnown || !!settings.brandName,
  brand: async () => { const name = settings.brandName.replace(/^@+/, ''), logo = (await logoBlob()) || undefined; return name || logo ? { name, logo } : undefined; },
  saveSettings,
  library: libraryP,
  loadFeature,
  engine: getEngine,
  lastTranscript: () => { const c = clips[0]; return c ? (c.transcript || (c.state && c.state.transcript) || null) : null; },
  saveLogo: async (blob) => { const ok = await store.setLogo(blob); if (ok) brandKnown = true; return ok; },
  removeLogo: async () => { await store.clearLogo(); brandKnown = !!settings.brandName; },
  logoUrl: async () => { const b = await store.getLogo(); return b ? URL.createObjectURL(b) : ''; },
};

// ------------------------------------------------------------------ אתחול

function buildTabs() {
  clear(tabsEl);
  for (const tab of M.TABS) {
    tabsEl.append(h('button', { type: 'button', class: 'tab', dataset: { tab }, onClick: () => dispatch({ type: 'go', screen: tab }) },
      icon(TAB_ICONS[tab], 22), h('span', {}, T.tabs[tab])));
  }
}
function paintBadge() {
  badgeEl.hidden = !turbo.connected;
  clear(badgeEl);
  if (turbo.connected) badgeEl.append(icon('mac', 16), h('span', {}, T.settings.turboOn));
}

async function probeFeatures() {
  await Promise.all(FEATURES.map(async (f) => { has[f] = !!(await loadFeature(f)); }));
  if (current && ['results', 'library'].includes(state.screen) && current.update) current.update(state);
}

function boot() {
  applyTheme();
  try { history.replaceState({ screen: 'home' }, ''); } catch { /* */ }
  buildTabs();
  const wantTab = new URLSearchParams(location.search).get('tab');
  if (ROOTS.includes(wantTab) && wantTab !== 'home') state = M.reduce(state, { type: 'go', screen: wantTab });
  render();
  const boot = document.getElementById('boot');
  if (boot) { boot.classList.add('is-out'); setTimeout(() => boot.remove(), 300); }
  registerSW();
  featuresReady = probeFeatures();
  featuresReady.then(checkPending);
  turboStatus(location).then((s) => { turbo = s; paintBadge(); if (state.screen === 'settings') mount('settings'); }).catch(() => {});
}
boot();

// לבדיקות ולניפוי שגיאות
window.__frame = { get state() { return state; }, dispatch, ctx, has };
