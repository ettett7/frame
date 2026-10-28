// cover.js: תמונת שער (JPEG) לקליפ, בקנבס בלבד.
//   makeCover(file, moment, {title, style:'bold'|'box', size:[1080,1920]|[1280,720], faces}) -> Promise<Blob image/jpeg>
// נגזר מ־thumbnails.py ו־thumbnails_render.py בגרסת המק: בוחרים כמה פריימים מהרגע, מדרגים לפי חדות, הבעה, גודל פנים ומסגור,
// ובונים שער עם כותרת ענקית (קו מתאר וצבע הדגשה), בעברית מימין לשמאל. שני עיצובים:
//   bold: הפריים על כל השטח, מעבר צבע כהה והכותרת הלבנה עם קו מתאר עבה ומילה אחת בצבע הדגשה (כמו עיצוב A/B במק)
//   box:  הכותרת בקופסה צבעונית עם צל וזווית קלה, מעל הפריים (כמו עיצוב B במק)
// בלי ctx.filter (אין ב־Safari): ההגברה והחידוד נעשים בלולאת פיקסלים. פונקציות הניתוח והפריסה טהורות וקיימות גם ב־node.
// FaceSamples (מ־engine/frame.js) משמשים לדירוג ולמסגור כשהם נמסרים; בלעדיהם הבחירה לפי חדות ומרכז העניין של הפריים.
// הערה: ב־FaceSamples של היום יש רק פתיחת פה (mouth). אם יתווספו eyeOpen ו־yaw, עיניים עצומות ופנים מופנות הצידה יורדו בדירוג (poseFactor).

import { shortTitle, highlightIndex, tidy, detectLang } from './post-kit.js';

// ---------------------------------------------------------------------------------------------- קבועים

export const COVER_STYLES = {
  bold: { id: 'bold', nameHe: 'כותרת ענקית' },
  box: { id: 'box', nameHe: 'קופסה צבעונית' },
};
export const DEFAULT_COVER_STYLE = 'bold';
export const COVER_SIZES = { story: [1080, 1920], wide: [1280, 720], square: [1080, 1080], feed: [1080, 1350] };
export const MAX_JPEG_BYTES = 2000000;       // תקרת יוטיוב לתמונה ממוזערת
export const COVER_MAX_WORDS = 6;

export const FONT_VERSION = '5.2.5';
const FONT_BASE = `https://cdn.jsdelivr.net/npm/@fontsource/heebo@${FONT_VERSION}/files/`;
export const FONT_FAMILY = 'FrameCover';
/** קבצי הגופן (Heebo 900) כדי שה־service worker ישמור אותם במטמון. */
export const FONT_FILES = [
  { url: `${FONT_BASE}heebo-hebrew-900-normal.woff2`, range: 'U+0307-0308,U+0590-05FF,U+200C-2010,U+20AA,U+25CC,U+FB1D-FB4F' },
  { url: `${FONT_BASE}heebo-latin-900-normal.woff2`, range: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD' },
];
export const FONT_STACK = `"${FONT_FAMILY}", Heebo, Rubik, "Arial Hebrew", "Noto Sans Hebrew", system-ui, -apple-system, "Segoe UI", sans-serif`;
const WEIGHT = 900;

const hex = (c) => { const v = c.replace('#', ''); return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)); };
const rgba = (c, a = 1) => { const [r, g, b] = Array.isArray(c) ? c : hex(c); return `rgba(${r},${g},${b},${a})`; };

/** פלטות הדגשה (כמו ב־thumbnails_render.py): box צבע הקופסה, hi צבע המילה המודגשת, ink צבע כתב בקופסה, deep גוון הצל בתחתית. */
export const PALETTES = {
  fire: { box: '#E50914', glow: '#FF3B30', hi: '#FFE14D', ink: '#FFFFFF', deep: '#3A0508' },
  electric: { box: '#1E50FF', glow: '#27D8FF', hi: '#FFE14D', ink: '#FFFFFF', deep: '#06123F' },
  magenta: { box: '#D1127A', glow: '#FF4FB8', hi: '#FFF04D', ink: '#FFFFFF', deep: '#3A0524' },
  violet: { box: '#6C2BFF', glow: '#A06BFF', hi: '#FFE14D', ink: '#FFFFFF', deep: '#190A44' },
  gold: { box: '#FFD60A', glow: '#FFC400', hi: '#FFD60A', hib: '#E50914', ink: '#111111', deep: '#3D2F00' },
  cyan: { box: '#00E5FF', glow: '#00E5FF', hi: '#39F3FF', hib: '#FF2E93', ink: '#0A0A0A', deep: '#003A44' },
  lime: { box: '#C6F432', glow: '#9BE000', hi: '#C6F432', hib: '#FF2E63', ink: '#0A0A0A', deep: '#1E3300' },
};
/** העדפת פלטה לפי הגוון השולט בפריים (מעלות): ההדגשה צריכה לבלוט מהתמונה. */
const HUE_PREFS = [
  [[330, 50], ['electric', 'violet', 'cyan', 'gold']],
  [[50, 170], ['fire', 'magenta', 'violet', 'gold']],
  [[170, 260], ['gold', 'fire', 'magenta', 'lime']],
  [[260, 330], ['lime', 'gold', 'cyan', 'fire']],
];
const GRAY_PREF = ['fire', 'gold', 'electric', 'magenta'];

// ---------------------------------------------------------------------------------------------- עזרים

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const abortError = () => { const e = new Error('הפעולה בוטלה'); e.name = 'AbortError'; return e; };
const now = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());
const hasHeb = (s) => /[֐-׿]/.test(s);

export function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const k = ((v.length - 1) * p) / 100, a = Math.floor(k), b = Math.min(v.length - 1, a + 1);
  return v[a] + (v[b] - v[a]) * (k - a);
}

/** פלטה לפי הגוון השולט בפריים (hue במעלות או null לפריים אפור) ולפי הסגנון; override: שם פלטה. */
export function paletteFor(hue, style = DEFAULT_COVER_STYLE, override = null) {
  if (override && PALETTES[override]) return { name: override, ...PALETTES[override] };
  let prefs = GRAY_PREF;
  if (Number.isFinite(hue)) {
    const h = ((hue % 360) + 360) % 360;
    const entry = HUE_PREFS.find(([[a, b]]) => (a <= b ? h >= a && h < b : h >= a || h < b));
    if (entry) prefs = entry[1];
  }
  // קופסה: הצבע הראשון שמנוגד לפריים. כותרת ענקית: מילת ההדגשה בצהוב (או זהב) כשאפשר, כי היא נקראת הכי טוב על לבן
  const yellow = (n) => /^#FF[DE]/.test(PALETTES[n].hi) || n === 'gold';
  const name = style === 'box' ? prefs[0] : prefs.find(yellow) || prefs[0];
  return { name, ...PALETTES[name] };
}

