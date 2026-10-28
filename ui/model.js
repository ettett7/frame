// הלוגיקה הטהורה של הממשק: מצבים, ניווט, אפשרויות, התקדמות, התקנה, שיתוף.
// אין כאן DOM ואין רשת, ולכן הכול נבדק ב־node (tests/ui.test.mjs).
import { T, lengthLabel, clipsLabel, etaText } from './texts.js';

// ------------------------------------------------------------------ קטלוגים

export const TYPES = [
  { id: 'viral', icon: '🔥', name: 'ויראלי', genre: 'auto', style: 'bold', pacing: 'tight' },
  { id: 'podcast', icon: '🎙', name: 'פודקאסט', genre: 'podcast', style: 'clean', pacing: 'natural' },
  { id: 'food', icon: '🍔', name: 'אוכל', genre: 'food', style: 'bold', pacing: 'natural' },
  { id: 'prank', icon: '😂', name: 'מתיחות', genre: 'prank', style: 'punch', pacing: 'tight' },
  { id: 'fitness', icon: '💪', name: 'כושר', genre: 'fitness', style: 'bold', pacing: 'tight' },
  { id: 'tips', icon: '🎓', name: 'טיפים', genre: 'tips', style: 'clean', pacing: 'natural' },
];
export const LENGTHS = ['auto', 15, 30, 60];
export const COUNTS = [1, 3, 5];
export const MUSIC = [
  { id: '', name: 'ללא' },
  { id: 'lofi', name: 'לואו־פיי' },
  { id: 'drive', name: 'אנרגטי' },
  { id: 'playful', name: 'שובב' },
  { id: 'epic', name: 'אפי' },
  { id: 'ambient', name: 'אווירה רגועה' },
];
export const FORMATS = ['9:16', '4:5', '1:1'];
export const FORMAT_NAMES = { '9:16': 'סטורי וריל', '4:5': 'פיד', '1:1': 'ריבוע' };
export const TEMPLATE_IDS = T.templates.list.map((x) => x.id);
export const LANGUAGES = ['auto', 'he', 'en'];
export const QUALITIES = ['fast', 'high'];
export const THEMES = ['dark', 'light', 'auto'];
export const LIMITS = { maxBytes: 2 * 1024 ** 3, longSeconds: 20 * 60, brandMax: 30, maxBatch: 12, nameMax: 60 };
export const BACKGROUNDS = ['none', 'blur', 'replace'];
// רקעים מובנים: מצוירים על קנבס בזמן הצורך (ui/backgrounds.js), ו־'gallery' הוא תמונה מהגלריה
export const BG_SCENES = [
  { id: 'studio', name: 'סטודיו', from: '#2b3a55', to: '#0f1624' },
  { id: 'sunset', name: 'שקיעה', from: '#ff8a4c', to: '#6a2c70' },
  { id: 'mint', name: 'מנטה', from: '#7be0c3', to: '#1c5d6e' },
  { id: 'neon', name: 'ניאון', from: '#b84dff', to: '#101036' },
];
export const BG_IDS = [...BG_SCENES.map((x) => x.id), 'gallery'];
export const DENSITIES = ['low', 'normal', 'high'];

// ------------------------------------------------------------------ מסכים

export const MAIN_SCREENS = ['home', 'options', 'progress', 'results'];
export const SUB_SCREENS = ['templates', 'smart', 'settings', 'install', 'teleprompter', 'reaction', 'voice', 'library', 'editor'];
export const SCREENS = [...MAIN_SCREENS, ...SUB_SCREENS];
export const TABS = ['home', 'library', 'templates', 'smart', 'settings'];

// איזה לשונית מודגשת בכל מסך
export function tabOf(screen) {
  if (screen === 'templates') return 'templates';
  if (screen === 'library') return 'library';
  if (['smart', 'teleprompter', 'reaction', 'voice'].includes(screen)) return 'smart';
  if (screen === 'settings' || screen === 'install') return 'settings';
  return 'home';
}
// בהתקדמות ובתוצאות אין שורת לשוניות, כדי שהנגן והסרגל יקבלו את כל המסך
export const showTabs = (screen) => !['progress', 'results', 'editor'].includes(screen);

