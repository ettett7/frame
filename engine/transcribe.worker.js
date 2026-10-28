/**
 * ה־worker של התמלול: טוען את המודלים (transformers.js מה־CDN), מזהה שפה, מתמלל בחלונות של 30 שניות עם חפיפה,
 * מיישר מילים (כשהמודל לא נותן זמנים בעצמו) ומחזיר Transcript. כל העבודה הכבדה כאן, כדי שהממשק לא ייתקע.
 * ההודעות: run, detect, abort. כל תשובה נושאת את ה־id של הבקשה: progress, done או error.
 */
import {
  TRANSFORMERS_URL, ChunkedCache, SAMPLE_RATE, WINDOW_SEC, OVERLAP_SEC,
  planWindows, mergeWindows, buildTranscript, energyEnvelope, speechThreshold, hasSpeech, distributeWords, voicedIntervals, pausesFromIntervals,
  alignmentJumps, wordTimesFromJumps, modelSpec, helperSpec, normalizeLanguage, cleanText, explainError, abortError,
} from './transcribe.js';

let T = null;                        // המודול של transformers.js
const loaded = new Map();            // מפתח מודל -> pipeline
const aborted = new Set();           // מזהי בקשות שבוטלו
let currentCrit = null;              // InterruptableStoppingCriteria של הפענוח הנוכחי

const post = (id, type, data = {}) => self.postMessage({ id, type, ...data });

async function ensureLib() {
  if (T) return T;
  T = await import(TRANSFORMERS_URL);
  const env = T.env;
  env.allowLocalModels = false;       // בלי חיפוש מודלים בשרת שלנו
  env.useBrowserCache = false;
  env.useCustomCache = true;          // מטמון שמחלק קבצים גדולים (Cache API של כרום דוחה ערך מ־256MB)
  env.customCache = new ChunkedCache();
  return T;
}

const keyOf = (spec) => `${spec.id}|${spec.device}|${typeof spec.dtype === 'string' ? spec.dtype : JSON.stringify(spec.dtype)}`;

/** טוען pipeline של זיהוי דיבור. התקדמות ההורדה (0..1) מדווחת דרך onFraction. */
async function loadModel(spec, onFraction, cached) {
  const key = keyOf(spec);
  if (loaded.has(key)) { onFraction(1); return loaded.get(key); }
  await ensureLib();
  let lastPost = 0;
  const cb = (e) => {
    if (e && e.status === 'progress_total' && e.total) {
      const now = Date.now();
      if (now - lastPost > 120) { lastPost = now; onFraction(Math.min(0.999, e.loaded / e.total)); }
    }
  };
  const create = (device, dtype) => T.pipeline('automatic-speech-recognition', spec.id, { device, dtype, progress_callback: cb });
  let asr;
  try {
    asr = await create(spec.device, spec.dtype);
  } catch (e) {
    // דרגות שאינן high נופלות ל־WASM כש־WebGPU נכשל (למשל באייפון). high לא ירוץ על WASM: איטי מדי ותופס יותר מדי זיכרון.
    if (spec.device === 'webgpu' && spec.tier !== 'high') {
      asr = await create('wasm', 'q8');
      spec = { ...spec, device: 'wasm', dtype: 'q8' };
    } else throw e;
  }
  onFraction(1);
  loaded.set(keyOf(spec), asr);
  asr._frameSpec = spec;
  return asr;
}

async function freeModel(spec) {
  const key = keyOf(spec);
  const asr = loaded.get(key);
  loaded.delete(key);
  try { if (asr && asr.dispose) await asr.dispose(); } catch (e) { /* ignore */ }
}