// ---------------------------------------------------------------------------------------------- פנים (FaceSamples)

const faceArea = (f) => Math.max(0, +f.w || 0) * Math.max(0, +f.h || 0);

/** הפנים הראשיות: הגדולה ביותר, עם עדיפות קלה למי שפתוחה לדיבור. */
export function primaryFace(list) {
  let best = null, bw = -1;
  for (const f of list || []) {
    const w = Math.sqrt(faceArea(f)) * (1 + 0.5 * clamp((+f.mouth || 0) / 0.12));
    if (w > bw) { bw = w; best = f; }
  }
  return best;
}

/** הפנים בזמן t (שניות מקור): הדגימה הקרובה ביותר בטווח maxDt. */
export function facesAt(faces, t, maxDt = 0.3) {
  const s = faces?.samples;
  if (!s || !s.length) return null;
  let lo = 0, hi = s.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (s[m].t < t) lo = m + 1; else hi = m; }
  let best = s[lo];
  if (lo > 0 && Math.abs(s[lo - 1].t - t) <= Math.abs(best.t - t)) best = s[lo - 1];
  const dt = Math.abs(best.t - t);
  if (dt > maxDt) return null;
  return { faces: best.faces || [], primary: primaryFace(best.faces), dt };
}

/** הבעה 0..1 מפתיחת הפה (צעקה, צחוק, הפתעה). הסקאלה כמו ב־thumbnails.py: 0.03 סגור ועד 0.12 פתוח. */
export function expression(face) {
  if (!face) return 0;
  return clamp(((+face.mouth || 0) - 0.03) / 0.09);
}

/** פנים שנחתכות בקצה התמונה לא מתאימות לשער. */
export function framingFactor(face) {
  const { x, y, w, h } = { x: +face.x || 0, y: +face.y || 0, w: +face.w || 0, h: +face.h || 0 };
  const out = Math.max(0, -x) + Math.max(0, x + w - 1) + Math.max(0, -y) + Math.max(0, y + h - 1);
  const near = (x < 0.01) + (x + w > 0.99) + (y < 0.005) + (y + h > 0.995);
  return clamp(1 - (4 * out) / Math.max(w, h, 1e-6)) * (near ? 0.55 : 1);
}

const sizeFactor = (face) => clamp(Math.sqrt(faceArea(face)) / 0.25) ** 0.7;

/**
 * שדות אופציונליים ב־FaceSamples (אם engine/frame.js יוסיף אותם): eyeOpen (פתיחת עין יחסית, כמו ב־thumbnails.py) ו־yaw (מעלות).
 * עיניים עצומות (מצמוץ) ופנים מופנות הצידה נענשות; בלעדיהם הגורם הוא 1.
 */
export function poseFactor(face) {
  let f = 1;
  if (Number.isFinite(+face?.eyeOpen) && face.eyeOpen !== null) f *= clamp((+face.eyeOpen - 0.08) / 0.14, 0.3, 1);
  const yaw = Math.abs(+face?.yaw || 0);
  return f * (yaw <= 20 ? 1 : yaw <= 50 ? 0.88 : 0.6);
}

/** ציון לפי נתוני פנים בלבד (בלי פיקסלים): משמש לבחירת מועמדים לפני פענוח. */
export function faceOnlyScore(info) {
  const p = info?.primary;
  if (!p) return 0.05;
  return (0.45 * expression(p) + 0.3 * sizeFactor(p) + 0.25 * framingFactor(p)) * poseFactor(p);
}

/** 1 רחוק מחיתוכים; נמוך על חיתוך ובשוליים של הקליפ. */
export function transitionFactor(t, cuts, start, end) {
  const d = Math.min(...(cuts || []).map((c) => Math.abs(t - c)), t - start, end - t);
  return clamp(0.2 + 0.8 * (Math.max(0, d) / 0.4) ** 1.2, 0.2, 1);
}

export function exposureFactor(m) {
  if (m.luma === undefined || m.luma === null) return 1;
  let f = 1;
  if (m.luma < 40) f *= clamp(0.35 + m.luma / 62, 0.35, 1);
  if (m.luma > 215) f *= clamp(0.35 + (255 - m.luma) / 62, 0.35, 1);
  f *= 1 - 0.6 * clamp(((m.dark || 0) - 0.55) / 0.4);
  return f;
}

/** זמני המועמדים בתוך הרגע, בסדר עולה. עם FaceSamples: הזמנים שהפנים בהם הכי טובות; בלעדיהם: פיזור שווה. */
export function candidateTimes(moment, { faces = null, count = 6, minGap = 0.45 } = {}) {
  const a = +moment?.start, b = +moment?.end;
  if (!(b > a)) throw new Error('הרגע לא תקין: אין טווח זמן');
  const len = b - a;
  const pad = clamp(0.07 * len, 0.25, 1.0);
  const lo = a + Math.min(pad, len * 0.3), hi = Math.max(lo, b - Math.min(pad, len * 0.3));
  count = Math.max(1, Math.round(count));
  const even = [];
  for (let i = 0; i < count; i++) even.push(lo + ((hi - lo) * (i + 0.5)) / count);
  let times = even;
  if (faces?.samples?.length) {
    const grid = [];
    for (let t = lo; t <= hi + 1e-6; t += 0.25) {
      const info = facesAt(faces, t, 0.3);
      grid.push({ t, s: faceOnlyScore(info) * transitionFactor(t, faces.cuts, a, b) });
    }
    grid.sort((x, y) => y.s - x.s || x.t - y.t);
    const picked = [];
    for (const g of grid) {
      if (picked.length >= count - 1) break;
      if (picked.every((p) => Math.abs(p - g.t) >= minGap)) picked.push(g.t);
    }
    // מועמד אחד נשאר לפיזור: שיהיה פריים טוב גם כשנתוני הפנים שגויים
    const spread = even.find((e) => picked.every((p) => Math.abs(p - e) >= minGap));
    times = spread === undefined ? picked : [...picked, spread];
  }
  const peak = +moment.peak;
  if (Number.isFinite(peak) && peak > lo && peak < hi && times.every((t) => Math.abs(t - peak) >= minGap)) times = [...times.slice(0, Math.max(1, count - 1)), peak];
  return [...new Set(times.map((t) => Math.round(t * 100) / 100))].sort((x, y) => x - y);
}

// ---------------------------------------------------------------------------------------------- ניתוח פיקסלים (טהור)

