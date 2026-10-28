// pipeline.js: הצינור שמחבר את כל המודולים של FRAME בטלפון.
// makeClips(file, options, {onProgress, signal}) -> [Clip]
//   probe -> decodeAudio -> analyzeAudio -> transcribe -> findMoments ->
//   לכל רגע: planPacing -> analyzeFaces -> cameraFor -> wordsOut + prepareCaptions -> buildTrack -> render -> thumbnail
// המודולים נטענים ב־import() דינמי. מודול (או פונקציה) שחסר מוחלף ב־stub פנימי שמכבד את החוזה.
// אין כאן DOM מחוץ ל־stubs, כך שהקובץ נבדק ב־node עם `modules` מוזרקים.

import { getTemplate, listTemplates, TEMPLATES } from './templates.js';

export { TEMPLATES, listTemplates };

// ------------------------------------------------------------------------------------------------ עזרים

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const round = (x, d = 2) => { const k = 10 ** d; return Math.round(x * k) / k; };
const defaultNow = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now()) / 1000;
// MessageChannel במקום setTimeout: בטאב ברקע setTimeout מוגבל לפעם בשנייה בערך, וכל מעבר בין קליפים היה מתעכב
const yieldTick = () => new Promise((resolve) => {
  if (typeof MessageChannel === 'function') {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
    ch.port2.postMessage(0);
  } else setTimeout(resolve, 0);
});
const errText = (e) => String((e && e.message) || e || 'שגיאה לא ידועה');

export class AbortError extends Error {
  constructor(message = 'העריכה בוטלה') { super(message); this.name = 'AbortError'; }
}
export const isAbortError = (e) => !!e && (e.name === 'AbortError' || e.code === 20);

function throwIfAborted(signal) { if (signal?.aborted) throw new AbortError(); }

/** מחזיר הבטחה שנדחית ב־AbortError ברגע שהאות מופעל, גם אם המודול עצמו לא מכבד אותו. */
function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) { promise.catch?.(() => {}); return Promise.reject(new AbortError()); }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new AbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

// ------------------------------------------------------------------------------------------------ אפשרויות וגדלים

const MUSIC = ['', 'lofi', 'drive', 'playful', 'epic', 'ambient'];
const PACING = ['natural', 'tight', 'off'];
const FORMATS = ['9:16', '1:1', '4:5'];
const LENGTHS = [15, 30, 60, 90];

/** ממלא ברירות מחדל ומתקן ערכים לא חוקיים. שומר גם מפתחות נוספים שהמשתמש העביר. */
export function normalizeOptions(o = {}) {
  const num = Number(o.count);
  const count = Number.isFinite(num) ? clamp(Math.round(num), 1, 5) : 3;
  let length = 'auto';
  if (o.length !== undefined && o.length !== null && o.length !== 'auto') {
    const n = Number(o.length);
    if (Number.isFinite(n) && n > 0) length = LENGTHS.includes(n) ? n : clamp(Math.round(n), 5, 900);
  }
  const lang = typeof o.language === 'string' && o.language ? o.language : 'auto';
  // רקע: 'blur' | 'replace' (+ backgroundImage), או האובייקט {mode, image} ש־resolveBackground של background.js מחזיר
  const bgObj = o.background && typeof o.background === 'object' ? o.background : null;
  const background = bgObj ? bgObj.mode : o.background;
  return {
    ...o,
    background: background === 'blur' || background === 'replace' ? background : undefined,
    density: ['low', 'normal', 'high'].includes(o.density) ? o.density : undefined,   // צפיפות האפקטים (fx.planEffects)
    quality: o.quality === 'high' || o.quality === 'fast' ? o.quality : undefined,    // 'high' = פלט 1080 ורינדור באיכות גבוהה
    backgroundImage: bgObj && bgObj.image !== undefined ? bgObj.image : o.backgroundImage,
    count,
    length,
    style: o.style,
    genre: o.genre || 'auto',
    music: MUSIC.includes(o.music) ? o.music : '',
    pacing: PACING.includes(o.pacing) ? o.pacing : 'natural',
    captions: o.captions !== false,
    language: lang,
    format: FORMATS.includes(o.format) ? o.format : '9:16',
    template: o.template && getTemplate(o.template) ? o.template : null,
  };
}

/** גודל הפלט. ברירת המחדל 720 כדי לחסוך זיכרון ובטריה בטלפון, ו־quality:'high' נותן 1080. */
export function outputSize(format = '9:16', quality = 'standard') {
  const base = quality === 'high' ? 1080 : 720;
  const even = (n) => Math.round(n / 2) * 2;
  if (format === '1:1') return { width: base, height: base };
  if (format === '4:5') return { width: base, height: even(base * 5 / 4) };
  return { width: base, height: even(base * 16 / 9) };
}

// אחוזים (0..100), כמו ש־captions.js מצפה: כך הכתוביות לא נבלעות מתחת לממשק של טיקטוק/אינסטגרם
const DEFAULT_SAFE = { top: 10, bottom: 22, left: 6, right: 10 };

// ------------------------------------------------------------------------------------------------ התקדמות משוקללת

const LABELS = {
  probe: 'בודק את הסרטון',
  decode: 'מפענח שמע',
  analyze: 'מנתח את השמע',
  transcribe: 'מתמלל את הדיבור',
  moments: 'מחפש את הרגעים הטובים',
  pace: 'מכוון קצב',
  faces: 'מזהה פנים ומסגר',
  captions: 'מכין כתוביות',
  audio: 'בונה סאונד ומוזיקה',
  render: 'מייצא',
  bg: 'מכין רקע',
  thumb: 'מכין תמונה ושער',
};

/** הערכת זמן מראש (בשניות) לכל סוג שלב. זה המשקל של השלב בסרגל, והבסיס להערכת הזמן שמתכווננת לפי מדידה. */
export function expectedSeconds(kind, { videoDur = 60, clipDur = 30, bg = false } = {}) {
  switch (kind) {
    case 'probe': return 0.1;
    case 'decode': return 0.1 + videoDur * 0.005;
    case 'analyze': return 0.1 + videoDur * 0.002;
    case 'transcribe': return 4 + videoDur * 0.6;
    case 'moments': return 0.1;
    case 'pace': return 0.1;
    case 'faces': return 1.5 + clipDur * 0.35;
    case 'captions': return 0.2;
    case 'audio': return 0.3 + clipDur * 0.02;
    case 'bg': return 2 + clipDur * 0.8;   // prepareBackground: 0.3 עד 1 שנייה לכל שנייה של קליפ (מדידת סוכן 12)
    case 'render': return 0.5 + clipDur * (bg ? 0.6 : 0.2);
    case 'thumb': return 0.5;
    default: return 1;
  }
}

export function formatEtaHe(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  if (sec < 8) return 'עוד כמה שניות';
  if (sec < 55) return `נותרו כ־${Math.max(10, Math.round(sec / 5) * 5)} שניות`;
  if (sec < 90) return 'נותרה כדקה';
  const m = Math.round(sec / 60);
  if (m < 60) return `נותרו כ־${m} דקות`;
  const h = Math.round(sec / 360) / 10;
  return h <= 1.05 ? 'נותרה כשעה' : `נותרו כ־${h} שעות`;
}

export function makeStage(kind, { id = kind, clip = null, videoDur, clipDur, bg } = {}) {
  return { id, kind, label: LABELS[kind] || kind, clip, expected: expectedSeconds(kind, { videoDur, clipDur, bg }), state: 'pending', frac: 0, startedAt: 0, actual: 0 };
}

/**
 * מעקב התקדמות. משקל שלב = הזמן המשוער שלו. הערכת הזמן שנותר נבנית ממדידה:
 * היחס בין הזמן האמיתי למשוער בשלבים שהסתיימו (לכל סוג שלב בנפרד, ובהיעדרו היחס הכללי).
 * הסרגל לא יורד לאחור גם כשהתוכנית מתעדכנת.
 */
export class ProgressTracker {
  constructor({ now = defaultNow } = {}) {
    this.now = now;
    this.t0 = now();
    this.stages = [];
    this.active = null;
    this.detail = '';
    this.maxFraction = 0;
    this.kindFactor = {};
    this.clipTotal = 1;
    this.finished = false;
    this.lastText = '';
  }

  setPlan(stages) { this.stages = stages.slice(); }

  /** מחליף את כל השלבים שעוד לא התחילו (למשל אחרי שנודע כמה רגעים נמצאו). */
  replacePending(stages) { this.stages = this.stages.filter((s) => s.state !== 'pending').concat(stages); }

  get(id) { return this.stages.find((s) => s.id === id) || null; }

  start(id) {
    const s = this.get(id);
    if (!s) return;
    s.state = 'active'; s.frac = 0; s.startedAt = this.now();
    this.active = s; this.detail = '';
  }

  update(frac, detail = '') {
    const s = this.active;
    if (!s) return;
    const f = Number.isFinite(frac) ? clamp(frac) : s.frac;
    s.frac = Math.max(s.frac, f);
    this.detail = typeof detail === 'string' ? detail : '';
  }

  finish(id) {
    const s = this.get(id);
    if (!s || s.state === 'done') return;
    s.actual = Math.max(0, this.now() - s.startedAt);
    s.state = 'done'; s.frac = 1;
    if (s.expected >= 0.5 && s.actual > 0) {   // שלבים זעירים לא מלמדים כלום על מהירות המכשיר
      const f = clamp(s.actual / s.expected, 0.2, 8);
      this.kindFactor[s.kind] = this.kindFactor[s.kind] === undefined ? f : this.kindFactor[s.kind] * 0.4 + f * 0.6;
    }
    if (this.active === s) { this.active = null; this.detail = ''; }
  }

  /** שלב שדולג: נספר כהושלם בלי להשפיע על המדידה. */
  skip(id) {
    const s = this.get(id);
    if (!s || s.state === 'done') return;
    s.state = 'done'; s.frac = 1; s.actual = 0; s.skipped = true;
  }

