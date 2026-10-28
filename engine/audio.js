// FRAME לטלפון: אודיו. פענוח, ניתוח, בניית רצועת הקול של הקליפ (חיתוך והדבקה, שרשרת קול, מוזיקה, עוצמה) ושינוי קצב דגימה לתמלול.
// ES module בלי תלויות. הפונקציות הטהורות (ניתוח, עוצמה, חיתוך והדבקה, ducking, שינוי קצב) רצות גם ב־node; רק פענוח ורינדור צריכים דפדפן.
// כל הזמנים בשניות. "מקור" = זמן בסרטון המקורי, "פלט" = זמן בקליפ הערוך (plan.segments במקור, plan.duration בפלט).

export const SAMPLE_RATE = 48000;
export const TARGET_LUFS = -14;       // עוצמת היעד של הקליפ
export const CEILING_DB = -1.5;       // תקרת true peak
export const BED_DB = -6.5;           // מוזיקת הרקע מתחת ליעד, כשאין דיבור
export const DUCK_DB = -9;            // כמה יורדת המוזיקה בזמן דיבור
export const MUSIC_IDS = ['lofi', 'drive', 'playful', 'epic', 'ambient'];
export const SFX_DB = { whoosh: -4, pop: -3, riser: -5, ding: -4, boom: -3, tada: -5, swish: -5, hit: -4 };
export const MAX_DECODE_BYTES = 600e6;  // מעל זה אין טעם לנסות לטעון את הקובץ כולו לזיכרון בטלפון

// ------------------------------------------------------------------ כלים
const hebrew = (message) => new Error(message);
const dB = (x) => 20 * Math.log10(Math.max(x, 1e-12));
const lin = (db) => Math.pow(10, db / 20);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function checkAbort(signal) {
  if (signal && signal.aborted) {
    const e = hebrew('העבודה בוטלה');
    e.name = 'AbortError';
    throw e;
  }
}

function report(cb, fraction, text) {
  if (typeof cb === 'function') cb(clamp(fraction, 0, 1), text);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** ערוצים של AudioBuffer (או אובייקט דומה לו) כמערך של Float32Array. */
export function channelsOf(buffer) {
  const out = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c));
  return out;
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100))];
}

function contextClass() {
  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  return g.OfflineAudioContext || g.webkitOfflineAudioContext || null;
}

function makeBuffer(channels, sampleRate) {
  const length = channels[0].length;
  const g = globalThis;
  let buf;
  if (typeof g.AudioBuffer === 'function') {
    try { buf = new g.AudioBuffer({ numberOfChannels: channels.length, length, sampleRate }); } catch (e) { buf = null; }
  }
  if (!buf) {
    const Ctx = contextClass();
    if (!Ctx) throw hebrew('הדפדפן הזה אינו תומך בעיבוד קול');
    buf = new Ctx(channels.length, 1, sampleRate).createBuffer(channels.length, length, sampleRate);
  }
  for (let c = 0; c < channels.length; c++) {
    if (buf.copyToChannel) buf.copyToChannel(channels[c], c, 0);
    else buf.getChannelData(c).set(channels[c]);
  }
  return buf;
}

// ------------------------------------------------------------------ מסננים (biquad)
/** מקדמי RBJ למסנן high-pass או low-pass מסדר שני. */
export function biquadCoeffs(type, fs, f0, Q = Math.SQRT1_2) {
  const w = 2 * Math.PI * f0 / fs;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * Q);
  const a0 = 1 + alpha;
  let b0, b1, b2;
  if (type === 'highpass') { b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = b0; }
  else if (type === 'lowpass') { b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = b0; }
  else throw hebrew('סוג מסנן לא מוכר');
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: -2 * cos / a0, a2: (1 - alpha) / a0 };
}

/** מקדמי K-weighting של BS.1770 לכל קצב דגימה: מדף גבוה ואחריו high-pass (RLB). ב־48kHz הם הערכים שבתקן. */
export function kWeightCoeffs(fs) {
  const f1 = 1681.974450955533, G = 3.999843853973347, Q1 = 0.7071752369554196;
  let K = Math.tan(Math.PI * f1 / fs);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q1 + K * K;
  const shelf = { b0: (Vh + Vb * K / Q1 + K * K) / a0, b1: 2 * (K * K - Vh) / a0, b2: (Vh - Vb * K / Q1 + K * K) / a0, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q1 + K * K) / a0 };
  const f2 = 38.13547087602444, Q2 = 0.5003270373238773;
  K = Math.tan(Math.PI * f2 / fs);
  a0 = 1 + K / Q2 + K * K;
  const rlb = { b0: 1, b1: -2, b2: 1, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q2 + K * K) / a0 };
  return [shelf, rlb];
}

/** מסנן biquad עם מצב (צורה ישירה II מוסבת). הפונקציה מחזירה פונקציה שמעבדת דגימה אחת. */
function makeBiquad(c) {
  let z1 = 0, z2 = 0;
  return (x) => {
    const y = c.b0 * x + z1;
    z1 = c.b1 * x - c.a1 * y + z2;
    z2 = c.b2 * x - c.a2 * y;
    return y;
  };
}

// ------------------------------------------------------------------ ניתוח: envelope, קטעים רועשים, RMS
/**
 * מצבר של envelope: 100 ערכים בשנייה, כל ערך הוא RMS של 20 ms (חלון כפול מהקפיצה) ב־dBFS. אפשר להזין אותו בנתחים (למי שרוצה לוותר על חסימת הממשק).
 * voiceBand: מסנן high-pass ב־100Hz ו־low-pass ב־3400Hz לפני המדידה, כמו ניתוח הקצב ב־FRAME במק: רעש נמוך וסיבילנטים לא מזיזים את הסף.
 */