/** ניתוח פריים מוקטן. rgba: Uint8ClampedArray של w*h*4. box: תיבת פנים מנורמלת (אופציונלי) למדידת חדות הפנים. */
export function analyzePixels(rgba, w, h, box = null) {
  const n = w * h;
  const g = new Float32Array(n);
  let sum = 0, dark = 0, bright = 0, mrg = 0, myb = 0, srg = 0, syb = 0, hx = 0, hy = 0, satN = 0, ex = 0, ey = 0, et = 0;
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    const r = rgba[i], gr = rgba[i + 1], b = rgba[i + 2];
    const l = 0.299 * r + 0.587 * gr + 0.114 * b;
    g[j] = l; sum += l;
    if (l < 35) dark++; else if (l > 225) bright++;
    const rg = r - gr, yb = 0.5 * (r + gr) - b;
    mrg += rg; myb += yb; srg += rg * rg; syb += yb * yb;
    const mx = Math.max(r, gr, b), mn = Math.min(r, gr, b);
    if (mx > 51 && (mx - mn) / mx > 0.25) {
      const c = mx - mn;
      let hue = mx === r ? ((gr - b) / c) % 6 : mx === gr ? (b - r) / c + 2 : (r - gr) / c + 4;
      hue *= (Math.PI * 2) / 6;
      const wgt = (mx - mn) / mx;
      hx += Math.cos(hue) * wgt; hy += Math.sin(hue) * wgt; satN++;
    }
  }
  const mean = sum / n;
  const sdrg = Math.sqrt(Math.max(0, srg / n - (mrg / n) ** 2)), sdyb = Math.sqrt(Math.max(0, syb / n - (myb / n) ** 2));
  const colorful = Math.sqrt(sdrg * sdrg + sdyb * sdyb) + 0.3 * Math.sqrt((mrg / n) ** 2 + (myb / n) ** 2);
  const lapOf = (x0, y0, x1, y1) => {
    x0 = Math.max(1, x0); y0 = Math.max(1, y0); x1 = Math.min(w - 1, x1); y1 = Math.min(h - 1, y1);
    if (x1 - x0 < 4 || y1 - y0 < 4) return 0;
    let s = 0, s2 = 0, c = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const k = y * w + x;
      const l = -4 * g[k] + g[k - 1] + g[k + 1] + g[k - w] + g[k + w];
      s += l; s2 += l * l; c++;
    }
    return c ? s2 / c - (s / c) ** 2 : 0;
  };
  // מרכז העניין: מרכז כובד של האנרגיה בקצוות (בלי פנים), מוטה קלות למרכז
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const k = y * w + x;
    const m = Math.abs(g[k + 1] - g[k - 1]) + Math.abs(g[k + w] - g[k - w]);
    const cw = 1 - 0.5 * (Math.abs(x / w - 0.5) + Math.abs(y / h - 0.45));
    ex += x * m * cw; ey += y * m * cw; et += m * cw;
  }
  let faceSharp = null;
  if (box) {
    const mx = box.w * 0.15, my = box.h * 0.15;
    faceSharp = lapOf(Math.floor((box.x - mx) * w), Math.floor((box.y - my) * h), Math.ceil((box.x + box.w + mx) * w), Math.ceil((box.y + box.h + my) * h));
  }
  const hue = satN > n * 0.04 ? ((Math.atan2(hy, hx) * 180) / Math.PI + 360) % 360 : null;
  return {
    sharp: lapOf(1, 1, w - 1, h - 1), faceSharp, luma: mean, dark: dark / n, bright: bright / n, colorful, hue,
    center: et > 0 ? { x: ex / et / w, y: ey / et / h } : { x: 0.5, y: 0.45 },
  };
}

/**
 * דירוג המועמדים. cand: {t, sharp, faceSharp?, luma, dark, colorful, info: {primary, faces}|null}. מחזיר אותם עם score ו־parts.
 * חדות נמדדת יחסית לפריימים הטובים של הרגע עצמו, כדי שמקור רך לא ייענש כולו. אם יש פנים, ציון הפריים תמיד מעל פריים בלי פנים.
 */
export function scoreCandidates(cands, { cuts = [], start = -Infinity, end = Infinity } = {}) {
  const sh = percentile(cands.map((c) => c.sharp), 85) || 1;
  const fs = percentile(cands.filter((c) => c.faceSharp !== null && c.faceSharp !== undefined).map((c) => c.faceSharp), 85) || 1;
  for (const c of cands) {
    const p = c.info?.primary || null;
    const sFrame = clamp((c.sharp || 0) / sh);
    const trans = Number.isFinite(start) ? transitionFactor(c.t, cuts, start, end) : 1;
    const expo = exposureFactor(c);
    let base, parts;
    if (!p) {
      base = Math.min(0.34, 0.26 * sFrame + 0.1 * clamp((c.colorful || 0) / 80));
      parts = { sharp: sFrame, expr: 0, size: 0, frame: 0 };
    } else {
      const sFace = c.faceSharp !== null && c.faceSharp !== undefined ? clamp(c.faceSharp / fs) : sFrame;
      const sharpN = 0.4 * sFrame + 0.6 * sFace;
      const ex = expression(p), size = sizeFactor(p), frame = framingFactor(p);
      base = (0.3 * ex + 0.28 * sharpN + 0.18 * size + 0.14 * frame + 0.1) * poseFactor(p);
      parts = { sharp: sharpN, expr: ex, size, frame };
    }
    c.parts = parts;
    c.score = base * trans * expo;
  }
  return cands;
}

/** המועמד הטוב ביותר; בתיקו (עד 3%) המוקדם יותר, כי ה־hook בתחילת הרגע. */
export function pickBest(cands) {
  let best = null;
  for (const c of [...cands].sort((a, b) => a.t - b.t)) if (!best || c.score > best.score * 1.03) best = c;
  return best;
}

// ---------------------------------------------------------------------------------------------- מסגור הפריים (טהור)

/** הפנים שהשער ממקד בהן: הראשיות, ואם יש עוד פנים גדולות והן נכנסות לקנבס יחד איתה, כולן. מנורמל במקור. */
export function focusFace(faces, { srcW, srcH, W, H }) {
  const p = primaryFace(faces);
  if (!p) return null;
  const group = faces.filter((f) => faceArea(f) >= 0.4 * faceArea(p));
  const x0 = Math.min(...group.map((f) => f.x)), x1 = Math.max(...group.map((f) => f.x + f.w));
  const y0 = Math.min(...group.map((f) => f.y)), y1 = Math.max(...group.map((f) => f.y + f.h));
  const cover = Math.max(W / srcW, H / srcH);
  if (group.length > 1 && (x1 - x0) * srcW * cover <= 0.92 * W) return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0, count: group.length };
  return { cx: p.x + p.w / 2, cy: p.y + p.h / 2, w: p.w, h: p.h, count: 1 };
}

/**
 * מיקום הפריים בקנבס. face: {cx, cy, w, h} מנורמל במקור (או null: אז center). target: איפה הפנים בקנבס {x, y, h} מנורמל.
 * מחזיר {s, ox, oy, mode}: mode 'fit' כשמקור קטן מדי ויש להציגו שלם על רקע מטושטש.
 */