// ------------------------------------------------------------------ קובץ

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|3gp|3g2|avi|mts|m2ts)$/i;
export const isVideoMeta = (meta) => !!meta && (String(meta.type || '').startsWith('video/') || (!meta.type && VIDEO_EXT.test(String(meta.name || ''))));

export function fileMeta(file) {
  const f = file || {};
  return { name: String(f.name || 'סרטון'), type: String(f.type || ''), size: Number(f.size) || 0, duration: Number.isFinite(f.duration) ? f.duration : null };
}

// בדיקה לפני שמתחילים: מחזירה {ok, error, warn}
export function validateFile(meta) {
  const m = meta || {};
  if (!isVideoMeta(m)) return { ok: false, error: T.options.notVideo };
  if (!(Number(m.size) > 0)) return { ok: false, error: T.options.empty };
  if (Number(m.size) > LIMITS.maxBytes) return { ok: false, error: T.options.fileHuge };
  if (Number(m.duration) > LIMITS.longSeconds) return { ok: true, warn: T.options.fileLong };
  return { ok: true };
}

// ------------------------------------------------------------------ מצב

export function initialState(extra = {}) {
  return {
    screen: 'home', file: null, type: 'viral', length: 'auto', count: 3, music: '', format: '9:16', captions: true, template: null,
    background: 'none', bgScene: 'studio', bgGallery: null, density: 'normal', brand: true,
    batch: null, batchRun: null, editing: null,
    job: null, results: null, error: '', notice: '', ...extra,
  };
}

const OPTION_CHECKS = {
  type: (v) => TYPES.some((x) => x.id === v),
  length: (v) => LENGTHS.includes(v),
  count: (v) => COUNTS.includes(v),
  music: (v) => v === '' || MUSIC.some((x) => x.id === v),
  format: (v) => FORMATS.includes(v),
  captions: (v) => typeof v === 'boolean',
  template: (v) => v === null || TEMPLATE_IDS.includes(v),
  background: (v) => BACKGROUNDS.includes(v),
  bgScene: (v) => BG_IDS.includes(v),
  density: (v) => DENSITIES.includes(v),
  brand: (v) => typeof v === 'boolean',
};

// "החלפת רקע" דורשת תמונה: מובנית, או מהגלריה אחרי שנבחרה
export const backgroundReady = (s) => s.background !== 'replace' || s.bgScene !== 'gallery' || !!s.bgGallery;
export const canStart = (s) => !!s.file && validateFile(s.file).ok && s.screen === 'options' && backgroundReady(s);

// ------------------------------------------------------------------ התקדמות

export const STEPS = [
  { id: 'prepare', label: 'הכנת הסרטון', from: 0 },
  { id: 'transcribe', label: 'תמלול הדיבור', from: 0.08 },
  { id: 'moments', label: 'בחירת הרגעים החזקים', from: 0.45 },
  { id: 'frame', label: 'מסגור לטלפון', from: 0.58 },
  { id: 'render', label: 'עריכה ורינדור', from: 0.7 },
];
const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

export function stepIndex(fraction) {
  const f = clamp01(fraction);
  let idx = 0;
  STEPS.forEach((st, i) => { if (f >= st.from) idx = i; });
  return idx;
}
// שלבים עם מצב: סיימנו, פעיל, ממתין
export function stepStates(fraction, done = false) {
  const active = done ? STEPS.length : stepIndex(fraction);
  return STEPS.map((st, i) => ({ id: st.id, label: st.label, state: i < active ? 'done' : i === active ? 'active' : 'pending' }));
}

// הערכת זמן: לפי הקצב עד עכשיו. לפני 4% או 3 שניות אין מספיק מידע
export function etaSeconds(startedAt, now, fraction) {
  const f = clamp01(fraction), elapsed = (now - startedAt) / 1000;
  if (f < 0.04 || elapsed < 3) return null;
  if (f >= 1) return 0;
  return (elapsed * (1 - f)) / f;
}
// החלקה, כדי שהמספר לא יקפוץ מצד לצד
export const smoothEta = (prev, raw) => (raw === null ? prev : prev === null || prev === undefined ? raw : prev * 0.6 + raw * 0.4);

// ------------------------------------------------------------------ שגיאות