class EnvelopeAccumulator {
  constructor(sr, { voiceBand = true } = {}) {
    this.sr = sr;
    this.hp = voiceBand ? makeBiquad(biquadCoeffs('highpass', sr, 100)) : null;
    this.lp = voiceBand ? makeBiquad(biquadCoeffs('lowpass', sr, 3400)) : null;
    this.sums = [];        // סכום ריבועים בכל קפיצה של 10 ms
    this.counts = [];
    this.n = 0;            // כמה דגימות עובדו
    this.hop = 0;
    this.acc = 0;
    this.next = Math.round(sr / 100);
    this.sq = 0;           // סכום ריבועים כללי (ל־RMS), על האות לפני המסננים
    this.peak = 0;
  }

  push(channels, from, to) {
    const nCh = channels.length;
    const inv = 1 / nCh;
    const { hp, lp, sr } = this;
    let { acc, next, hop } = this;
    for (let i = from; i < to; i++) {
      let x = channels[0][i];
      for (let c = 1; c < nCh; c++) x += channels[c][i];
      x *= inv;
      const ax = x < 0 ? -x : x;
      if (ax > this.peak) this.peak = ax;
      this.sq += x * x;
      if (hp) x = lp(hp(x));
      acc += x * x;
      this.n++;
      if (this.n === next) {
        this.sums.push(acc);
        this.counts.push(next - Math.round(hop * sr / 100));
        acc = 0;
        hop++;
        next = Math.round((hop + 1) * sr / 100);
      }
    }
    this.acc = acc; this.next = next; this.hop = hop;
  }

  finish() {
    const { sums, counts } = this;
    const len = Math.max(0, sums.length - 1);
    const envelope = new Float32Array(len);
    for (let i = 0; i < len; i++) envelope[i] = 10 * Math.log10(Math.max((sums[i] + sums[i + 1]) / (counts[i] + counts[i + 1]), 1e-10));
    return { envelope, rms: this.n ? 10 * Math.log10(Math.max(this.sq / this.n, 1e-12)) : -120, peak: dB(this.peak) };
  }
}

/** [{envelope: Float32Array, rms, peak}] מכל הערוצים, בבת אחת. */
export function envelopeOf(channels, sr, opts = {}) {
  const acc = new EnvelopeAccumulator(sr, opts);
  acc.push(channels, 0, channels[0].length);
  return acc.finish();
}

/**
 * קטעים רועשים (בדרך כלל דיבור) לפי היסטרזיס: הרצפה היא אחוזון 10 של ה־envelope והדיבור אחוזון 90. קטע מתחיל כשהרמה עוברת רצפה + רבע מהמרחק, ונחשב רק אם
 * הגיע לרצפה + חצי מהמרחק. הפרשים של פחות מ־0.12 שניות מתמזגים וקטעים קצרים מ־0.1 שניות נזרקים. כשהמרחק בין הרצפה לדיבור קטן מ־10dB (רעש רצוף או מוזיקה) אין קטעים.
 */
export function loudSegments(envelope, hop = 0.01) {
  const n = envelope.length;
  if (n < 20) return { segments: [], floor: -120, speech: -120, contrast: 0 };
  const sorted = Float32Array.from(envelope).sort();
  const floor = percentile(sorted, 10), speech = percentile(sorted, 90);
  const contrast = speech - floor;
  if (contrast < 10) return { segments: [], floor, speech, contrast };
  const lo = floor + 0.25 * contrast, hi = floor + 0.5 * contrast;
  const runs = [];
  for (let i = 0; i < n;) {
    if (envelope[i] >= lo) {
      let j = i, top = -Infinity;
      while (j < n && envelope[j] >= lo) { if (envelope[j] > top) top = envelope[j]; j++; }
      if (top >= hi) runs.push([i, j - 1]);
      i = j;
    } else i++;
  }
  const merged = [];
  const gap = Math.round(0.12 / hop);
  for (const r of runs) {
    if (merged.length && r[0] - merged[merged.length - 1][1] <= gap) merged[merged.length - 1][1] = r[1];
    else merged.push(r.slice());
  }
  const segments = [];
  for (const [a, b] of merged) {
    if ((b - a + 2) * hop < 0.1) continue;
    let sum = 0;
    for (let k = a; k <= b; k++) sum += envelope[k];
    segments.push({ start: +(a * hop).toFixed(3), end: +((b + 2) * hop).toFixed(3), db: +(sum / (b - a + 1)).toFixed(1) });
  }
  return { segments, floor, speech, contrast };
}

function infoFrom(buffer, env, extra) {
  const { segments, floor, speech, contrast } = loudSegments(env.envelope);
  return {
    sampleRate: buffer.sampleRate, duration: buffer.length / buffer.sampleRate, envelope: env.envelope, loud: segments,
    rms: +env.rms.toFixed(1), peak: +env.peak.toFixed(1), floor: +floor.toFixed(1), speech: +speech.toFixed(1), contrast: +contrast.toFixed(1), ...extra,
  };
}

/** AudioInfo: {sampleRate, duration, envelope (100 לשנייה, dBFS), loud: [{start,end,db}], rms, peak, floor, speech, contrast}. סינכרוני ומהיר: עשר דקות בסטריאו ב־48kHz לוקחות בערך שנייה. */
export function analyzeAudio(buffer, opts = {}) {
  if (!buffer || !buffer.length) throw hebrew('אין קול לניתוח');
  return infoFrom(buffer, envelopeOf(channelsOf(buffer), buffer.sampleRate, opts), {});
}

/** אותו ניתוח, בנתחים של כמה שניות שמחזירים שליטה לדפדפן ביניהם, עם התקדמות וביטול. */
export async function analyzeAudioAsync(buffer, { onProgress, signal, voiceBand = true } = {}) {
  if (!buffer || !buffer.length) throw hebrew('אין קול לניתוח');
  const ch = channelsOf(buffer);
  const acc = new EnvelopeAccumulator(buffer.sampleRate, { voiceBand });
  const step = Math.round(buffer.sampleRate * 8);
  for (let i = 0; i < buffer.length; i += step) {
    checkAbort(signal);
    acc.push(ch, i, Math.min(buffer.length, i + step));
    report(onProgress, i / buffer.length, 'מנתחים את הקול');
    await tick();
  }
  report(onProgress, 1, 'מנתחים את הקול');
  return infoFrom(buffer, acc.finish(), {});
}

