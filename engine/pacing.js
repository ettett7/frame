// קצב: חיתוכי קפיצה שמקצרים שתיקות, בטלפון. אותם עקרונות כמו pacing.py במק:
// חיתוך נעשה רק כשהתמלול וגם אנרגיית הקול מסכימים שיש שם שתיקה, הוא נוחת על רשת של 30 פריימים,
// לא חותך באמצע מילה, ולא משאיר קטעים קצרים מדי. במצב tight נחתכות גם מילות היסוס עומדות בפני עצמן.
// כל הזמנים בשניות. זמני מקור בקלט, ובפלט `segments` הם זמני מקור ו־mapTime/wordsOut נותנים זמני פלט.

export const FPS = 30;
// מצב -> פער שמפעיל חיתוך, כמה נשאר אחרי הדיבור הקודם, כמה נשאר לפני הדיבור הבא, האם מסירים היסוס, תקרת ההסרה (שבר מהקליפ)
export const MODES = {
  natural: { gap: 0.7, keepAfter: 0.17, keepBefore: 0.16, fillers: false, cap: 0.18 },
  tight: { gap: 0.3, keepAfter: 0.05, keepBefore: 0.07, fillers: true, cap: 0.3 },
};
const MIN_SEG = 0.35;      // קטע שנשאר בין שני חיתוכים לא יהיה קצר מזה (אלא אם יש בו מילה)
const EDGE = 0.15;         // קצה הקליפ לא נחתך
const MIN_CUT = 0.08;      // חיתוך קצר מזה לא נעשה
const LEAD = 0.1;          // שקט משני צדי מילת היסוס
const MAX_PIECES = 400;    // מספר קטעים מרבי בקליפ (גרף רינדור אחד)
const FILLER = /^(?:u+h*m+|u+h+|e+r+m+|h+m+|א+מ+|א+ה+מ*|מ{2,})$/u;
const ANSWER = new Set(['כן', 'לא', 'נכון', 'בסדר', 'אוקיי', 'אוקי', 'בטח', 'ברור', 'טוב']);
const HEBREW = /[֐-׿]/;

const round = (x, d = 4) => { const k = 10 ** d; return Math.round(x * k) / k; };

// ---------------------------------------------------------------------------------------------- מילים

const indexCache = new WeakMap();

/** מילים ממוינות לפי התחלה (מהמילים, ואם אין, מהמקטעים בחלוקה יחסית). נשמר לכל תמלול. */
function wordIndex(transcript) {
  if (!transcript || typeof transcript !== 'object') return { words: [], starts: [] };
  const hit = indexCache.get(transcript);
  if (hit && hit.src === transcript.words && hit.seg === transcript.segments) return hit;
  let words = (transcript.words || []).filter((w) => w && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start && String(w.text ?? '').trim());
  if (!words.length) words = fromSegments(transcript.segments || []);
  words = words.slice().sort((a, b) => a.start - b.start);
  const out = { words, starts: words.map((w) => w.start), src: transcript.words, seg: transcript.segments };
  indexCache.set(transcript, out);
  return out;
}

function fromSegments(segments) {
  const out = [];
  for (const s of segments) {
    if (!s || !(s.end > s.start)) continue;
    const parts = String(s.text || '').trim().split(/\s+/).filter(Boolean);
    const total = parts.reduce((n, p) => n + p.length + 1, 0);
    let at = s.start;
    for (const p of parts) {
      const d = (s.end - s.start) * ((p.length + 1) / total);
      out.push({ text: p, start: at, end: at + d, synthetic: true });
      at += d;
    }
  }
  return out;
}

function lowerBound(arr, x) {
  let lo = 0; let hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
  return lo;
}

/** מילים שנוגעות בטווח [start,end], חתוכות אליו. */
function tokensIn(transcript, start, end) {
  const { words, starts } = wordIndex(transcript);
  const out = [];
  for (let i = Math.max(0, lowerBound(starts, start - 5) - 1); i < words.length && words[i].start < end; i++) {
    const w = words[i];
    const a = Math.max(start, w.start); const b = Math.min(end, w.end);
    const t = String(w.text).trim();
    if (b > a && t) out.push({ a, b, t, timed: !w.synthetic });
  }
  return out;
}