  complete() { this.finished = true; this.active = null; for (const s of this.stages) if (s.state !== 'done') { s.state = 'done'; s.frac = 1; s.skipped = true; } }

  elapsed() { return this.now() - this.t0; }

  rawFraction() {
    let total = 0; let done = 0;
    for (const s of this.stages) {
      total += s.expected;
      done += s.state === 'done' ? s.expected : s.state === 'active' ? s.expected * s.frac : 0;
    }
    return total > 0 ? clamp(done / total) : 0;
  }

  fraction() {
    if (this.finished) return 1;
    // שומרים על מקסימום 0.995 עד complete(), כדי ש־1 יסמל "הכול מוכן"
    this.maxFraction = Math.max(this.maxFraction, Math.min(0.995, this.rawFraction()));
    return this.maxFraction;
  }

  /** מהירות המכשיר ביחס לתחזית: חציון היחסים של סוגי השלבים שנמדדו. בלי תמלול (תלוי בהורדת המודל ושונה מאוד בין הרצות). */
  speedFactor() {
    const v = Object.entries(this.kindFactor).filter(([k]) => k !== 'transcribe').map(([, f]) => f).sort((a, b) => a - b);
    if (!v.length) return 1;
    const m = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
    return clamp(m, 0.5, 3);
  }

  etaSeconds() {
    if (this.finished) return 0;
    const now = this.now();
    const speed = this.speedFactor();
    const factor = (kind) => (this.kindFactor[kind] !== undefined ? this.kindFactor[kind] : speed);
    const a = this.active;
    let eta = 0;
    if (a) {
      const aElapsed = Math.max(0, now - a.startedAt);
      eta += a.frac >= 0.1 ? aElapsed * ((1 - a.frac) / a.frac) : a.expected * (1 - a.frac) * factor(a.kind);
    }
    for (const s of this.stages) if (s.state === 'pending') eta += s.expected * factor(s.kind);
    return Math.max(0, eta);
  }

  /** מציג הערכה רק כשיש בסיס למדידה (שלב אחד הסתיים או שעברו כמה שניות והסרגל התקדם). */
  etaKnown() {
    if (this.finished) return false;
    const anyDone = this.stages.some((s) => s.state === 'done' && !s.skipped);
    return (anyDone && this.elapsed() >= 2) || (this.elapsed() >= 4 && this.rawFraction() >= 0.04);
  }

  text() {
    if (this.finished) return 'הקליפים מוכנים';
    const s = this.active;
    if (!s) return this.lastText || 'מתחיל';
    let t = s.label;
    if (s.clip !== null && this.clipTotal > 1) t = `קליפ ${s.clip + 1} מתוך ${this.clipTotal} · ${t}`;
    else if (s.clip === null && this.detail && this.detail !== s.label && this.detail.length <= 40) t += ` · ${this.detail}`;
    this.lastText = t;
    return t;
  }
}

// ------------------------------------------------------------------------------------------------ stubs (מכבדים את החוזה)

const HE_WORDS = ['זה', 'רגע', 'שאי', 'אפשר', 'לשכוח', 'ואז', 'קרה', 'משהו', 'מטורף', 'שאף', 'אחד', 'לא', 'ציפה', 'לו', 'בכלל', 'תראו', 'מה', 'יצא', 'מזה'];

function makeAudioBuffer(channels, sampleRate) {
  const length = channels[0].length;
  if (typeof AudioBuffer !== 'undefined') {
    try {
      const b = new AudioBuffer({ length: Math.max(1, length), numberOfChannels: channels.length, sampleRate });
      channels.forEach((c, i) => b.copyToChannel(c.length ? c : new Float32Array(1), i));
      return b;
    } catch (_) { /* נופלים לאובייקט פשוט */ }
  }
  return {
    sampleRate, length, numberOfChannels: channels.length, duration: length / sampleRate,
    getChannelData: (i) => channels[i],
    copyFromChannel(dst, i, off = 0) { dst.set(channels[i].subarray(off, off + dst.length)); },
  };
}

function onceEvent(el, name, errName = 'error') {
  return new Promise((resolve, reject) => {
    const ok = () => { el.removeEventListener(errName, bad); resolve(); };
    const bad = () => { el.removeEventListener(name, ok); reject(new Error('הדפדפן לא הצליח לקרוא את הסרטון')); };
    el.addEventListener(name, ok, { once: true });
    el.addEventListener(errName, bad, { once: true });
  });
}

async function openVideo(file) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
  await onceEvent(v, 'loadedmetadata');
  return { v, url, close() { v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); } };
}