// ------------------------------------------------------------------ עוצמה: LUFS, true peak, limiter
/**
 * עוצמה משולבת (LUFS) לפי BS.1770: K-weighting, בלוקים של 400ms בקפיצות של 100ms, שער מוחלט ב־‎-70 ושער יחסי ב־‎-10. ערוצים שווי משקל (סטריאו או מונו).
 * מחזיר ‎-Infinity כשאין מה למדוד.
 */
export function integratedLoudness(channels, sr) {
  const hopN = Math.round(sr * 0.1);
  const total = channels[0].length;
  const nHops = Math.floor(total / hopN);
  const energy = new Float64Array(Math.max(nHops, 1));
  const lastLen = nHops ? 0 : total;
  for (const x of channels) {
    const [shelf, rlb] = kWeightCoeffs(sr);
    const f1 = makeBiquad(shelf), f2 = makeBiquad(rlb);
    for (let h = 0; h < energy.length; h++) {
      const from = h * hopN, to = nHops ? from + hopN : total;
      let s = 0;
      for (let i = from; i < to; i++) { const y = f2(f1(x[i])); s += y * y; }
      energy[h] += s;
    }
  }
  const blocks = [];
  if (nHops >= 4) {
    for (let j = 0; j + 4 <= nHops; j++) blocks.push((energy[j] + energy[j + 1] + energy[j + 2] + energy[j + 3]) / (4 * hopN));
  } else if (total > 0) {
    blocks.push(energy.reduce((a, b) => a + b, 0) / (nHops ? nHops * hopN : lastLen));
  }
  const loud = (p) => -0.691 + 10 * Math.log10(p);
  const above = blocks.filter((p) => p > 0 && loud(p) > -70);
  if (!above.length) return -Infinity;
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const rel = loud(mean(above)) - 10;
  const kept = above.filter((p) => loud(p) > rel);
  return kept.length ? loud(mean(kept)) : -Infinity;
}

// גרעיני אינטרפולציה ל־true peak: sinc עם חלון Hann, 16 נקודות (8 מכל צד), בשלוש נקודות ביניים בין כל שתי דגימות
const TP_KERNELS = [0.25, 0.5, 0.75].map((frac) => {
  const h = new Float64Array(16);
  let sum = 0;
  for (let k = 0; k < 16; k++) {
    const d = k - 7 - frac;                       // מרחק מהנקודה, הדגימות i-7..i+8
    const sinc = Math.sin(Math.PI * d) / (Math.PI * d);
    h[k] = sinc * 0.5 * (1 + Math.cos(Math.PI * d / 8));
    sum += h[k];
  }
  for (let k = 0; k < 16; k++) h[k] /= sum;
  return h;
});

/** true peak ב־dBTP בקירוב: האות מוגדל פי 4 באינטרפולציית sinc, ונבדקות רק הדגימות שליד שיא (חוסך זמן). */
export function truePeakDb(channels) {
  let peak = 0;
  for (const x of channels) for (let i = 0; i < x.length; i++) { const a = x[i] < 0 ? -x[i] : x[i]; if (a > peak) peak = a; }
  const sample = peak;
  for (const x of channels) {
    const n = x.length;
    for (let i = 7; i < n - 8; i++) {
      const a = x[i] < 0 ? -x[i] : x[i];
      if (a < 0.6 * sample) continue;
      for (const h of TP_KERNELS) {
        let v = 0;
        for (let k = 0; k < 16; k++) v += x[i - 7 + k] * h[k];
        if (v < 0) v = -v;
        if (v > peak) peak = v;
      }
    }
  }
  return dB(peak);
}

/**
 * limiter עם הצצה קדימה, במקום. הרווח הנדרש בכל דגימה מחושב מהשיא בין הערוצים, ממוזער בחלון ההצצה (3ms) ומוחלק בממוצע באותו אורך, ולכן הוא אף פעם לא גבוה
 * מהנדרש ואין חריגה מהתקרה. אחר כך החזרה לרווח מלא איטית (release). מחזיר את ההפחתה המרבית ב־dB.
 */
export function limitPeaks(channels, sr, { ceilingDb = CEILING_DB, lookaheadMs = 3, releaseMs = 80 } = {}) {
  const n = channels[0].length;
  const ceil = lin(ceilingDb);
  const la = Math.max(1, Math.round(sr * lookaheadMs / 1000));
  const g = new Float32Array(n);
  let needs = false;
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (const x of channels) { const a = x[i] < 0 ? -x[i] : x[i]; if (a > p) p = a; }
    if (p > ceil) { g[i] = ceil / p; needs = true; } else g[i] = 1;
  }
  if (!needs) return 0;
  const m = new Float32Array(n);
  const q = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = n - 1; i >= 0; i--) {         // המינימום בחלון [i, i+la]
    while (tail > head && g[q[tail - 1]] >= g[i]) tail--;
    q[tail++] = i;
    while (q[head] > i + la) head++;
    m[i] = g[q[head]];
  }
  const gain = new Float32Array(n);
  const rel = 1 - Math.exp(-1 / (releaseMs / 1000 * sr));
  let run = m[0] * la;                                  // הממוצע על [i-la, i]; מה שלפני 0 שווה ל־m[0]
  let prev = 1, minGain = 1;
  for (let i = 0; i < n; i++) {
    run += m[i];
    const avg = run / (la + 1);
    run -= i - la >= 0 ? m[i - la] : m[0];
    const v = avg < prev ? avg : prev + (avg - prev) * rel;   // ירידה מיידית, עלייה איטית
    gain[i] = v;
    prev = v;
    if (v < minGain) minGain = v;
  }
  for (const x of channels) for (let i = 0; i < n; i++) x[i] *= gain[i];
  return -dB(minGain);
}