const HEBREW = /[֐-׿]/;
export function friendlyError(err) {
  if (err && (err.name === 'AbortError' || err.aborted)) return { cancelled: true, message: T.progress.cancelled };
  const msg = err && typeof err.message === 'string' ? err.message : '';
  if (HEBREW.test(msg)) return { cancelled: false, message: msg };
  if (/memory|allocation|out of|oom|quota/i.test(msg)) return { cancelled: false, message: T.errors.memory };
  if (/import|module|fetch|network|load/i.test(msg)) return { cancelled: false, message: T.errors.engine };
  return { cancelled: false, message: T.errors.generic };
}

// ------------------------------------------------------------------ המצב כפונקציה טהורה

const M_batchFraction = (items) => (items.length ? items.reduce((sum, it) => sum + (it.status === 'done' || it.status === 'error' ? 1 : 0), 0) / items.length : 0);
export const BATCH_STATUS = ['waiting', 'working', 'done', 'error'];
// קליפ בתוצאות: עד שלוש כותרות ייחודיות, והנבחרת היא זו של הקליפ
export function resultOf(c, i = 0) {
  const hooks = [...new Set([...(Array.isArray(c.hooks) ? c.hooks : []), c.hook].filter((x) => typeof x === 'string' && x.trim()))].slice(0, 3);
  const at = hooks.indexOf(c.hook);
  return { id: i, hooks, hookIndex: at >= 0 ? at : 0 };
}

