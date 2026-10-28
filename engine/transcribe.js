/**
 * תמלול עם זמן לכל מילה, בתוך הדפדפן (סוכן 2, סבב 8).
 *
 * ממשק ציבורי:
 *   transcribe(input, {language, onProgress, signal, model, device, keepLoaded}) -> Promise<Transcript>
 *   detectLanguage(audio16k, {signal}) -> Promise<'he'|'en'|...>      (detectLanguageDetailed מחזיר גם ביטחון)
 *   modelInfo({language}) -> {id, sizeMB, quality, device, ...}        (סינכרוני; probeDevice() מדייק אותו)
 *
 * הקובץ הזה כולל גם את כל הלוגיקה הטהורה (ניקוי, חלוקה לחלונות, איחוד, חזרות, segments, DTW), ולכן אפשר לבדוק אותה ב־node.
 * שום דבר כאן לא נוגע ב־DOM בזמן הטעינה. ה־worker (transcribe.worker.js) מייבא ממנו את אותן פונקציות.
 */

// ------------------------------------------------------------------ קבועים
export const TRANSFORMERS_VERSION = '4.3.1';
export const TRANSFORMERS_URL = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/dist/transformers.min.js`;
/** קבצים שה־service worker צריך לשמור כדי שהתמלול יעבוד בלי אינטרנט (המודלים עצמם נשמרים במטמון נפרד של הדפדפן). */
export const ASSET_URLS = [
  TRANSFORMERS_URL,
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort-wasm-simd-threaded.asyncify.mjs',
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort-wasm-simd-threaded.asyncify.wasm',
];
export const SAMPLE_RATE = 16000;
export const WINDOW_SEC = 30;
export const OVERLAP_SEC = 4;
export const CACHE_NAME = 'frame-asr-v1';

// ------------------------------------------------------------------ מדרג מודלים
// הגדלים נמדדו מההורדה בפועל (קבצי המודל יחד עם tokenizer ו־config), במגה־בייט (10^6).
// high: מודל ivrit-ai לעברית (אין בו פלט cross-attention, ולכן הזמנים של המילים מגיעים מיישור מאולץ במודל העזר) ו־Whisper turbo המקורי לשאר השפות.
// balanced ו־fast: מודלי whisper-small ו־whisper-base עם זמני מילים מובנים.
export const TIERS = {
  high: {
    rank: 3, quality: 'high', labelHe: 'איכות גבוהה', needsGpu: true,
    models: {
      he: { id: 'ivrit-ai/whisper-large-v3-turbo-onnx', timing: 'align' },
      default: { id: 'onnx-community/whisper-large-v3-turbo_timestamped', timing: 'native' },
    },
    dtype: { f16: { encoder_model: 'q4f16', decoder_model_merged: 'q4f16' }, plain: { encoder_model: 'q4', decoder_model_merged: 'q4' } },
    sizeMB: { f16: 568, plain: 764 },
  },
  balanced: {
    rank: 2, quality: 'good', labelHe: 'איכות טובה', needsGpu: false,
    models: { default: { id: 'onnx-community/whisper-small_timestamped', timing: 'native' } },
    dtype: { gpu: { encoder_model: 'q4', decoder_model_merged: 'q4' }, wasm: 'q8' },
    sizeMB: { gpu: 305, wasm: 254 },
  },
  fast: {
    rank: 1, quality: 'basic', labelHe: 'מהיר ופשוט', needsGpu: false,
    models: { default: { id: 'onnx-community/whisper-base_timestamped', timing: 'native' } },
    dtype: { f16: 'fp16', gpu: 'q4', wasm: 'q8' },
    sizeMB: { f16: 151, gpu: 147, wasm: 81 },
  },
};
export const TIER_ORDER = ['fast', 'balanced', 'high'];
/** מודל העזר: זיהוי שפה, ויישור מאולץ של מילים כשמודל הטקסט לא מספק זמנים בעצמו. זה אותו מודל של דרגת fast. */
export function helperSpec(cap) {
  const t = TIERS.fast;
  if (cap.gpu) return { id: t.models.default.id, device: 'webgpu', dtype: cap.f16 ? t.dtype.f16 : t.dtype.gpu, sizeMB: cap.f16 ? t.sizeMB.f16 : t.sizeMB.gpu };
  return { id: t.models.default.id, device: 'wasm', dtype: t.dtype.wasm, sizeMB: t.sizeMB.wasm };
}

/** מפרט מלא למודל הטקסט לפי דרגה, שפה ויכולות המכשיר. */
export function modelSpec(tierId, language, cap) {
  const tier = TIERS[tierId];
  if (!tier) throw new Error('דרגת תמלול לא מוכרת');
  const m = (language && tier.models[language]) || tier.models.default;
  let device, dtype, sizeMB;
  if (tierId === 'high') {
    device = 'webgpu';
    dtype = cap.f16 ? tier.dtype.f16 : tier.dtype.plain;
    sizeMB = cap.f16 ? tier.sizeMB.f16 : tier.sizeMB.plain;
  } else if (tierId === 'balanced') {
    device = cap.gpu ? 'webgpu' : 'wasm';
    dtype = cap.gpu ? tier.dtype.gpu : tier.dtype.wasm;
    sizeMB = cap.gpu ? tier.sizeMB.gpu : tier.sizeMB.wasm;
  } else {
    device = cap.gpu ? 'webgpu' : 'wasm';
    dtype = cap.gpu ? (cap.f16 ? tier.dtype.f16 : tier.dtype.gpu) : tier.dtype.wasm;
    sizeMB = cap.gpu ? (cap.f16 ? tier.sizeMB.f16 : tier.sizeMB.gpu) : tier.sizeMB.wasm;
  }
  return { tier: tierId, id: m.id, timing: m.timing, device, dtype, sizeMB, quality: tier.quality, labelHe: tier.labelHe };
}

// שפות שבהן whisper-base מספיק טוב (ובעברית הוא לא: שגיאות של כ־40% בבדיקה)
const LIGHT_LANGS = new Set(['en', 'es', 'fr', 'de', 'it', 'pt', 'nl']);

/**
 * האם המכשיר מסוגל להריץ את דרגת high (כ־570MB מודל, ועוד כ־150MB מודל עזר בעברית): {ok, risky, reason}.
 * דורש WebGPU. מחשב: בסדר. טלפון עם deviceMemory ידוע: מ־8GB ומעלה, אחרת לא. טלפון בלי deviceMemory (Safari): מותר, אבל מסומן כמסוכן.
 */
export function highSupport(cap) {
  if (!cap.gpu) return { ok: false, risky: false, reason: 'אין WebGPU במכשיר' };
  const mobile = !!(cap.ios || cap.ipad || cap.android);
  if (!mobile) return { ok: true, risky: false, reason: '' };
  if (cap.memoryGB) {
    return cap.memoryGB >= 8
      ? { ok: true, risky: true, reason: 'האיכות הגבוהה תופסת הרבה זיכרון בטלפון' }
      : { ok: false, risky: false, reason: 'אין מספיק זיכרון במכשיר לאיכות הגבוהה' };
  }
  return { ok: true, risky: true, reason: 'אי אפשר לבדוק את זיכרון המכשיר, והאיכות הגבוהה תופסת הרבה זיכרון' };
}

/**
 * בחירת דרגה. cap = {gpu, f16, memoryGB|null, ios, ipad, android, threads, crashed:{tier:true}}.
 * ברירת המחדל (auto) היא תמיד מודל קטן: balanced (whisper-small, כ־250–300MB) כשיש WebGPU או הרבה זיכרון וחוטים, אחרת fast (whisper-base, כ־80MB).
 * לשפות כמו אנגלית מספיק fast. דרגת high היא רק בבקשה מפורשת (model:'high'), ורק במכשיר שמסוגל אליה (highSupport).
 */
export function pickTier(cap, prefer = 'auto', language = 'auto') {
  if (prefer && prefer !== 'auto') {
    if (!TIERS[prefer]) throw new Error('דרגת תמלול לא מוכרת: ' + prefer);
    if (prefer === 'high' && !highSupport(cap).ok) return 'balanced';
    return prefer;
  }
  const mem = cap.memoryGB || 0;
  let tier = LIGHT_LANGS.has(language) ? 'fast' : (cap.gpu || (mem >= 6 && cap.threads)) ? 'balanced' : 'fast';
  if (mem && mem <= 2) tier = 'fast';
  // אם הניסיון הקודם בדרגה הזאת קרס את הדף, יורדים דרגה אחת
  while (tier !== 'fast' && cap.crashed && cap.crashed[tier]) tier = TIER_ORDER[TIER_ORDER.indexOf(tier) - 1];
  return tier;
}

/** המודלים שצריך להוריד ולטעון לדרגה ושפה: מודל הטקסט, ובדרגת high בעברית (או בשפה לא ידועה) גם מודל עזר ליישור ולזיהוי שפה. */
export function requiredModels(tier, language, cap) {
  const lang = normalizeLanguage(language);
  const spec = modelSpec(tier, lang === 'auto' ? 'he' : lang, cap);
  const list = [{ role: 'text', ...spec }];
  const helper = helperSpec(cap);
  const needsHelper = spec.timing === 'align' || (tier === 'high' && lang === 'auto');
  if (needsHelper && !(helper.id === spec.id && JSON.stringify(helper.dtype) === JSON.stringify(spec.dtype))) {
    list.push({ role: 'helper', tier: 'fast', id: helper.id, timing: 'native', device: helper.device, dtype: helper.dtype, sizeMB: helper.sizeMB, quality: TIERS.fast.quality, labelHe: TIERS.fast.labelHe });
  }
  return list;
}
export function tierDownloadMB(tier, language, cap) { return requiredModels(tier, language, cap).reduce((a, m) => a + m.sizeMB, 0); }

/**
 * בחירת דרגה לפי המקום הפנוי: מתחילים מ־tier, ואם ההורדה (בתוספת מרווח) לא נכנסת, יורדים דרגה אחת בכל פעם.
 * isCached(tier) אומר אם המודלים של הדרגה כבר שמורים (אז אין הורדה). מחזיר {tier, fits, needMB, steps:[{from,to,needMB}]}.
 */
export function chooseTierForSpace(tier, { language = 'auto', cap, freeMB = Infinity, isCached = () => false, margin = 1.15 } = {}) {
  const steps = [];
  let cur = tier;
  for (;;) {
    const need = isCached(cur) ? 0 : tierDownloadMB(cur, language, cap);
    if (need * margin <= freeMB) return { tier: cur, fits: true, needMB: need, steps };
    const idx = TIER_ORDER.indexOf(cur);
    if (idx === 0) return { tier: cur, fits: false, needMB: need, steps };
    steps.push({ from: cur, to: TIER_ORDER[idx - 1], needMB: need });
    cur = TIER_ORDER[idx - 1];
  }
}

// ------------------------------------------------------------------ שפות
const LANG_NAMES = {
  hebrew: 'he', english: 'en', arabic: 'ar', russian: 'ru', spanish: 'es', french: 'fr', german: 'de', italian: 'it', portuguese: 'pt',
  yiddish: 'yi', turkish: 'tr', polish: 'pl', ukrainian: 'uk', dutch: 'nl', hindi: 'hi', chinese: 'zh', japanese: 'ja', korean: 'ko', persian: 'fa', romanian: 'ro',
};
export function normalizeLanguage(l) {
  if (!l) return 'auto';
  let s = String(l).trim().toLowerCase();
  if (!s || s === 'auto') return 'auto';
  if (LANG_NAMES[s]) return LANG_NAMES[s];
  s = s.split(/[-_]/)[0];
  if (s === 'iw') return 'he';
  if (s === 'jw') return 'jv';
  return s;
}
const NO_SPACE_LANGS = new Set(['zh', 'ja', 'th', 'lo', 'km', 'my', 'yue']);
export function joinWords(words, language = 'en') {
  const sep = NO_SPACE_LANGS.has(language) ? '' : ' ';
  return words.map((w) => w.text).join(sep).trim();
}

// ------------------------------------------------------------------ ניקוי טקסט
// תווי כיווניות (LRM, RLM, LRE, RLE, PDF, LRO, RLO, LRI, RLI, FSI, PDI, ALM), רוחב־אפס, BOM ו־soft hyphen
const INVISIBLE_RE = /[\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\u061C\uFEFF\u00AD\u2060]/g;
const SPECIAL_TOKEN_RE = /<\|[^|>]*\|>/g;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function cleanText(s) {
  return String(s ?? '').replace(SPECIAL_TOKEN_RE, ' ').replace(INVISIBLE_RE, '').replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim();
}
/** צורה מנורמלת להשוואה בין מילים: בלי ניקוד, פיסוק ואותיות גדולות. */
export function normWord(s) {
  return cleanText(s).toLowerCase().replace(/[\u0591-\u05C7]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
}
const hasLetterOrDigit = (s) => /[\p{L}\p{N}]/u.test(s);
/** תגיות של Whisper לרעש ולמוזיקה, כמו [מוזיקה] או (applause) או ♪. */
export function isNonSpeechTag(s) {
  const t = cleanText(s);
  if (!t) return true;
  if (/^[♪♫♬\s*#-]+$/u.test(t)) return true;
  return /^[\[({].{0,40}[\])}]$/u.test(t) && t.split(/\s+/).length <= 3;
}
const SENT_END = /[.!?…。！？؟]["'”’)\]]*$/u;
const SOFT_END = /[,;:،、，；：]["'”’)\]]*$/u;

/** מילים שעוברות ניקוי: טקסט נקי, זמנים תקינים, תגיות לא־דיבור הוסרו, פיסוק בודד מחובר למילה הקודמת, בלי חפיפות. */
export function sanitizeWords(raw, { defaultDuration = 0.3 } = {}) {
  const out = [];
  for (const r of raw || []) {
    const text = cleanText(r && r.text);
    if (!text || isNonSpeechTag(text)) continue;
    let s = Number(r.start), e = Number(r.end);
    if (!Number.isFinite(s)) continue;
    if (!Number.isFinite(e) || e < s) e = s + defaultDuration;
    if (!hasLetterOrDigit(text)) {
      if (out.length) out[out.length - 1].text += text;   // פסיק או נקודה שנפרדו מהמילה
      continue;
    }
    out.push({ text, start: s, end: e });
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < out.length; i++) {
    const p = out[i - 1], w = out[i];
    if (w.start < p.end) p.end = Math.max(p.start + 0.02, Math.min(p.end, w.start));
    if (w.start < p.start) w.start = p.start;
  }
  for (const w of out) {
    if (w.end < w.start + 0.02) w.end = w.start + 0.02;
    w.start = Math.round(w.start * 1000) / 1000;
    w.end = Math.round(w.end * 1000) / 1000;
  }
  return out;
}

// ------------------------------------------------------------------ חזרות והזיות של whisper
/**
 * מסיר לולאות חזרה: מילה אחת שחוזרת יותר מ־maxWordRun פעמים רצופות מצטמצמת ל־keepWord עותקים,
 * וצירוף של 2 עד maxGram מילים שחוזר maxGramRepeat פעמים רצופות ויותר מצטמצם לעותק אחד.
 */
export function removeRepeats(words, { maxWordRun = 4, keepWord = 2, maxGramRepeat = 4, maxGram = 8 } = {}) {
  const norm = words.map((w) => normWord(w.text));
  const out = [];
  let i = 0;
  while (i < words.length) {
    let handled = false;
    for (let n = 1; n <= Math.min(maxGram, Math.floor((words.length - i) / 2)) && !handled; n++) {
      let r = 1;
      for (;;) {
        let same = true;
        const a = i + r * n;
        if (a + n > words.length) { same = false; }
        else for (let k = 0; k < n; k++) if (!norm[i + k] || norm[i + k] !== norm[a + k]) { same = false; break; }
        if (!same) break;
        r++;
      }
      const limit = n === 1 ? maxWordRun + 1 : maxGramRepeat;
      if (r >= limit) {
        const keep = n === 1 ? keepWord : 1;
        for (let c = 0; c < keep; c++) for (let k = 0; k < n; k++) out.push(words[i + c * n + k]);
        i += r * n;
        handled = true;
      }
    }
    if (!handled) { out.push(words[i]); i++; }
  }
  return out;
}

// משפטי "פיליינג" ידועים של whisper בשקט או במוזיקה, בצורה מנורמלת. מוסרים רק כשהקטע שקט באמת (isQuiet).
const HALLUCINATIONS = new Set([
  'thankyou', 'thankyouforwatching', 'thanksforwatching', 'pleasesubscribe', 'subtitlesbytheamaraorgcommunity', 'bye', 'byebye', 'you',
  'תודהרבהעלהצפייה', 'תודהשצפיתם', 'תודהעלהצפייה', 'תודהרבהשצפיתם', 'הירשמולערוץ', 'לייקושיתוף', 'תודהרבה', 'כתוביותמאתהקהילהשלamaraorg', 'תרגוםוכתוביות',
]);
export function dropHallucinations(words, { isQuiet = null, language = 'en' } = {}) {
  if (!words.length) return words;
  const segs = buildSegments(words, { language });
  const drop = new Set();
  for (const s of segs) {
    const key = normWord(s.text);
    const phrase = HALLUCINATIONS.has(key) || (key.length > 0 && isNonSpeechTag(s.text));
    if (!phrase) continue;
    if (isNonSpeechTag(s.text) || (isQuiet && isQuiet(s.start, s.end))) drop.add(s);
  }
  if (!drop.size) return words;
  return words.filter((w) => ![...drop].some((s) => w.start >= s.start - 1e-6 && w.end <= s.end + 1e-6));
}

// ------------------------------------------------------------------ אנרגיה, שקט ודיבור
/** מעטפת אנרגיה: dBFS ל־RMS בכל hop דגימות (ברירת מחדל 160 = 10ms ב־16kHz). */
export function energyEnvelope(audio, { hop = 160 } = {}) {
  const n = Math.floor(audio.length / hop);
  const env = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    const o = f * hop;
    for (let k = 0; k < hop; k++) { const v = audio[o + k]; s += v * v; }
    env[f] = 10 * Math.log10(s / hop + 1e-12);
  }
  return env;
}
function percentile(arr, p) {
  if (!arr.length) return -100;
  const a = Float32Array.from(arr).sort();
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))];
}
/** סף אנרגיה שמעליו יש דיבור: מעל רצפת הרעש ב־8dB ובתוך 30dB מהשיא. */
export function speechThreshold(env) {
  const floor = percentile(env, 0.1), peak = percentile(env, 0.95);
  return Math.min(-25, Math.max(-70, Math.max(floor + 8, peak - 30)));
}
/** האם בטווח (שניות) יש דיבור: לפחות 150ms רצופים מעל הסף, או 4% מהפריימים. */
export function hasSpeech(env, a, b, thr, hopSec = 0.01) {
  const i0 = Math.max(0, Math.floor(a / hopSec)), i1 = Math.min(env.length, Math.ceil(b / hopSec));
  let run = 0, maxRun = 0, count = 0;
  for (let i = i0; i < i1; i++) {
    if (env[i] > thr) { count++; run++; if (run > maxRun) maxRun = run; } else run = 0;
  }
  return maxRun * hopSec >= 0.15 || (i1 > i0 && count / (i1 - i0) >= 0.04);
}
/** קטעי קול רציפים [{a, b}] בשניות: ריצות של לפחות minVoiced מעל הסף, שהפסקה קצרה מ־minPause ביניהן לא מפרידה. */
export function voicedIntervals(env, thr, { hopSec = 0.01, minPause = 0.08, minVoiced = 0.03 } = {}) {
  const raw = [];
  let start = -1;
  for (let i = 0; i <= env.length; i++) {
    const on = i < env.length && env[i] > thr;
    if (on && start < 0) start = i;
    else if (!on && start >= 0) { if ((i - start) * hopSec >= minVoiced) raw.push({ a: start * hopSec, b: i * hopSec }); start = -1; }
  }
  const out = [];
  for (const r of raw) {
    const last = out[out.length - 1];
    if (last && r.a - last.b < minPause) last.b = r.b; else out.push({ ...r });
  }
  return out;
}
/**
 * מצמיד את המילים לקול: קצה של מילה שנמרח לתוך הפסקה (או לתחילת המילה הבאה) מקוצר לקצה הקול,
 * ותחילת מילה שאחרי הפסקה מוזזת להתחלת הקול. מילה בשקט מוחלט מוסרת (אלא אם יש בה קול חלש מאוד).
 */
export function trimWordsToVoice(words, env, thr, { hopSec = 0.01, minPause = 0.1, dropSilent = true, snapGrow = 0.15 } = {}) {
  const iv = voicedIntervals(env, thr, { hopSec, minPause });
  const out = [];
  let k0 = 0;
  for (const w of words) {
    while (k0 < iv.length && iv[k0].b <= w.start) k0++;
    const hits = [];
    for (let k = k0; k < iv.length && iv[k].a < w.end; k++) {
      const ov = Math.min(w.end, iv[k].b) - Math.max(w.start, iv[k].a);
      if (ov > 0) hits.push({ k, ov });
    }
    if (!hits.length) {
      let anyLow = false;   // שקט אמיתי = גם בסף נמוך ב־6dB אין קול. אחרת זה דיבור שקט, והמילה נשארת בזמנים המקוריים
      const i0 = Math.max(0, Math.floor(w.start / hopSec)), i1 = Math.min(env.length, Math.ceil(w.end / hopSec));
      for (let i = i0; i < i1 && !anyLow; i++) if (env[i] > thr - 6) anyLow = true;
      if (anyLow || !dropSilent) out.push(w);
      continue;
    }
    // מילה אחת לא חוצה הפסקה: הקול הראשי שלה הוא הקטע עם החפיפה הגדולה ביותר, והשאר זליגה של מילים שכנות
    const best = hits.reduce((x, y) => (y.ov > x.ov ? y : x));
    const main = iv[best.k];
    let start = w.start, end = w.end;
    if (main.a > start) start = main.a;
    if (main.b < end) end = main.b;
    if (end < start + 0.04) { start = w.start; end = w.end; }
    out.push({ text: w.text, start, end });
  }
  // הרחבה: מילה שמתחילה קצת אחרי תחילת קול (אחרי הפסקה) מתחילה בקול, ומילה שנגמרת קצת לפני סוף קול נגמרת בו
  if (snapGrow > 0) {
    for (let i = 0; i < out.length; i++) {
      const w = out[i], prev = out[i - 1], next = out[i + 1];
      for (const v of iv) {
        if (v.a < w.start && w.start - v.a <= snapGrow && (!prev || prev.end <= v.a + 1e-9) && v.a < w.end - 0.04) { w.start = v.a; break; }
      }
      for (const v of iv) {
        if (v.b > w.end && v.b - w.end <= snapGrow && (!next || next.start >= v.b - 1e-9) && v.b > w.start + 0.04) { w.end = v.b; break; }
      }
    }
  }
  return out.map((w) => ({ text: w.text, start: Math.round(w.start * 1000) / 1000, end: Math.round(w.end * 1000) / 1000 }));
}

// ------------------------------------------------------------------ חלונות ואיחוד
/**
 * חלוקה של סרטון באורך total שניות לחלונות של windowSec (30) שמרוחקים בשווה זה מזה, עם חפיפה של overlapSec לפחות (פחות שנייה אחת).
 * מספר החלונות הוא המינימלי שמכסה את כל הסרטון, ולכן אין חלון אחרון זעיר.
 */
export function planWindows(total, { windowSec = WINDOW_SEC, overlapSec = OVERLAP_SEC } = {}) {
  if (!(total > 0)) return [];
  if (total <= windowSec) return [{ start: 0, end: total }];
  const minOverlap = Math.max(2, overlapSec - 1);
  const n = Math.ceil((total - windowSec) / (windowSec - minOverlap)) + 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const start = Math.round(((total - windowSec) * i / (n - 1)) * 1000) / 1000;
    out.push({ start, end: i === n - 1 ? total : Math.round((start + windowSec) * 1000) / 1000 });
  }
  return out;
}

/** נקודת חיתוך בין שני חלונות: מרכז ההפסקה (שקט של 120ms ומעלה) הקרובה ביותר לאמצע החפיפה, ואם אין כזו אז אמצע החפיפה עצמו. */
export function seamCut(prevEnd, nextStart, pauses = null) {
  const mid = (prevEnd + nextStart) / 2;
  if (!pauses || !pauses.length) return mid;
  let best = null;
  for (const p of pauses) {
    const c = (p.a + p.b) / 2;
    if (p.b - p.a < 0.12 || c < nextStart + 0.4 || c > prevEnd - 0.4) continue;
    if (!best || Math.abs(c - mid) < Math.abs(best - mid)) best = c;
  }
  return best === null ? mid : best;
}
/** ההפסקות (פערים בין קטעי קול) מתוך קטעי הקול. */
export function pausesFromIntervals(iv) {
  const out = [];
  for (let i = 1; i < iv.length; i++) out.push({ a: iv[i - 1].b, b: iv[i].a });
  return out;
}

/** איחוד תוצאות חלונות [{start, end, words}] (זמנים מוחלטים). בכל תפר חותכים בהפסקה הקרובה לאמצע החפיפה, ומסירים מילה כפולה בתפר. */
export function mergeWindows(parts, { pauses = null } = {}) {
  const sorted = [...parts].sort((a, b) => a.start - b.start);
  const cuts = [];
  for (let k = 0; k + 1 < sorted.length; k++) cuts.push(seamCut(sorted[k].end, sorted[k + 1].start, pauses));
  const out = [];
  for (let k = 0; k < sorted.length; k++) {
    const lo = k === 0 ? -Infinity : cuts[k - 1];
    const hi = k === sorted.length - 1 ? Infinity : cuts[k];
    const kept = [];
    for (const w of sorted[k].words || []) {
      const mid = (w.start + w.end) / 2;
      if (mid >= lo && mid < hi) kept.push(w);
    }
    if (kept.length && out.length) {
      const prev = out[out.length - 1], first = kept[0];
      if (normWord(prev.text) && normWord(prev.text) === normWord(first.text) && first.start < prev.end + 0.15) kept.shift();
    }
    out.push(...kept);
  }
  return out;
}

// ------------------------------------------------------------------ segments
/** בניית segments (משפטים וקטעי כתוביות) מרשימת מילים: פיצול בסוף משפט, בהפסקה ארוכה, ובקטע ארוך מדי (עדיפות לפסיק). */
export function buildSegments(words, { language = 'en', maxGap = 0.8, maxDuration = 7.5, maxChars = 80 } = {}) {
  const segs = [];
  let cur = [];
  let chars = 0;
  const sep = NO_SPACE_LANGS.has(language) ? 0 : 1;
  const flush = () => {
    if (!cur.length) return;
    segs.push({ text: joinWords(cur, language), start: cur[0].start, end: cur[cur.length - 1].end });
    cur = []; chars = 0;
  };
  for (const w of words) {
    if (cur.length) {
      const prev = cur[cur.length - 1];
      if (w.start - prev.end >= maxGap || SENT_END.test(prev.text)) flush();
      else if (w.end - cur[0].start > maxDuration || chars + sep + w.text.length > maxChars) {
        let k = -1;
        for (let j = cur.length - 2; j >= Math.floor(cur.length * 0.4); j--) if (SOFT_END.test(cur[j].text)) { k = j; break; }
        if (k >= 0) { const rest = cur.splice(k + 1); flush(); cur = rest; chars = rest.reduce((a, x) => a + x.text.length + sep, 0) - (rest.length ? sep : 0); }
        else flush();
      }
    }
    chars += (cur.length ? sep : 0) + w.text.length;
    cur.push(w);
  }
  flush();
  return segs;
}

/**
 * מכל המילים הגולמיות (זמנים מוחלטים) ל־Transcript סופי: ניקוי, חזרות, הזיות בשקט, צמצום לקצוות הקוליים ו־segments.
 * env ו־thr (אופציונליים) הם מעטפת האנרגיה והסף של כל הסרטון.
 */
export function buildTranscript(rawWords, { language = 'en', env = null, thr = null, duration = null } = {}) {
  let words = sanitizeWords(rawWords);
  words = removeRepeats(words);
  if (env && thr !== null) {
    const isQuiet = (a, b) => !hasSpeech(env, a, b, thr + 4);
    words = dropHallucinations(words, { isQuiet, language });
    words = trimWordsToVoice(words, env, thr);
  } else {
    words = dropHallucinations(words, { language });
  }
  words = sanitizeWords(words);
  if (duration) for (const w of words) { if (w.end > duration) w.end = Math.max(w.start + 0.02, duration); if (w.start > duration) w.start = duration; }
  const segments = buildSegments(words, { language });
  const t = { language, words, segments };
  return t;
}

// ------------------------------------------------------------------ חלוקת מילים לפי משקל (גיבוי כשאין יישור)
function syllableWeight(text, language) {
  const t = normWord(text);
  if (!t) return 0.5;
  if (language === 'he' || /[\u0590-\u05FF]/.test(t)) {
    let w = 0;
    for (const ch of t) w += 'ויאהע'.includes(ch) ? 0.5 : 1;
    return Math.max(1, w);
  }
  if (/^[a-z]+$/.test(t)) return Math.max(1, (t.match(/[aeiouy]+/g) || []).length);
  return Math.max(1, t.length * 0.5);
}
/** מחלק מילים על הטווח [start,end] לפי משקל הברות, ורק על הזמן הקולי (ההפסקות לא "נאכלות" על ידי מילים). */
export function distributeWords(texts, start, end, { env = null, thr = null, hopSec = 0.01, language = 'en' } = {}) {
  const n = texts.length;
  if (!n) return [];
  const weights = texts.map((t) => syllableWeight(t, language));
  const total = weights.reduce((a, b) => a + b, 0);
  const frames = [];
  if (env && thr !== null) {
    const i0 = Math.max(0, Math.floor(start / hopSec)), i1 = Math.min(env.length, Math.ceil(end / hopSec));
    for (let i = i0; i < i1; i++) if (env[i] > thr) frames.push(i);
  }
  const out = [];
  if (frames.length < n * 3) {   // אין מספיק קול כדי להתבסס עליו: חלוקה ליניארית
    let acc = 0;
    for (let k = 0; k < n; k++) {
      const s = start + (end - start) * (acc / total);
      acc += weights[k];
      out.push({ text: texts[k], start: s, end: Math.max(s + 0.02, start + (end - start) * (acc / total)) });
    }
    return out;
  }
  const idx = [0];
  let acc = 0;
  for (let k = 0; k < n - 1; k++) {
    acc += weights[k];
    let i = Math.round((acc / total) * frames.length);
    i = Math.max(idx[idx.length - 1] + 1, Math.min(frames.length - (n - 1 - k), i));
    idx.push(i);
  }
  idx.push(frames.length);
  for (let k = 0; k < n; k++) {
    const s = frames[idx[k]] * hopSec;
    const e = (frames[Math.max(idx[k], idx[k + 1] - 1)] + 1) * hopSec;
    out.push({ text: texts[k], start: s, end: Math.max(s + 0.02, e) });
  }
  return out;
}

// ------------------------------------------------------------------ יישור מאולץ (DTW על תשומת הלב של המפענח)
/** חציון בחלון 'width' לכל שורה (פינות משתקפות), כמו median_filter של Whisper. */
export function medianFilterRows(mat, rows, cols, width = 7) {
  const hw = width >> 1;
  const out = new Float32Array(mat.length);
  const win = new Float32Array(width);
  for (let r = 0; r < rows; r++) {
    const o = r * cols;
    for (let c = 0; c < cols; c++) {
      for (let k = -hw; k <= hw; k++) {
        let cc = c + k;
        if (cc < 0) cc = -cc;
        if (cc >= cols) cc = 2 * (cols - 1) - cc;
        if (cc < 0) cc = 0;
        win[k + hw] = mat[o + cc];
      }
      for (let i = 1; i < width; i++) {   // מיון הכנסה של חלון קטן
        const v = win[i];
        let j = i - 1;
        while (j >= 0 && win[j] > v) { win[j + 1] = win[j]; j--; }
        win[j + 1] = v;
      }
      out[o + c] = win[hw];
    }
  }
  return out;
}
/** DTW על מטריצת עלות rows*cols (מינימום). מחזיר את המסלול כ־{rows:[], cols:[]}. אותה שיטה כמו dtw של OpenAI. */
export function dtwPath(cost, rows, cols) {
  const W = cols + 1;
  const acc = new Float32Array((rows + 1) * W).fill(Infinity);
  const trace = new Int8Array((rows + 1) * W).fill(-1);
  acc[0] = 0;
  for (let j = 1; j <= cols; j++) {
    for (let i = 1; i <= rows; i++) {
      const c0 = acc[(i - 1) * W + (j - 1)], c1 = acc[(i - 1) * W + j], c2 = acc[i * W + (j - 1)];
      let c, t;
      if (c0 < c1 && c0 < c2) { c = c0; t = 0; } else if (c1 < c0 && c1 < c2) { c = c1; t = 1; } else { c = c2; t = 2; }
      acc[i * W + j] = cost[(i - 1) * cols + (j - 1)] + c;
      trace[i * W + j] = t;
    }
  }
  for (let j = 0; j <= cols; j++) trace[j] = 2;
  for (let i = 0; i <= rows; i++) trace[i * W] = 1;
  let i = rows, j = cols;
  const pr = [], pc = [];
  while (i > 0 || j > 0) {
    pr.push(i - 1); pc.push(j - 1);
    const t = trace[i * W + j];
    if (t === 0) { i--; j--; } else if (t === 1) i--; else j--;
  }
  pr.reverse(); pc.reverse();
  return { rows: pr, cols: pc };
}
/**
 * מתשומת לב של ראשי יישור ל"פריים התחלה" של כל שורה (טוקן).
 * heads: מערך של Float32Array בגודל rows*cols (הסתברויות תשומת לב של ראש אחד, שורה לטוקן, עמודה לפריים של 20ms).
 * מחזיר Int32Array באורך rows+1: jumps[r] הוא הפריים שבו מתחילה שורה r, ו־jumps[rows] = cols.
 */
export function alignmentJumps(heads, rows, cols, { medianWidth = 7 } = {}) {
  const avg = new Float32Array(rows * cols);
  for (const m0 of heads) {
    const m = Float32Array.from(m0);
    for (let f = 0; f < cols; f++) {
      let mean = 0;
      for (let r = 0; r < rows; r++) mean += m[r * cols + f];
      mean /= rows;
      let v = 0;
      for (let r = 0; r < rows; r++) { const x = m[r * cols + f] - mean; v += x * x; }
      const sd = Math.sqrt(v / rows) + 1e-9;
      for (let r = 0; r < rows; r++) m[r * cols + f] = (m[r * cols + f] - mean) / sd;
    }
    const filt = medianFilterRows(m, rows, cols, medianWidth);
    for (let i = 0; i < avg.length; i++) avg[i] += filt[i] / heads.length;
  }
  for (let i = 0; i < avg.length; i++) avg[i] = -avg[i];
  const { rows: pr, cols: pc } = dtwPath(avg, rows, cols);
  const jumps = new Int32Array(rows + 1).fill(-1);
  let prev = -1;
  for (let k = 0; k < pr.length; k++) if (pr[k] !== prev) { jumps[pr[k]] = pc[k]; prev = pr[k]; }
  jumps[rows] = cols;
  for (let r = rows - 1; r >= 0; r--) if (jumps[r] < 0) jumps[r] = jumps[r + 1];
  return jumps;
}
/** זמני מילים (שניות, יחסית לתחילת האודיו שנשלח) מ־jumps ומספר הטוקנים בכל מילה. */
export function wordTimesFromJumps(jumps, tokenCounts, texts, frameSec = 0.02) {
  const out = [];
  let k = 0;
  for (let w = 0; w < texts.length; w++) {
    const a = k, b = k + tokenCounts[w];
    out.push({ text: texts[w], start: jumps[a] * frameSec, end: jumps[Math.min(b, jumps.length - 1)] * frameSec });
    k = b;
  }
  return out;
}

// ------------------------------------------------------------------ מטמון שמחלק קבצים גדולים לחלקים
// Cache API של כרום דוחה ערך של 256MB ומעלה, ושקט־שקט transformers.js לא שומר אותו. לכן המטמון הזה שומר קבצים גדולים במנות.
const PART_BYTES = 96 * 1024 * 1024;
export class ChunkedCache {
  constructor(name = CACHE_NAME, partBytes = PART_BYTES) { this.name = name; this.partBytes = partBytes; this._cache = null; }
  async _c() { if (!this._cache) this._cache = await caches.open(this.name); return this._cache; }
  _key(req) { return typeof req === 'string' ? req : req.url; }
  // ה־Cache API מתעלם מ־#fragment במפתח, ולכן המפתחות של החלקים והמטא נבדלים בפרמטר שאילתה
  _meta(k) { return k + (k.includes('?') ? '&' : '?') + 'frame-meta=1'; }
  _part(k, i) { return k + (k.includes('?') ? '&' : '?') + 'frame-part=' + i; }
  async has(req) {
    const k = this._key(req), c = await this._c();
    return !!(await c.match(k)) || !!(await c.match(this._meta(k)));
  }
  async match(req) {
    const k = this._key(req), c = await this._c();
    const direct = await c.match(k);
    if (direct) return direct;
    const m = await c.match(this._meta(k));
    if (!m) return undefined;
    let info;
    try { info = await m.json(); } catch (e) { return undefined; }
    const blobs = [];
    for (let i = 0; i < info.parts; i++) {
      const p = await c.match(this._part(k, i));
      if (!p) return undefined;   // חלק חסר (פינוי של הדפדפן): כאילו הקובץ לא נשמר
      blobs.push(await p.blob());
    }
    const type = info.type || 'application/octet-stream';
    return new Response(new Blob(blobs, { type }), { status: 200, headers: { 'content-length': String(info.size), 'content-type': type } });
  }
  async put(req, response) {
    const k = this._key(req), c = await this._c();
    const type = response.headers.get('content-type') || 'application/octet-stream';
    const len = Number(response.headers.get('content-length')) || 0;
    if (len && len <= this.partBytes) { await c.put(k, response); return; }
    const reader = response.body.getReader();
    let part = [], partBytes = 0, idx = 0, total = 0;
    const flush = async () => {
      if (!partBytes) return;
      await c.put(this._part(k, idx), new Response(new Blob(part)));
      idx++; part = []; partBytes = 0;
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        let off = 0;
        while (off < value.length) {
          const take = Math.min(value.length - off, this.partBytes - partBytes);
          part.push(value.subarray(off, off + take));
          partBytes += take; total += take; off += take;
          if (partBytes >= this.partBytes) await flush();
        }
      }
      await flush();
      if (idx === 0) { await c.put(k, new Response(new Blob([]), { headers: { 'content-type': type } })); return; }
      if (idx === 1) { // קובץ קטן שהגיע בלי content-length: נשמר כרגיל
        const only = await (await c.match(this._part(k, 0))).blob();
        await c.put(k, new Response(only, { headers: { 'content-type': type, 'content-length': String(total) } }));
        await c.delete(this._part(k, 0));
        return;
      }
      await c.put(this._meta(k), new Response(JSON.stringify({ size: total, parts: idx, type })));
    } catch (e) {
      for (let i = 0; i <= idx; i++) { try { await c.delete(this._part(k, i)); } catch (e2) { /* ignore */ } }
      throw e;
    }
  }
  /** מוחק מהמטמון כל מודל שאין ב־keepUrls (כתובות הקבצים השלמות). מחזיר כמה קבצים נמחקו. */
  async prune(keepUrls, prefix = 'https://huggingface.co/') {
    const c = await this._c();
    const bases = new Set((await c.keys()).map((r) => r.url.replace(/[?&]frame-(part|meta)=\d*$/, '')));
    let n = 0;
    for (const b of bases) if (b.startsWith(prefix) && !keepUrls.has(b)) { await this.delete(b); n++; }
    return n;
  }
  async delete(req) {
    const k = this._key(req), c = await this._c();
    let any = await c.delete(k);
    const m = await c.match(this._meta(k));
    if (m) {
      try { const info = await m.json(); for (let i = 0; i < info.parts; i++) await c.delete(this._part(k, i)); } catch (e) { /* ignore */ }
      any = (await c.delete(this._meta(k))) || any;
    }
    return any;
  }
}

/** רשימת קבצי המודל ש־transformers.js מבקש (והמפתחות במטמון) עבור מודל, לפי dtype. */
export function modelFiles(id, dtype) {
  const suffix = (d) => (d === 'q8' || d === 'int8' || d === 'uint8' ? '_quantized' : d === 'fp32' ? '' : '_' + d);
  const enc = typeof dtype === 'string' ? dtype : dtype.encoder_model;
  const dec = typeof dtype === 'string' ? dtype : dtype.decoder_model_merged;
  const base = `https://huggingface.co/${id}/resolve/main/`;
  return ['config.json', 'preprocessor_config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json',
    `onnx/encoder_model${suffix(enc)}.onnx`, `onnx/decoder_model_merged${suffix(dec)}.onnx`].map((f) => base + f);
}