// ------------------------------------------------------------------ מיפוי plan, חיתוך והדבקה
/**
 * פריסת ה־plan על ציר הפלט, במדגמים: לכל מקטע {src0, src1, out0, len}. המיקום ואורך כל מקטע מעוגלים מצטבר (כמו ב־pacing.filter_graph), ולכן אין סחף
 * וסכום האורכים הוא בדיוק round(duration * sr). מקטע שחורג מהמקור נשאר באורכו ומה שחסר בו הוא שקט. מקטע ריק נזרק.
 */
export function planLayout(plan, sr) {
  if (!plan || !Array.isArray(plan.segments)) throw hebrew('תוכנית העריכה חסרה');
  const out = [];
  let cum = 0;
  for (const seg of plan.segments) {
    const s0 = Number(seg[0]), s1 = Number(seg[1]);
    if (!(s1 > s0) || !Number.isFinite(s0) || !Number.isFinite(s1)) continue;
    const out0 = Math.round(cum * sr);
    cum += s1 - s0;
    const out1 = Math.round(cum * sr);
    if (out1 > out0) out.push({ src0: Math.round(s0 * sr), src1: Math.round(s1 * sr), out0, len: out1 - out0 });
  }
  return out;
}

/** זמן הפלט של שנייה במקור, או null כשהיא נחתכה. אותה הגדרה כמו mapTime ב־pacing. */
export function sourceToOut(plan, t) {
  let o = 0;
  for (const [s0, s1] of plan.segments) {
    if (t >= s0 - 1e-6 && t <= s1 + 1e-6) return o + Math.min(Math.max(t, s0), s1) - s0;
    o += s1 - s0;
  }
  return null;
}

/** שנייה במקור של זמן בפלט (המקטע שמכיל אותו), או null מחוץ לקליפ. */
export function outToSource(plan, t) {
  let o = 0;
  for (const [s0, s1] of plan.segments) {
    if (t >= o - 1e-9 && t < o + (s1 - s0)) return s0 + (t - o);
    o += s1 - s0;
  }
  return null;
}

/**
 * חיתוך והדבקה של הערוצים לפי ה־plan, באורך round(plan.duration * sr) בדיוק. בכל חיבור בין מקטעים שאינם רצופים במקור יש crossfade בהספק שווה של fadeMs מילישניות,
 * שמשתמש בקול שמסביב לחיתוך (סוף המקטע הקודם וההתחלה של הבא, בתוך החלק שנחתך), כך שהאורך לא משתנה ואין קליק. מקטעים רצופים במקור מועתקים כמות שהם.
 */
export function assembleVoice(channels, sr, plan, { fadeMs = 6 } = {}) {
  const layout = planLayout(plan, sr);
  const total = Math.round(plan.duration * sr);
  const srcLen = channels[0].length;
  const out = channels.map(() => new Float32Array(total));
  const read = (x, i) => (i >= 0 && i < srcLen ? x[i] : 0);
  for (const seg of layout) {
    for (let c = 0; c < channels.length; c++) {
      const x = channels[c], y = out[c];
      const end = Math.min(seg.len, total - seg.out0);
      for (let k = 0; k < end; k++) y[seg.out0 + k] = read(x, seg.src0 + k);
    }
  }
  const half = Math.max(1, Math.round(sr * fadeMs / 2000));
  for (let s = 1; s < layout.length; s++) {
    const a = layout[s - 1], b = layout[s];
    if (Math.abs((a.src0 + a.len) - b.src0) <= 1) continue;           // רצוף במקור: אין מה להחליק
    const h = Math.min(half, a.len >> 1, b.len >> 1);
    const J = b.out0;
    for (let k = -h; k < h; k++) {
      const n = J + k;
      if (n < 0 || n >= total) continue;
      const g = (k + h + 0.5) / (2 * h);
      const wa = Math.cos(g * Math.PI / 2), wb = Math.sin(g * Math.PI / 2);
      for (let c = 0; c < channels.length; c++) {
        out[c][n] = wa * read(channels[c], a.src0 + (n - a.out0)) + wb * read(channels[c], b.src0 + (n - J));
      }
    }
  }
  return out;
}

/** מחליש פתיחה וסיום של הקליפ (כמו ב־FRAME במק: 40ms ו־80ms), במקום. */
export function fadeEnds(channels, sr, inSeconds = 0.04, outSeconds = 0.08) {
  const n = channels[0].length;
  const fi = Math.min(Math.round(inSeconds * sr), n >> 2), fo = Math.min(Math.round(outSeconds * sr), n >> 2);
  for (const x of channels) {
    for (let i = 0; i < fi; i++) x[i] *= i / fi;
    for (let i = 0; i < fo; i++) x[n - 1 - i] *= i / fo;
  }
}

// ------------------------------------------------------------------ ducking
/**
 * עקומת ducking למוזיקה לפי המילים (זמני פלט): {rate: 100, gains: Float32Array} עם רווח ליניארי לכל 10ms. מילים שמרווח של פחות מ־mergeGap ביניהן הן קטע אחד. בכל קטע
 * הרווח יורד ל־depthDb בתוך attack שניות לפני תחילת הדיבור, נשאר שם עד hold שניות אחרי סופו, וחוזר ל־1 במשך release. בין קטעים קרובים לוקחים את הנמוך מהשניים.
 */