export function reduce(state, action) {
  const s = state;
  switch (action.type) {
    case 'pickFile': {
      const meta = fileMeta(action.file), check = validateFile(meta);
      if (!check.ok) return { ...s, error: check.error, notice: '' };
      return { ...s, file: meta, batch: null, batchRun: null, screen: 'options', error: '', notice: check.warn || '', job: null, results: null };
    }
    case 'pickFiles': {
      const metas = (Array.isArray(action.files) ? action.files : []).map(fileMeta);
      const valid = metas.filter((m) => validateFile(m).ok);
      if (!valid.length) return { ...s, error: metas.length ? validateFile(metas[0]).error : T.options.notVideo, notice: '' };
      if (valid.length === 1) return reduce(s, { type: 'pickFile', file: valid[0] });
      const kept = valid.slice(0, LIMITS.maxBatch);
      const notice = valid.length > kept.length ? T.batch.tooMany : valid.length < metas.length ? T.options.someSkipped : '';
      return { ...s, file: kept[0], batch: { files: kept }, batchRun: null, screen: 'options', error: '', notice, job: null, results: null };
    }
    case 'clearFile':
      return { ...s, file: null, batch: null, batchRun: null, screen: 'home', error: '', notice: '', job: null, results: null };
    case 'setBgGallery':
      return { ...s, bgGallery: action.name ? { name: String(action.name) } : null, bgScene: action.name ? 'gallery' : s.bgScene, error: '' };
    case 'setDuration': {
      if (!s.file || !Number.isFinite(action.duration)) return s;
      const file = { ...s.file, duration: action.duration }, check = validateFile(file);
      return { ...s, file, notice: check.warn || s.notice };
    }
    case 'setOption': {
      const check = OPTION_CHECKS[action.key];
      if (!check || !check(action.value)) return s;
      return { ...s, [action.key]: action.value, error: '' };
    }
    case 'go': {
      if (!SCREENS.includes(action.screen)) return s;
      if (action.screen === 'options' && !s.file) return s;
      if (action.screen === 'progress' || action.screen === 'results') return s; // רק דרך התחלה וסיום
      if (action.screen === 'editor') return s; // רק דרך openEditor
      if (s.screen === 'progress') return s; // בזמן עריכה יוצאים רק בביטול
      if (action.screen === 'home' && s.file && s.screen !== 'home') return { ...s, screen: 'options', error: '' };
      return { ...s, screen: action.screen, error: '' };
    }
    case 'start': {
      if (!canStart(s)) return s;
      const batchRun = s.batch ? { items: s.batch.files.map((f) => ({ name: f.name, status: 'waiting', fraction: 0 })), doneCount: 0 } : null;
      return { ...s, screen: 'progress', error: '', batchRun, job: { startedAt: action.now ?? 0, fraction: 0, step: 0, text: '', eta: null, etaAt: 0 }, results: null };
    }
    case 'resumeBatch': {
      // המשך תור שנקטע: אין קובץ נבחר, רק רשימת הסרטונים מהתור
      if (s.screen === 'progress') return s;
      const items = (Array.isArray(action.items) ? action.items : []).map((it) => ({ name: String(it.name || 'סרטון'), status: it.status === 'done' ? 'done' : it.status === 'error' ? 'error' : 'waiting', fraction: it.status === 'done' ? 1 : 0 }));
      if (!items.length) return s;
      const batchRun = { items, doneCount: items.filter((it) => it.status === 'done' || it.status === 'error').length, resumed: true };
      return { ...s, screen: 'progress', error: '', notice: '', batchRun, job: { startedAt: action.now ?? 0, fraction: M_batchFraction(items), step: 0, text: '', eta: null, etaAt: 0 }, results: null };
    }
    case 'batchItem': {
      if (!s.batchRun) return s;
      const items = s.batchRun.items.map((it, i) => (i === action.index ? { ...it, status: BATCH_STATUS.includes(action.status) ? action.status : it.status, fraction: action.status === 'done' ? 1 : clamp01(action.fraction ?? it.fraction), error: action.error || '' } : it));
      return { ...s, batchRun: { items, doneCount: items.filter((it) => it.status === 'done' || it.status === 'error').length } };
    }
    case 'progress': {
      if (s.screen !== 'progress' || !s.job) return s;
      const fraction = Math.max(s.job.fraction, clamp01(action.fraction)), now = action.now ?? 0;
      const eta = smoothEta(s.job.eta, etaSeconds(s.job.startedAt, now, fraction));
      return { ...s, job: { ...s.job, fraction, step: stepIndex(fraction), text: String(action.text || s.job.text || ''), eta, etaAt: eta === s.job.eta ? s.job.etaAt : now } };
    }
    case 'done': {
      if (s.screen !== 'progress') return s;
      const clips = (Array.isArray(action.clips) ? action.clips : []).map(resultOf);
      if (!clips.length) return { ...s, screen: s.file ? 'options' : 'home', job: null, batchRun: null, results: null, error: T.results.noClips };
      return { ...s, screen: 'results', job: null, batchRun: null, results: { clips, active: 0 }, error: '', notice: s.batchRun && s.batchRun.items.some((it) => it.status === 'error') ? T.batch.someFailed : '' };
    }
    case 'fail': {
      const f = friendlyError(action.error);
      return { ...s, screen: s.file ? 'options' : 'home', job: null, batchRun: null, error: f.cancelled ? '' : f.message, notice: f.cancelled ? f.message : '' };
    }
    case 'cancel':
      return s.screen === 'progress' ? { ...s, screen: s.file ? 'options' : 'home', job: null, batchRun: null, error: '', notice: T.progress.cancelled } : s;
    case 'selectHook': {
      if (!s.results) return s;
      const clip = s.results.clips[action.clip];
      if (!clip || !Number.isInteger(action.index) || action.index < 0 || action.index >= clip.hooks.length) return s;
      const clips = s.results.clips.map((c, i) => (i === action.clip ? { ...c, hookIndex: action.index } : c));
      return { ...s, results: { ...s.results, clips } };
    }
    case 'page': {
      if (!s.results) return s;
      const active = Math.min(s.results.clips.length - 1, Math.max(0, Number(action.index) || 0));
      return active === s.results.active ? s : { ...s, results: { ...s.results, active } };
    }
    case 'editAgain':
      return s.file ? { ...s, screen: 'options', results: null, job: null, editing: null, error: '', notice: '' } : s;
    case 'newVideo':
      return { ...initialState(), type: s.type, length: s.length, count: s.count, music: s.music, format: s.format, captions: s.captions, background: s.background, bgScene: s.bgScene, bgGallery: s.bgGallery, density: s.density, brand: s.brand };
    case 'openEditor': {
      if (!s.results || !s.results.clips[action.clip]) return s;
      return { ...s, screen: 'editor', editing: action.clip, error: '' };
    }
    case 'closeEditor':
      return s.results ? { ...s, screen: 'results', editing: null, error: '' } : { ...s, screen: 'home', editing: null };
    case 'clipUpdated': {
      if (!s.results || !s.results.clips[action.clip]) return s;
      const clips = s.results.clips.map((c, i) => (i === action.clip ? { ...resultOf(action.data || {}, i), id: c.id } : c));
      return { ...s, results: { ...s.results, clips } };
    }
    case 'selectTemplate': {
      if (action.id !== null && !TEMPLATE_IDS.includes(action.id)) return s;
      return { ...s, template: action.id, screen: s.file ? 'options' : 'home' };
    }
    default:
      return s;
  }
}