export function placeFrame({ srcW, srcH, W, H, face = null, center = { x: 0.5, y: 0.45 }, target, maxZoom = 1.7, minZoom = 1 }) {
  const cover = Math.max(W / srcW, H / srcH);
  const tx = target.x * W, ty = target.y * H;
  if (cover > 3.4) {
    const s = W / srcW;
    return { s, ox: (W - srcW * s) / 2, oy: clamp(ty - srcH * s * 0.5, 0, Math.max(0, H - srcH * s)), mode: 'fit', cover };
  }
  let s = cover * minZoom, cx = center.x, cy = center.y;
  if (face) {
    cx = face.cx; cy = face.cy;
    const want = (target.h * H) / Math.max(1e-6, face.h * srcH);
    s = clamp(want, cover * minZoom, Math.min(cover * maxZoom, 3.2));
    if (face.count > 1) s = Math.min(s, (0.92 * W) / Math.max(1e-6, face.w * srcW));
    s = Math.max(s, cover * minZoom);
  }
  const ox = clamp(tx - cx * srcW * s, Math.min(0, W - srcW * s), 0);
  const oy = clamp(ty - cy * srcH * s, Math.min(0, H - srcH * s), 0);
  return { s, ox, oy, mode: 'cover', cover };
}

/**
 * תכנית הקומפוזיציה: אזור הכותרת, מיקום הפנים ומספר השורות. הכול מנורמל לגודל הקנבס.
 * @returns {{orient:string, title:{x:number,y:number,w:number,h:number}, align:'center'|'side', maxLines:number, maxSize:number, rotate:number, face:{x:number,y:number,h:number}}}
 */
export function planCover({ W, H, style = DEFAULT_COVER_STYLE, rtl = true, side = null }) {
  const ratio = W / H;
  const orient = ratio > 1.25 ? 'landscape' : ratio < 0.8 ? 'portrait' : 'square';
  const dir = rtl ? 1 : -1;       // כיוון הכתב: ימינה בעברית
  if (orient === 'landscape') {
    if (style === 'box') return { orient, title: { x: 0.08 * W, y: 0.6 * H, w: 0.84 * W, h: 0.27 * H }, align: 'center', maxLines: 2, maxSize: 0.2 * H, rotate: -1.8 * dir, face: { x: 0.5, y: 0.36, h: 0.4 } };
    // הכותרת בצד אחד והפנים בצד השני: בעברית הכותרת מימין כברירת מחדל
    const where = side || (rtl ? 'right' : 'left');
    const x0 = where === 'right' ? 0.5 * W : 0.045 * W;
    return { orient, side: where, minZoom: 1.18, title: { x: x0, y: 0.1 * H, w: 0.455 * W, h: 0.8 * H }, align: 'side', maxLines: 4, maxSize: 0.34 * H, rotate: -2.4 * dir, face: { x: where === 'right' ? 0.27 : 0.73, y: 0.46, h: 0.46 } };
  }
  const sq = orient === 'square';
  if (style === 'box') return { orient, title: { x: 0.1 * W, y: (sq ? 0.55 : 0.58) * H, w: 0.8 * W, h: (sq ? 0.27 : 0.2) * H }, align: 'center', maxLines: 3, maxSize: 0.17 * W, rotate: -2.2 * dir, face: { x: 0.5, y: sq ? 0.34 : 0.33, h: sq ? 0.3 : 0.2 } };
  return { orient, title: { x: 0.055 * W, y: (sq ? 0.5 : 0.5) * H, w: 0.89 * W, h: (sq ? 0.38 : 0.33) * H }, align: 'center', maxLines: 4, maxSize: 0.25 * W, rotate: -2.2 * dir, face: { x: 0.5, y: sq ? 0.34 : 0.33, h: sq ? 0.3 : 0.2 } };
}

// ---------------------------------------------------------------------------------------------- כותרת: סדר חזותי ופריסה (טהור)

const RTLCH = /[֐-׿؀-ۿ]/;
const wordIsRtl = (w) => RTLCH.test(w);

/**
 * סדר הציור משמאל לימין של מילים בשורה. רצף מילים בעברית נקרא מימין לשמאל; מילה לועזית או מספר שומרים על סדר הקריאה שלהם.
 * בשורה RTL הרצפים מונחים מימין, כך שמילה לועזית בתוך עברית נשארת במקום שהקורא מצפה לו.
 */
export function visualOrder(texts, rtl) {
  const runs = [];
  texts.forEach((t, i) => {
    const letters = t.replace(/[^\p{L}\p{N}]+/gu, '');
    const r = letters ? wordIsRtl(t) : (runs.length ? runs[runs.length - 1][0] : rtl);
    if (runs.length && runs[runs.length - 1][0] === r) runs[runs.length - 1][1].push(i);
    else runs.push([r, [i]]);
  });
  let seq = runs.map(([r, idx]) => [r, r ? idx.slice().reverse() : idx]);
  if (rtl) seq = seq.reverse();
  return seq.flatMap(([, idx]) => idx);
}

/** כל חלוקות n מילים ל־1..maxLines שורות רצופות: רשימות אורכים. */
export function partitions(n, maxLines) {
  const out = [];
  const rec = (left, acc) => {
    if (!left) { out.push(acc); return; }
    if (acc.length >= maxLines) return;
    for (let k = 1; k <= left; k++) rec(left - k, [...acc, k]);
  };
  rec(n, []);
  return out;
}

/**
 * פריסת כותרת בתיבה: הגופן הגדול ביותר שנכנס. measure(word) מחזיר רוחב המילה בגודל 100.
 * @returns {{size:number, lines:{idx:number[], width:number}[], pitch:number, width:number, height:number, stroke:number}}
 */