export function duckCurve(words, duration, { depthDb = DUCK_DB, attack = 0.12, release = 0.45, hold = 0.15, mergeGap = 0.3, pad = 0.04 } = {}) {
  const rate = 100;
  const n = Math.max(1, Math.ceil(duration * rate) + 1);
  const gains = new Float32Array(n).fill(1);
  const spans = [];
  for (const w of words || []) {
    const s = Number(w && w.start), e = Number(w && w.end);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s || e <= 0 || s >= duration) continue;
    spans.push([s, e]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const sp of spans) {
    if (merged.length && sp[0] - merged[merged.length - 1][1] < mergeGap) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], sp[1]);
    else merged.push(sp.slice());
  }
  const depth = lin(depthDb);
  for (const [s, e] of merged) {
    const t0 = s - pad - attack, t1 = s - pad, t2 = e + hold, t3 = e + hold + release;
    const from = Math.max(0, Math.floor(t0 * rate)), to = Math.min(n - 1, Math.ceil(t3 * rate));
    for (let i = from; i <= to; i++) {
      const t = i / rate;
      let v;
      if (t <= t0) v = 1;
      else if (t < t1) v = 1 - (1 - depth) * (t - t0) / (t1 - t0);
      else if (t <= t2) v = depth;
      else if (t < t3) v = depth + (1 - depth) * (t - t2) / (t3 - t2);
      else v = 1;
      if (v < gains[i]) gains[i] = v;
    }
  }
  return { rate, gains };
}

/** ערך העקומה בזמן t (אינטרפולציה ליניארית). */
export function duckAt(curve, t) {
  const p = Math.max(0, t) * curve.rate;
  const i = Math.floor(p);
  if (i >= curve.gains.length - 1) return curve.gains[curve.gains.length - 1];
  const f = p - i;
  return curve.gains[i] * (1 - f) + curve.gains[i + 1] * f;
}

// ------------------------------------------------------------------ מוזיקה ואפקטים
/**
 * מוזיקת רקע באורך outLen מדגמים, בסטריאו: לולאה על חלון [loopStart, loopStart + loopLen) (הרצועות של FRAME מחזוריות ולכן אין תפר), הגברה, ducking, ופתיחה וסיום הדרגתיים.
 */
export function renderMusic({ channels, loopStart = 0, loopLen = 0, outLen, sr, gainDb = 0, duck = null, fadeIn = 1.0, fadeOut = 1.5 }) {
  const srcLen = channels[0].length;
  const start = clamp(Math.round(loopStart), 0, srcLen - 1);
  const len = loopLen > 0 ? Math.min(Math.round(loopLen), srcLen - start) : srcLen - start;
  if (len < 1) throw hebrew('רצועת המוזיקה ריקה');
  const out = [new Float32Array(outLen), new Float32Array(outLen)];
  const L = channels[0], R = channels[1] || channels[0];
  const g = lin(gainDb);
  const fi = Math.round(fadeIn * sr), fo = Math.round(fadeOut * sr);
  let idx = 0;
  for (let n = 0; n < outLen; n++) {
    let v = g;
    if (duck) v *= duckAt(duck, n / sr);
    if (n < fi) v *= n / fi;
    const left = outLen - 1 - n;
    if (left < fo) v *= left / fo;
    out[0][n] = L[start + idx] * v;
    out[1][n] = R[start + idx] * v;
    if (++idx === len) idx = 0;
  }
  return out;
}

/** מערבב אפקטים (סטריאו) אל out: כל אפקט נוחת עם השיא שלו בזמן at. events: [{kind, at}], sounds: kind -> {channels, peakAt, gainDb?}. */
export function mixSfx(out, sounds, events, sr) {
  const total = out[0].length;
  for (const ev of events || []) {
    const s = sounds[ev.kind];
    if (!s || !Number.isFinite(ev.at)) continue;
    // The effect plan may ask for a softer hit on a single event (fx.js effectsAudio: gainDb).
    const g = lin((s.gainDb !== undefined ? s.gainDb : (SFX_DB[ev.kind] ?? -4)) + (Number.isFinite(ev.gainDb) ? ev.gainDb : 0));
    const start = Math.round((ev.at - (s.peakAt || 0)) * sr);
    const L = s.channels[0], R = s.channels[1] || s.channels[0];
    for (let k = 0; k < L.length; k++) {
      const n = start + k;
      if (n < 0) continue;
      if (n >= total) break;
      out[0][n] += L[k] * g;
      out[1][n] += R[k] * g;
    }
  }
}

// ------------------------------------------------------------------ שינוי קצב דגימה
function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }

/** שינוי קצב דגימה של ערוץ אחד במסנן sinc עם חלון Hann (8 מעברי אפס מכל צד), בפאזות מחושבות מראש. מסנן anti-alias מובנה כשמורידים קצב. */
export function resampleMono(x, from, to) {
  if (from === to) return Float32Array.from(x);
  const outLen = Math.round(x.length * to / from);
  const out = new Float32Array(outLen);
  const g = gcd(Math.round(from), Math.round(to));
  const M = Math.round(from) / g, L = Math.round(to) / g;   // כל L דגימות פלט נגזרות מ־M דגימות קלט
  const scale = Math.min(1, to / from) * 0.92;
  const W = 8;
  const T = Math.ceil(W / scale);
  const phases = [];
  for (let r = 0; r < L; r++) {
    const pos = r * M / L, base = Math.floor(pos), frac = pos - base;
    const h = new Float32Array(2 * T);
    let sum = 0;
    for (let k = -T + 1; k <= T; k++) {
      const d = k - frac;
      const arg = scale * d;
      const sinc = Math.abs(arg) < 1e-9 ? 1 : Math.sin(Math.PI * arg) / (Math.PI * arg);
      const win = Math.abs(d) < T ? 0.5 * (1 + Math.cos(Math.PI * d / T)) : 0;
      h[k + T - 1] = scale * sinc * win;
      sum += h[k + T - 1];
    }
    for (let k = 0; k < h.length; k++) h[k] /= sum;          // רווח DC של 1
    phases.push({ base, h });
  }
  const n = x.length;
  for (let j = 0; j < outLen; j++) {
    const q = Math.floor(j / L), r = j - q * L;
    const { base, h } = phases[r];
    const i0 = q * M + base - T + 1;
    let s = 0;
    if (i0 >= 0 && i0 + 2 * T <= n) {
      for (let k = 0; k < 2 * T; k++) s += x[i0 + k] * h[k];
    } else {
      for (let k = 0; k < 2 * T; k++) { const i = i0 + k; if (i >= 0 && i < n) s += x[i] * h[k]; }
    }
    out[j] = s;
  }
  return out;
}