// ------------------------------------------------------------------ זיהוי שפה
async function detectWith(asr, audio, env10, thr) {
  let first = 0;
  for (let i = 0; i < env10.length; i++) if (env10[i] > thr) { first = i; break; }
  const a = Math.floor(Math.max(0, first * 0.01 - 0.5) * SAMPLE_RATE);
  const chunk = audio.subarray(a, Math.min(audio.length, a + WINDOW_SEC * SAMPLE_RATE));
  const feats = await asr.processor(chunk);
  const sot = asr.tokenizer.convert_tokens_to_ids(['<|startoftranscript|>'])[0];
  const dec = new T.Tensor('int64', BigInt64Array.from([BigInt(sot)]), [1, 1]);
  const out = await asr.model({ input_features: feats.input_features, decoder_input_ids: dec });
  const l2i = asr.model.generation_config.lang_to_id;
  const logits = out.logits.data;
  const scores = Object.entries(l2i).map(([tok, id]) => [tok.replace(/^<\||\|>$/g, ''), logits[id]]).sort((x, y) => y[1] - x[1]);
  const mx = scores[0][1];
  let Z = 0;
  for (const s of scores) Z += Math.exp(s[1] - mx);
  const top = scores.slice(0, 3).map((s) => [s[0], Math.round((Math.exp(s[1] - mx) / Z) * 1000) / 1000]);
  return { language: top[0][0], confidence: top[0][1], top };
}

async function detect(m) {
  await ensureLib();
  const hspec = helperSpec(m.cap);
  const helper = await loadModel(hspec, (f) => post(m.id, 'progress', { stage: 'download', fraction: f }), false);
  const audio = m.audio;
  const env10 = energyEnvelope(audio);
  return await detectWith(helper, audio, env10, speechThreshold(env10));
}

// ------------------------------------------------------------------ יישור מילים בעזרת מודל העזר
/** יישור מאולץ: מזינים למפענח את הטקסט המוכן ומשתמשים בתשומת הלב שלו לאודיו (DTW). הזמנים יחסיים לתחילת audioSlice. */
async function alignGroup(helper, audioSlice, texts, lang) {
  const tok = helper.tokenizer, model = helper.model;
  const ids = tok.convert_tokens_to_ids(['<|startoftranscript|>', `<|${lang}|>`, '<|transcribe|>', '<|notimestamps|>', '<|endoftext|>']);
  if (ids.some((x) => x === undefined || x === null)) throw new Error('שפה לא נתמכת ביישור');
  const [sot, lg, tr, nots, eot] = ids;
  const wordTokens = texts.map((w) => Array.from(tok.encode(' ' + w)).map(Number));
  const flat = wordTokens.flat();
  const seq = [sot, lg, tr, nots, ...flat, eot];
  const feats = await helper.processor(audioSlice);
  const dec = new T.Tensor('int64', BigInt64Array.from(seq.map(BigInt)), [1, seq.length]);
  const out = await model({ input_features: feats.input_features, decoder_input_ids: dec });
  const nFrames = Math.max(8, Math.min(1500, Math.floor(audioSlice.length / 320)));
  const rows = flat.length + 1;
  const heads = [];
  for (const [layer, head] of model.generation_config.alignment_heads) {
    const t = out[`cross_attentions.${layer}`];
    if (!t) throw new Error('למודל העזר אין פלט של תשומת לב');
    const tq = t.dims[2], tk = t.dims[3], d = t.data;
    const mat = new Float32Array(rows * nFrames);
    for (let r = 0; r < rows; r++) {
      const base = (head * tq + (3 + r)) * tk;
      for (let f = 0; f < nFrames; f++) mat[r * nFrames + f] = d[base + f];
    }
    heads.push(mat);
  }
  for (const k of Object.keys(out)) { try { out[k].dispose && out[k].dispose(); } catch (e) { /* ignore */ } }
  const jumps = alignmentJumps(heads, rows, nFrames);
  return wordTimesFromJumps(jumps, wordTokens.map((t) => t.length), texts);
}