export function layoutTitle({ words, rtl = true, boxW, boxH, maxLines = 3, measure, space, stroke = 0.1, lineHeight = 1.0, maxSize = Infinity, minWordsPerLine = 1 }) {
  const n = words.length;
  if (!n) throw new Error('אין כותרת לפריסה');
  const w100 = words.map((w) => measure(w));
  const sp = space ?? measure(' ');
  let best = null;
  for (const part of partitions(n, Math.min(maxLines, n))) {
    if (part.some((k) => k < minWordsPerLine && n >= minWordsPerLine)) continue;
    let i = 0;
    const lines = part.map((k) => {
      const idx = Array.from({ length: k }, (_, j) => i + j);
      i += k;
      return { idx, w100: idx.reduce((s, j) => s + w100[j], 0) + sp * (k - 1) };
    });
    const widest = Math.max(...lines.map((l) => l.w100));
    const sW = boxW / (widest / 100 + 2 * stroke);
    const L = lines.length;
    const sH = boxH / ((L - 1) * lineHeight + 0.8 + 2 * stroke);
    const size = Math.min(sW, sH, maxSize);
    // שורה אחרונה של מילה בודדת וקצרה נראית יתומה; פער רחב בין השורות נראה גרוע
    const last = lines[L - 1];
    let q = 1;
    if (L > 1 && last.idx.length === 1 && last.w100 < 0.45 * widest) q *= 0.93;
    const narrow = Math.min(...lines.map((l) => l.w100));
    q *= 1 - 0.1 * (1 - narrow / widest) ** 2;
    const score = size * q;
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && L < best.lines.length)) best = { score, size, lines, L };
  }
  const size = best.size;
  const lines = best.lines.map((l) => ({ idx: l.idx, width: (l.w100 * size) / 100 }));
  const pitch = lineHeight * size;
  return { size, lines, pitch, width: Math.max(...lines.map((l) => l.width)), height: (lines.length - 1) * pitch + 0.8 * size, stroke };
}

// ---------------------------------------------------------------------------------------------- גוון ופיקסלים (טהור)

/** הגברת ניגודיות וצבע, וחידוד בהירות (unsharp 3x3). משנה את data במקום. */
export function gradePixels(data, w, h, { contrast = 1.08, saturation = 1.14, brightness = 0, sharpen = 0 } = {}) {
  const n = w * h;
  let luma = null, blur = null;
  if (sharpen > 0) {
    luma = new Float32Array(n);
    for (let i = 0, j = 0; j < n; i += 4, j++) luma[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const tmp = new Float32Array(n);
    blur = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      const r = y * w;
      for (let x = 0; x < w; x++) tmp[r + x] = (luma[r + Math.max(0, x - 1)] + luma[r + x] + luma[r + Math.min(w - 1, x + 1)]) / 3;
    }
    for (let y = 0; y < h; y++) {
      const a = Math.max(0, y - 1) * w, b = y * w, c = Math.min(h - 1, y + 1) * w;
      for (let x = 0; x < w; x++) blur[b + x] = (tmp[a + x] + tmp[b + x] + tmp[c + x]) / 3;
    }
  }
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    let r = data[i], g = data[i + 1], b = data[i + 2];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    r = l + (r - l) * saturation; g = l + (g - l) * saturation; b = l + (b - l) * saturation;
    r = (r - 128) * contrast + 128 + brightness; g = (g - 128) * contrast + 128 + brightness; b = (b - 128) * contrast + 128 + brightness;
    if (luma) { const d = (luma[j] - blur[j]) * sharpen; r += d; g += d; b += d; }
    data[i] = r < 0 ? 0 : r > 255 ? 255 : r;
    data[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
    data[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }
  return data;
}

// ---------------------------------------------------------------------------------------------- גופנים (דפדפן)

let fontPromise = null;
/** טוען את Heebo 900 (עברית ולטינית) מה־CDN. נכשל בשקט: אז הציור נופל לגופן מערכת. מחזיר true כשנטען. */
export function loadCoverFonts({ timeoutMs = 4000 } = {}) {
  if (fontPromise) return fontPromise;
  const set = globalThis.document?.fonts || globalThis.fonts;
  if (!set || typeof FontFace === 'undefined') return (fontPromise = Promise.resolve(false));
  const one = (f) => {
    const face = new FontFace(FONT_FAMILY, `url(${f.url}) format("woff2")`, { weight: String(WEIGHT), unicodeRange: f.range });
    return face.load().then((loaded) => { set.add(loaded); return true; });
  };
  const timeout = new Promise((r) => setTimeout(() => r(false), timeoutMs));
  fontPromise = Promise.race([Promise.all(FONT_FILES.map(one)).then((r) => r.every(Boolean)).catch(() => false), timeout]).then((ok) => { if (!ok) fontPromise = null; return ok; });
  return fontPromise;
}

// ---------------------------------------------------------------------------------------------- פריימים מהסרטון (דפדפן)

const makeCanvas = (w, h) => {
  if (typeof document !== 'undefined') return Object.assign(document.createElement('canvas'), { width: w, height: h });
  return new OffscreenCanvas(w, h);
};
const ctx2d = (c, opts) => c.getContext('2d', opts);

function waitEvent(el, ok, bad, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); reject(new Error('הסרטון לא נטען בזמן')); }, ms);
    const on = () => { cleanup(); resolve(); };
    const off = () => { cleanup(); reject(new Error('לא ניתן לקרוא את הסרטון')); };
    const cleanup = () => { clearTimeout(t); el.removeEventListener(ok, on); el.removeEventListener(bad, off); };
    el.addEventListener(ok, on); el.addEventListener(bad, off);
  });
}

async function openVideo(file, signal) {
  if (typeof document === 'undefined') throw new Error('יצירת שער פועלת רק בדפדפן');
  const own = typeof file !== 'string';
  const url = own ? URL.createObjectURL(file) : file;
  const v = document.createElement('video');
  v.muted = true; v.defaultMuted = true; v.playsInline = true; v.preload = 'auto';
  v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
  Object.assign(v.style, { position: 'fixed', left: '0', top: '0', width: '2px', height: '2px', opacity: '0.01', pointerEvents: 'none' });
  document.body.appendChild(v);
  const dispose = () => { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (_) { /* נעלם */ } v.remove(); if (own) URL.revokeObjectURL(url); };
  try {
    const ready = waitEvent(v, 'loadeddata', 'error', 10000);
    v.src = url;
    await ready;
    if (signal?.aborted) throw abortError();
    if (!v.videoWidth || !v.videoHeight) throw new Error('לא ניתן לקרוא את הסרטון');
  } catch (e) { dispose(); throw e; }
  return { video: v, dispose };
}

async function seekTo(v, t) {
  const target = clamp(t, 0, Math.max(0, (v.duration || t) - 0.05));
  if (Math.abs(v.currentTime - target) > 0.001 || v.readyState < 2) {
    await new Promise((resolve) => {
      const done = () => { clearTimeout(to); v.removeEventListener('seeked', done); resolve(); };
      const to = setTimeout(done, 3000);
      v.addEventListener('seeked', done);
      v.currentTime = target;
    });
  }
  // אחרי seeked הפריים החדש כבר ניתן לציור; requestVideoFrameCallback לא נורה בווידאו מושהה ומחוץ למסך, ולכן לא מחכים לו
  if (v.readyState < 2) await new Promise((r) => { const to = setTimeout(r, 400); v.addEventListener('canplay', () => { clearTimeout(to); r(); }, { once: true }); });
}

const FULL_SIDE = 2560;