const letters = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const isFiller = (t) => !t.trimEnd().endsWith('?') && FILLER.test(letters(t));

/** מילת היסוס בעברית חייבת לעמוד לבדה; באנגלית (um, uh) מספיק שהיא מבודדת. */
function standsAlone(toks, i, start, end) {
  const t = toks[i];
  if (!HEBREW.test(t.t)) return true;
  let prev = start;
  for (let k = Math.max(0, i - 3); k < i; k++) prev = Math.max(prev, toks[k].b);
  const next = toks[i + 1];
  const before = t.a - prev;
  const after = (next ? next.a : end) - t.b;
  if (t.b - t.a < 0.15 || before < LEAD || after < LEAD) return false;
  if (i && toks[i - 1].t.trimEnd().endsWith('?') && before < 1.0) return false;
  if (next && after < 0.45 && (t.t.trimEnd().endsWith(',') || ANSWER.has(letters(next.t)))) return false;
  return true;
}

function fillersByText(toks, start, end) {
  const found = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!(t.timed && isFiller(t.t) && t.b - t.a >= 0.1 && t.b - t.a <= 1.2)) continue;
    const before = t.a - (i ? Math.max(...toks.slice(0, i).map((x) => x.b)) : start);
    const after = (i + 1 < toks.length ? toks[i + 1].a : end) - t.b;
    if (before >= LEAD && after >= LEAD && standsAlone(toks, i, start, end)) found.push(t);
  }
  return found;
}

// ---------------------------------------------------------------------------------------------- אודיו

/** אזורי דיבור [a, b, softA, softB] (בשניות מקור) לפי אנרגיית הקול (היסטרזיס), או מחרוזת סטטוס. */
function speechRegions(audioInfo, start, end, toks, fill) {
  const env = audioInfo?.envelope;
  if (!env || !env.length) return 'unavailable';
  const perSecond = Number(audioInfo.envelopeRate) || 100;
  const hop = 1 / perSecond;
  const i0 = Math.max(0, Math.floor(start * perSecond)); const i1 = Math.min(env.length, Math.ceil(end * perSecond));
  if (i1 - i0 < 10) return 'unavailable';
  const e = env.subarray ? env.subarray(i0, i1) : Float32Array.from(env.slice(i0, i1));
  const n = e.length;
  // אחוזונים בלי מיון: היסטוגרמה של חצי דציבל
  const bins = new Uint32Array(400);
  const bin = (v) => Math.max(0, Math.min(399, Math.round((Math.max(v, -120) + 120) * 2)));
  for (let i = 0; i < n; i++) bins[bin(e[i])]++;
  const pct = (q) => { let c = 0; const goal = q * n; for (let k = 0; k < 400; k++) { c += bins[k]; if (c >= goal) return k / 2 - 120; } return 0; };
  const fl = pct(0.04); const sp = pct(0.9); // רצפת הרעש: ה־4% השקטים ביותר (קליפ מדבר מאוד עדיין מכיל כמה שתיקות)
  if (sp - fl < 14) return 'low-contrast';
  const lo = fl + 0.25 * (sp - fl); const hi = fl + 0.5 * (sp - fl);
  let comps = [];
  for (let i = 0; i < n;) {
    if (e[i] >= lo) {
      let j = i; let peak = -Infinity;
      while (j < n && e[j] >= lo) { if (e[j] > peak) peak = e[j]; j++; }
      if (peak >= hi) comps.push([i, j - 1, false, false]);
      i = j;
    } else i++;
  }
  const at = (x) => Math.max(0, Math.min(n - 1, Math.round(x / hop)));
  const cleared = [];
  for (const t of fill) { // מילת היסוס נחתכת רק אם היא נמצאת בין שני שקעי אנרגיה (עצירה לפניה ואחריה)
    const fa = t.a - start; const fb = t.b - start;
    const w1 = []; const w2 = [];
    for (let k = at(fa - 0.1); k <= at(fa + 0.06); k++) w1.push(k);
    for (let k = at(fb - 0.06); k <= at(fb + 0.1); k++) w2.push(k);
    const mid = []; for (let k = at(fa + 0.04); k <= at(fb - 0.04); k++) mid.push(e[k]);
    mid.sort((x, y) => x - y);
    if (mid.length < 3 || !w1.length || !w2.length) continue;
    const level = mid[mid.length >> 1];
    const i1 = w1.reduce((m, k) => (e[k] < e[m] ? k : m), w1[0]);
    const i2 = w2.reduce((m, k) => (e[k] < e[m] ? k : m), w2[0]);
    if (level >= hi && level - e[i1] >= 8 && level - e[i2] >= 8 && i2 - i1 >= 0.12 * perSecond && i2 - i1 <= 1.3 * perSecond) cleared.push([i1, i2, t]);
  }
  for (const [i1, i2] of cleared) {
    const next = [];
    for (const [p, q, sa, sb] of comps) {
      if (q < i1 || p >= i2) { next.push([p, q, sa, sb]); continue; }
      if (p < i1) next.push([p, i1 - 1, sa, true]);
      if (q >= i2) next.push([i2, q, true, sb]);
    }
    comps = next;
  }
  const regs = comps.map(([p, q, sa, sb]) => [p * hop, (q + 2) * hop, sa, sb]);
  for (const r of regs) {
    for (const [i1, i2] of cleared) {
      r[2] = r[2] || (Math.abs(r[0] - i2 * hop) <= 0.04 && r[0] >= i1 * hop);
      r[3] = r[3] || Math.abs(r[1] - (i1 + 2) * hop) <= 0.06;
    }
  }
  return { regions: regs.map(([a, b, sa, sb]) => [start + a, start + b, sa, sb]), cleared: cleared.map((c) => c[2]) };
}