/** מונו ב־16kHz לתמלול (Float32Array בטווח ‎-1..1). start ו־end (שניות) מגבילים לטווח, כדי לא לשנות קצב דגימה לכל הסרטון. */
export function to16kMono(buffer, { start = 0, end = null } = {}) {
  if (!buffer || !buffer.length) throw hebrew('אין קול להמרה');
  const sr = buffer.sampleRate;
  const a = clamp(Math.round(start * sr), 0, buffer.length);
  const b = end === null || end === undefined ? buffer.length : clamp(Math.round(end * sr), a, buffer.length);
  const ch = channelsOf(buffer);
  const mono = new Float32Array(b - a);
  const inv = 1 / ch.length;
  for (let i = 0; i < mono.length; i++) {
    let s = 0;
    for (let c = 0; c < ch.length; c++) s += ch[c][a + i];
    mono[i] = s * inv;
  }
  return sr === 16000 ? mono : resampleMono(mono, sr, 16000);
}

// ------------------------------------------------------------------ פענוח
async function decodeWith(ctx, bytes) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = ctx.decodeAudioData(bytes, resolve, reject); } catch (e) { reject(e); return; }
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  });
}

/**
 * מפענח קול מקובץ (וידאו או שמע) ל־AudioBuffer בקצב sampleRate (ברירת מחדל 48kHz; לתמלול מספיק 16000, וזה חוסך שני שלישים מהזיכרון). start ו־end חותכים את הטווח
 * אחרי הפענוח ומשחררים את השאר. מגבלה: decodeAudioData חייב את הקובץ כולו בזיכרון ומפענח את כל הרצועה, ואי אפשר לבקש טווח (בסרטוני אייפון ה־moov בסוף הקובץ, ולכן גם
 * קובץ קטוע לא יפוענח). קבצים של יותר מ־maxBytes נדחים עם הסבר; לסרטונים ארוכים מאוד צריך להפריד את רצועת הקול מהסרטון קודם (WebCodecs, ראו engine/media.js).
 */
export async function decodeAudio(file, { sampleRate = SAMPLE_RATE, start = 0, end = null, mono = false, maxBytes = MAX_DECODE_BYTES, onProgress, signal } = {}) {
  if (!file || typeof file.arrayBuffer !== 'function') throw hebrew('לא נבחר קובץ');
  if (!file.size) throw hebrew('הקובץ ריק');
  if (file.size > maxBytes) throw hebrew('הקובץ גדול מדי לפענוח הקול בתוך הטלפון. נסו סרטון קצר יותר.');
  const Ctx = contextClass();
  if (!Ctx) throw hebrew('הדפדפן הזה אינו תומך בעיבוד קול');
  checkAbort(signal);
  report(onProgress, 0, 'קוראים את הקובץ');
  const bytes = await file.arrayBuffer();
  checkAbort(signal);
  report(onProgress, 0.3, 'מפענחים את הקול');
  let decoded;
  try {
    decoded = await decodeWith(new Ctx(1, 1, sampleRate), bytes);
  } catch (e) {
    throw hebrew('לא הצלחנו לפענח את הקול בקובץ. ייתכן שאין בו קול או שהפורמט אינו נתמך.');
  }
  checkAbort(signal);
  const sr = decoded.sampleRate;
  const a = clamp(Math.round(start * sr), 0, decoded.length);
  const b = end === null || end === undefined ? decoded.length : clamp(Math.round(end * sr), a, decoded.length);
  let result = decoded;
  if (a > 0 || b < decoded.length || (mono && decoded.numberOfChannels > 1)) {
    const src = channelsOf(decoded);
    const nCh = mono ? 1 : src.length;
    const chans = [];
    for (let c = 0; c < nCh; c++) {
      const y = new Float32Array(b - a);
      if (mono && src.length > 1) { for (let i = 0; i < y.length; i++) { let s = 0; for (let k = 0; k < src.length; k++) s += src[k][a + i]; y[i] = s / src.length; } }
      else y.set(src[c].subarray(a, b));
      chans.push(y);
    }
    result = makeBuffer(chans, sr);
  }
  report(onProgress, 1, 'הקול מוכן');
  return result;
}

// ------------------------------------------------------------------ טעינת נכסים
const assetCache = new Map();
function assetUrl(path) { return new URL('../assets/' + path, import.meta.url).href; }

async function fetchJson(path) {
  if (!assetCache.has(path)) {
    assetCache.set(path, fetch(assetUrl(path)).then((r) => { if (!r.ok) throw new Error('x'); return r.json(); }));
  }
  try { return await assetCache.get(path); } catch (e) { assetCache.delete(path); throw hebrew('לא הצלחנו לטעון קובץ שמע של האפליקציה'); }
}

async function decodeAsset(path, sr) {
  const Ctx = contextClass();
  const res = await fetch(assetUrl(path));
  if (!res.ok) throw hebrew('לא הצלחנו לטעון קובץ שמע של האפליקציה');
  try { return await decodeWith(new Ctx(1, 1, sr), await res.arrayBuffer()); } catch (e) { throw hebrew('לא הצלחנו לפענח קובץ שמע של האפליקציה'); }
}

/** רצועת מוזיקה לפי מזהה: {id, name, channels, loopStart, loopLen (מדגמים בקצב sr), lufs}. */
export async function loadMusic(id, sr = SAMPLE_RATE) {
  if (!MUSIC_IDS.includes(id)) throw hebrew('רצועת המוזיקה שנבחרה אינה קיימת');
  const meta = (await fetchJson('music/index.json'))[id];
  if (!meta) throw hebrew('רצועת המוזיקה שנבחרה אינה קיימת');
  const buf = await decodeAsset('music/' + meta.file, sr);
  return { id, name: meta.name, channels: channelsOf(buf), loopStart: Math.round(meta.loopStart * sr), loopLen: Math.round(meta.samples * sr / 48000), lufs: meta.lufs };
}