/** מצייר את הפריים הנוכחי של הסרטון לקנבס בגודל מלא (עד FULL_SIDE בצלע הארוכה). */
function drawFull(v) {
  const sw = v.videoWidth, sh = v.videoHeight;
  const k = Math.min(1, FULL_SIDE / Math.max(sw, sh));
  const c = makeCanvas(Math.max(2, Math.round(sw * k)), Math.max(2, Math.round(sh * k)));
  ctx2d(c).drawImage(v, 0, 0, c.width, c.height);
  return c;
}

/** גרסה מוקטנת של קנבס (או חיתוך ממנו) לניתוח: {canvas, ctx}. */
function shrink(src, side, crop = null) {
  const sx = crop ? crop.x : 0, sy = crop ? crop.y : 0, sw = crop ? crop.w : src.width, sh = crop ? crop.h : src.height;
  const k = Math.min(1, side / Math.max(sw, sh));
  const c = makeCanvas(Math.max(8, Math.round(sw * k)), Math.max(8, Math.round(sh * k)));
  const x = ctx2d(c, { willReadFrequently: true });
  x.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return { canvas: c, ctx: x };
}

/**
 * מפענח את הפריימים המועמדים: ניתוח בגודל קטן לכל אחד, והפריים המלא נשמר רק למועמד הטוב ביותר עד כה (לא מחפשים אותו שוב בסוף).
 * הזמנים עולים כדי שהחיפוש בסרטון יתקדם קדימה. מפסיקים כשנגמר התקציב (אחרי שני מועמדים לפחות).
 * @returns {{video, dispose, cands: object[], leader: object}} cand: {t, sharp, faceSharp, luma, dark, colorful, hue, center, info, frame?}
 */
async function sampleCandidates(file, times, { faces, signal, budgetMs, moment, analysisSide = 360, timings = {} }) {
  const to = now();
  const handle = await openVideo(file, signal);
  timings.open = now() - to;
  const ts = now();
  const { video } = handle;
  const cands = [];
  try {
    for (let i = 0; i < times.length; i++) {
      if (signal?.aborted) throw abortError();
      if (i >= 2 && now() - ts > budgetMs) break;
      const t = times[i];
      await seekTo(video, t);
      const frame = drawFull(video);
      const info = facesAt(faces, t, 0.3);
      const small = shrink(frame, analysisSide);
      const a = analyzePixels(small.ctx.getImageData(0, 0, small.canvas.width, small.canvas.height).data, small.canvas.width, small.canvas.height, null);
      const p = info?.primary;
      if (p) {
        // חדות הפנים נמדדת על חיתוך סביב הפנים מהפריים המלא, לא על הגרסה המוקטנת
        const fx = clamp(p.x - 0.15 * p.w, 0, 1) * frame.width, fy = clamp(p.y - 0.15 * p.h, 0, 1) * frame.height;
        const crop = { x: fx, y: fy, w: Math.max(8, Math.min(frame.width - fx, p.w * 1.3 * frame.width)), h: Math.max(8, Math.min(frame.height - fy, p.h * 1.3 * frame.height)) };
        const fs = shrink(frame, 112, crop);
        a.faceSharp = analyzePixels(fs.ctx.getImageData(0, 0, fs.canvas.width, fs.canvas.height).data, fs.canvas.width, fs.canvas.height, null).sharp;
      }
      cands.push({ t, ...a, info, frame });
      // המוביל כרגע שומר את הפריים המלא, כל השאר משחררים
      scoreCandidates(cands, { cuts: faces?.cuts || [], start: +moment.start, end: +moment.end });
      const lead = pickBest(cands);
      for (const c of cands) if (c !== lead) c.frame = null;
    }
  } catch (e) { handle.dispose(); throw e; }
  timings.sample = now() - ts;
  return { ...handle, cands };
}

// ---------------------------------------------------------------------------------------------- ציור

function rrect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function setFont(ctx, size, word) {
  ctx.font = `${WEIGHT} ${size}px ${FONT_STACK}`;
  try { ctx.direction = wordIsRtl(word) ? 'rtl' : 'ltr'; } catch (_) { /* ctx ישן */ }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

/** מרקם רקע מטושטש: מכווצים ומגדילים (בלי ctx.filter). */
function blurredFill(src, W, H, level = 24) {
  const k = Math.max(1, level);
  const small = makeCanvas(Math.max(4, Math.round(W / k)), Math.max(4, Math.round(H / k)));
  const sx = ctx2d(small);
  sx.imageSmoothingQuality = 'high';
  const cover = Math.max(small.width / src.width, small.height / src.height);
  const dw = src.width * cover, dh = src.height * cover;
  sx.drawImage(src, (small.width - dw) / 2, (small.height - dh) / 2, dw, dh);
  const mid = makeCanvas(Math.max(4, Math.round(W / (k / 3))), Math.max(4, Math.round(H / (k / 3))));
  const mx = ctx2d(mid);
  mx.imageSmoothingQuality = 'high';
  mx.drawImage(small, 0, 0, mid.width, mid.height);
  return mid;
}

function drawFrame(ctx, frame, place, W, H) {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (place.mode === 'fit') {
    const bg = blurredFill(frame, W, H, 30);
    ctx.drawImage(bg, 0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.fillRect(0, 0, W, H);
  }
  ctx.drawImage(frame, place.ox, place.oy, frame.width * place.s, frame.height * place.s);
}

function drawOverlays(ctx, W, H, plan, pal, style, rtl) {
  const deep = hex(pal.deep);
  if (plan.orient === 'landscape' && style === 'bold') {
    const side = rtl ? W : 0;
    const g = ctx.createLinearGradient(side, 0, W / 2 + (rtl ? -W * 0.1 : W * 0.1), 0);
    g.addColorStop(0, rgba(deep, 0.88)); g.addColorStop(0.55, rgba(deep, 0.62)); g.addColorStop(1, rgba(deep, 0));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  } else {
    const y0 = H * (plan.orient === 'landscape' ? 0.45 : 0.36);
    const g = ctx.createLinearGradient(0, y0, 0, H);
    g.addColorStop(0, rgba(deep, 0)); g.addColorStop(0.4, rgba(deep, 0.66)); g.addColorStop(1, 'rgba(2,2,6,0.93)');
    ctx.fillStyle = g; ctx.fillRect(0, y0, W, H - y0);
  }
  const t = ctx.createLinearGradient(0, 0, 0, H * 0.2);
  t.addColorStop(0, 'rgba(0,0,0,0.34)'); t.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = t; ctx.fillRect(0, 0, W, H * 0.2);
  const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.max(W, H) * 0.78);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.3)');
  ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
}