// ------------------------------------------------------------------ אפשרויות לצינור (חוזה: Options)

export function buildOptions(state, settings = {}, assets = {}) {
  const type = TYPES.find((x) => x.id === state.type) || TYPES[0];
  const set = normalizeSettings(settings);
  const options = {
    count: state.count,
    length: state.length,
    style: type.style,
    genre: type.genre,
    music: state.music,
    pacing: type.pacing,
    captions: state.captions,
    language: set.language,
    format: state.format,
    template: state.template,
    quality: set.quality, // תוספת של הממשק: 'high' נותן פלט 1080 (כמו בצינור)
    model: set.quality === 'high' ? 'high' : 'auto', // תוספת של הממשק: דרגת התמלול. 'auto' משאיר למכשיר לבחור
  };
  options.background = BACKGROUNDS.includes(state.background) ? state.background : 'none';
  if (options.background === 'replace' && assets.bgImage) options.backgroundImage = assets.bgImage;
  options.density = DENSITIES.includes(state.density) ? state.density : 'normal';
  const name = set.brandName.replace(/^@+/, '');
  if (state.brand !== false && (name || assets.logo)) {
    options.brand = {};
    if (name) options.brand.name = name;
    if (assets.logo) options.brand.logo = assets.logo;
  }
  return options;
}

export function optionsSummary(state) {
  const type = TYPES.find((x) => x.id === state.type) || TYPES[0];
  const music = MUSIC.find((x) => x.id === state.music);
  const bits = [type.name, state.length === 'auto' ? 'אורך אוטומטי' : lengthLabel(state.length), clipsLabel(state.count), music && music.id ? music.name : 'בלי מוזיקה'];
  if (state.batch) bits.unshift(T.batch.count(state.batch.files.length));
  return bits.join(' · ');
}

// ------------------------------------------------------------------ הגדרות

export const DEFAULT_SETTINGS = { brandName: '', language: 'auto', quality: 'fast', theme: 'auto' };
export function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const brandName = typeof r.brandName === 'string' ? r.brandName.replace(/\s+/g, ' ').trim().slice(0, LIMITS.brandMax) : '';
  return {
    brandName,
    language: LANGUAGES.includes(r.language) ? r.language : DEFAULT_SETTINGS.language,
    quality: QUALITIES.includes(r.quality) ? r.quality : DEFAULT_SETTINGS.quality,
    theme: THEMES.includes(r.theme) ? r.theme : DEFAULT_SETTINGS.theme,
  };
}
// כהה כברירת מחדל: "לפי המכשיר" נהיה בהיר רק כשהמכשיר ביקש בהיר
export const resolveTheme = (theme, prefersLight) => (theme === 'light' || (theme === 'auto' && prefersLight) ? 'light' : 'dark');
export const themeColor = (resolved) => (resolved === 'light' ? '#f3f6ef' : '#0d100f');

// ------------------------------------------------------------------ התקנה

export const isIOS = (ua = '', touchPoints = 0) => /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
export const isAndroid = (ua = '') => /Android/i.test(ua);
// ב־iOS רק Safari יכול להוסיף למסך הבית. דפדפנים אחרים מזוהים לפי סימן בכתובת
export const isIOSSafari = (ua = '') => isIOS(ua, 2) && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua);

// 'installed' | 'ios' | 'android' | 'other'
export function installMode({ standalone = false, ua = '', touchPoints = 0, canPrompt = false } = {}) {
  if (standalone) return 'installed';
  if (isIOS(ua, touchPoints)) return 'ios';
  if (canPrompt || isAndroid(ua)) return 'android';
  return 'other';
}
export const DISMISS_DAYS = 7;
// באנר ההתקנה: רק כשהאפליקציה לא מותקנת, והמשתמש לא סגר אותו בשבוע האחרון
export function showInstallBanner(mode, dismissedAt, now) {
  if (mode === 'installed') return false;
  if (mode === 'other') return false;
  if (!dismissedAt) return true;
  return now - dismissedAt > DISMISS_DAYS * 24 * 3600 * 1000;
}