const MAX_ALIGN_TOKENS = 420;
/** מחלק את ה־segments של חלון לקבוצות שנכנסות לתקרת הטוקנים של המפענח (448), ומיישר כל קבוצה על פיסת האודיו שלה. */
async function alignWindow(helper, chunk, segs, lang, winStart, env10, thr, notes) {
  const items = segs.map((s) => ({ s, texts: cleanText(s.text).split(/\s+/).filter(Boolean) })).filter((x) => x.texts.length);
  const groups = [];
  let cur = null, curTokens = 0;
  for (const it of items) {
    const tokens = it.texts.reduce((a, w) => a + Math.max(1, Math.ceil(w.length / 1.6)), 0);   // הערכה גסה, מספיק לקבוע גבולות
    if (!cur || curTokens + tokens > MAX_ALIGN_TOKENS || (it.s.end - cur.s0) > 28) { cur = { s0: it.s.start, s1: it.s.end, items: [] }; groups.push(cur); curTokens = 0; }
    cur.items.push(it); cur.s1 = it.s.end; curTokens += tokens;
  }
  const out = [];
  for (const g of groups) {
    const texts = g.items.flatMap((x) => x.texts);
    const a = Math.max(0, g.s0 - 0.5), b = Math.min(chunk.length / SAMPLE_RATE, g.s1 + 0.5);
    const slice = chunk.subarray(Math.floor(a * SAMPLE_RATE), Math.max(Math.floor(a * SAMPLE_RATE) + 1600, Math.floor(b * SAMPLE_RATE)));
    try {
      const w = await alignGroup(helper, slice, texts, lang);
      for (const x of w) out.push({ text: x.text, start: winStart + a + x.start, end: winStart + a + x.end });
    } catch (e) {
      notes.push('יישור נכשל, חולקו לפי משקל: ' + String((e && e.message) || e).slice(0, 80));
      for (const x of distributeWords(texts, winStart + g.s0, winStart + g.s1, { env: env10, thr, language: lang })) out.push(x);
    }
  }
  return out;
}

// ------------------------------------------------------------------ תמלול
/** לבדיקות בלבד: חוסם בקשות לאתרים מסוימים (מדמה חוסר אינטרנט). */
function blockHosts(hosts) {
  if (!hosts || !hosts.length || self.__frameBlocked) return;
  const real = self.fetch.bind(self);
  self.__frameBlocked = hosts;
  self.fetch = (u, i) => {
    const url = typeof u === 'string' ? u : (u && u.url) || String(u);
    if (hosts.some((h) => url.includes(h))) return Promise.reject(new TypeError('Failed to fetch'));
    return real(u, i);
  };
}