/** מצייר את הכותרת לפי פריסה. מחזיר את תיבת הטקסט (לפני הסיבוב) שאפשר לצייר מאחוריה קופסה. */
function drawTitleText(ctx, words, layout, area, { rtl, align, hi, colors, rotate, style, boxPad }) {
  const { size, lines, pitch } = layout;
  const stroke = style === 'box' ? 0 : layout.stroke * size;
  const space = (() => { setFont(ctx, size, 'א'); return ctx.measureText(' ').width || size * 0.22; })();
  const capH = 0.72 * size;
  const blockH = (lines.length - 1) * pitch + capH;
  const cx = area.x + area.w / 2, cy = area.y + area.h / 2;
  const top = cy - blockH / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((rotate * Math.PI) / 180);
  ctx.translate(-cx, -cy);
  const placed = [];
  lines.forEach((line, li) => {
    const texts = line.idx.map((i) => words[i]);
    const order = visualOrder(texts, rtl).map((k) => line.idx[k]);
    const widths = order.map((i) => { setFont(ctx, size, words[i]); return ctx.measureText(words[i]).width; });
    const total = widths.reduce((s, w) => s + w, 0) + space * (order.length - 1);
    let x = align === 'center' ? cx - total / 2 : rtl ? area.x + area.w - total : area.x;
    const y = top + capH + li * pitch;
    order.forEach((i, k) => { placed.push({ i, x, y, w: widths[k] }); x += widths[k] + space; });
  });
  if (style === 'box') {
    const bw = Math.max(...lines.map((l) => l.width)) + 2 * boxPad.x, bh = blockH + 2 * boxPad.y + 0.18 * size;
    const bx = cx - bw / 2, by = top - boxPad.y - 0.02 * size;
    const r = 0.26 * Math.min(bw, bh);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 0.12 * size; ctx.shadowOffsetY = 0.07 * size;
    ctx.fillStyle = colors.box; rrect(ctx, bx, by, bw, bh, r); ctx.fill();
    ctx.restore();
    const sh = ctx.createLinearGradient(0, by, 0, by + bh);
    sh.addColorStop(0, 'rgba(255,255,255,0.26)'); sh.addColorStop(0.5, 'rgba(255,255,255,0.02)'); sh.addColorStop(1, 'rgba(0,0,0,0.16)');
    ctx.fillStyle = sh; rrect(ctx, bx, by, bw, bh, r); ctx.fill();
    ctx.lineWidth = Math.max(2, 0.025 * size); ctx.strokeStyle = 'rgba(255,255,255,0.28)'; rrect(ctx, bx + ctx.lineWidth / 2, by + ctx.lineWidth / 2, bw - ctx.lineWidth, bh - ctx.lineWidth, r); ctx.stroke();
  }
  ctx.lineJoin = 'round'; ctx.miterLimit = 2;
  if (stroke) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 0.08 * size; ctx.shadowOffsetY = 0.045 * size; ctx.shadowOffsetX = 0;
    ctx.strokeStyle = '#08080d'; ctx.lineWidth = stroke * 2;
    for (const p of placed) { setFont(ctx, size, words[p.i]); ctx.strokeText(words[p.i], p.x, p.y); }
    ctx.restore();
    ctx.strokeStyle = '#08080d'; ctx.lineWidth = stroke * 2;
    for (const p of placed) { setFont(ctx, size, words[p.i]); ctx.strokeText(words[p.i], p.x, p.y); }
  }
  for (const p of placed) {
    setFont(ctx, size, words[p.i]);
    ctx.fillStyle = p.i === hi ? colors.hi : colors.ink;
    ctx.fillText(words[p.i], p.x, p.y);
  }
  ctx.restore();
  return placed;
}

/**
 * מצייר שער על קנבס חדש מפריים נתון.
 * @param {HTMLCanvasElement|OffscreenCanvas|ImageBitmap} frame הפריים המלא
 * @param {{title:string, style?:string, size?:number[], rtl?:boolean, faces?:object[]|null, center?:{x:number,y:number}, hue?:number|null, palette?:string, maxWords?:number}} o
 */
export function renderCover(frame, o) {
  const [W, H] = normalizeSize(o.size);
  const style = COVER_STYLES[o.style] ? o.style : DEFAULT_COVER_STYLE;
  const rtl = o.rtl ?? hasHeb(o.title || '');
  const title = shortTitle(tidy(o.title || ''), { maxWords: o.maxWords ?? COVER_MAX_WORDS, maxChars: 48, ellipsis: false, anyStart: true }).replace(/[…]+$/, '').trim();
  if (!title) throw new Error('אין כותרת לשער');
  const words = title.split(/\s+/).filter(Boolean);
  const pal = paletteFor(o.hue ?? null, style, o.palette);
  const canvas = makeCanvas(W, H);
  const ctx = ctx2d(canvas);
  const face = o.faces?.length ? focusFace(o.faces, { srcW: frame.width, srcH: frame.height, W, H }) : null;
  const arrange = (side) => {
    const pl = planCover({ W, H, style, rtl, side });
    const pc = placeFrame({ srcW: frame.width, srcH: frame.height, W, H, face, center: o.center || { x: 0.5, y: 0.45 }, target: pl.face, minZoom: pl.minZoom || 1 });
    // כמה מקום פנוי בין הפנים לאזור הכותרת (חיובי: הפנים בצד החופשי)
    let clear = 1;
    if (face && pl.side) {
      const fx = (face.cx * frame.width * pc.s + pc.ox) / W, hw = (face.w * frame.width * pc.s) / 2 / W;
      clear = pl.side === 'right' ? 0.5 - (fx + hw) : fx - hw - 0.5;
    }
    return { plan: pl, place: pc, clear };
  };
  let pick = arrange(null);
  if (pick.plan.side && face && pick.clear < 0.04) {
    // הפנים נכנסות לאזור הכותרת: הכותרת עוברת לצד השני אם שם יש יותר מקום
    const other = arrange(pick.plan.side === 'right' ? 'left' : 'right');
    if (other.clear > pick.clear) pick = other;
  }
  const { plan, place } = pick;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  drawFrame(ctx, frame, place, W, H);
  // הגברת צבע, ניגודיות וחדות: חידוד רק כשהפריים הוגדל משמעותית
  try {
    const img = ctx.getImageData(0, 0, W, H);
    gradePixels(img.data, W, H, { contrast: 1.07, saturation: 1.15, sharpen: place.s > 1.6 ? 0.55 : place.s > 1.15 ? 0.3 : 0.12 });
    ctx.putImageData(img, 0, 0);
  } catch (_) { /* קנבס מסומן (cross-origin): בלי הגברה */ }
  drawOverlays(ctx, W, H, plan, pal, style, rtl);
  const measureCtx = ctx;
  const measure = (w) => { setFont(measureCtx, 100, w); return measureCtx.measureText(w).width; };
  const boxMode = style === 'box';
  const layout = layoutTitle({
    words, rtl, boxW: plan.title.w - (boxMode ? 0 : 0), boxH: plan.title.h, maxLines: plan.maxLines, measure,
    space: (() => { setFont(ctx, 100, 'א'); return ctx.measureText(' ').width || 22; })(), stroke: boxMode ? 0 : 0.085, lineHeight: boxMode ? 1.04 : 0.98, maxSize: plan.maxSize,
  });
  const hi = highlightIndex(words);
  const colors = { ink: boxMode ? pal.ink : '#FFFFFF', hi: boxMode ? (pal.hib || pal.hi) : pal.hi, box: pal.box };
  if (boxMode) {
    const bl = hex(colors.box), hl = hex(colors.hi);
    // הדגשה שלא מתבלטת על הקופסה (קרובה בצבע) מוחלפת באדום או צהוב
    if (Math.abs(bl[0] - hl[0]) + Math.abs(bl[1] - hl[1]) + Math.abs(bl[2] - hl[2]) < 150) colors.hi = bl[0] + bl[1] + bl[2] < 520 ? '#FFE14D' : '#E50914';
  }
  drawTitleText(ctx, words, layout, plan.title, { rtl, align: plan.align, hi, colors, rotate: plan.rotate, style, boxPad: { x: 0.34 * layout.size, y: 0.2 * layout.size } });
  return { canvas, plan, place, palette: pal, layout, words, highlight: hi, size: [W, H], style };
}