// ------------------------------------------------------------------ שיתוף והורדה

export const shareStrategy = ({ hasShare = false, canShareFiles = false } = {}) => (hasShare && canShareFiles ? 'share' : 'download');

export function slug(text, max = 24) {
  const s = String(text || '').normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '');
  return s || 'clip';
}
export const extForMime = (mime) => (/mp4|quicktime/i.test(String(mime || '')) ? 'mp4' : /webm/i.test(String(mime || '')) ? 'webm' : 'mp4');
export function clipFileName(clip, index = 0) {
  const c = clip || {};
  return `FRAME-${slug(c.hook || c.title)}-${index + 1}.${extForMime(c.blob && c.blob.type)}`;
}

// ------------------------------------------------------------------ טורבו

// מאיפה נפתחה האפליקציה: 'mac' (מהמק בבית), 'github' (גרסת הענן) או 'local' (פיתוח)
export function turboContext(loc = {}) {
  const host = String(loc.hostname || ''), port = String(loc.port || '');
  if (/\.github\.io$/i.test(host)) return 'github';
  if (port === '18775' || /\.local$/i.test(host)) return 'mac';
  if (/^(localhost|127\.|0\.0\.0\.0)/.test(host) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return 'local';
  return 'github';
}

// ------------------------------------------------------------------ כותרות

export const hookOf = (resultClip, clip) => (resultClip && resultClip.hooks[resultClip.hookIndex]) || (clip && clip.hook) || '';
export const pageLabel = (active, total) => `${active + 1} ${T.results.of} ${total}`;
export { etaText };

// ------------------------------------------------------------------ ספרייה, תור והתראות (מודולים של סוכנים 14 ו־15)

// המודול האמיתי עשוי להחזיר {used, quota} או {usage, quota} או {bytes, quota}
export function normalizeUsage(u) {
  const x = u && typeof u === 'object' ? u : {};
  const used = Math.max(0, Number(x.used ?? x.usage ?? x.bytes ?? x.size) || 0);
  const quota = Math.max(0, Number(x.quota ?? x.total ?? x.limit) || 0);
  const fraction = quota > 0 ? Math.min(1, used / quota) : 0;
  return { used, quota, fraction, known: quota > 0, level: fraction >= 0.9 ? 'full' : fraction >= 0.75 ? 'warn' : 'ok' };
}
const stamp = (it) => Number(it && (it.createdAt ?? it.savedAt ?? it.date ?? it.t)) || 0;
export const sortLibrary = (items) => [...(Array.isArray(items) ? items : [])].sort((a, b) => stamp(b) - stamp(a));
// השם שהמשתמש נתן (title) קודם לכותרת הקליפ (hook)
export const libraryTitle = (it) => String((it && (it.title || it.hook)) || T.library.untitled).trim() || T.library.untitled;
export function validateName(raw) {
  const value = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return { ok: false, error: T.library.nameEmpty, value };
  if (value.length > LIMITS.nameMax) return { ok: false, error: T.library.nameLong, value };
  return { ok: true, value };
}
const STATUS_ALIASES = { waiting: 'waiting', queued: 'waiting', pending: 'waiting', idle: 'waiting', working: 'working', running: 'working', active: 'working', start: 'working', started: 'working', processing: 'working', done: 'done', ok: 'done', finished: 'done', complete: 'done', completed: 'done', success: 'done', error: 'error', failed: 'error', fail: 'error', canceled: 'error', cancelled: 'error', 'needs-file': 'error' };
// אירוע של התור יכול להגיע כ־(index, info) או כאובייקט אחד
export function normalizeBatchEvent(a, b) {
  const info = a && typeof a === 'object' ? a : { ...(b && typeof b === 'object' ? b : {}), index: a };
  const status = STATUS_ALIASES[String(info.status || info.state || '').toLowerCase()] || (info.error ? 'error' : info.clips || info.done ? 'done' : 'working');
  const index = Number.isInteger(info.index) ? info.index : Number.isInteger(info.i) ? info.i : -1;
  return { index, status, fraction: Number.isFinite(info.fraction) ? info.fraction : Number.isFinite(info.progress) ? info.progress : undefined, clips: Array.isArray(info.clips) ? info.clips : info.clip ? [info.clip] : null, clipIds: Array.isArray(info.clipIds) ? info.clipIds : [], error: info.error ? (info.error.message || String(info.error)) : '' };
}
// התוצאה של התור: מערך של קליפים, או מערך של {clips} / מערך של מערכים
export function flattenBatch(result) {
  const out = [];
  const walk = (x) => { if (!x) return; if (Array.isArray(x)) x.forEach(walk); else if (x.clips && Array.isArray(x.clips)) walk(x.clips); else if (x.blob || x.url) out.push(x); };
  walk(result);
  return out;
}
export function batchFraction(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return 0;
  return list.reduce((sum, it) => sum + (it.status === 'done' || it.status === 'error' ? 1 : clamp01(it.fraction)), 0) / list.length;
}
// מצב כפתור ההתראות: 'ask' | 'on' | 'denied' | 'unsupported'
export function notifyState({ supported = false, permission = 'default' } = {}) {
  if (!supported) return 'unsupported';
  return permission === 'granted' ? 'on' : permission === 'denied' ? 'denied' : 'ask';
}

// ------------------------------------------------------------------ פוסט ותמונת שער (סוכן 13)

// {title, description, hashtags[], cta}: מתקן צורות שונות, ומוסיף # להאשטגים
export function normalizePost(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tags = Array.isArray(raw.hashtags) ? raw.hashtags : typeof raw.hashtags === 'string' ? raw.hashtags.split(/\s+/) : [];
  const hashtags = [...new Set(tags.map((t) => String(t).trim().replace(/^#*/, '')).filter(Boolean).map((t) => `#${t}`))];
  const post = { title: String(raw.title || '').trim(), description: String(raw.description || '').trim(), hashtags, cta: String(raw.cta || '').trim() };
  return post.title || post.description || hashtags.length || post.cta ? post : null;
}
export const hashtagsText = (post) => (post ? post.hashtags.join(' ') : '');
export function postText(post) {
  if (!post) return '';
  return [post.title, post.description, hashtagsText(post), post.cta].filter(Boolean).join('\n\n');
}
// פלט הממשק של שיתוף תמונה: שם קובץ לשער
export const coverFileName = (clip, index = 0) => clipFileName(clip, index).replace(/\.(mp4|webm)$/, '-cover.jpg');

// ------------------------------------------------------------------ תור שנקטע ומקום מלא (סוכן 14)

// פריט מ־batch.pending(): מתקן שדות חסרים ומוסיף טקסט בעברית
export function normalizePending(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  const total = Math.max(0, Number(raw.total) || (Array.isArray(raw.items) ? raw.items.length : 0));
  const remaining = Math.max(0, Number(raw.remaining) || 0);
  if (!remaining || !total) return null;
  const needFiles = Math.min(remaining, Math.max(0, Number(raw.needFiles) || 0));
  return {
    id: String(raw.id), total, remaining, needFiles, done: Math.max(0, Number(raw.done) || 0),
    text: T.batch.pendingText(remaining, total), items: Array.isArray(raw.items) ? raw.items : [],
  };
}

// הצעת מחיקה מהספרייה (suggestion של onLowSpace): כמה ישתחרר מהבחירה, והאם מספיק
export function lowSpacePlan(suggestion, selectedIds = []) {
  const sg = suggestion && typeof suggestion === 'object' ? suggestion : {};
  const need = Math.max(0, Number(sg.shortBy) || 0);
  const candidates = Array.isArray(sg.candidates) ? sg.candidates : [];
  const pick = new Set(selectedIds);
  const got = candidates.reduce((sum, c) => (pick.has(c.id) ? sum + Math.max(0, Number(c.bytes) || 0) : sum), 0);
  return { need, got, enough: need > 0 && got >= need, possible: sg.enough !== false && candidates.length > 0, candidates };
}
// הישנים ביותר (הרשימה מגיעה ממוינת מהישן לחדש) עד שמשתחרר מספיק מקום
export function selectOldest(suggestion) {
  const { need, candidates } = lowSpacePlan(suggestion);
  const ids = []; let got = 0;
  for (const c of candidates) { ids.push(c.id); got += Math.max(0, Number(c.bytes) || 0); if (got >= need) break; }
  return ids;
}