// ------------------------------------------------------------------ יכולות המכשיר
let capCache = null;
const CRASH_KEY = 'frame.asr.loading', CRASHED_KEY = 'frame.asr.crashed';
function ls() { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; } }
/** סימן "בטעינה": אם הדף נהרג באמצע (נגמר זיכרון), בפעם הבאה נרד דרגה. */
export function markLoading(tier) {
  const s = ls(); if (!s) return;
  try { s.setItem(CRASH_KEY, JSON.stringify({ tier, t: Date.now() })); } catch (e) { /* ignore */ }
}
export function clearLoading() { const s = ls(); if (s) try { s.removeItem(CRASH_KEY); } catch (e) { /* ignore */ } }
export function resetCrashGuard() { const s = ls(); if (s) try { s.removeItem(CRASH_KEY); s.removeItem(CRASHED_KEY); } catch (e) { /* ignore */ } capCache = null; }
function readCrashed() {
  const s = ls(); const out = {};
  if (!s) return out;
  try {
    const week = 7 * 24 * 3600 * 1000;
    let rec = JSON.parse(s.getItem(CRASHED_KEY) || '{}');
    const pending = JSON.parse(s.getItem(CRASH_KEY) || 'null');
    if (pending && pending.tier) { rec[pending.tier] = Date.now(); s.removeItem(CRASH_KEY); }
    for (const [t, ts] of Object.entries(rec)) if (Date.now() - ts > week) delete rec[t]; else out[t] = true;
    s.setItem(CRASHED_KEY, JSON.stringify(rec));
  } catch (e) { /* ignore */ }
  return out;
}
function syncCaps() {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const ua = nav.userAgent || '';
  const ios = /iPhone|iPod/.test(ua);
  const ipad = /iPad/.test(ua) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  return {
    gpu: !!nav.gpu, f16: !!nav.gpu, memoryGB: nav.deviceMemory || null, ios, ipad, android, mobile: ios || ipad || android || /Mobile/.test(ua),
    threads: typeof self !== 'undefined' && !!self.crossOriginIsolated, cores: nav.hardwareConcurrency || 0, crashed: {}, probed: false,
  };
}
/** בדיקה אמיתית של WebGPU (כולל shader-f16). התוצאה נשמרת, ו־modelInfo() נעשה מדויק אחריה. */
export async function probeDevice(force = false) {
  if (capCache && capCache.probed && !force) return capCache;
  const cap = syncCaps();
  cap.crashed = readCrashed();
  cap.gpu = false; cap.f16 = false;
  try {
    if (typeof navigator !== 'undefined' && navigator.gpu) {
      const ad = await navigator.gpu.requestAdapter();
      if (ad) { cap.gpu = true; cap.f16 = ad.features.has('shader-f16'); cap.maxBufferMB = Math.round((ad.limits.maxBufferSize || 0) / 1048576); }
    }
  } catch (e) { /* אין WebGPU */ }
  cap.probed = true;
  capCache = cap;
  return cap;
}
const HEBREW_QUALITY = { high: 'מצוין', balanced: 'סביר', fast: 'חלש מאוד' };
/**
 * פרטי המודל שייבחר, כדי שהממשק יציג מראש "הורדה חד־פעמית של NNNMB": {id, sizeMB, quality, device, tier, labelHe, downloadHe, canHigh, tiers[], ...}.
 * סינכרוני. לפני probeDevice() הוא מניח WebGPU עם f16 אם navigator.gpu קיים. quality: 'high' | 'good' | 'basic'.
 * sizeMB הוא כל ההורדה של הדרגה שנבחרה (כולל מודל עזר). tiers מפרט את כל הדרגות עם הגודל והזמינות שלהן, לבחירה בהגדרות.
 * language ברירת המחדל 'he' (האפליקציה בעברית). model: 'auto' (מודל קטן) | 'high' | 'balanced' | 'fast'.
 */