/** אפקט קול לפי סוג: {channels, peakAt}. */
export async function loadSfx(kind, sr = SAMPLE_RATE) {
  const meta = (await fetchJson('sfx/index.json'))[kind];
  if (!meta) throw hebrew('אפקט הקול אינו קיים');
  const buf = await decodeAsset('sfx/' + meta.file, sr);
  return { kind, channels: channelsOf(buf), peakAt: meta.peakAt };
}

// ------------------------------------------------------------------ שרשרת הקול (OfflineAudioContext)
function buildVoiceChain(ctx, speechDb) {
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 80; hp.Q.value = Math.SQRT1_2;
  const box = ctx.createBiquadFilter(); box.type = 'peaking'; box.frequency.value = 300; box.Q.value = 0.9; box.gain.value = -2;
  const air = ctx.createBiquadFilter(); air.type = 'peaking'; air.frequency.value = 3800; air.Q.value = 0.7; air.gain.value = 1.5;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = clamp(speechDb - 2, -50, -12);
  comp.knee.value = 8; comp.ratio.value = 2.5; comp.attack.value = 0.006; comp.release.value = 0.14;
  hp.connect(box); box.connect(air); air.connect(comp);
  return { input: hp, output: comp };
}

const latencyCache = new Map();
/**
 * ההשהיה של שרשרת הקול במדגמים. DynamicsCompressor של Web Audio מקדים את האות ב־6ms (look-ahead) ובדפדפנים שונים הערך שונה, ולכן מודדים אותו: נקישה בודדת עוברת
 * בשרשרת ומחפשים את השיא. את ההשהיה מפצים ב־processVoice כדי שהקול יישאר על התמונה.
 */
export async function chainLatency(sr = SAMPLE_RATE) {
  if (latencyCache.has(sr)) return latencyCache.get(sr);
  const Ctx = contextClass();
  if (!Ctx) return 0;
  const n = Math.round(sr * 0.5), at = Math.round(sr * 0.1);
  const ctx = new Ctx(1, n, sr);
  const buf = ctx.createBuffer(1, n, sr);
  buf.getChannelData(0)[at] = 0.5;
  const src = ctx.createBufferSource(); src.buffer = buf;
  const chain = buildVoiceChain(ctx, -20);
  src.connect(chain.input); chain.output.connect(ctx.destination); src.start(0);
  const y = (await ctx.startRendering()).getChannelData(0);
  let k = 0, m = 0;
  for (let i = 0; i < n; i++) if (Math.abs(y[i]) > m) { m = Math.abs(y[i]); k = i; }
  const lat = m > 1e-6 ? Math.max(0, k - at) : 0;
  latencyCache.set(sr, lat);
  return lat;
}

/**
 * מעבד את הקול הערוך בשרשרת של FRAME: high-pass ב־80Hz, EQ עדין לקול (הנמכה ב־300Hz והדגשה ב־3.8kHz) ודחיסה (DynamicsCompressor) עם סף לפי רמת הדיבור.
 * מרנדר בנתחים של 60 שניות עם חצי שנייה לפניהם כדי שהדחיסה תתחמם, ולכן הזיכרון קבוע גם בקליפים ארוכים. ההשהיה של הדחיסה מפוצה (chainLatency), והאורך נשמר.
 */
export async function processVoice(voice, sr, { speechDb = -20, onProgress, signal } = {}) {
  const Ctx = contextClass();
  if (!Ctx) throw hebrew('הדפדפן הזה אינו תומך בעיבוד קול');
  const lat = await chainLatency(sr);
  const total = voice[0].length;
  const chunk = 60 * sr, pre = Math.round(0.5 * sr);
  const out = voice.map(() => new Float32Array(total));
  for (let start = 0; start < total; start += chunk) {
    checkAbort(signal);
    const end = Math.min(total, start + chunk), from = Math.max(0, start - pre), length = end - from;
    const ctx = new Ctx(2, length + lat, sr);
    const buf = ctx.createBuffer(2, length + lat, sr);
    for (let c = 0; c < 2; c++) buf.getChannelData(c).set((voice[c] || voice[0]).subarray(from, end));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const chain = buildVoiceChain(ctx, speechDb);
    src.connect(chain.input); chain.output.connect(ctx.destination);
    src.start(0);
    const rendered = await ctx.startRendering();
    for (let c = 0; c < out.length; c++) out[c].set(rendered.getChannelData(c).subarray(lat + start - from, lat + end - from), start);
    report(onProgress, end / total, 'משפרים את הקול');
  }
  return out;
}

// ------------------------------------------------------------------ בניית הרצועה
function peakOf(channels) {
  let p = 0;
  for (const x of channels) for (let i = 0; i < x.length; i++) { const a = x[i] < 0 ? -x[i] : x[i]; if (a > p) p = a; }
  return p;
}

function scaleInPlace(channels, g) {
  for (const x of channels) for (let i = 0; i < x.length; i++) x[i] *= g;
}

/**
 * הרצועה המלאה של הקליפ בציר הפלט, עם פרטים: {buffer: AudioBuffer, info}. אפשרויות: buffer (קול המקור), plan, music (מזהה, או ''), words (מילים בזמני פלט, ל־ducking), sfx ([{kind, at}]),
 * loudness (LUFS, ברירת מחדל ‎-14), info (תוצאת analyzeAudio של המקור, כדי לא לחשב שוב), debug (מחזיר גם את הערוצים בנפרד), onProgress, signal.
 */