async function run(m) {
  const { id } = m;
  blockHosts(m.blockHosts);
  const audio = m.audio;
  const cap = m.cap;
  const duration = audio.length / SAMPLE_RATE;
  const env10 = energyEnvelope(audio);
  const thr = speechThreshold(env10);
  const notes = [];
  const checkAbort = () => { if (aborted.has(id)) { aborted.delete(id); throw abortError(); } };

  const hspec = helperSpec(cap);
  let lang = normalizeLanguage(m.language);
  const needsDetect = lang === 'auto';
  // בדרגות balanced ו־fast מודל הטקסט זהה לכל השפות, ולכן הוא מזהה את השפה בעצמו, בלי מודל עזר.
  // בדרגת high המודל תלוי בשפה (ivrit לעברית), ולכן הזיהוי נעשה קודם במודל העזר הקטן.
  const detectWithHelper = needsDetect && m.tier === 'high';
  const guessSpec = modelSpec(m.tier, needsDetect ? 'he' : lang, cap);
  const needsHelperUpfront = detectWithHelper || guessSpec.timing === 'align';
  const totalMB = guessSpec.sizeMB + (needsHelperUpfront && guessSpec.id !== hspec.id ? hspec.sizeMB : 0);
  let doneMB = 0;
  const stageFor = (mb) => (f) => post(id, 'progress', { stage: m.cached ? 'load' : 'download', fraction: totalMB ? Math.min(1, (doneMB + mb * f) / totalMB) : 1 });

  let helper = null;
  let asr = null;
  let spec = guessSpec;
  let detection = null;
  if (needsDetect && !detectWithHelper) {
    asr = await loadModel(guessSpec, stageFor(guessSpec.sizeMB), m.cached);
    doneMB = totalMB;
    checkAbort();
    post(id, 'progress', { stage: 'detect', fraction: 0 });
    detection = await detectWith(asr, audio, env10, thr);
    lang = detection.language;
    checkAbort();
  } else {
    if (needsHelperUpfront) {
      helper = await loadModel(hspec, stageFor(hspec.sizeMB), m.cached);
      doneMB += hspec.sizeMB;
      checkAbort();
    }
    if (detectWithHelper) {
      post(id, 'progress', { stage: 'detect', fraction: 0 });
      detection = await detectWith(helper, audio, env10, thr);
      lang = detection.language;
      checkAbort();
    }
    spec = modelSpec(m.tier, lang, cap);
    if (spec.id === hspec.id && spec.device === hspec.device && JSON.stringify(spec.dtype) === JSON.stringify(hspec.dtype) && helper) asr = helper;
    else {
      // מודל העזר שימש רק לזיהוי השפה: משחררים אותו לפני טעינת מודל הטקסט, כדי להוריד את שיא הזיכרון
      if (helper && spec.timing !== 'align') { await freeModel(hspec); helper = null; }
      asr = await loadModel(spec, stageFor(spec.sizeMB), m.cached);
    }
    doneMB = totalMB;
  }
  const usedSpec = asr._frameSpec || spec;
  if (spec.timing === 'align' && !helper) helper = await loadModel(hspec, () => {}, m.cached);
  post(id, 'progress', { stage: m.cached ? 'load' : 'download', fraction: 1 });
  checkAbort();

  const windows = planWindows(duration, { windowSec: WINDOW_SEC, overlapSec: OVERLAP_SEC });
  const parts = [];
  for (let i = 0; i < windows.length; i++) {
    checkAbort();
    const w = windows[i];
    post(id, 'progress', { stage: 'transcribe', fraction: i / windows.length });
    if (!hasSpeech(env10, w.start, w.end, thr)) { parts.push({ start: w.start, end: w.end, words: [] }); continue; }
    const chunk = audio.subarray(Math.floor(w.start * SAMPLE_RATE), Math.min(audio.length, Math.ceil(w.end * SAMPLE_RATE)));
    const crit = new T.InterruptableStoppingCriteria();
    currentCrit = crit;
    const opts = { language: lang, task: 'transcribe', max_new_tokens: 400, stopping_criteria: crit };
    let words = [];
    try {
      if (spec.timing === 'native') {
        const out = await asr(chunk, { ...opts, return_timestamps: 'word' });
        words = (out.chunks || []).map((c) => ({ text: c.text, start: w.start + c.timestamp[0], end: c.timestamp[1] == null ? NaN : w.start + c.timestamp[1] }));
      } else {
        const out = await asr(chunk, { ...opts, return_timestamps: true });
        const segs = (out.chunks || []).map((c) => ({ text: c.text, start: c.timestamp[0] ?? 0, end: c.timestamp[1] ?? (chunk.length / SAMPLE_RATE) }));
        checkAbort();
        words = await alignWindow(helper, chunk, segs, lang, w.start, env10, thr, notes);
      }
    } finally { currentCrit = null; }
    checkAbort();
    parts.push({ start: w.start, end: w.end, words });
  }
  post(id, 'progress', { stage: 'transcribe', fraction: 1 });
  const merged = mergeWindows(parts, { pauses: pausesFromIntervals(voicedIntervals(env10, thr)) });
  const transcript = buildTranscript(merged, { language: lang, env: env10, thr, duration });
  return {
    transcript,
    meta: { model: usedSpec.id, device: usedSpec.device, dtype: usedSpec.dtype, timing: spec.timing, windows: windows.length, detected: detection, notes: notes.slice(0, 5), thresholdDb: Math.round(thr * 10) / 10 },
  };
}

self.onmessage = async (ev) => {
  const m = ev.data || {};
  if (m.type === 'abort') {
    aborted.add(m.target);
    if (currentCrit) { try { currentCrit.interrupt(); } catch (e) { /* ignore */ } }
    return;
  }
  try {
    let result;
    if (m.type === 'run') result = await run(m);
    else if (m.type === 'detect') result = await detect(m);
    else throw new Error('פקודה לא מוכרת');
    post(m.id, 'done', { result });
  } catch (e) {
    const err = explainError(e, 'load');
    post(m.id, 'error', { message: err.message, aborted: err.name === 'AbortError', raw: String((e && e.message) || e).slice(0, 300) });
  } finally { aborted.delete(m.id); }
};