export function modelInfo({ language = 'he', model = 'auto', cap: capOverride = null } = {}) {
  const cap = capOverride || capCache || syncCaps();
  const lang = normalizeLanguage(language);
  const tier = pickTier(cap, model, lang);
  const req = requiredModels(tier, lang, cap);
  const text = req[0];
  const helper = req.find((m) => m.role === 'helper') || null;
  const sizeMB = req.reduce((a, m) => a + m.sizeMB, 0);
  const hs = highSupport(cap);
  const tiers = TIER_ORDER.map((t) => {
    const r = requiredModels(t, lang, cap);
    const isHigh = t === 'high';
    return {
      tier: t, id: r[0].id, sizeMB: r.reduce((a, m) => a + m.sizeMB, 0), quality: r[0].quality, labelHe: r[0].labelHe, device: r[0].device,
      available: !isHigh || hs.ok, risky: isHigh && hs.ok && hs.risky, reason: isHigh ? hs.reason : '', hebrewQuality: HEBREW_QUALITY[t],
    };
  });
  return {
    id: text.id, sizeMB, quality: text.quality, device: text.device, tier, labelHe: text.labelHe, dtype: text.dtype, timing: text.timing,
    downloadHe: 'הורדה חד־פעמית של ' + sizeMB + 'MB',
    helper: helper ? { id: helper.id, sizeMB: helper.sizeMB, device: helper.device, dtype: helper.dtype } : null,
    canHigh: hs.ok, tiers, probed: !!cap.probed, hebrewQuality: HEBREW_QUALITY[tier],
  };
}
function filesFor(tier, language, cap) { return requiredModels(tier, language, cap).flatMap((m) => modelFiles(m.id, m.dtype)); }
/** האם כל קבצי הדרגה כבר שמורים בדפדפן (אפשר לעבוד בלי אינטרנט). */
export async function isModelCached({ language = 'he', model = 'auto', cap: capOverride = null } = {}) {
  if (typeof caches === 'undefined') return false;
  const cap = capOverride || await probeDevice();
  const lang = normalizeLanguage(language);
  const tier = pickTier(cap, model, lang);
  const cache = new ChunkedCache();
  for (const f of filesFor(tier, lang, cap)) if (!(await cache.has(f))) return false;
  return true;
}
async function freeStorageMB() {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
      const { quota, usage } = await navigator.storage.estimate();
      if (quota) return Math.max(0, (quota - (usage || 0)) / 1048576);
    }
  } catch (e) { /* לא ידוע */ }
  return Infinity;
}
/** modelInfo עם מצב המטמון והמקום הפנוי: {...modelInfo, cached, freeMB, fits}. אסינכרוני. */
export async function modelStatus(opts = {}) {
  const cap = opts.cap || await probeDevice();
  const info = modelInfo({ ...opts, cap });
  const cached = await isModelCached({ language: opts.language, model: info.tier, cap }).catch(() => false);
  const freeMB = await freeStorageMB();
  return { ...info, cached, freeMB: freeMB === Infinity ? null : Math.round(freeMB), fits: cached || info.sizeMB * 1.15 <= freeMB };
}