export function normalizeSize(size) {
  const s = size || COVER_SIZES.story;
  const W = Math.round(+s[0]), H = Math.round(+s[1]);
  if (!(W >= 320 && W <= 4096 && H >= 320 && H <= 4096)) throw new Error('גודל השער לא תקין. בחרו בין 320 ל־4096 פיקסלים בכל צד.');
  return [W, H];
}

async function encode(canvas, q = 0.9) {
  const tryOnce = (quality) => new Promise((resolve, reject) => {
    if (canvas.convertToBlob) { canvas.convertToBlob({ type: 'image/jpeg', quality }).then(resolve, reject); return; }
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('הקידוד ל־JPEG נכשל'))), 'image/jpeg', quality);
  });
  let blob = await tryOnce(q);
  for (const lower of [0.82, 0.74, 0.66]) { if (blob.size <= MAX_JPEG_BYTES) break; blob = await tryOnce(lower); }
  return blob;
}

/** חימום: טוען את הגופן ומקודד JPEG קטן, כדי שהשער הראשון לא ישלם על האתחול (מקודד ה־JPEG בדפדפן טוען אחרי השימוש הראשון). קוראים לזה כשהאפליקציה פנויה. */
export async function warmUpCover() {
  const fontOk = await loadCoverFonts();
  try {
    if (typeof document !== 'undefined' || typeof OffscreenCanvas !== 'undefined') {
      const c = makeCanvas(64, 64);
      const x = ctx2d(c);
      x.fillStyle = '#888'; x.fillRect(0, 0, 64, 64);
      x.font = `${WEIGHT} 20px ${FONT_STACK}`; x.fillStyle = '#fff'; x.fillText('אA', 8, 40);
      await encode(c, 0.8);
    }
  } catch (_) { /* חימום בלבד */ }
  return fontOk;
}

// ---------------------------------------------------------------------------------------------- הפונקציה הראשית

/**
 * שער לקליפ, עם פרטים על הבחירה (לכלי פיתוח ולממשק).
 * @returns {Promise<{blob:Blob, t:number, style:string, size:number[], palette:string, ms:number, fontOk:boolean, candidates:{t:number, score:number, parts:object}[], title:string}>}
 */
export async function makeCoverDetailed(file, moment, opts = {}) {
  const t0 = now();
  const { signal, quality = 0.9, budgetMs = 600, count = 4 } = opts;
  if (!file) throw new Error('לא נבחר סרטון לשער');
  const [W, H] = normalizeSize(opts.size);
  const style = COVER_STYLES[opts.style] ? opts.style : DEFAULT_COVER_STYLE;
  const faces = opts.faces || null;
  const rawTitle = opts.title ?? moment?.hook ?? moment?.hooks?.[0] ?? '';
  if (!tidy(rawTitle)) throw new Error('אין כותרת לשער. העבירו title או hook ברגע.');
  const fontsP = opts.fonts === false ? Promise.resolve(false) : loadCoverFonts();
  const times = candidateTimes(moment, { faces, count });
  const tm = {};
  const sampled = await sampleCandidates(file, times, { faces, signal, budgetMs, moment, timings: tm });
  try {
    const cuts = faces?.cuts || [];
    scoreCandidates(sampled.cands, { cuts, start: +moment.start, end: +moment.end });
    const best = pickBest(sampled.cands);
    // הפריים המלא של המוביל נשמר בזמן הדגימה; רק כשהדירוג הסופי שינה את המוביל מחפשים אותו שוב
    const tf = now();
    let frame = best.frame;
    if (!frame) { await seekTo(sampled.video, best.t); frame = drawFull(sampled.video); }
    tm.reseek = now() - tf;
    if (signal?.aborted) throw abortError();
    const fontOk = await fontsP;
    const lang = opts.lang || detectLang(rawTitle);
    const tr = now();
    const r = renderCover(frame, { title: rawTitle, style, size: [W, H], rtl: opts.rtl ?? (lang === 'he' || hasHeb(rawTitle)), faces: best.info?.faces?.length ? best.info.faces : null, center: best.center, hue: best.hue, palette: opts.palette, maxWords: opts.maxWords });
    tm.render = now() - tr;
    const te = now();
    const blob = await encode(r.canvas, quality);
    tm.encode = now() - te;
    return {
      timings: Object.fromEntries(Object.entries(tm).map(([k, v]) => [k, Math.round(v)])),
      blob, t: best.t, style, size: [W, H], palette: r.palette.name, fontOk, title: r.words.join(' '), place: r.place, highlight: r.highlight,
      ms: now() - t0, candidates: sampled.cands.map((c) => ({ t: c.t, score: c.score, parts: c.parts, sharp: c.sharp, faceSharp: c.faceSharp, hasFace: !!c.info?.primary })),
    };
  } finally { sampled.dispose(); }
}

/**
 * שער JPEG מהרגע: בוחר פריים טוב מתוך הרגע ומצייר עליו את הכותרת.
 * @param {File|Blob|string} file הסרטון המקורי
 * @param {{start:number,end:number,hook?:string,hooks?:string[],peak?:number}} moment זמני מקור
 * @param {{title?:string, style?:'bold'|'box', size?:number[], faces?:object, lang?:string, palette?:string, signal?:AbortSignal}} [opts] faces = FaceSamples מ־engine/frame.js
 * @returns {Promise<Blob>} image/jpeg
 */
export async function makeCover(file, moment, opts = {}) {
  return (await makeCoverDetailed(file, moment, opts)).blob;
}