export const stubs = {
  async probe(file) {
    const h = await openVideo(file);
    try {
      const hasAudio = h.v.audioTracks ? h.v.audioTracks.length > 0 : true;
      return { duration: h.v.duration, width: h.v.videoWidth, height: h.v.videoHeight, fps: 30, hasAudio };
    } finally { h.close(); }
  },

  async decodeAudio(file) {
    const Ctx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!Ctx) throw new Error('הדפדפן לא תומך בפענוח שמע');
    const ctx = new Ctx(1, 1, 22050);
    return ctx.decodeAudioData(await file.arrayBuffer());
  },

  analyzeAudio(buffer) {
    const sr = buffer.sampleRate; const ch = buffer.getChannelData(0);
    const hop = Math.max(1, Math.round(sr / 100));
    const n = Math.ceil(ch.length / hop);
    const envelope = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0; const a = i * hop; const b = Math.min(ch.length, a + hop);
      for (let j = a; j < b; j++) s += ch[j] * ch[j];
      envelope[i] = 10 * Math.log10(s / Math.max(1, b - a) + 1e-10);
    }
    const loud = []; let cur = null;
    for (let i = 0; i < n; i++) {
      if (envelope[i] > -32) { if (!cur) cur = { start: i / 100, end: i / 100, sum: 0, n: 0 }; cur.end = (i + 1) / 100; cur.sum += envelope[i]; cur.n++; }
      else if (cur && (i / 100 - cur.end) > 0.4) { if (cur.end - cur.start >= 0.5) loud.push({ start: cur.start, end: cur.end, db: cur.sum / cur.n }); cur = null; }
    }
    if (cur && cur.end - cur.start >= 0.5) loud.push({ start: cur.start, end: cur.end, db: cur.sum / cur.n });
    return { sampleRate: sr, duration: ch.length / sr, envelope, loud };
  },

  to16kMono(buffer) {
    const sr = buffer.sampleRate; const nch = buffer.numberOfChannels;
    const ratio = sr / 16000; const n = Math.floor(buffer.length / ratio);
    const out = new Float32Array(n);
    const chans = Array.from({ length: nch }, (_, i) => buffer.getChannelData(i));
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * ratio); const b = Math.max(a + 1, Math.floor((i + 1) * ratio));
      let s = 0; let c = 0;
      for (let k = 0; k < nch; k++) for (let j = a; j < b && j < chans[k].length; j++) { s += chans[k][j]; c++; }
      out[i] = c ? s / c : 0;
    }
    return out;
  },

  async detectLanguage() { return 'he'; },

  async transcribe(audio, { language = 'he', onProgress } = {}) {
    // תמלול מדומה: מילים בעברית בתוך אזורי הקול (לפי עוצמה), רק כדי שהצינור כולו ירוץ.
    const dur = (audio?.length || 0) / 16000;
    const words = []; let t = 0; let i = 0;
    const env = audio && audio.length ? stubs._coarseLoud(audio) : [];
    for (const r of env) {
      t = Math.max(t, r.start);
      while (t + 0.4 <= r.end) { words.push({ text: HE_WORDS[i++ % HE_WORDS.length], start: round(t, 2), end: round(t + 0.38, 2) }); t += 0.43; }
    }
    const segments = [];
    for (let k = 0; k < words.length; k += 8) {
      const chunk = words.slice(k, k + 8);
      segments.push({ text: chunk.map((w) => w.text).join(' '), start: chunk[0].start, end: chunk[chunk.length - 1].end });
    }
    onProgress?.(1, 'מתמלל');
    return { language: language === 'auto' ? 'he' : language, words, segments, duration: dur };
  },

  _coarseLoud(audio) { // אזורי קול בחלונות של 0.1 שנייה על אות 16kHz
    const win = 1600; const out = []; let cur = null;
    for (let i = 0; i + win <= audio.length; i += win) {
      let s = 0; for (let j = i; j < i + win; j++) s += audio[j] * audio[j];
      const loud = 10 * Math.log10(s / win + 1e-10) > -34; const t = i / 16000;
      if (loud) { if (!cur) cur = { start: t, end: t + 0.1 }; else cur.end = t + 0.1; }
      else if (cur && t - cur.end > 0.5) { out.push(cur); cur = null; }
    }
    if (cur) out.push(cur);
    return out;
  },

  findMoments(transcript, audioInfo, { count = 3, length = 'auto' } = {}) {
    const dur = audioInfo?.duration || 0;
    if (!dur) return [];
    const win = clamp(typeof length === 'number' ? length : 30, 5, dur);
    const env = audioInfo.envelope; const hop = win / 2;
    const cands = [];
    for (let s = 0; s + win <= dur + 0.001; s += hop) {
      let sum = 0; let n = 0;
      for (let i = Math.floor(s * 100); i < Math.min(env.length, Math.floor((s + win) * 100)); i += 5) { sum += clamp((env[i] + 70) / 70); n++; }
      cands.push({ start: s, end: Math.min(dur, s + win), v: n ? sum / n : 0 });
    }
    cands.sort((a, b) => b.v - a.v);
    const out = [];
    for (const c of cands) {
      if (out.length >= count) break;
      if (out.every((o) => c.end <= o.start || c.start >= o.end)) out.push(c);
    }
    const hooks = ['תראו מה קרה כאן', 'זה רגע שאי אפשר לפספס', 'אף אחד לא ציפה לזה'];
    return out.map((c) => ({ start: round(c.start), end: round(c.end), score: round(c.v * 10, 1), hook: hooks[0], hooks, reason: 'קטע עם הכי הרבה קול', peak: round((c.start + c.end) / 2) }));
  },

  planPacing(transcript, audioInfo, start, end) {
    return { segments: [[start, end]], duration: end - start, removed: 0 };
  },

  mapTime(plan, t) {
    let off = 0;
    for (const [a, b] of plan.segments) { if (t >= a && t <= b) return off + (t - a); off += b - a; }
    return null;
  },

  wordsOut(transcript, plan) {
    const out = [];
    let off = 0;
    for (const [a, b] of plan.segments) {
      for (const w of transcript.words || []) if (w.start >= a - 1e-6 && w.end <= b + 1e-6) out.push({ ...w, start: off + (w.start - a), end: off + (w.end - a) });
      off += b - a;
    }
    return out;
  },

  async analyzeFaces(file, start, end, { fps = 4 } = {}) {
    const samples = [];
    for (let t = start; t <= end + 1e-6; t += 1 / fps) samples.push({ t: round(t, 3), faces: [{ x: 0.38, y: 0.18, w: 0.24, h: 0.3, mouth: 0.08, id: 0 }] });
    return { fps, width: 1280, height: 720, samples };
  },

  cameraFor(samples, plan, { outW = 720, outH = 1280, layout = 'auto' } = {}) {
    const sw = samples?.width || 1280; const sh = samples?.height || 720;
    const faces = (samples?.samples || []).flatMap((s) => s.faces || []);
    if (layout === 'fit' || !faces.length) return { layout: 'fit', rectAt: () => ({ x: 0, y: 0, w: 1, h: 1 }), cuts: [] };
    const cw = Math.min(1, (outW / outH) * (sh / sw));
    const cx = faces.reduce((s, f) => s + f.x + f.w / 2, 0) / faces.length;
    const x = clamp(cx - cw / 2, 0, 1 - cw);
    return { layout: 'tracked', rectAt: () => ({ x, y: 0, w: cw, h: 1 }), cuts: [] };
  },

  // מודולים שעוד לא קיימים: "אין אפקטים", "אין רקע", פוסט מינימלי ובלי שער. הצינור ממשיך כרגיל.
  planEffects: () => null,
  effectsCamera: (camera) => camera,
  drawEffects: () => {},
  effectsAudio: () => [],
  async prepareBackground() { throw new Error('מודול הרקע עדיין לא זמין'); },
  drawWithBackground: () => {},
  makePost: () => null,
  makeCover: async () => null,

  pickKeywords(words) {
    return words.map((w, i) => [w, i]).filter(([w]) => (w.text || '').length >= 5).map(([, i]) => i).slice(0, 8);
  },

  prepareCaptions(spec) { return { spec, words: spec.words || [] }; },

  drawCaptions(ctx, t, prepared) {
    const { width: W, height: H, safeZone } = prepared.spec;
    const i = prepared.words.findIndex((w) => t >= w.start && t < w.end + 0.15);
    if (i < 0) return;
    const text = prepared.words.slice(Math.max(0, i - 1), i + 2).map((w) => w.text).join(' ');
    const px = W * 0.06;
    ctx.save();
    ctx.font = `bold ${Math.round(px)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    try { ctx.direction = prepared.spec.direction || 'rtl'; } catch (_) { /* ignore */ }
    const y = H * (1 - (safeZone?.bottom ?? 0.2)) - px;
    ctx.lineWidth = px * 0.15; ctx.strokeStyle = '#000'; ctx.strokeText(text, W / 2, y);
    ctx.fillStyle = '#fff'; ctx.fillText(text, W / 2, y);
    ctx.restore();
  },

  async buildTrack({ buffer, plan, onProgress }) {
    const sr = buffer.sampleRate; const nch = buffer.numberOfChannels;
    const total = Math.max(1, Math.round(plan.duration * sr));
    const out = Array.from({ length: nch }, () => new Float32Array(total));
    let off = 0;
    for (const [a, b] of plan.segments) {
      const i0 = Math.round(a * sr); const n = Math.min(Math.round((b - a) * sr), total - off);
      for (let c = 0; c < nch; c++) out[c].set(buffer.getChannelData(c).subarray(i0, i0 + n), off);
      off += n;
    }
    onProgress?.(1, 'סאונד');
    return makeAudioBuffer(out, sr);
  },

  // רינדור dev בלבד: מקליט canvas בזמן אמת עם MediaRecorder (וידאו בלבד, בלי שמע). המודול האמיתי הוא render.js.
  async render({ file, plan, camera, overlay, width, height, fps = 30, onProgress, signal }) {
    if (typeof MediaRecorder === 'undefined' || typeof document === 'undefined') throw new Error('אין רינדור זמין בסביבה הזאת');
    const h = await openVideo(file);
    const { v } = h;
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(fps);
    const mime = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 3_000_000 } : undefined);
    const chunks = []; rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    const stopped = new Promise((r) => { rec.onstop = r; });
    const draw = (tOut) => {
      const r = camera.rectAt(tOut); const vw = v.videoWidth; const vh = v.videoHeight;
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, width, height);
      if (camera.layout === 'fit') {
        const s = Math.min(width / vw, height / vh);
        ctx.drawImage(v, (width - vw * s) / 2, (height - vh * s) / 2, vw * s, vh * s);
      } else {
        ctx.drawImage(v, r.x * vw, r.y * vh, r.w * vw, r.h * vh, 0, 0, width, height);
      }
      overlay?.(ctx, tOut, v);
    };
    rec.start(500);
    let base = 0;
    try {
      for (const [s0, s1] of plan.segments) {
        throwIfAborted(signal);
        v.currentTime = s0; await onceEvent(v, 'seeked');
        await v.play();
        await new Promise((res) => {
          const tick = () => {
            if (signal?.aborted || v.currentTime >= s1 || v.ended) { v.pause(); res(); return; }
            const t = base + (v.currentTime - s0);
            draw(t); onProgress?.(clamp(t / plan.duration), 'מקליט');
            setTimeout(tick, 1000 / fps);
          };
          tick();
        });
        base += s1 - s0;
      }
      throwIfAborted(signal);
      draw(plan.duration - 0.001);
    } finally { try { rec.stop(); } catch (_) { /* כבר נעצר */ } await stopped; h.close(); }
    return new Blob(chunks, { type: rec.mimeType || 'video/webm' });
  },

  async thumbnail(file, t) {
    const h = await openVideo(file);
    try {
      h.v.currentTime = clamp(t, 0, Math.max(0, h.v.duration - 0.05)); await onceEvent(h.v, 'seeked');
      const w = 360; const hh = Math.round(w * 16 / 9);
      const c = document.createElement('canvas'); c.width = w; c.height = hh;
      const cx = c.getContext('2d'); cx.fillStyle = '#000'; cx.fillRect(0, 0, w, hh);
      const s = Math.max(w / h.v.videoWidth, hh / h.v.videoHeight);
      cx.drawImage(h.v, (w - h.v.videoWidth * s) / 2, (hh - h.v.videoHeight * s) / 2, h.v.videoWidth * s, h.v.videoHeight * s);
      return await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('לא נוצרה תמונה'))), 'image/jpeg', 0.85));
    } finally { h.close(); }
  },
};

// ------------------------------------------------------------------------------------------------ טעינת מודולים

const GROUPS = {
  transcribe: { names: ['transcribe', 'detectLanguage'] },
  render: { names: ['probe', 'render', 'thumbnail'], optional: ['unlockAudio'] },
  frame: { names: ['analyzeFaces', 'cameraFor'], optional: ['benchmarkDecoders'] },
  captions: { names: ['prepareCaptions', 'drawCaptions', 'pickKeywords'], extra: ['STYLES'] },
  moments: { names: ['findMoments'] },
  pacing: { names: ['planPacing', 'mapTime', 'wordsOut'] },
  audio: { names: ['decodeAudio', 'analyzeAudio', 'buildTrack', 'to16kMono'], optional: ['analyzeAudioAsync'] },
  fx: { names: ['planEffects', 'effectsCamera', 'drawEffects', 'effectsAudio'] },
  background: { names: ['prepareBackground', 'drawWithBackground'] },
  postkit: { names: ['makePost'] },
  cover: { names: ['makeCover'] },
};
const RELEASE_NAMES = ['unload', 'unloadModel', 'release', 'dispose', 'disposeTranscriber', 'disposeRender', 'terminate', 'shutdown'];

const importers = {
  transcribe: () => import('./transcribe.js'),
  render: () => import('./render.js'),
  frame: () => import('./frame.js'),
  captions: () => import('./captions.js'),
  moments: () => import('./moments.js'),
  pacing: () => import('./pacing.js'),
  audio: () => import('./audio.js'),
  fx: () => import('./fx.js'),
  background: () => import('./background.js'),
  postkit: () => import('../features/post-kit.js'),
  cover: () => import('../features/cover.js'),
};

function findRelease(ns) {
  if (!ns) return null;
  for (const n of RELEASE_NAMES) if (typeof ns[n] === 'function') return ns[n].bind(ns);
  return null;
}

/** ממזג מודולים (אמיתיים או מוזרקים) עם ה־stubs. מחזיר גם סטטוס לכל קבוצה. */
export function mergeModules(input = {}) {
  // קלט "שטוח" ({probe, render, ...}) או לפי קבוצות ({render: {probe, render}, ...})
  const grouped = Object.keys(GROUPS).some((g) => input[g] && typeof input[g] === 'object');
  const namespaces = grouped ? input : Object.fromEntries(Object.keys(GROUPS).map((g) => [g, input]));
  const mods = {};
  const status = {};
  for (const [group, { names, extra = [], optional = [] }] of Object.entries(GROUPS)) {
    const ns = namespaces[group];
    const missing = [];
    for (const n of names) {
      if (ns && typeof ns[n] === 'function') mods[n] = ns[n].bind(ns);
      else { mods[n] = stubs[n]; missing.push(n); }
    }
    for (const n of extra) if (ns && ns[n] !== undefined) mods[n] = ns[n];
    for (const n of optional) if (ns && typeof ns[n] === 'function') mods[n] = ns[n].bind(ns);
    status[group] = ns && missing.length < names.length ? (missing.length ? { state: 'partial', missing } : { state: 'real' }) : { state: 'stub', missing: names.slice() };
    if (ns?.error) status[group].error = ns.error;
  }
  // סגנונות/עזרים שאינם חלק מקבוצה אחת
  mods.mapTime = mods.mapTime || stubs.mapTime;
  const rel = (name, ns) => (!grouped && typeof input[name] === 'function' ? input[name] : findRelease(ns));
  mods.releaseTranscriber = rel('releaseTranscriber', namespaces.transcribe);
  mods.releaseFrame = rel('releaseFrame', namespaces.frame);
  mods.releaseRender = rel('releaseRender', namespaces.render);
  mods.stubs = Object.entries(status).filter(([, s]) => s.state !== 'real').map(([g, s]) => (s.state === 'partial' ? `${g} (${s.missing.join(', ')})` : g));
  return { mods, status };
}

let loaded = null;
let loadedSync = null;

/** טוען את המודולים של שאר הסוכנים. מודול שלא קיים או שנכשל בטעינה מוחלף ב־stub. התוצאה נשמרת במטמון. */
export function loadModules({ force = false } = {}) {
  if (loaded && !force) return loaded;
  loaded = (async () => {
    const ns = {};
    await Promise.all(Object.entries(importers).map(async ([group, imp]) => {
      try { ns[group] = await imp(); } catch (e) {
        ns[group] = null;
        if (!/Failed to fetch|Cannot find|not found|404|Failed to load|Unexpected token '<'/i.test(errText(e))) console.warn(`[pipeline] המודול ${group} נכשל בטעינה: ${errText(e)}`);
      }
    }));
    loadedSync = mergeModules(ns);
    return loadedSync;
  })();
  return loaded;
}

export function resetModules() { loaded = null; loadedSync = null; }

/**
 * באייפון צריך "לפתוח" את האודיו בתוך לחיצה של המשתמש (מסלול הגיבוי של הרינדור). לקרוא מתוך מטפל הלחיצה של "ערכו לי",
 * אחרי ש־loadModules() כבר הסתיימה (למשל בטעינת הדף), כדי שהקריאה תהיה סינכרונית בתוך הלחיצה.
 */
export function unlockAudio() {
  try { return !!loadedSync?.mods.unlockAudio?.(); } catch (_) { return false; }
}

// ------------------------------------------------------------------------------------------------ מבני נתונים

function silentBuffer(duration, sampleRate = 8000) {
  return makeAudioBuffer([new Float32Array(Math.max(1, Math.round(duration * sampleRate)))], sampleRate);
}

function silentAudioInfo(duration) {
  return { sampleRate: 8000, duration, envelope: new Float32Array(Math.max(1, Math.round(duration * 100))).fill(-90), loud: [] };
}

function planDuration(plan) {
  const d = Number(plan?.duration);
  if (Number.isFinite(d) && d > 0) return d;
  return (plan?.segments || []).reduce((s, [a, b]) => s + (b - a), 0);
}

/** תוכנית אחת, או חיבור של כמה תוכניות (top3) לתוכנית אחת בציר פלט רציף. */
function combinePlans(plans) {
  if (plans.length === 1) return { ...plans[0], duration: planDuration(plans[0]) };
  const cuts = []; let acc = 0;
  plans.forEach((p, i) => {
    if (i > 0) cuts.push(round(acc, 3));
    for (const c of p.cuts || []) cuts.push(round(acc + c, 3));
    acc += planDuration(p);
  });
  return {
    segments: plans.flatMap((p) => p.segments),
    duration: plans.reduce((s, p) => s + planDuration(p), 0),
    removed: plans.reduce((s, p) => s + (Number(p.removed) || 0), 0),
    cuts,
  };
}

function mergeFaceSamples(list) {
  const ok = list.filter((x) => x && Array.isArray(x.samples));
  if (!ok.length) return null;
  const samples = ok.flatMap((x) => x.samples).sort((a, b) => a.t - b.t);
  const cuts = ok.flatMap((x) => x.cuts || []).sort((a, b) => a - b);
  const merged = { fps: ok[0].fps, width: ok[0].width, height: ok[0].height, samples, cuts };
  if (ok.length === 1 && ok[0].source) { merged.source = ok[0].source; merged.duration = ok[0].duration; }   // cameraFor משתמש ב־source כשאין תוכנית
  return merged;
}

function fitCamera() {
  return { layout: 'fit', rectAt: () => ({ x: 0, y: 0, w: 1, h: 1 }), cuts: [] };
}

function normalizeTranscript(t, language) {
  const words = Array.isArray(t?.words) ? t.words.filter((w) => w && Number.isFinite(w.start) && Number.isFinite(w.end)) : [];
  const segments = Array.isArray(t?.segments) ? t.segments : [];
  const out = { ...t, language: t?.language || (language && language !== 'auto' ? language : 'he'), words, segments };
  if (t && t.meta) Object.defineProperty(out, 'meta', { value: t.meta, enumerable: false });   // transcribe.js מצרף meta (דגם, זמן ריצה) שאינו נספר
  return out;
}

function directionOf(lang) {
  if (!lang) return null;
  return ['he', 'ar', 'fa', 'ur', 'yi'].includes(lang) ? 'rtl' : 'ltr';
}

function sanitizeMoments(list, duration) {
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    if (!m || !Number.isFinite(m.start) || !Number.isFinite(m.end)) continue;
    const start = clamp(m.start, 0, duration || Infinity); const end = clamp(m.end, 0, duration || Infinity);
    if (end - start < 1) continue;
    out.push({ ...m, start, end });
  }
  return out;
}

/** שער ברזולוציה של פרסום (1080 לרוחב), באותו יחס של הקליפ: [רוחב, גובה] כמו ש־cover.js מצפה. */
function coverSizeFor({ width, height }) {
  const W = 1080;
  return [W, Math.round((W * height / width) / 2) * 2];
}

// סרטון ארוך: מפענחים מונו ב־24kHz כדי לא להחזיק מאות מגה של סטריאו ב־48kHz בזיכרון של טאב באייפון
const HEAVY_DECODE_SECONDS = 300;
const decodeOptionsFor = (videoDur) => (videoDur > HEAVY_DECODE_SECONDS ? { sampleRate: 24000, mono: true } : {});
/** fx.js מצפה ל־{handle, logoBitmap}. מקבלים גם מחרוזת או {nick|nickname|name, logo}. */
export function normalizeBrand(b) {
  if (!b) return null;
  if (typeof b === 'string') return b.trim() ? { handle: b.trim() } : null;
  const handle = b.handle || b.nick || b.nickname || b.name || '';
  const logoBitmap = b.logoBitmap || (typeof ImageBitmap !== 'undefined' && b.logo instanceof ImageBitmap ? b.logo : null);
  if (!handle && !logoBitmap) return null;
  return { ...b, handle, logoBitmap };
}
/** כמו normalizeBrand, וגם הופך לוגו שהוא Blob/File ל־ImageBitmap (מה ש־drawEffects מצייר). שגיאה בלוגו לא מפילה: נשאר רק הכינוי. */
export async function resolveBrand(b) {
  const nb = normalizeBrand(b) || (b && typeof b === 'object' && b.logo ? { ...b, handle: '', logoBitmap: null } : null);
  if (!nb) return null;
  if (!nb.logoBitmap && b && typeof b === 'object' && b.logo && typeof createImageBitmap === 'function' && typeof Blob !== 'undefined' && b.logo instanceof Blob) {
    try { nb.logoBitmap = await createImageBitmap(b.logo); } catch (_) { /* לוגו פגום: בלי לוגו */ }
  }
  return nb.handle || nb.logoBitmap ? nb : null;
}
const wantsBackground = (o) => o?.background === 'blur' || o?.background === 'replace';

// ------------------------------------------------------------------------------------------------ הרצה: התקדמות, ביטול ושלבים

/** מעקב + דיווח + ביטול + הרצת שלבים. משותף ל־makeClips ול־renderState. */
function createRun({ signal, onProgress, etaInText = true, now = defaultNow }) {
  const tracker = new ProgressTracker({ now });
  const stageTimes = {};
  let lastKey = '';
  const emit = (force = false) => {
    if (signal?.aborted || !onProgress) return;
    const fraction = tracker.fraction();
    const etaSec = tracker.etaKnown() ? tracker.etaSeconds() : null;
    const etaHe = etaSec === null ? '' : formatEtaHe(etaSec);
    let text = tracker.text();
    if (etaInText && etaHe) text += ` · ${etaHe}`;
    const key = `${Math.round(fraction * 1000)}|${text}`;
    if (!force && key === lastKey) return;
    lastKey = key;
    const s = tracker.active;
    try {
      onProgress(fraction, text, { stage: s?.kind || null, clip: s?.clip != null ? s.clip + 1 : null, clips: tracker.clipTotal, etaSec, etaHe, elapsedSec: tracker.elapsed() });
    } catch (_) { /* באג בממשק לא מפיל את העריכה */ }
  };
  const call = (fn, ...args) => { throwIfAborted(signal); return raceAbort((async () => fn(...args))(), signal); };
  /** מריץ שלב: מסמן התחלה, מעביר פונקציית התקדמות למודול, ומסמן סיום גם אם נכשל. */
  async function stage(id, fn) {
    throwIfAborted(signal);
    tracker.start(id); emit();
    const report = (f, text) => { if (signal?.aborted) return; tracker.update(f, text); emit(); };
    try { return await fn(report); } finally {
      tracker.finish(id);
      const s = tracker.get(id);
      if (s && !s.skipped) stageTimes[s.kind] = round((stageTimes[s.kind] || 0) + s.actual);
      emit();
    }
  }
  const skipStage = (id) => { tracker.skip(id); emit(); };
  return { tracker, emit, call, stage, skipStage, stageTimes, signal };
}

const clipStageList = (n, clipDur, videoDur, bg) => Array.from({ length: n }, (_, i) => ['pace', 'faces', 'captions', ...(bg ? ['bg'] : []), 'audio', 'render', 'thumb']
  .map((k) => makeStage(k, { id: `c${i}:${k}`, clip: i, videoDur, clipDur, bg }))).flat();

async function releaseModules(mods, keys = ['releaseTranscriber', 'releaseFrame', 'releaseRender']) {
  for (const k of keys) {
    try { await mods[k]?.(); } catch (_) { /* שחרור הוא best-effort */ }
  }
}

// ------------------------------------------------------------------------------------------------ overlay ורינדור מתוך state

function collectSfx(state, mods) {
  const out = [...(state.audioOptions?.sfx || [])];
  if (state.effects) {
    try {
      for (const e of mods.effectsAudio(state.effects) || []) {
        const kind = e.kind ?? e.sfx; const at = e.at ?? e.t;
        if (kind && Number.isFinite(at)) out.push(Number.isFinite(e.gainDb) ? { kind, at, gainDb: e.gainDb } : { kind, at });   // audio.js מצפה ל־{kind, at}, ו־fx.js מחזיר את שני הזוגות
      }
    } catch (_) { /* בלי אפקטי קול */ }
  }
  return out;
}

/** מקור ציור אמיתי (VideoFrame, ImageBitmap, קנבס או video), להבדיל מאינדקס פריים. */
function isFrameSource(f) {
  return !!f && typeof f === 'object' && !!(f.videoWidth || f.displayWidth || f.naturalWidth || f.width || f.codedWidth);
}

/**
 * ה־overlay של הקליפ, בסדר הציור: רקע, אפקט תבנית (מתחת), כתוביות, אפקט תבנית (מעל), ואז אפקטים ומותג.
 * זהה לזה שהייצוא משתמש בו, כדי שתצוגה מקדימה (העורך המהיר) תצייר בדיוק כמו הייצוא.
 * החתימה היא של render.js: overlay(ctx, tOut, frameIndex, frame?). frame מגיע רק עם render({overlayFrame:true}) (פריים כבר חתוך).
 * הרקע מצויר כשכבה עם חור במקום האדם, ולכן הוא עובד גם בלי פריים (שכבה שקופה מעל הווידאו).
 * mods = מה ש־loadModules() מחזירה. כשל באחד השלבים מכבה אותו ומוסיף הערה ל־notes, ולא מפיל את הציור.
 */
export function makeOverlay(state, { mods, prepared = null, bg = null, camera = null, notes = [] } = {}) {
  const spec = state.captionSpec;
  const cam = camera || state.camera || fitCamera();
  const info = { ...(state.tplInfo || {}), width: spec.width, height: spec.height, fps: spec.fps, duration: state.plan.duration, moment: state.moment, options: state.options };
  const under = state.overlayUnder; const extra = state.overlayExtra;
  const bgList = Array.isArray(bg) ? bg : (bg ? [{ bg, startOut: 0, endOut: Infinity }] : []);   // רשימה כשיש כמה חלקים (top3): לכל חלק מסכות משלו
  let bgOn = bgList.length > 0; let underOn = typeof under === 'function'; let capOn = !!prepared; let extraOn = typeof extra === 'function';
  let fxOn = !!(state.effects || state.brand);
  return (ctx, tOut, index, frame) => {
    if (bgOn) {
      // פריים חתוך מ־render (4 פרמטרים): cropped. פריים מקור בפרמטר השלישי (החוזה הישן): drawWithBackground חותך אותו לפי rect. בלי פריים: רק שכבת הרקע
      const cropped = isFrameSource(frame) ? frame : null;
      const source = cropped || (isFrameSource(index) ? index : null);
      const cur = bgList.find((x) => tOut >= x.startOut && tOut < x.endOut);
      try { if (cur) mods.drawWithBackground(ctx, source, tOut, cur.bg, cam.rectAt(tOut), cropped ? { cropped: true } : {}); } catch (e) { bgOn = false; notes.push('החלפת הרקע נעצרה באמצע הייצוא בגלל תקלה'); }
    }
    if (underOn) { try { under(ctx, tOut, info, index); } catch (e) { underOn = false; notes.push(`אפקט התבנית נכשל בזמן הייצוא: ${errText(e)}`); } }
    if (capOn) { try { mods.drawCaptions(ctx, tOut, prepared); } catch (e) { capOn = false; notes.push('הכתוביות נעצרו באמצע הייצוא בגלל תקלה'); } }
    if (extraOn) { try { extra(ctx, tOut, info, index); } catch (e) { extraOn = false; notes.push(`אפקט התבנית נכשל בזמן הייצוא: ${errText(e)}`); } }
    if (fxOn) { try { mods.drawEffects(ctx, tOut, state.effects, { brand: state.brand, width: spec.width, height: spec.height }); } catch (e) { fxOn = false; notes.push('האפקטים נעצרו באמצע הייצוא בגלל תקלה'); } }
  };
}

/**
 * הזנב המשותף: כתוביות, מצלמה עם אפקטים, רקע, סאונד, רינדור, תמונה ממוזערת ושער ופוסט.
 * env = { mods, run, signal, pre (קידומת מזהי שלבים), notes, getBuffer(report), releaseBuffer?() }
 */
async function renderTail(state, env) {
  const { mods, run, signal, pre = '', notes } = env;
  const { stage, skipStage, call } = run;
  const spec = state.captionSpec; const plan = state.plan;
  const size = { width: spec.width, height: spec.height, fps: spec.fps || 30 };
  const words = spec.words || [];
  let prepared = null; let bg = null; let track = null;
  try {
    // כתוביות: כשל לא מפיל, ממשיכים בלי כתוביות
    if (state.captions !== false && words.length) {
      await stage(`${pre}captions`, async () => {
        try {
          prepared = await call(mods.prepareCaptions, { ...spec, duration: plan.duration });
          if (prepared && prepared.ready && typeof prepared.ready.then === 'function') await call(() => prepared.ready);   // גופנים ופריסה, לפני הציור הראשון
          if (prepared && typeof prepared.warm === 'function') {
            // חימום מראש של הכתוביות כדי שאף פריים בייצוא לא יתעכב. עם תקרת זמן: אם זה ארוך, הציור ממשיך לבנות לפי הצורך
            await call(() => Promise.race([prepared.warm(), new Promise((r) => setTimeout(r, 8000))]));
          }
        } catch (e) {
          if (isAbortError(e) || signal?.aborted) throw e;
          try { await prepared?.dispose?.(); } catch (_) { /* ignore */ }
          prepared = null;
          notes.push('הכתוביות לא נטענו, ולכן הקליפ נוצר בלי כתוביות');
        }
      });
    } else skipStage(`${pre}captions`);

    // מצלמה: זום הדגשה ורעידה מ־fx מעל המסגור הבסיסי
    let camera = state.camera || fitCamera();
    if (state.effects) {
      try { const c = mods.effectsCamera(camera, state.effects); if (c && typeof c.rectAt === 'function') camera = c; } catch (_) { notes.push('זום ההדגשה לא הופעל בגלל תקלה'); }
    }

    // רקע (טשטוש או החלפה): כשל לא מפיל, ממשיכים עם הרקע המקורי
    // רקע (טשטוש או החלפה): שכבה עם חור במקום האדם מעל הווידאו (background.js). כשל לא מפיל, ממשיכים עם הרקע המקורי.
    // plan חובה: הוא ממפה זמן פלט לזמן מקור כשיש חיתוכים (וגם בקליפ מרובה חלקים)
    const bgSpec = state.background;
    if (bgSpec && (bgSpec.mode === 'blur' || bgSpec.mode === 'replace')) {
      await stage(`${pre}bg`, async (report) => {
        // קליפ מרובה חלקים: מסכות רק לטווחי המקור של החלקים (ולא לכל הטווח ביניהם), ו־plan המאוחד ממפה זמן פלט לזמן מקור
        const parts = state.tplInfo?.parts;
        const spans = parts && parts.length > 1 && parts.every((x) => x.moment)
          ? parts.map((x) => ({ start: x.moment.start, end: x.moment.end, startOut: x.startOut, endOut: x.endOut }))
          : [{ start: bgSpec.start ?? 0, end: bgSpec.end ?? plan.duration, startOut: 0, endOut: Infinity }];
        const made = [];
        try {
          for (let k = 0; k < spans.length; k++) {
            const b = await call(mods.prepareBackground, state.file, spans[k].start, spans[k].end, {
              mode: bgSpec.mode, image: bgSpec.image, plan, onProgress: (f, t) => report((k + clamp(f)) / spans.length, t), signal,
            });
            made.push({ bg: b, startOut: spans[k].startOut, endOut: spans[k].endOut });
            for (const n of b?.notes || []) notes.push(n);   // למשל "לא זוהה אדם בקטע"
          }
          bg = made;
        } catch (e) {
          for (const x of made) { try { await x.bg?.close?.(); } catch (_) { /* ignore */ } }
          if (isAbortError(e) || signal?.aborted) throw e;
          bg = null;
          notes.push('החלפת הרקע לא זמינה כרגע, ולכן הקליפ נוצר עם הרקע המקורי');
        }
      });
    } else skipStage(`${pre}bg`);

    // סאונד: מוזיקה שנכשלה לא מפילה. מנסים שוב בלי מוזיקה
    track = await stage(`${pre}audio`, async (report) => {
      const ao = state.audioOptions || {};
      const buffer = await env.getBuffer(report);
      const base = { buffer, plan, words, loudness: ao.loudness ?? -14, sfx: collectSfx(state, mods), signal };
      if (Number.isFinite(ao.musicGainDb)) base.musicGainDb = ao.musicGainDb;   // העורך המהיר (רמת עוצמה); audio.js יקרא את זה כשיתמוך
      try {
        return await call(mods.buildTrack, { ...base, music: ao.music || '', onProgress: report });
      } catch (e) {
        if (isAbortError(e) || signal?.aborted) throw e;
        if (!ao.music) throw e;
        notes.push('המוזיקה לא נטענה, ולכן הקליפ נוצר בלי מוזיקה');
        return call(mods.buildTrack, { ...base, music: '', onProgress: report });
      } finally { env.releaseBuffer?.(); }
    });

    // רינדור
    const overlay = makeOverlay(state, { mods, prepared, bg, camera, notes });   // bg: רשימה של {bg, startOut, endOut}
    const blob = await stage(`${pre}render`, (report) => call(mods.render, {
      file: state.file, plan, camera, overlay, audio: track, width: size.width, height: size.height, fps: size.fps, onProgress: report, signal,
      ...(state.renderQuality ? { quality: state.renderQuality } : {}),
    }));
    track = null;

    // תמונה ממוזערת, שער ופוסט: כשל לא מפיל
    let thumbnail = null; let cover = null; let post = null;
    await stage(`${pre}thumb`, async () => {
      try { thumbnail = await call(mods.thumbnail, state.file, state.thumbTime); } catch (e) {
        if (isAbortError(e) || signal?.aborted) throw e;
        notes.push('לא הצלחנו ליצור תמונה ממוזערת');
      }
      try {
        const c = await call(mods.makeCover, state.file, state.coverMoment || state.moment, {
          title: spec.hook?.text || state.moment?.hook || '', style: state.options?.coverStyle, size: coverSizeFor(size), faces: state.faces || undefined, signal,
        });
        cover = c instanceof Blob ? c : null;
      } catch (e) {
        if (isAbortError(e) || signal?.aborted) throw e;
        notes.push('לא הצלחנו להכין תמונת שער');
      }
      if (!thumbnail && cover) thumbnail = cover;
      if (state.transcript) {
        try {
          const m = state.coverMoment ? { ...state.coverMoment, hook: state.moment.hook, hooks: state.moment.hooks } : state.moment;
          post = (await call(mods.makePost, state.transcript, m, { lang: state.language, genre: state.options?.genre, platform: state.options?.platform })) || null;
        } catch (e) {
          if (isAbortError(e) || signal?.aborted) throw e;
          notes.push('לא הצלחנו להכין טקסט לפוסט');
        }
      }
    });
    return { blob, thumbnail, cover, post, camera, captionsOn: !!prepared, backgroundOn: !!(bg && bg.length) };
  } finally {
    // שחרור משאבים לפני הקליפ הבא
    try { await prepared?.dispose?.(); } catch (_) { /* best-effort */ }
    for (const x of Array.isArray(bg) ? bg : []) { try { await (x.bg?.close ? x.bg.close() : x.bg?.dispose?.()); } catch (_) { /* best-effort */ } }
    prepared = null; bg = null; track = null;
    await yieldTick();
  }
}

function assembleClip(state, out, notes, meta) {
  const spec = state.captionSpec; const moment = state.moment;
  const url = typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(out.blob) : '';
  return {
    blob: out.blob, url, duration: state.plan.duration,
    title: spec.hook?.text || moment.hook || moment.hooks?.[0] || 'קליפ',
    hook: moment.hook, hooks: moment.hooks, thumbnail: out.thumbnail, cover: out.cover, post: out.post, moment,
    transcript: state.transcript || null,   // בזמני מקור, לעריכה בקול
    ext: out.blob.frameInfo?.ext || (/webm/.test(out.blob.type) ? 'webm' : 'mp4'),   // סיומת לשם קובץ הייצוא
    options: state.options, notes: [...new Set(notes)], template: state.template || null, state,
    meta: { ...meta, camera: out.camera?.layout, captions: out.captionsOn, background: out.backgroundOn, effects: !!state.effects, outDuration: round(state.plan.duration) },
  };
}

// ------------------------------------------------------------------------------------------------ הצינור

/**
 * makeClips(file, options, {onProgress(fraction, textHe, info), signal, modules?, quality?, etaInText?, now?}) -> [Clip]
 * Clip = { blob, url, duration, title, hook, hooks, thumbnail, cover, post, moment, options, notes:[עברית], template, state, meta }
 *   state = { file, plan, camera, captionSpec, audioOptions, effects, ... } לעריכה מחדש ב־renderState
 * למערך המוחזר יש גם `report` ({totalSeconds, stages, stubs, momentsFound, video, output}) ו־`errors` (קליפים שנכשלו, אם היו).
 * ביטול: זורק AbortError ("העריכה בוטלה"), ובו `partial` עם הקליפים שכבר הושלמו.
 */
export async function makeClips(file, options = {}, { onProgress, signal, modules, quality = 'standard', etaInText = true, now = defaultNow } = {}) {
  const userOpts = normalizeOptions(options);
  const tpl = userOpts.template ? getTemplate(userOpts.template) : null;
  const { mods } = modules ? mergeModules(modules) : await loadModules();
  const run = createRun({ signal, onProgress, etaInText, now });
  const { tracker, emit, call, stage, skipStage } = run;
  const size = outputSize(userOpts.format, userOpts.quality || quality);
  const globalNotes = [];
  const clips = [];
  const errors = [];
  const wantBg = wantsBackground(userOpts);
  const brand = await resolveBrand(userOpts.brand);

  let buffer = null;
  let a16 = null;
  // משתנים שמשותפים ל־buildClip (מוגדרים כאן ולא בתוך try, כדי שיהיו גלויים לו)
  let info = null; let transcript = null; let audioInfo = null; let hasAudio = true; let fps = 30; let tplRes = null; let realClips = 0; let videoDur = 0;
  let transcriberReleased = false;
  let decoderTuned = false;

  try {
    throwIfAborted(signal);

    // תוכנית ראשונית: עוד לא ידוע אורך הסרטון, לכן משתמשים בברירות מחדל ומעדכנים אחרי probe.
    const guessClips = tpl?.momentsNeeded ? 1 : userOpts.count;   // תבנית שמרכיבה כמה רגעים (top3, beforeAfter) נותנת קליפ אחד
    const guessLen = typeof userOpts.length === 'number' ? userOpts.length : 30;
    const globalStages = (dur, skipSpeech = false) => ['probe', 'decode', 'analyze', 'transcribe', 'moments']
      .filter((k) => !(skipSpeech && ['decode', 'analyze', 'transcribe'].includes(k)))
      .map((k) => makeStage(k, { videoDur: dur }));
    tracker.clipTotal = guessClips;
    tracker.setPlan([...globalStages(60), ...clipStageList(guessClips, guessLen, 60, wantBg)]);
    emit(true);

    // 1. probe
    try {
      info = await stage('probe', () => call(mods.probe, file));
    } catch (e) {
      if (isAbortError(e) || signal?.aborted) throw e;
      throw new Error(`לא הצלחנו לפתוח את הסרטון. נסו קובץ אחר או פורמט אחר. (${errText(e)})`);
    }
    videoDur = Number(info?.duration);
    if (!(videoDur > 0)) throw new Error('לא הצלחנו לקרוא את אורך הסרטון. נסו קובץ אחר.');
    hasAudio = info.hasAudio !== false;
    fps = clamp(Math.round(Number(info.fps) || 30), 24, 30);
    const done = tracker.stages.filter((s) => s.state === 'done');
    tracker.replacePending([...globalStages(videoDur, !hasAudio).filter((s) => !done.some((d) => d.id === s.id)), ...clipStageList(guessClips, guessLen, videoDur, wantBg)]);

    // 2-4. שמע ותמלול
    if (hasAudio) {
      try {
        buffer = await stage('decode', (report) => call(mods.decodeAudio, file, { ...decodeOptionsFor(videoDur), onProgress: report, signal }));
      } catch (e) {
        if (isAbortError(e) || signal?.aborted) throw e;
        throw new Error(`לא הצלחנו לפענח את השמע של הסרטון. (${errText(e)})`);
      }
      try {
        // הניתוח הסינכרוני מהיר (עשר דקות בשנייה בערך), והגרסה בנתחים מחזירה שליטה לדפדפן בין נתחים ולכן איטית יותר: משתמשים בה רק בסרטון ארוך
        audioInfo = await stage('analyze', (report) => (mods.analyzeAudioAsync && videoDur > 300
          ? call(mods.analyzeAudioAsync, buffer, { onProgress: report, signal })
          : call(mods.analyzeAudio, buffer)));
      } catch (e) {
        if (isAbortError(e) || signal?.aborted) throw e;
        throw new Error(`ניתוח השמע נכשל. (${errText(e)})`);
      }
      try {
        transcript = await stage('transcribe', async (report) => {
          a16 = await call(mods.to16kMono, buffer);
          let lang = userOpts.language;
          if (lang === 'auto') {
            report(0.02, 'מזהה את שפת הדיבור');
            const start = Math.floor(clamp(audioInfo?.loud?.[0]?.start ?? 0, 0, Math.max(0, a16.length / 16000 - 1)) * 16000);
            try {
              const r = await call(mods.detectLanguage, a16.subarray(start, start + 16000 * 30), { signal, keepLoaded: true });
              const code = typeof r === 'string' ? r : (r?.language || r?.lang || r?.code);
              if (code) lang = code;
            } catch (e) { if (isAbortError(e) || signal?.aborted) throw e; /* אם הזיהוי נכשל, התמלול עצמו יזהה */ }
          }
          report(0.05, 'מתמלל');
          const t = await call(mods.transcribe, a16, { language: lang, ...(userOpts.model ? { model: userOpts.model } : {}), onProgress: (f, text) => report(0.05 + 0.95 * clamp(f), text), signal });
          return normalizeTranscript(t, lang);
        });
      } catch (e) {
        if (isAbortError(e) || signal?.aborted) throw e;
        throw new Error(`התמלול נכשל, בדקו חיבור לאינטרנט בטעינה הראשונה ונסו שוב. (${errText(e)})`);
      } finally {
        a16 = null;
        transcriberReleased = true;
        try { await mods.releaseTranscriber?.(); } catch (_) { /* שחרור הוא best-effort */ }
      }
    } else {
      buffer = silentBuffer(videoDur);
      audioInfo = silentAudioInfo(videoDur);
      transcript = normalizeTranscript({ words: [], segments: [] }, userOpts.language);
      globalNotes.push('בסרטון אין שמע, ולכן הרגעים נבחרו בלי תמלול והקליפים בלי כתוביות');
    }
    throwIfAborted(signal);

    // 5. רגעים
    let momentOpts = userOpts;
    try { if (tpl?.adjustOptions) momentOpts = tpl.adjustOptions(userOpts) || userOpts; } catch (_) { momentOpts = userOpts; }
    const need = Math.max(1, tpl?.momentsNeeded ? tpl.momentsNeeded(userOpts) : userOpts.count);
    const moments = await stage('moments', async () => sanitizeMoments(
      await call(mods.findMoments, transcript, audioInfo, { count: need, length: momentOpts.length, genre: userOpts.genre, faces: null }),
      Math.min(videoDur, audioInfo?.duration || videoDur),
    ));
    if (!moments.length) throw new Error('לא מצאנו רגעים מתאימים בסרטון. נסו סרטון עם יותר דיבור או תנועה.');
    let clipMoments = moments.slice(0, userOpts.count);
    if (tpl) {
      try {
        tplRes = tpl.apply(userOpts, moments);
        if (Array.isArray(tplRes?.moments) && tplRes.moments.length) clipMoments = tplRes.moments;
        else tplRes = null;
      } catch (e) {
        tplRes = null;
        globalNotes.push(`התבנית "${tpl.nameHe}" לא הופעלה: ${errText(e)}`);
      }
      for (const n of tplRes?.notes || []) globalNotes.push(n);
    }

    // עדכון התוכנית לפי מספר הקליפים והאורכים בפועל
    const momentLen = (m) => (m.parts || [m]).reduce((s, p) => s + (p.end - p.start), 0);
    realClips = clipMoments.length;
    const avgLen = clipMoments.reduce((s, m) => s + momentLen(m), 0) / realClips;
    tracker.clipTotal = realClips;
    tracker.replacePending(clipStageList(realClips, avgLen, videoDur, wantBg));
    emit(true);

    // 6. קליפ אחרי קליפ (אחד בכל פעם, עם שחרור משאבים ביניהם)
    for (let i = 0; i < realClips; i++) {
      throwIfAborted(signal);
      try {
        clips.push(await buildClip(i, clipMoments[i]));
      } catch (e) {
        if (isAbortError(e) || signal?.aborted) throw e;
        errors.push({ index: i, message: errText(e) });
        for (const s of tracker.stages) if (s.clip === i && s.state !== 'done') tracker.skip(s.id);
        emit();
      }
      await yieldTick();
    }
    if (!clips.length) throw new Error(`לא הצלחנו לייצר קליפים. ${errors[0]?.message || ''}`.trim());

    tracker.complete(); emit(true);
    clips.report = { totalSeconds: round(tracker.elapsed()), stages: run.stageTimes, stubs: mods.stubs || [], momentsFound: moments.length, video: { duration: videoDur, width: info.width, height: info.height, fps: info.fps }, output: { ...size, fps } };
    clips.errors = errors;
    return clips;
  } catch (e) {
    if (isAbortError(e) || signal?.aborted) {
      const err = e instanceof AbortError ? e : new AbortError();
      err.partial = clips;
      throw err;
    }
    throw e;
  } finally {
    buffer = null; a16 = null;
    await releaseModules(mods, transcriberReleased ? ['releaseFrame', 'releaseRender'] : undefined);   // מודל התמלול כבר שוחרר מיד אחרי התמלול
  }

  // ---------------------------------------------------------------------------------------------- קליפ אחד

  async function buildClip(index, moment) {
    const pre = `c${index}:`;
    const notes = [...globalNotes];
    const timings = {};
    const parts = (moment.parts && moment.parts.length ? moment.parts : [moment]);
    // קצב
    const plans = await stage(`${pre}pace`, async () => {
      const out = [];
      for (const p of parts) {
        let plan;
        try { plan = await call(mods.planPacing, transcript, audioInfo, p.start, p.end, userOpts.pacing); } catch (e) {
          if (isAbortError(e) || signal?.aborted) throw e;
          plan = null;
        }
        if (!plan || !Array.isArray(plan.segments) || !plan.segments.length) {
          plan = stubs.planPacing(transcript, audioInfo, p.start, p.end);
          notes.push('כוונון הקצב נכשל, ולכן הקטע נשאר כמו במקור');
        }
        out.push({ ...plan, duration: planDuration(plan) });
      }
      return out;
    });
    const plan = combinePlans(plans);
    const duration = plan.duration;
    const partInfos = []; let acc = 0;
    parts.forEach((p, k) => { partInfos.push({ startOut: acc, endOut: acc + plans[k].duration, rank: p.rank, role: p.role, moment: p }); acc += plans[k].duration; });

    // פנים ומסגור: כשל כאן לא מפיל את הקליפ, וממשיכים עם fit
    let camera = null; let facesMerged = null;
    await stage(`${pre}faces`, async (report) => {
      const list = [];
      let failed = null;
      // פעם אחת במכשיר: מודדים מה מהיר יותר, "play" או "seek", ו־frame.js שומר את הבחירה (בלי זה auto בוחר play)
      if (mods.benchmarkDecoders && !decoderTuned) {
        decoderTuned = true;
        let known = false;
        try { known = !!globalThis.localStorage?.getItem('frame.decoder'); } catch (_) { known = false; }
        if (!known) {
          try { await call(mods.benchmarkDecoders, file, { seconds: 3, signal }); } catch (e) { if (isAbortError(e) || signal?.aborted) throw e; /* מדידה היא best-effort */ }
        }
      }
      for (let k = 0; k < parts.length; k++) {
        try {
          list.push(await call(mods.analyzeFaces, file, parts[k].start, parts[k].end, {
            fps: 5, signal, onProgress: (f, text) => report(((k + clamp(f)) / parts.length) * 0.9, text),
          }));
        } catch (e) {
          if (isAbortError(e) || signal?.aborted) throw e;
          failed = e; break;
        }
      }
      const faceSamples = failed ? null : mergeFaceSamples(list);
      facesMerged = faceSamples;
      if (failed) notes.push('זיהוי הפנים לא עבד, ולכן הקליפ נערך במסגור "התאמה" (fit) בלי מעקב אחרי הפנים');
      report(0.9);
      try {
        const layout = faceSamples ? 'auto' : 'fit';
        camera = await call(mods.cameraFor, faceSamples || { fps: 5, width: info.width, height: info.height, samples: [] }, plan, { outW: size.width, outH: size.height, layout });
        if (!camera || typeof camera.rectAt !== 'function') throw new Error('מצלמה לא תקינה');
      } catch (e) {
        if (isAbortError(e) || signal?.aborted) throw e;
        camera = fitCamera();
        if (faceSamples) notes.push('המסגור האוטומטי נכשל, ולכן הקליפ נערך במסגור "התאמה" (fit)');
      }
    });

    // מילים בזמן פלט (לכל חלק בנפרד, ואז מזיזים לפי מיקום החלק בקליפ)
    let words = [];
    parts.forEach((p, k) => {
      for (const x of mods.wordsOut(transcript, plans[k]) || []) words.push({ ...x, start: x.start + partInfos[k].startOut, end: x.end + partInfos[k].startOut });
    });
    words = words.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end));
    if (userOpts.captions && hasAudio && !words.length) notes.push('לא זוהה דיבור בקטע הזה, ולכן אין בו כתוביות');

    // מפרט הכתוביות והאפקטים (חלק מה־state, כדי שאפשר יהיה לערוך ולייצא מחדש)
    const lang = transcript.language;
    let keywords = [];
    if (userOpts.captions && words.length) { try { keywords = mods.pickKeywords ? (await call(mods.pickKeywords, words, lang)) || [] : []; } catch (_) { keywords = []; } }
    const hookText = tplRes?.captionHook === false ? '' : String(moment.hook || '').trim();
    const captionSpec = {
      width: size.width, height: size.height, fps, duration, words, style: userOpts.style, emoji: true, keywords, lang,
      safeZone: tplRes?.safeZone || DEFAULT_SAFE,
      hook: hookText ? { text: hookText, seconds: clamp(duration * 0.15, 1.5, 3) } : null,
      direction: directionOf(lang),
      splits: camera?.split?.intervals || (camera?.layout === 'split' ? [{ start: 0, end: duration }] : []),
    };
    let effects = null;
    try {
      effects = (await call(mods.planEffects, words, { ...moment, duration }, {
        genre: userOpts.genre, keywords, plan, duration, cuts: camera?.cuts || [], ...(userOpts.density ? { density: userOpts.density } : {}),
        transitions: partInfos.slice(1).map((p) => p.startOut),   // מעבר בין חלקים (top3, לפני ואחרי) מקבל פלאש
      })) || null;
    } catch (e) {
      if (isAbortError(e) || signal?.aborted) throw e;
      notes.push('האפקטים לא הופעלו בגלל תקלה');
    }

    const best = parts.find((p) => p.rank === 1) || parts[parts.length - 1];
    const state = {
      file, plan, camera, captionSpec,
      audioOptions: { music: userOpts.music, loudness: -14, sfx: [], decode: decodeOptionsFor(videoDur), silentDuration: hasAudio ? null : videoDur },
      effects,
      captions: userOpts.captions,
      template: tpl && tplRes ? tpl.id : null, overlayUnder: tplRes?.overlayUnder || null, overlayExtra: tplRes?.overlayExtra || null,
      tplInfo: { parts: partInfos, clipIndex: index, clips: realClips },
      background: wantBg ? { mode: userOpts.background, image: userOpts.backgroundImage, start: moment.start, end: moment.end } : null,
      brand, captionHook: tplRes?.captionHook !== false, renderQuality: userOpts.quality === 'high' ? 'high' : undefined,
      moment, coverMoment: best,
      thumbTime: Number.isFinite(best.peak) && best.peak >= best.start && best.peak <= best.end ? best.peak : best.start + Math.min(1, (best.end - best.start) / 3),
      options: userOpts, transcript, language: lang, faces: facesMerged,   // faces משמש גם לבחירת פריים לשער
    };

    const out = await renderTail(state, { mods, run, signal, pre, notes, getBuffer: async () => buffer });
    for (const k of ['pace', 'faces', 'captions', 'bg', 'audio', 'render', 'thumb']) { const s = tracker.get(`${pre}${k}`); if (s && !s.skipped) timings[k] = round(s.actual); }
    const clip = assembleClip(state, out, notes, { index, timings, stubs: mods.stubs || [], size: { ...size, fps } });
    if (!clip.title || clip.title === 'קליפ') clip.title = `קליפ ${index + 1}`;
    return clip;
  }
}

/** אורך הפלט של כל חלק (לפי הקטעים של התוכנית שנופלים בטווח המקור שלו), ברצף: מיקום כל חלק בציר הפלט אחרי שהתוכנית השתנתה. */
function partsFromPlan(plan, moment, old) {
  const parts = moment?.parts?.length ? moment.parts : null;
  if (!parts) return [{ startOut: 0, endOut: plan.duration, rank: undefined, role: undefined, moment }];
  let acc = 0;
  return parts.map((p, k) => {
    const len = plan.segments.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, p.end) - Math.max(a, p.start)), 0);
    const info = { startOut: acc, endOut: acc + len, rank: p.rank, role: p.role, moment: p };
    acc += len;
    return old?.[k] ? { ...old[k], ...info } : info;
  });
}

/**
 * תוכנית שהשתנתה מחוץ לצינור (למשל "החל" בעריכה בקול, שמחליפה רק את plan) משאירה כתוביות, מצלמה ואפקטים בציר זמן ישן.
 * מזהים את זה לפי אורך (captionSpec.duration מול plan.duration) ובונים מחדש מה שתלוי בזמן פלט: מילים (מהתמלול), מצלמה (מהפנים השמורים), אפקטים וחלקי תבנית.
 * עריכה שהעורך המהיר עשה (קיצוץ) מעדכנת את ה־captionSpec יחד עם התוכנית, ולכן לא נבנית מחדש וגם לא נדרסת.
 */
async function reconcileState(state, mods, run, notes) {
  const { call, signal } = run;
  const segDur = (state.plan.segments || []).reduce((sum, [a, b]) => sum + (b - a), 0);
  const plan = Math.abs(segDur - (Number(state.plan.duration) || 0)) > 0.05 ? { ...state.plan, duration: round(segDur, 3) } : state.plan;
  const spec = state.captionSpec;
  const stale = Math.abs((Number(spec.duration) || plan.duration) - plan.duration) > 0.05;
  if (!stale) return plan === state.plan ? state : { ...state, plan };
  const next = { ...state, plan };
  const lang = state.language || state.transcript?.language;
  let words = spec.words || [];
  if (state.transcript && mods.wordsOut) {
    try { words = (await call(mods.wordsOut, state.transcript, plan)) || []; } catch (e) { if (isAbortError(e) || signal?.aborted) throw e; notes.push('לא הצלחנו לרענן את הכתוביות אחרי שינוי התוכנית'); }
  } else notes.push('אין תמליל שמור, ולכן הכתוביות לא רועננו אחרי שינוי התוכנית');
  words = words.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > 0 && w.start < plan.duration);
  let keywords = [];
  try { keywords = mods.pickKeywords ? (await call(mods.pickKeywords, words, lang)) || [] : []; } catch (_) { keywords = []; }
  let camera = state.camera;
  if (state.faces && mods.cameraFor) {
    try {
      const c = await call(mods.cameraFor, state.faces, plan, { outW: spec.width, outH: spec.height, layout: 'auto' });
      if (c && typeof c.rectAt === 'function') camera = c;
    } catch (e) { if (isAbortError(e) || signal?.aborted) throw e; camera = fitCamera(); notes.push('המסגור האוטומטי נכשל אחרי שינוי התוכנית, ולכן הקליפ נערך במסגור "התאמה" (fit)'); }
  } else camera = fitCamera();
  let effects = null;
  if (state.effects) {
    try {
      effects = (await call(mods.planEffects, words, { ...state.moment, duration: plan.duration }, {
        genre: state.options?.genre, keywords, plan, duration: plan.duration, cuts: camera?.cuts || [], ...(state.options?.density ? { density: state.options.density } : {}),
      })) || null;
    } catch (e) { if (isAbortError(e) || signal?.aborted) throw e; effects = null; }
  }
  const hook = spec.hook ? { ...spec.hook, seconds: Math.min(spec.hook.seconds || 2.5, plan.duration) } : null;
  next.camera = camera; next.effects = effects;
  next.captionSpec = { ...spec, words, keywords, duration: plan.duration, hook, splits: camera?.split?.intervals || (camera?.layout === 'split' ? [{ start: 0, end: plan.duration }] : []) };
  next.tplInfo = { ...(state.tplInfo || {}), parts: partsFromPlan(plan, state.moment, state.tplInfo?.parts) };
  return next;
}

/**
 * renderState(state, {onProgress, signal, modules?, etaInText?, now?}) -> Clip
 * מייצא מחדש קליפ ממצב שנערך (clip.state). המקור נשאר, והכתוביות, הסגנון, ה־hook, המוזיקה, הפורמט (captionSpec.width/height), המסגור והאפקטים נלקחים מה־state כפי שהם עכשיו.
 * הקול של המקור מפוענח שוב בתוך השלב (state.audioOptions.buffer, אם קיים, מדלג על זה), כדי שלא נחזיק את כל הסרטון מפוענח בזיכרון בין הקליפים.
 */
export async function renderState(state, { onProgress, signal, modules, etaInText = true, now = defaultNow } = {}) {
  if (!state || !state.file || !state.plan || !state.captionSpec) throw new Error('מצב הקליפ חסר, אי אפשר לייצא מחדש.');
  const { mods } = modules ? mergeModules(modules) : await loadModules();
  const run = createRun({ signal, onProgress, etaInText, now });
  const hasBg = !!(state.background && state.background.mode && state.background.mode !== 'none');
  const clipDur = state.plan.duration;
  run.tracker.clipTotal = 1;
  run.tracker.setPlan(['captions', ...(hasBg ? ['bg'] : []), 'audio', 'render', 'thumb'].map((k) => makeStage(k, { id: k, clip: 0, clipDur, bg: hasBg })));
  const notes = [];
  const ao = state.audioOptions || {};
  let buffer = null;
  const env = {
    mods, run, signal, pre: '', notes,
    getBuffer: async (report) => {
      if (ao.buffer) return ao.buffer;
      if (ao.silentDuration) return silentBuffer(ao.silentDuration);
      buffer = await run.call(mods.decodeAudio, state.file, { ...(ao.decode || {}), onProgress: (f, t) => report?.(f * 0.4, t), signal });
      return buffer;
    },
    releaseBuffer: () => { buffer = null; },
  };
  const t0 = run.tracker.elapsed();
  try {
    throwIfAborted(signal);
    run.emit(true);
    const st = await reconcileState(state, mods, run, notes);
    const out = await renderTail(st, env);
    run.tracker.complete(); run.emit(true);
    return assembleClip(st, out, notes, { index: state.tplInfo?.clipIndex ?? 0, rerender: true, timings: { ...run.stageTimes }, stubs: mods.stubs || [], size: { width: state.captionSpec.width, height: state.captionSpec.height, fps: state.captionSpec.fps }, totalSeconds: round(run.tracker.elapsed() - t0) });
  } catch (e) {
    if (isAbortError(e) || signal?.aborted) throw (e instanceof AbortError ? e : new AbortError());
    throw e;
  } finally {
    buffer = null;
    await releaseModules(mods);
  }
}

/**
 * rehook(clip, hook, {onProgress, signal, modules?}) -> Clip
 * מייצא מחדש את הקליפ עם כותרת אחרת (למשל אחת משלוש ב־clip.hooks). נשען על clip.state: ה־hook החדש נכנס ל־captionSpec.hook
 * (ובתבניות שמציירות את הכותרת בעצמן, כמו POV, ל־moment.hook), והשער והפוסט נבנים מחדש עם הכותרת החדשה.
 */
export async function rehook(clip, hook, opts = {}) {
  const st = clip && clip.state;
  if (!st || !st.captionSpec || !st.plan) throw new Error('בקליפ הזה אין מצב לעריכה מחדש, ולכן אי אפשר להחליף כותרת.');
  const text = String(typeof hook === 'string' ? hook : hook?.text ?? '').trim();
  if (!text) throw new Error('חסרה כותרת להחלפה.');
  const spec = st.captionSpec;
  const seconds = spec.hook?.seconds ?? clamp(st.plan.duration * 0.15, 1.5, 3);
  const newHook = st.captionHook === false ? spec.hook : { text, seconds };   // POV וטופ 3 מציירים כותרת בעצמן
  const next = { ...st, moment: { ...st.moment, hook: text }, captionSpec: { ...spec, hook: newHook } };
  return renderState(next, opts);
}

/**
 * לקרוא בתוך מטפל הלחיצה של "ערכו לי" (באייפון מסלול הגיבוי של הרינדור לא ישמיע קול בלי זה).
 * סינכרוני כשהמודולים כבר נטענו (מומלץ לקרוא ל־loadModules() בטעינת הדף), ומתחיל לטעון אותם אם לא.
 * מחזיר Promise<boolean>: האם האודיו נפתח.
 */
export function prepareForUserGesture() {
  let ok = unlockAudio();
  return loadModules().then(() => { if (!ok) ok = unlockAudio(); return ok; }).catch(() => false);
}