// ------------------------------------------------------------------ שגיאות בעברית
export function hebrewError(message, name = 'Error') { const e = new Error(message); e.name = name; return e; }
export function abortError() { return hebrewError('התמלול בוטל', 'AbortError'); }
function throwIfAborted(signal) { if (signal && signal.aborted) throw abortError(); }
/** מתרגם שגיאה טכנית של הדפדפן או של ONNX Runtime להודעה בעברית. */
export function explainError(e, stage = '') {
  if (e && e.name === 'AbortError') return abortError();
  const raw = String((e && e.message) || e || '');
  const low = raw.toLowerCase();
  if (e && /^[\u0590-\u05FF]/.test(raw)) return e instanceof Error ? e : hebrewError(raw);   // כבר בעברית
  if (/quota|storage|no space|disk full/.test(low)) return hebrewError('אין מספיק מקום בטלפון כדי לשמור את מודל התמלול. פנו מקום ונסו שוב.');
  if (/failed to fetch|networkerror|network error|load failed|err_internet|offline|could not locate file|unable to get model file/.test(low)) {
    return hebrewError(stage === 'load' ? 'לא הצלחנו להוריד את מודל התמלול. בדקו את החיבור לאינטרנט ונסו שוב.' : 'אין חיבור לאינטרנט, והמודל עוד לא נשמר בטלפון. התחברו פעם אחת כדי להוריד אותו.');
  }
  if (/out of memory|oom|allocation|memory access|bad_alloc|aborted\(|device lost|gpuoutofmemory|buffer.*too large|maxbuffersize|exceeds/.test(low)) {
    return hebrewError('נגמר הזיכרון בזמן התמלול. נסו סרטון קצר יותר או איכות תמלול נמוכה יותר.');
  }
  if (/webgpu|adapter|gpu/.test(low)) return hebrewError('המעבד הגרפי של המכשיר לא הצליח להריץ את התמלול. נסו שוב או בחרו איכות נמוכה יותר.');
  return hebrewError('התמלול נכשל. נסו שוב. (' + raw.slice(0, 120) + ')');
}

// ------------------------------------------------------------------ חילוץ קול
/** מחזיר Float32Array של מונו ב־16kHz מכל קלט: Float32Array, AudioBuffer, או Blob/File של וידאו וקול. */
export async function toAudio16k(input, { signal, onProgress } = {}) {
  throwIfAborted(signal);
  if (input instanceof Float32Array) return input;
  if (typeof AudioBuffer !== 'undefined' && input instanceof AudioBuffer) return await resampleBuffer(input);
  if (!input || typeof input.arrayBuffer !== 'function') throw hebrewError('לא נבחר קובץ לתמלול');
  if (!input.size) throw hebrewError('הקובץ ריק');
  let audioMod = null;
  try { audioMod = await import('./audio.js'); } catch (e) { audioMod = null; }
  if (audioMod && audioMod.decodeAudio && audioMod.to16kMono) {
    const buf = await audioMod.decodeAudio(input, { sampleRate: SAMPLE_RATE, mono: true, signal, onProgress: onProgress ? (f) => onProgress(f) : undefined });
    return audioMod.to16kMono(buf);
  }
  // מימוש מקומי: decodeAudioData בקצב 16kHz, ואם הדפדפן מתעלם מהקצב, שינוי קצב ב־OfflineAudioContext
  const Ctx = (typeof AudioContext !== 'undefined' && AudioContext) || (typeof webkitAudioContext !== 'undefined' && webkitAudioContext);
  if (!Ctx) throw hebrewError('הדפדפן הזה אינו תומך בעיבוד קול');
  const bytes = await input.arrayBuffer();
  throwIfAborted(signal);
  let ctx, decoded;
  try {
    try { ctx = new Ctx({ sampleRate: SAMPLE_RATE }); } catch (e) { ctx = new Ctx(); }
    decoded = await new Promise((res, rej) => { const p = ctx.decodeAudioData(bytes, res, rej); if (p && p.then) p.then(res, rej); });
  } catch (e) {
    throw hebrewError('לא הצלחנו לפענח את הקול בקובץ. ייתכן שאין בו קול או שהפורמט אינו נתמך.');
  } finally { try { ctx && ctx.close && ctx.close(); } catch (e) { /* ignore */ } }
  return await resampleBuffer(decoded);
}
async function resampleBuffer(buf) {
  const n = buf.numberOfChannels;
  let mono;
  if (buf.sampleRate === SAMPLE_RATE) {
    if (n === 1) return Float32Array.from(buf.getChannelData(0));
    mono = new Float32Array(buf.length);
    for (let c = 0; c < n; c++) { const d = buf.getChannelData(c); for (let i = 0; i < mono.length; i++) mono[i] += d[i] / n; }
    return mono;
  }
  const len = Math.ceil(buf.duration * SAMPLE_RATE);
  const off = new OfflineAudioContext(1, len, SAMPLE_RATE);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return Float32Array.from(rendered.getChannelData(0));
}

// ------------------------------------------------------------------ הלקוח של ה־worker
let client = null;
class Client {
  constructor() {
    if (typeof Worker === 'undefined') throw hebrewError('הדפדפן הזה אינו תומך בעיבוד ברקע, ולכן אי אפשר לתמלל בו');
    this.worker = new Worker(new URL('./transcribe.worker.js', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.nextId = 1;
    this.worker.onmessage = (ev) => {
      const m = ev.data || {};
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') { if (p.onEvent) p.onEvent(m); return; }
      this.pending.delete(m.id);
      if (m.type === 'error') p.reject(m.aborted ? abortError() : hebrewError(m.message || 'התמלול נכשל'));
      else p.resolve(m.result);
    };
    const fail = (msg) => { for (const [, p] of this.pending) p.reject(hebrewError(msg)); this.pending.clear(); this.dead = true; };
    this.worker.onerror = (ev) => fail('התמלול נכשל בעיבוד ברקע. נסו שוב.' + (ev && ev.message ? ' (' + String(ev.message).slice(0, 100) + ')' : ''));
    this.worker.onmessageerror = () => fail('התמלול נכשל בקבלת נתונים מהעיבוד ברקע');
  }
  call(cmd, payload = {}, { transfer = [], onEvent, signal } = {}) {
    throwIfAborted(signal);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const done = (fn) => (v) => { if (signal) signal.removeEventListener('abort', onAbort); fn(v); };
      const onAbort = () => {
        try { this.worker.postMessage({ type: 'abort', target: id }); } catch (e) { /* ignore */ }
        // אם ה־worker לא עוצר תוך 2.5 שניות, מפילים אותו (הזיכרון משתחרר, והמודל ייטען שוב מהמטמון בפעם הבאה)
        setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); this.terminate(); reject(abortError()); } }, 2500);
      };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject), onEvent });
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.worker.postMessage({ type: cmd, id, ...payload }, transfer);
    });
  }
  terminate() { try { this.worker.terminate(); } catch (e) { /* ignore */ } this.dead = true; if (client === this) client = null; }
}
function getClient() { if (!client || client.dead) client = new Client(); return client; }
/** סוגר את ה־worker ומשחרר את הזיכרון של המודל (אפשר לקרוא כשמסיימים לתמלל). */
export function disposeTranscriber() { if (client) client.terminate(); client = null; }