export async function buildTrackDetailed({ buffer, plan, music = '', words = [], sfx = [], loudness = TARGET_LUFS, musicGainDb = 0, info = null, debug = false, onProgress, signal } = {}) {
  if (!buffer || !buffer.length) throw hebrew('אין קול לבניית הרצועה');
  if (!plan || !Array.isArray(plan.segments) || !(plan.duration > 0)) throw hebrew('תוכנית העריכה חסרה');
  const sr = SAMPLE_RATE;
  const t0 = Date.now();
  const timing = {};
  const mark = (name, since) => { timing[name] = Date.now() - since; };
  report(onProgress, 0, 'מכינים את הקול');
  checkAbort(signal);
  let src = channelsOf(buffer);
  if (buffer.sampleRate !== sr) src = src.map((x) => resampleMono(x, buffer.sampleRate, sr));
  const srcBuffer = { sampleRate: sr, length: src[0].length, numberOfChannels: src.length, getChannelData: (c) => src[c] };
  const stereo = src.length > 1 ? [src[0], src[1]] : [src[0], src[0]];
  const analysis = info && info.speech !== undefined && buffer.sampleRate === sr ? info : analyzeAudio(srcBuffer);
  let s = Date.now();
  let voice = assembleVoice(stereo, sr, plan);
  mark('assemble', s);
  report(onProgress, 0.08, 'מחברים את הקטעים');
  await tick();
  const total = voice[0].length;
  // מוזיקה ואפקטים נטענים לפני העיבוד הכבד, כדי שכשל בהם ייעצר מוקדם
  s = Date.now();
  let bed = null;
  if (music) bed = await loadMusic(music, sr);
  const sounds = {};
  for (const kind of new Set((sfx || []).map((e) => e.kind))) { try { sounds[kind] = await loadSfx(kind, sr); } catch (e) { /* אפקט חסר לא עוצר את הקליפ */ } }
  mark('assets', s);
  report(onProgress, 0.15, bed ? 'מכינים מוזיקת רקע' : 'מכינים את הקול');
  checkAbort(signal);
  // שרשרת הקול
  s = Date.now();
  let chained = false;
  if (contextClass()) {
    voice = await processVoice(voice, sr, { speechDb: analysis.speech, signal, onProgress: (f, t) => report(onProgress, 0.15 + 0.5 * f, t) });
    chained = true;
  }
  mark('voiceChain', s);
  fadeEnds(voice, sr);
  checkAbort(signal);
  await tick();
  // עוצמת הקול לבדו
  s = Date.now();
  report(onProgress, 0.68, 'מכווננים עוצמה');
  const voiceLufs = integratedLoudness(voice, sr);
  await tick();
  let voiceGainDb = 0;
  if (Number.isFinite(voiceLufs) && voiceLufs > -70) {
    voiceGainDb = clamp(loudness - voiceLufs, -12, 30);
    const room = CEILING_DB + 6 - dB(peakOf(voice));       // לא מעלים יותר ממה שה־limiter יכול לשאת (עד 6dB הפחתה)
    voiceGainDb = Math.min(voiceGainDb, room);
    scaleInPlace(voice, lin(voiceGainDb));
  }
  const mix = voice.map((x) => Float32Array.from(x));
  let musicInfo = null, stems = null;
  if (bed) {
    const curve = duckCurve(words, plan.duration);
    // musicGainDb: the quick editor's music level (0 = the usual bed), clamped so speech always stays on top.
    const gainDb = loudness + BED_DB + Math.max(-24, Math.min(6, Number(musicGainDb) || 0)) - (bed.lufs ?? -20);
    const m = renderMusic({ channels: bed.channels, loopStart: bed.loopStart, loopLen: bed.loopLen, outLen: total, sr, gainDb, duck: curve });
    for (let c = 0; c < 2; c++) for (let i = 0; i < total; i++) mix[c][i] += m[c][i];
    musicInfo = { id: bed.id, name: bed.name, gainDb: +gainDb.toFixed(1), duckDb: DUCK_DB };
    if (debug) stems = { voice: voice.map((x) => Float32Array.from(x)), music: m, musicDry: renderMusic({ channels: bed.channels, loopStart: bed.loopStart, loopLen: bed.loopLen, outLen: total, sr, gainDb }), duck: curve };
  }
  if (Object.keys(sounds).length) mixSfx(mix, sounds, sfx, sr);
  // תיקון עוצמה של התערובת כולה (רק כשיש מה לתקן: מוזיקה או אפקטים), ואז limiter
  report(onProgress, 0.82, 'מכווננים עוצמה');
  await tick();
  let corrDb = 0;
  if (bed || Object.keys(sounds).length) {
    const mixLufs = integratedLoudness(mix, sr);
    if (Number.isFinite(mixLufs)) {
      corrDb = clamp(loudness - mixLufs, -3, 3);
      scaleInPlace(mix, lin(corrDb));
    }
    await tick();
  }
  let limiterDb = limitPeaks(mix, sr, { ceilingDb: CEILING_DB - 0.3 });
  await tick();
  let tp = truePeakDb(mix);
  if (tp > CEILING_DB + 0.05) { limiterDb += limitPeaks(mix, sr, { ceilingDb: CEILING_DB - 0.3 - (tp - CEILING_DB) }); tp = truePeakDb(mix); }
  await tick();
  const finalLufs = integratedLoudness(mix, sr);
  mark('loudness', s);
  report(onProgress, 0.95, 'מסיימים');
  const out = makeBuffer(mix, sr);
  timing.total = Date.now() - t0;
  report(onProgress, 1, 'הקול מוכן');
  const result = {
    buffer: out,
    info: {
      sampleRate: sr, duration: total / sr, samples: total, lufs: +finalLufs.toFixed(2), truePeak: +tp.toFixed(2), voiceLufs: +voiceLufs.toFixed(2), voiceGainDb: +voiceGainDb.toFixed(2),
      mixCorrectionDb: +corrDb.toFixed(2), limiterDb: +limiterDb.toFixed(2), voiceChain: chained, music: musicInfo, segments: planLayout(plan, sr).length, timing,
    },
  };
  if (stems) result.stems = stems;
  return result;
}

/** הרצועה של הקליפ בציר הפלט, כ־AudioBuffer סטריאו ב־48kHz באורך round(plan.duration * 48000) בדיוק. ראו buildTrackDetailed לפרטים ולאפשרויות. */
export async function buildTrack(opts) {
  return (await buildTrackDetailed(opts)).buffer;
}