// ---------------------------------------------------------------------------------------------- שמירות

/** מצמצם חיתוך כך שלא ייגע במילה: מילה בקצה מקצרת את החיתוך, מילה באמצע פוסלת אותו (התמלול והקול חלוקים). */
function avoidWords(c1, c2, keep) {
  for (const t of keep) {
    if (t.b <= c1 || t.a >= c2) continue;
    const startsBefore = t.a <= c1 + 0.06;
    const endsAfter = t.b >= c2 - 0.06;
    if (startsBefore && endsAfter) return null;
    if (startsBefore) c1 = Math.max(c1, t.b + 0.01);
    else if (endsAfter) c2 = Math.min(c2, t.a - 0.01);
    else return null;
    if (c2 - c1 < MIN_CUT) return null;
  }
  return [c1, c2];
}

/** קצוות, רשת פריימים, אורך קטע מינימלי, ותקרת הסרה. מחזיר זוגות (c1,c2) ממוינים. */
function guard(rem, start, end, cap) {
  let out = [];
  for (const [r1, r2] of rem.slice().sort((x, y) => x[0] - y[0])) {
    const c1 = Math.max(r1, start + EDGE); const c2 = Math.min(r2, end - EDGE);
    const k1 = Math.ceil((c1 - start) * FPS - 1e-6); const k2 = Math.floor((c2 - start) * FPS + 1e-6);
    if (c2 - c1 >= MIN_CUT && k2 - k1 >= 3 && (!out.length || start + k1 / FPS > out[out.length - 1][1])) out.push([start + k1 / FPS, start + k2 / FPS]);
  }
  for (;;) {
    const bounds = [start, ...out.flat(), end];
    const segs = [];
    for (let i = 0; i < bounds.length; i += 2) segs.push([bounds[i], bounds[i + 1]]);
    let bad = -1;
    for (let i = 1; i < segs.length - 1; i++) if (segs[i][1] - segs[i][0] < MIN_SEG) { bad = i; break; }
    if (bad < 0) break;
    const left = out[bad - 1]; const right = out[bad];
    out.splice(left[1] - left[0] <= right[1] - right[0] ? bad - 1 : bad, 1);
  }
  const total = () => out.reduce((s, [a, b]) => s + b - a, 0);
  while (out.length > 1 && total() > cap * (end - start)) {
    let m = 0;
    for (let i = 1; i < out.length; i++) if (out[i][1] - out[i][0] < out[m][1] - out[m][0]) m = i;
    out.splice(m, 1);
  }
  const over = total() - cap * (end - start);
  if (out.length && over > 0) { // פסקת שתיקה אחת ארוכה מהתקרה: נשארת מנוחה ארוכה יותר
    const c1 = out[0][0] + over / 2; const c2 = out[0][1] - over / 2;
    const k1 = Math.ceil((c1 - start) * FPS - 1e-6); const k2 = Math.floor((c2 - start) * FPS + 1e-6);
    out = k2 - k1 >= 3 ? [[start + k1 / FPS, start + k2 / FPS]] : [];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- התוכנית

function checkNumber(v, what) {
  const x = Number(v);
  if (!Number.isFinite(x)) throw new Error(`${what} אינו מספר תקין`);
  return x;
}

function offPlan(start, end, mode, audio) {
  return { segments: [[start, end]], duration: round(end - start), removed: 0, cuts: [], removedRanges: [], mode, fps: FPS, fillers: [], audio, origin: start };
}

/**
 * planPacing(transcript, audioInfo, start, end, mode) -> Plan
 * Plan = { segments:[[s0,s1],...] זמני מקור, duration (פלט), removed (שניות שנחתכו), cuts:[tOut], removedRanges, fillers, audio, mode, origin }
 * mode: 'natural' | 'tight' | 'off'. בלי אודיו או בלי תמלול החיתוך זהיר יותר (ראו `audio`).
 */
export function planPacing(transcript, audioInfo, start, end, mode = 'natural') {
  start = checkNumber(start, 'זמן ההתחלה'); end = checkNumber(end, 'זמן הסיום');
  if (end <= start) throw new Error('טווח הקליפ אינו תקין');
  const cfg = MODES[mode];
  const name = cfg ? mode : 'off';
  if (!cfg || end - start < 3 * MIN_SEG) return offPlan(start, end, name, 'off');
  const toks = tokensIn(transcript, start, end);
  if (!toks.length) return offPlan(start, end, name, 'no-transcript');
  const candidates = cfg.fillers ? toks.filter((t, i) => t.timed && isFiller(t.t) && t.b - t.a >= 0.1 && t.b - t.a <= 1.2 && standsAlone(toks, i, start, end)) : [];
  let regs; let fill; let status;
  if (audioInfo?.envelope?.length) {
    const got = speechRegions(audioInfo, start, end, toks, candidates);
    if (typeof got === 'string') return offPlan(start, end, name, got);
    regs = got.regions; fill = got.cleared; status = 'verified';
  } else {
    fill = cfg.fillers ? fillersByText(toks, start, end) : [];
    regs = [];
    for (const t of toks) {
      if (fill.includes(t)) continue;
      const last = regs[regs.length - 1];
      if (last && t.a <= last[1] + 1e-6) last[1] = Math.max(last[1], t.b);
      else regs.push([t.a, t.b, false, false]);
    }
    status = 'transcript-only';
  }
  if (!regs.length) return offPlan(start, end, name, status);
  const keep = toks.filter((t) => !fill.includes(t));
  const { gap, keepAfter: ka, keepBefore: kb, cap } = cfg;
  const cand = [];
  if (regs[0][0] - start > gap) cand.push([start + EDGE, regs[0][0] - (regs[0][2] ? 0.02 : kb)]);
  for (let i = 0; i + 1 < regs.length; i++) {
    const p = regs[i]; const q = regs[i + 1];
    if (q[0] - p[1] > gap) cand.push([p[1] + (p[3] ? 0.02 : ka), q[0] - (q[2] ? 0.02 : kb)]);
  }
  const lastReg = regs[regs.length - 1];
  if (end - lastReg[1] > gap) cand.push([lastReg[1] + (lastReg[3] ? 0.02 : ka), end - EDGE]);
  const safe = [];
  for (const [c1, c2] of cand) {
    if (c2 - c1 < MIN_CUT) continue;
    const kept = avoidWords(c1, c2, keep);
    if (kept && kept[1] - kept[0] >= MIN_CUT) safe.push(kept);
  }
  let rem = guard(safe, start, end, cap);
  let merged = 0;
  if (rem.length + 1 > MAX_PIECES) {
    merged = rem.length + 1 - MAX_PIECES;
    const top = rem.map((r, i) => [r[1] - r[0], i]).sort((x, y) => y[0] - x[0] || x[1] - y[1]).slice(0, MAX_PIECES - 1).map((x) => x[1]).sort((x, y) => x - y);
    rem = top.map((i) => rem[i]);
  }
  const bounds = [start, ...rem.flat(), end];
  const segments = [];
  for (let i = 0; i < bounds.length; i += 2) segments.push([round(bounds[i]), round(bounds[i + 1])]);
  segments[0][0] = start; segments[segments.length - 1][1] = end; // הקצוות בדיוק כפי שנתבקשו
  const cuts = []; let acc = 0;
  for (const [a, z] of segments.slice(0, -1)) { acc += z - a; cuts.push(round(acc)); }
  const duration = round(segments.reduce((s, [a, z]) => s + z - a, 0));
  const used = fill.filter((f) => rem.some(([c1, c2]) => c1 <= f.a + 0.03 && f.b <= c2 + 0.15 && f.a < c2));
  const plan = {
    segments, duration, removed: round(end - start - duration, 3), cuts, removedRanges: rem.map(([a, z]) => [round(a), round(z)]),
    mode: name, fps: FPS, fillers: used.map((f) => [f.t, round(f.a, 3)]), audio: status, origin: start,
  };
  if (merged) plan.mergedCuts = merged;
  return plan;
}

// ---------------------------------------------------------------------------------------------- מיפוי זמנים

function offsets(plan) {
  if (plan._offsets && plan._offsetsFor === plan.segments) return plan._offsets;
  const out = []; let acc = 0;
  for (const [a, z] of plan.segments) { out.push(acc); acc += z - a; }
  Object.defineProperty(plan, '_offsets', { value: out, enumerable: false, configurable: true });
  Object.defineProperty(plan, '_offsetsFor', { value: plan.segments, enumerable: false, configurable: true });
  return out;
}

/** זמן פלט של זמן מקור, או null כשהזמן נחתך (או מחוץ לקליפ). */
export function mapTime(plan, tSource) {
  const t = Number(tSource);
  if (!plan?.segments?.length || !Number.isFinite(t)) return null;
  const segs = plan.segments; const offs = offsets(plan);
  let lo = 0; let hi = segs.length - 1; let at = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (segs[m][0] <= t + 1e-9) { at = m; lo = m + 1; } else hi = m - 1; }
  if (at < 0) return null;
  const [a, z] = segs[at];
  if (t > z + 1e-9) return null;
  return round(offs[at] + Math.min(t, z) - a);
}

/** מילות הקליפ בזמני פלט: מילה שנחתכה (מילת היסוס) נעלמת, מילה שחוצה גבול קטע נחתכת אליו. */
export function wordsOut(transcript, plan) {
  const { words } = wordIndex(transcript);
  if (!plan?.segments?.length || !words.length) return [];
  const starts = wordIndex(transcript).starts;
  const offs = offsets(plan);
  const out = [];
  plan.segments.forEach(([a, z], k) => {
    for (let i = Math.max(0, lowerBound(starts, a - 5) - 1); i < words.length && words[i].start < z; i++) {
      const w = words[i];
      const s = Math.max(w.start, a); const e = Math.min(w.end, z);
      if (e <= s) continue;
      const overlap = e - s;
      if (overlap < 0.5 * (w.end - w.start)) continue; // רוב המילה נחתך: היא לא נשמעת
      // מילה שחוצה גבול: משתייכת לקטע שבו רובה
      const better = plan.segments.some(([a2, z2], k2) => k2 !== k && Math.min(w.end, z2) - Math.max(w.start, a2) > overlap);
      if (better) continue;
      out.push({ text: String(w.text).trim(), start: round(offs[k] + s - a), end: round(offs[k] + e - a), srcStart: w.start, srcEnd: w.end });
    }
  });
  return out.sort((x, y) => x.start - y.start);
}