if (typeof addEventListener === 'function' && typeof window !== 'undefined') {
  addEventListener('pagehide', () => { clearLoading(); });
}

function makeReporter(onProgress) {
  let last = -1, lastText = '';
  return (fraction, text) => {
    if (!onProgress) return;
    const f = Math.max(0, Math.min(1, fraction));
    if (f === last && text === lastText) return;
    last = f; lastText = text;
    try { onProgress(f, text); } catch (e) { /* ממשק שזרק לא עוצר תמלול */ }
  };
}
const pct = (f) => Math.round(Math.max(0, Math.min(1, f)) * 100) + '%';

/** בקשת שמירה קבועה של האחסון, כדי שהדפדפן לא יפנה את המודל (בלי תוצאה אם נדחה). */
function requestPersist() { try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) { /* ignore */ } }

// הפעלות מקבילות מתורגלות בתור, כדי ש־worker אחד לא יסתיים באמצע עבודה של בקשה אחרת
let queue = Promise.resolve();
let active = 0;
function enqueue(job) {
  active++;
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run.finally(() => { active--; });
}
function releaseIfIdle(keepLoaded) { if (!keepLoaded && active <= 1) disposeTranscriber(); }

/**
 * תמלול עם זמן לכל מילה.
 * input: File/Blob של וידאו או קול, AudioBuffer, או Float32Array של 16kHz מונו.
 * opts: {language:'auto'|'he'|'en'|..., onProgress(fraction, textHe), signal, model:'auto'|'high'|'balanced'|'fast', device:'auto'|'wasm', keepLoaded:false}
 * מחזיר Transcript: {language, words:[{text,start,end}], segments:[{text,start,end}]} (שניות, זמני מקור).
 * בנוסף יש על התוצאה מאפיין לא־נספר `meta` (מודל, מעבד, זמן ריצה) לצורכי אבחון.
 */
export function transcribe(input, opts = {}) {
  return enqueue(() => transcribeNow(input, opts));
}

async function transcribeNow(input, opts) {
  const { onProgress, signal, model = 'auto', device = 'auto', keepLoaded = false } = opts;
  const language = normalizeLanguage(opts.language);
  const report = makeReporter(onProgress);
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const t0 = now();
  throwIfAborted(signal);

  report(0, 'מחלץ את הקול מהסרטון…');
  const audio = await toAudio16k(input, { signal, onProgress: (f) => report(f * 0.06, 'מחלץ את הקול מהסרטון…') });
  throwIfAborted(signal);
  const duration = audio.length / SAMPLE_RATE;
  if (!(duration > 0.2)) throw hebrewError('אין קול בקובץ, ולכן אין מה לתמלל');
  report(0.06, 'מכין את התמלול…');

  const baseCap = { ...(await probeDevice()) };
  if (device === 'wasm') { baseCap.gpu = false; baseCap.f16 = false; }
  // מערך שהתקבל מהקורא מועתק (כדי לא לנתק לו אותו); מערך שפענחנו בעצמנו מועבר ל־worker בלי עותק
  const owned = !(input instanceof Float32Array) && audio.byteOffset === 0 && audio.buffer.byteLength === audio.byteLength;

  // בחירת דרגה לפי הבקשה, המכשיר והמקום הפנוי. אם המודל לא נכנס, מפנים מודלים ישנים, ואם עדיין לא, יורדים לדרגה קטנה יותר
  const notes = [];
  let startTier = pickTier(baseCap, model, language);
  if (model === 'high' && startTier !== 'high') notes.push('המכשיר לא מתאים לאיכות הגבוהה: ' + highSupport(baseCap).reason);
  const cachedMap = async (cap) => { const m = {}; for (const t of TIER_ORDER) m[t] = await isModelCached({ language, model: t, cap }).catch(() => false); return m; };
  let cached = await cachedMap(baseCap);
  let plan = chooseTierForSpace(startTier, { language, cap: baseCap, freeMB: await freeStorageMB(), isCached: (t) => cached[t] });
  if (plan.steps.length || !plan.fits) {
    // מנסים לפנות מקום ממודלים שאין בהם צורך (למשל של דרגה או שפה אחרת). המודלים של הדרגה המבוקשת ושל דרגת הגיבוי נשמרים תמיד
    try {
      const keep = new Set([...filesFor(startTier, language, baseCap), ...filesFor(plan.tier, language, baseCap)]);
      if (typeof caches !== 'undefined' && await new ChunkedCache().prune(keep)) {
        cached = await cachedMap(baseCap);
        const again = chooseTierForSpace(startTier, { language, cap: baseCap, freeMB: await freeStorageMB(), isCached: (t) => cached[t] });
        if (again.fits && TIER_ORDER.indexOf(again.tier) >= TIER_ORDER.indexOf(plan.tier)) plan = again;
      }
    } catch (e) { /* ניקוי המטמון נכשל: ממשיכים עם התכנית הקיימת */ }
  }
  if (!plan.fits) throw hebrewError('אין מספיק מקום פנוי בטלפון אפילו למודל התמלול הקטן (' + Math.round(plan.needMB) + 'MB). פנו מקום ונסו שוב.');
  if (plan.steps.length) {
    const first = plan.steps[0];
    const msg = 'אין מספיק מקום פנוי למודל של ' + Math.round(first.needMB) + 'MB, ולכן מתמללים במודל קטן יותר (' + Math.round(tierDownloadMB(plan.tier, language, baseCap)) + 'MB)';
    notes.push(msg);
    report(0.06, msg);
  }
  startTier = plan.tier;
  requestPersist();

  const mayRetry = baseCap.gpu && startTier !== 'high';   // רק אז צריך להחזיק את הקול לניסיון שני
  const attempt = async (cap, isLast) => {
    const tier = pickTier(cap, startTier, language);
    const cl = getClient();
    const cachedAlready = !!cached[tier];
    const onEvent = (m) => {
      if (m.stage === 'download') report(0.06 + m.fraction * 0.2, 'מוריד את מודל התמלול (פעם אחת)… ' + pct(m.fraction));
      else if (m.stage === 'load') report(0.06 + 0.2 * (m.fraction ?? 1), 'טוען את מודל התמלול…');
      else if (m.stage === 'detect') report(0.27, 'מזהה את שפת הדיבור…');
      else if (m.stage === 'transcribe') { clearLoading(); report(0.28 + m.fraction * 0.7, 'מתמלל · ' + pct(m.fraction)); }
    };
    markLoading(tier);
    const send = owned && isLast ? audio : audio.slice();
    const res = await cl.call('run', { audio: send, language, tier, cap: { gpu: cap.gpu, f16: cap.f16 }, cached: cachedAlready, blockHosts: opts._blockHosts }, { transfer: [send.buffer], onEvent, signal });
    return { res, tier };
  };

  let result;
  try {
    try {
      result = await attempt(baseCap, !mayRetry);
    } catch (e) {
      // כשל של WebGPU באמצע (למשל בדפדפן נייד): דרגות שאינן high מנסות שוב על WASM, פעם אחת
      if (!baseCap.gpu || startTier === 'high' || (e && e.name === 'AbortError') || (signal && signal.aborted)) throw e;
      if (client) client.terminate();
      report(0.06, 'מנסה שוב בדרך אחרת…');
      result = await attempt({ ...baseCap, gpu: false, f16: false }, true);
    }
  } catch (e) {
    clearLoading();
    if (client) client.terminate();
    throw explainError(e, 'run');
  }
  clearLoading();
  releaseIfIdle(keepLoaded);
  const transcript = result.res.transcript;
  if (transcript && result.res.meta) {
    Object.defineProperty(transcript, 'meta', { value: { ...result.res.meta, elapsedMs: Math.round(now() - t0), audioSeconds: duration, tier: result.tier, notes: [...notes, ...(result.res.meta.notes || [])] }, enumerable: false });
  }
  report(1, 'התמלול מוכן');
  return transcript;
}

/** זיהוי שפה מ־30 השניות הראשונות של הדיבור. מחזיר {language, confidence, top:[[code, prob]...]}. */
export function detectLanguageDetailed(audio16k, opts = {}) {
  return enqueue(() => detectNow(audio16k, opts));
}
async function detectNow(audio16k, { signal, keepLoaded = false } = {}) {
  if (!(audio16k instanceof Float32Array)) throw hebrewError('זיהוי שפה דורש קול של 16kHz במערך Float32Array');
  throwIfAborted(signal);
  const cap = await probeDevice();
  const cl = getClient();
  const copy = audio16k.slice(0, WINDOW_SEC * SAMPLE_RATE * 2);
  try {
    return await cl.call('detect', { audio: copy, cap: { gpu: cap.gpu, f16: cap.f16 } }, { transfer: [copy.buffer], signal });
  } catch (e) {
    if (client) client.terminate();
    throw explainError(e, 'detect');
  } finally { releaseIfIdle(keepLoaded); }
}
/** זיהוי שפה: מחזיר קוד שפה ('he', 'en', ...). */
export async function detectLanguage(audio16k, opts = {}) {
  return (await detectLanguageDetailed(audio16k, opts)).language;
}
