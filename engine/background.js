// background.js: טשטוש או החלפת רקע מאחורי הדובר, בתוך הטלפון (הגרסה הניידת של segment.py במק, אפקט bgReplace).
//
//   prepareBackground(file, start, end, {mode:'blur'|'replace'|'none', image, plan, quality, onProgress, signal}) -> Bg
//   drawWithBackground(ctx, frameSource|null, tOut, bg, rect, {dest?, tSource?}) -> boolean
//   backgroundCatalog() / resolveBackground(choice)     רשימת הרקעים לממשק, והמרה של בחירה ל־{mode, image}
//
// איך זה עובד
//   prepareBackground: טוען את MediaPipe ImageSegmenter (גרסה נעוצה מ־jsdelivr, מודל selfie) ב־Web Worker, עובר פעם אחת על הקטע
//   [start, end] של הסרטון המקורי (video מוסתר, כמו analyzeFaces) ומחשב מסכת אדם קטנה (256 פיקסלים בצלע הארוכה) כמה פעמים בשנייה.
//   בטשטוש הוא גם שומר כמה פעמים בשנייה תמונת "סביבה" קטנה (160 פיקסלים): הפריים בלי האדם, מטושטש, כך שצבעי האדם לא נמרחים אל הרקע.
//   המסכות והסביבה נשמרות במרחב המקור (לא במרחב ה־crop), ולכן המצלמה, זום ההדגשה ורעידה של fx יכולים להשתנות אחר כך בלי לפגוע בהן.
//   בסוף עובר ממוצע נע בזמן על המסכות, עם משקלים לפי הפרש (לא מורח תנועה אמיתית), כדי שהקצוות לא ירצדו.
//   drawWithBackground: סינכרוני וזול (אין בו מודל ואין צורך בפריים): מערבב שתי מסכות סמוכות בזמן, מרכך קצוות, ומצייר שכבת רקע
//   (תמונה מוכנה, או הסביבה המטושטשת) שהאדם "נחתך" ממנה. השכבה מונחת מעל הפריים, ולכן האדם נשאר בדיוק כמו במקור.
//
// איך משלבים ברינדור (render.js)
//   render.js קורא ל־overlay(ctx, tOut, i, frame?) כש־i הוא מספר הפריים בפלט. שני מסלולים:
//   א. ברירת המחדל של render.js: אין פריים. במסלול WebCodecs ה־ctx הוא שכבה שקופה שמורכבת בעצמה מעל הווידאו, ובגיבוי (MediaRecorder) ב־ctx כבר מצויר הפריים החתוך.
//      בשני המקרים מספיק לצייר את שכבת הרקע (עם חור במקום האדם), והאדם נשאר פיקסל־בפיקסל כמו במקור:
//        const bg = await prepareBackground(file, moment.start, moment.end, { mode, image, plan, onProgress, signal });   // אחרי שיש plan
//        const overlay = (ctx, tOut) => {
//          drawWithBackground(ctx, null, tOut, bg, camera.rectAt(tOut));       // הראשון: הרקע, ואחריו הכתוביות ושאר השכבות
//          ...
//        };
//        ... אחרי הרינדור (finally): bg.close()
//   ב. render({overlayFrame:true}): ה־overlay מקבל גם frame (ImageBitmap/VideoFrame של הפריים אחרי ה־crop, בגודל הפלט או קטן ממנו) ומצייר שכבה אטומה:
//        drawWithBackground(ctx, frame, tOut, bg, camera.rectAt(tOut), { cropped: true });
//      rect נשאר המצלמה (camera.rectAt) ולא "הפריים כולו": המסכות שמורות במרחב המקור, וה־rect אומר מה החלון שלהן. cropped:true אומר שהפריים כבר חתוך ומצויר כולו.
//   camera = המצלמה הסופית (אחרי effectsCamera, אם יש) כדי שהמסכה תתאים בדיוק למה ש־render.js חותך. זמן המקור של הפריים נקבע לפי opts.tSource, ואחרת לפי
//   ה־plan (נשלח ל־prepareBackground, או bg.setPlan(plan)), ואחרת לפי frame.timestamp / currentTime (רק בלי cropped), ואחרת start + tOut.
//   בלי render.js אפשר להעביר פריים מקור (VideoFrame, ImageBitmap, <video>, קנבס) בלי cropped: הפונקציה מציירת אותו חתוך לפי rect מתחת לרקע, וכך עובדת על קנבס ריק.
//   dest = {x,y,w,h} בפיקסלים של ה־ctx, לחלק מהקנבס (פריסת split: קריאה לכל חצי). rect יכול לחרוג מהתמונה (פריסת fit): מה שבחוץ הוא רקע.
//
// הקובץ בטוח לייבוא ב־node: כל מה שנוגע בדפדפן נוצר רק בתוך הפונקציות.

export const MEDIAPIPE_VERSION = '0.10.35';
export const MEDIAPIPE_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;
const MODEL_ROOT = 'https://storage.googleapis.com/mediapipe-models/image_segmenter';
export const MODELS = {
  // selfie_segmenter: מודל קטן (250KB), רץ על ה־CPU של הטלפון בכמה מילי־שניות. ברירת המחדל.
  selfie: { id: 'selfie', url: `${MODEL_ROOT}/selfie_segmenter/float16/1/selfie_segmenter.tflite`, bytes: 249537, nameHe: 'מהיר' },
  // selfie_segmenter_landscape: אותו מודל בקלט רחב (144x256), מעט מהיר יותר, לסרטוני רוחב.
  landscape: { id: 'landscape', url: `${MODEL_ROOT}/selfie_segmenter_landscape/float16/1/selfie_segmenter_landscape.tflite`, bytes: 250177, nameHe: 'מהיר לרוחב' },
  // selfie_multiclass: שישה מחלקות (רקע, שיער, עור, פנים, בגדים, אחר). קצוות נקיים יותר ושיער טוב יותר, אבל 16MB ואיטי פי כמה.
  multiclass: { id: 'multiclass', url: `${MODEL_ROOT}/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite`, bytes: 16371837, nameHe: 'מדויק' },
};
// איכות -> מודל ומספר המסכות בשנייה. 'high' (multiclass) נקי בהרבה: ריצוד הקצוות קטן פי 6 וגם השיער והבגדים מדויקים, ולכן מספיק לו קצב נמוך יותר.
// 'fast' (selfie) למכשירים חלשים: 250KB ו־10ms לפריים, אבל קצוות מרצדים ולפעמים משענות כיסא נחשבות אדם.
export const QUALITY_MODEL = { fast: 'selfie', high: 'multiclass' };
export const QUALITY_FPS = { fast: 15, high: 10 };

/** 'auto': איכות גבוהה, חוץ ממכשירים חלשים (פחות מ־6 ליבות או פחות מ־4GB זיכרון, כשהדפדפן מדווח). */
export function pickQuality(nav = globalThis.navigator) {
  if (nav && ((nav.hardwareConcurrency && nav.hardwareConcurrency < 6) || (nav.deviceMemory && nav.deviceMemory < 4))) return 'fast';
  return 'high';
}

// ----------------------------------------------------------------------------------------------------------------- קבועים
export const MASK_SIDE = 256;        // הצלע הארוכה של המסכה (בפיקסלים)
export const MASK_FPS = 20;          // כמה מסכות בשנייה (בערך, לפי מה שהמכשיר מספיק)
export const MAX_MASK_BYTES = 160e6; // תקרת זיכרון למסכות של קליפ אחד
export const MAX_MASKS = 700;       // תקרה למספר ההרצות של המודל בקליפ אחד: מגבילה את זמן ההכנה בקליפים ארוכים (קליפ ארוך יותר מקבל פחות מסכות בשנייה)
const EDGE_LO = 0.28, EDGE_HI = 0.72;     // טווח ההסתברות שבו הקצה עובר מרקע לאדם (ריכוך)
const TEMPORAL_RADIUS = 2, TEMPORAL_SIGMA = 56;     // נמדד על 8 שניות של דובר: ריצוד הקצוות יורד בכשליש, והסטייה מהמסכה הגולמית כ־1.5%
// הסביבה: תמונה קטנה של הפריים בלי האדם, מטושטשת (רוחב בפיקסלים, כמה בשנייה, רדיוס ומעברי הטשטוש בפיקסלים שלה, ומראה).
const ENV_BLUR = { side: 160, fps: 5, radius: 2, passes: 2, look: { dim: 0.97, sat: 1.05 } };   // טשטוש הרקע (כמו eq ב־segment.py)
const ENV_TINT = { side: 32, fps: 8, radius: 1, passes: 1, look: {} };                          // החלפת רקע: צבע ואור של הסביבה המקורית
const TINT_ALPHA = 0.18;                                 // כמה מהסביבה נמשך אל הרקע החדש (כמו all_opacity ב־segment.py)
const HOLE_MAX = 0.3;                                    // מרווח גדול מזה בין שתי מסכות (שניות): לא מערבבים
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const abortError = () => { const e = new Error('הפעולה בוטלה'); e.name = 'AbortError'; return e; };
const HE = {
  noBrowser: 'הפרדת רקע פועלת רק בדפדפן',
  badRange: 'טווח הקטע ריק',
  badFile: 'לא הצלחנו לקרוא את הסרטון',
  model: 'טעינת מודל הפרדת הרקע נכשלה. בדקו את החיבור לאינטרנט ונסו שוב',
  segFail: 'זיהוי האדם בסרטון נכשל בדפדפן הזה',
  badImage: 'לא הצלחנו לקרוא את תמונת הרקע. נסו תמונה אחרת',
  badBg: 'רקע לא מוכר',
  badMode: 'מצב רקע לא מוכר',
};

// ----------------------------------------------------------------------------------------------------------------- רקעים מובנים (אותם מזהים, שמות וצבעים כמו BACKGROUNDS ב־segment.py)
// 'lin': (x0, y0, x1, y1) ו־'rad': (cx, cy, rx, ry) הם שברים מהתמונה. עצירות: (מיקום 0..1, '#rrggbb').
export const BACKGROUNDS = [
  { id: 'blur', name: 'טשטוש חזק', ramp: null },
  { id: 'studio-dark', name: 'סטודיו כהה', ramp: ['rad', [0.5, 0.33, 0.95, 0.62], [[0, '#59627a'], [0.45, '#2b303d'], [1, '#07080b']]] },
  { id: 'studio-light', name: 'סטודיו בהיר', ramp: ['rad', [0.5, 0.33, 0.95, 0.62], [[0, '#fbf8f1'], [0.5, '#ddd9ce'], [1, '#9d9992']]] },
  { id: 'gradient-sunset', name: 'גרדיאנט שקיעה', ramp: ['lin', [0.5, 0, 0.5, 1], [[0, '#1d0b45'], [0.38, '#8a2d93'], [0.7, '#ef4b80'], [1, '#ffb347']]] },
  { id: 'gradient-ocean', name: 'גרדיאנט אוקיינוס', ramp: ['lin', [0.25, 0, 0.75, 1], [[0, '#031a3a'], [0.4, '#0a5c8c'], [0.75, '#2fb7c4'], [1, '#bdf0e6']]] },
  { id: 'gradient-neon', name: 'גרדיאנט ניאון', ramp: ['lin', [0, 0, 1, 1], [[0, '#0b0120'], [0.4, '#4a00b0'], [0.72, '#ff2bd6'], [1, '#00e5ff']]] },
  { id: 'gradient-forest', name: 'גרדיאנט יער', ramp: ['lin', [0.5, 0, 0.5, 1], [[0, '#07200f'], [0.4, '#1b5e3a'], [0.75, '#5cae6d'], [1, '#d5e8a0']]] },
  { id: 'gradient-rose', name: 'גרדיאנט ורד', ramp: ['lin', [0.25, 0, 0.75, 1], [[0, '#2d0a26'], [0.4, '#9c1a58'], [0.75, '#f2557c'], [1, '#ffc2a8']]] },
  { id: 'gradient-midnight', name: 'גרדיאנט חצות', ramp: ['lin', [0.5, 0, 0.5, 1], [[0, '#050818'], [0.4, '#16255e'], [0.75, '#3f64a8'], [1, '#9bb7e0']]] },
];
export const BUILTIN = Object.fromEntries(BACKGROUNDS.filter((b) => b.ramp).map((b) => [b.id, b]));

const rgbOf = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

/** הצבע (r, g, b) של רקע מובנה בנקודה (u, v) ביחידות של התמונה (0..1). אותו חישוב כמו geq ב־segment.py (אינטרפולציה לינארית בין העצירות). */
export function rampColor(ramp, u, v) {
  const [kind, geo, stops] = ramp;
  let t;
  if (kind === 'lin') {
    const [x0, y0, x1, y1] = geo, dx = x1 - x0, dy = y1 - y0;
    t = ((u - x0) * dx + (v - y0) * dy) / (dx * dx + dy * dy);
  } else {
    const [cx, cy, rx, ry] = geo;
    t = Math.hypot((u - cx) / rx, (v - cy) / ry);
  }
  t = clamp(t, 0, 1);
  for (let i = 1; i < stops.length; i++) {
    const [p1, c1] = stops[i];
    if (t < p1 || i === stops.length - 1) {
      const [p0, c0] = stops[i - 1];
      const a = rgbOf(c0), b = rgbOf(c1), f = clamp((t - p0) / (p1 - p0), 0, 1);
      return a.map((x, k) => x + (b[k] - x) * f);
    }
  }
  return rgbOf(stops[stops.length - 1][1]);
}

/** CSS של מדגם לכפתור הרקע (כמו catalog_backgrounds ב־segment.py). */
export function swatchCss(id) {
  const b = BACKGROUNDS.find((x) => x.id === id);
  if (!b) return '';
  if (!b.ramp) return 'linear-gradient(135deg, #5f6b7d, #b9aa9a 50%, #3a4658)';
  const [kind, geo, stops] = b.ramp;
  const cs = stops.map(([p, c]) => `${c} ${Math.round(p * 100)}%`).join(', ');
  if (kind === 'rad') return `radial-gradient(ellipse at ${Math.round(geo[0] * 100)}% ${Math.round(geo[1] * 100)}%, ${cs})`;
  return `linear-gradient(${Math.round((Math.atan2(geo[2] - geo[0], -(geo[3] - geo[1])) * 180) / Math.PI)}deg, ${cs})`;
}

/** רשימת הרקעים לממשק: [{id, name, kind:'blur'|'builtin', swatch}], טשטוש ראשון. תמונה של המשתמש מועברת בנפרד (Blob). */
export function backgroundCatalog() {
  return BACKGROUNDS.map((b) => ({ id: b.id, name: b.name, kind: b.ramp ? 'builtin' : 'blur', swatch: swatchCss(b.id) }));
}

/** בחירה בממשק -> אפשרויות ל־prepareBackground. 'blur' | מזהה מובנה | Blob/File/ImageBitmap/כתובת תמונה | ''/'none'/null = בלי שינוי. */
export function resolveBackground(choice) {
  if (choice === null || choice === undefined || choice === '' || choice === 'none') return { mode: 'none' };
  if (choice === 'blur') return { mode: 'blur' };
  return { mode: 'replace', image: choice };
}

// ----------------------------------------------------------------------------------------------------------------- פונקציות טהורות: מסכות (עובדות על מערכים, נבדקות ב־node)
export function smoothstep(lo, hi, x) {
  if (!(hi > lo)) return x >= hi ? 1 : 0;
  const u = clamp((x - lo) / (hi - lo), 0, 1);
  return u * u * (3 - 2 * u);
}

/** טבלת ריכוך: הסתברות 0..255 -> אלפא 0..255. מתחת ל־lo בדיוק רקע, מעל hi בדיוק אדם, ביניהם מעבר חלק. */
export function featherLut(lo = EDGE_LO, hi = EDGE_HI) {
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.round(255 * smoothstep(lo, hi, i / 255));
  return lut;
}

/** ערבוב שתי מסכות (a, b) לפי f (0..1) ומעבר דרך טבלה: out = lut[a + (b - a) * f]. בלי b או f<=0 זה העתק של a. */
export function blendMasks(a, b, f, out, lut = null) {
  const n = out.length;
  if (!b || !(f > 0)) { for (let i = 0; i < n; i++) out[i] = lut ? lut[a[i]] : a[i]; return out; }
  if (f >= 1) { for (let i = 0; i < n; i++) out[i] = lut ? lut[b[i]] : b[i]; return out; }
  const fb = Math.round(f * 256), fa = 256 - fb;
  for (let i = 0; i < n; i++) { const v = (a[i] * fa + b[i] * fb + 128) >> 8; out[i] = lut ? lut[v] : v; }
  return out;
}

/** ריכוך קצוות במרחב המסכה: טשטוש ריבועי (רדיוס 0 = כלום, 1 = 3x3), לכיוון אחד ואז לשני. מחזיר את out (יכול להיות זהה ל־src, tmp בגודל src). */
export function featherMask(src, w, h, radius, out = src, tmp = new Uint8Array(src.length)) {
  const r = radius | 0;
  if (r < 1) { if (out !== src) out.set(src); return out; }
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {                     // אופקי
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += src[row + clamp(x + k, 0, w - 1)];
      tmp[row + x] = (s / n + 0.5) | 0;
    }
  }
  for (let x = 0; x < w; x++) {                     // אנכי
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[clamp(y + k, 0, h - 1) * w + x];
      out[y * w + x] = (s / n + 0.5) | 0;
    }
  }
  return out;
}

/**
 * ממוצע נע בזמן של רצף מסכות (במקום), ממורכז: בלי השהיה. לכל פיקסל המשקל של שכן הוא משולש בזמן כפול exp(-(הפרש/sigma)^2),
 * ולכן ריצוד קטן נמחק אבל תנועה אמיתית (הפרש גדול) וחיתוכי צילום לא נמרחים. sigma = Infinity: ממוצע נע רגיל.
 */
export function createTemporalSmoother({ radius = TEMPORAL_RADIUS, sigma = TEMPORAL_SIGMA } = {}) {
  const tab = new Float32Array(256);
  for (let d = 0; d < 256; d++) tab[d] = Number.isFinite(sigma) && sigma > 0 ? Math.exp(-((d * d) / (sigma * sigma))) : 1;
  const hist = [];                                  // עותקי המקור של radius הפריימים הקודמים: hist[0] = הקודם
  const pool = [];
  return {
    /** מחליק את הפריימים i0..i1-1 של frames (קוראים ברצף, עם אותו מחליק). */
    run(frames, i0 = 0, i1 = frames.length) {
      const n = frames.length, len = frames[0]?.length || 0;
      for (let i = i0; i < i1; i++) {
        const cur = frames[i];
        const raw = pool.pop() || new Uint8Array(len);
        raw.set(cur);
        const past = Math.min(hist.length, radius), fut = Math.min(radius, n - 1 - i);
        if (past + fut > 0) {
          for (let p = 0; p < len; p++) {
            const c = raw[p];
            let num = c * (radius + 1), den = radius + 1;
            for (let k = 0; k < past; k++) { const v = hist[k][p], w = (radius - k) * tab[v > c ? v - c : c - v]; num += v * w; den += w; }
            for (let k = 0; k < fut; k++) { const v = frames[i + 1 + k][p], w = (radius - k) * tab[v > c ? v - c : c - v]; num += v * w; den += w; }
            cur[p] = (num / den + 0.5) | 0;
          }
        }
        hist.unshift(raw);
        if (hist.length > radius) pool.push(hist.pop());
      }
      return frames;
    },
  };
}
export function temporalSmooth(frames, opts) {
  if (frames.length < 2) return frames;
  return createTemporalSmoother(opts).run(frames);
}

/** ריצוד קצוות: ההפרש הממוצע (0..255) בין מסכות סמוכות, בפיקסלים שבהם אחת מהן במעבר (בין 20 ל־235), כלומר בקצה ולא בתוך האדם או הרקע. */
export function edgeFlicker(frames) {
  let sum = 0, cnt = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1], b = frames[i];
    for (let p = 0; p < a.length; p++) {
      const x = a[p], y = b[p];
      if ((x > 20 && x < 235) || (y > 20 && y < 235)) { sum += x > y ? x - y : y - x; cnt++; }
    }
  }
  return cnt ? sum / cnt : 0;
}

/** ממוצע נע ממורכז של סדרת מספרים (משמש לכיסוי: כמה מהתמונה הוא אדם). */
export function smoothSeries(values, radius) {
  const n = values.length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = Math.max(0, i - radius); k <= Math.min(n - 1, i + radius); k++) { s += values[k]; c++; }
    out[i] = s / c;
  }
  return out;
}

/** חלק התמונה שהוא אדם (0..1): פיקסלים שההסתברות שלהם מעל החצי. */
export function coverOf(mask) {
  let c = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] > 127) c++;
  return mask.length ? c / mask.length : 0;
}

/** כמה מהאפקט להפעיל לפי כיסוי האדם: כשכמעט אין אדם בתמונה (צילום של אוכל, נוף) הפריים נשאר כמו שהוא. */
export function presenceFade(cover) { return smoothstep(0.004, 0.02, cover); }

/** אינדקס i כך ש־times[i] <= t < times[i+1] (או -1 לפני הראשון). times עולה. */
export function bisectTimes(times, t) {
  let lo = 0, hi = times.length - 1, at = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] <= t) { at = m; lo = m + 1; } else hi = m - 1; }
  return at;
}

/** שתי המסכות הסמוכות לזמן t, והמשקל של השנייה: {i, j, f}. מחוץ לקטע או במרווח גדול (HOLE_MAX): המסכה הקרובה, בלי ערבוב. */
export function maskPair(times, t, holeMax = HOLE_MAX) {
  const n = times.length;
  if (!n) return null;
  const i = bisectTimes(times, t);
  if (i < 0) return { i: 0, j: 0, f: 0 };
  if (i >= n - 1) return { i: n - 1, j: n - 1, f: 0 };
  const gap = times[i + 1] - times[i];
  if (gap > holeMax) { const c = t - times[i] < times[i + 1] - t ? i : i + 1; return { i: c, j: c, f: 0 }; }
  return { i, j: i + 1, f: gap > 0 ? clamp((t - times[i]) / gap, 0, 1) : 0 };
}

/** הסתברות אדם (Uint8, 0..255) ממסכת ביטחון של המודל (Float32 0..1): מסכת אדם כמות שהיא, או (invert) מסכת הרקע של multiclass: 1 פחות הרקע. out: מערך Uint8 לשימוש חוזר. */
export function personFromConfidence(mask, invert = false, out = null) {
  const n = mask.length;
  if (!out || out.length !== n) out = new Uint8Array(n);
  if (invert) for (let i = 0; i < n; i++) out[i] = clamp(((1 - mask[i]) * 255 + 0.5) | 0, 0, 255);
  else for (let i = 0; i < n; i++) out[i] = clamp((mask[i] * 255 + 0.5) | 0, 0, 255);
  return out;
}

/** זמני דגימה שחסרים: בכל מרווח בין שתי דגימות שגדול מ־maxGap מוסיפים נקודות במרווחי step (כשנגינה איטית, דילוגים או דף שהוסתר השאירו חורים). times לא חייב להיות ממוין. */
export function gapTimes(times, a, b, step, maxGap = step * 2.5) {
  const s = [...times].sort((x, y) => x - y);
  const pts = [a, ...s.filter((t) => t > a && t < b), b];
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i];
    if (q - p <= maxGap) continue;
    for (let t = i === 1 && !s.length ? p : p + step; t < q - step * 0.5; t += step) out.push(+t.toFixed(6));
  }
  return out;
}

/** גודל המסכה (בפיקסלים) לפי יחס התמונה: הצלע הארוכה = side. */
export function maskSize(srcW, srcH, side = MASK_SIDE) {
  const r = srcW / srcH;
  return r >= 1 ? { w: side, h: Math.max(8, Math.round(side / r)) } : { w: Math.max(8, Math.round(side * r)), h: side };
}

/** מספר המסכות בשנייה כך שהזיכרון לא יעבור את התקרה: min(fps, תקרה / (שניות * בתים למסכה)). */
export function chooseMaskFps(fps, seconds, bytesPerMask, maxBytes = MAX_MASK_BYTES, maxSamples = MAX_MASKS) {
  const cap = Math.min(maxBytes / Math.max(1, seconds * bytesPerMask), maxSamples / Math.max(1, seconds));
  return clamp(Math.min(fps, cap), 2, 60);
}

// ----------------------------------------------------------------------------------------------------------------- פונקציות טהורות: צבע ותמונה
/**
 * טשטוש מנורמל במשקלים: rgba כשהאלפא היא המשקל (0..255) של כל פיקסל. הצבע של כל פיקסל הוא ממוצע משוקלל של סביבתו (ריבוע בגודל 2*radius+1, passes מעברים),
 * כך שפיקסלים עם משקל 0 (האדם) לא מדליפים את הצבעים שלהם אל הרקע המטושטש. איפה שאין משקל בסביבה: הממוצע הכללי. מחזיר RGBA אטום.
 * `dim` ו־`sat` מתאימים את המראה (כמו eq=brightness/saturation ב־segment.py).
 */
export function normalizedBlur(rgba, w, h, radius = 3, passes = 2, { dim = 1, sat = 1 } = {}) {
  const n = w * h;
  let R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n), A = new Float32Array(n);
  let sr = 0, sg = 0, sb = 0, sa = 0;
  for (let i = 0; i < n; i++) {
    const a = rgba[4 * i + 3] / 255;
    R[i] = rgba[4 * i] * a; G[i] = rgba[4 * i + 1] * a; B[i] = rgba[4 * i + 2] * a; A[i] = a;
    sr += R[i]; sg += G[i]; sb += B[i]; sa += a;
  }
  const gr = sa > 0 ? sr / sa : 128, gg = sa > 0 ? sg / sa : 128, gb = sa > 0 ? sb / sa : 128;
  const tmp = new Float32Array(n);
  for (let p = 0; p < passes; p++) for (const pl of [R, G, B, A]) boxBlurPlane(pl, tmp, w, h, radius);
  const out = new Uint8ClampedArray(4 * n);
  for (let i = 0; i < n; i++) {
    const a = A[i], t = smoothstep(0.02, 0.2, a);
    let r = a > 1e-6 ? R[i] / a : gr, g = a > 1e-6 ? G[i] / a : gg, b = a > 1e-6 ? B[i] / a : gb;
    r = gr + (r - gr) * t; g = gg + (g - gg) * t; b = gb + (b - gb) * t;
    if (sat !== 1) { const l = 0.299 * r + 0.587 * g + 0.114 * b; r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat; }
    out[4 * i] = r * dim; out[4 * i + 1] = g * dim; out[4 * i + 2] = b * dim; out[4 * i + 3] = 255;
  }
  return out;
}

/** טשטוש ריבועי של מישור (במקום), רדיוס r, ריפוד באפסים וחלוקה ב־(2r+1): ממוצע (עם הערכים מחוץ לתמונה כאפס). tmp בגודל המישור. */
export function boxBlurPlane(pl, tmp, w, h, r) {
  const k = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) s += pl[row + x];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s * k;
      if (x + r + 1 < w) s += pl[row + x + r + 1];
      if (x - r >= 0) s -= pl[row + x - r];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) s += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      pl[y * w + x] = s * k;
      if (y + r + 1 < h) s += tmp[(y + r + 1) * w + x];
      if (y - r >= 0) s -= tmp[(y - r) * w + x];
    }
  }
}

/**
 * משקלי הסביבה (0..255) בגריד ew x eh מתוך מסכת אדם mw x mh: 255 = רקע בטוח, 0 = אדם או סמוך לאדם (מקסימום על החלון של הפיקסל ועוד פיקסל שוליים,
 * כדי שלא יידלפו אל הרקע המטושטש צבעי הקצה של האדם).
 */
export function envWeights(mask, mw, mh, ew, eh, out = new Uint8Array(ew * eh)) {
  const sx = mw / ew, sy = mh / eh;
  for (let y = 0; y < eh; y++) {
    const y0 = Math.max(0, Math.floor(y * sy) - 1), y1 = Math.min(mh - 1, Math.ceil((y + 1) * sy));
    for (let x = 0; x < ew; x++) {
      const x0 = Math.max(0, Math.floor(x * sx) - 1), x1 = Math.min(mw - 1, Math.ceil((x + 1) * sx));
      let m = 0;
      for (let j = y0; j <= y1; j++) { const row = j * mw; for (let i = x0; i <= x1; i++) if (mask[row + i] > m) m = mask[row + i]; }
      out[y * ew + x] = Math.round(255 * (1 - smoothstep(0.04, 0.3, m / 255)));
    }
  }
  return out;
}

/** סביבה מוכנה: RGBA של הפריים (בגודל הגריד) + מסכת אדם -> RGB מטושטש (3 בתים לפיקסל). משנה את האלפא של rgba (היא המשקל). */
export function buildEnvRgb(rgba, mask, mw, mh, ew, eh, { radius = 2, passes = 2, look = {} } = {}) {
  const wts = envWeights(mask, mw, mh, ew, eh);
  for (let i = 0; i < wts.length; i++) rgba[4 * i + 3] = wts[i];
  const px = normalizedBlur(rgba, ew, eh, radius, passes, look);
  const rgb = new Uint8Array(ew * eh * 3);
  for (let i = 0, j = 0, k = 0; i < ew * eh; i++, j += 4) { rgb[k++] = px[j]; rgb[k++] = px[j + 1]; rgb[k++] = px[j + 2]; }
  return rgb;
}

/** ערבוב שתי תמונות RGB (a, b) לפי f ישר אל נתוני RGBA אטומים (out.length = 4 * הפיקסלים). */
export function lerpRgbToRgba(a, b, f, out) {
  const n = out.length / 4;
  const fb = b ? Math.round(clamp(f, 0, 1) * 256) : 0, fa = 256 - fb;
  for (let i = 0, j = 0, k = 0; i < n; i++, j += 3, k += 4) {
    if (fb) { out[k] = (a[j] * fa + b[j] * fb + 128) >> 8; out[k + 1] = (a[j + 1] * fa + b[j + 1] * fb + 128) >> 8; out[k + 2] = (a[j + 2] * fa + b[j + 2] * fb + 128) >> 8; }
    else { out[k] = a[j]; out[k + 1] = a[j + 1]; out[k + 2] = a[j + 2]; }
    out[k + 3] = 255;
  }
  return out;
}

/** הרכבה: out = fg * m + bg * (1 - m) לכל פיקסל (RGBA אטום; m = מסכה 0..255). המימוש המקורי שהקנבס צריך לשחזר, ושימוש לבדיקות. */
export function compositePixels(fg, bg, mask, out = new Uint8ClampedArray(fg.length)) {
  const n = mask.length;
  for (let i = 0; i < n; i++) {
    const m = mask[i] / 255, k = 4 * i;
    out[k] = fg[k] * m + bg[k] * (1 - m);
    out[k + 1] = fg[k + 1] * m + bg[k + 1] * (1 - m);
    out[k + 2] = fg[k + 2] * m + bg[k + 2] * (1 - m);
    out[k + 3] = 255;
  }
  return out;
}

/** מלבן החיתוך של תמונה שממלאת (cover) יעד בגודל dw x dh: {sx, sy, sw, sh} בפיקסלים של המקור. */
export function coverRect(srcW, srcH, dw, dh) {
  const s = Math.max(dw / srcW, dh / srcH);
  const sw = dw / s, sh = dh / s;
  return { sx: (srcW - sw) / 2, sy: (srcH - sh) / 2, sw, sh };
}

/**
 * גיאומטריה של ציור: rect מנורמל במקור (יכול לחרוג מהתמונה: אז מה שבחוץ הוא רקע), dest במלבן בפיקסלים של הקנבס.
 * מחזיר את החלק שבתוך התמונה: מקור בפיקסלים (sx, sy, sw, sh), יעד (dx, dy, dw, dh), חלון המסכה (mx, my, mw, mh) ביחידות של פיקסלי המסכה.
 * null כשאין חפיפה.
 */
export function cropGeometry(rect, srcW, srcH, maskW, maskH, dest) {
  const r = rect || { x: 0, y: 0, w: 1, h: 1 };
  const u0 = Math.max(r.x, 0), u1 = Math.min(r.x + r.w, 1), v0 = Math.max(r.y, 0), v1 = Math.min(r.y + r.h, 1);
  if (!(u1 > u0) || !(v1 > v0) || !(r.w > 0) || !(r.h > 0)) return null;
  return {
    sx: u0 * srcW, sy: v0 * srcH, sw: (u1 - u0) * srcW, sh: (v1 - v0) * srcH,
    dx: dest.x + ((u0 - r.x) / r.w) * dest.w, dy: dest.y + ((v0 - r.y) / r.h) * dest.h, dw: ((u1 - u0) / r.w) * dest.w, dh: ((v1 - v0) / r.h) * dest.h,
    mx: u0 * maskW, my: v0 * maskH, mw: (u1 - u0) * maskW, mh: (v1 - v0) * maskH,
    u0, v0, u1, v1,
  };
}

/** זמן מקור של זמן פלט לפי תוכנית (segments ברצף, מהירות 1): ההפך של mapTime ב־pacing.js. מחוץ לתוכנית: הקצה. */
export function planToSource(plan, tOut) {
  const segs = plan?.segments;
  if (!segs?.length || !Number.isFinite(tOut)) return null;
  let acc = 0;
  for (const [a, z] of segs) {
    const len = z - a;
    if (tOut < acc + len) return a + Math.max(0, tOut - acc);
    acc += len;
  }
  return segs[segs.length - 1][1];
}

// ----------------------------------------------------------------------------------------------------------------- המודל (worker, או הת'רד הראשי כשאי אפשר)
/**
 * ב־module worker אין importScripts, ו־MediaPipe טוען את קובץ ה־wasm loader (סקריפט רגיל, לא מודול) ב־import() ואז לא מוצא את ModuleFactory ("ModuleFactory not set").
 * הפתרון: מריצים את הסקריפט בעצמנו בהיקף הגלובלי של ה־worker, לפני שיוצרים את המודל. בדף הרגיל (ובאייפון בלי worker) אין צורך.
 */
async function primeModuleWorker(fileset) {
  const inWorker = typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope;
  if (!inWorker || self.ModuleFactory || !fileset?.wasmLoaderPath) return;
  const r = await fetch(fileset.wasmLoaderPath);
  if (!r.ok) throw new Error(`wasm loader ${r.status}`);
  (0, eval)(await r.text());
}

/** MediaPipe ImageSegmenter במצב IMAGE (כל פריים עומד לעצמו: אין מצב בין פריימים, אפשר לדלג). -> {delegate, ms, labels, segment(bitmap) -> {data: Uint8, w, h}, close()} */
export async function createSegmenter({ base = MEDIAPIPE_BASE, model = MODELS.selfie.url, delegate = 'GPU' } = {}) {
  const t0 = performance.now();
  const { ImageSegmenter, FilesetResolver } = await import(`${base}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${base}/wasm`);
  await primeModuleWorker(fileset);
  const make = (d) => ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: model, delegate: d }, runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false,
  });
  let used = delegate, seg;
  try { seg = await make(delegate); } catch (err) {
    if (delegate !== 'GPU') throw err;
    used = 'CPU'; seg = await make('CPU');                 // אין WebGL כאן: גרסת ה־WASM עובדת
  }
  const labels = seg.getLabels?.() || [];
  const bgIndex = labels.findIndex((l) => /background|רקע/i.test(l));
  const api = {
    delegate: used, ms: 0, labels,
    segment(bitmap) {
      const res = seg.segment(bitmap);
      try {
        const ms = res.confidenceMasks;
        const w = ms[0].width, h = ms[0].height;
        const invert = ms.length > 1 && bgIndex >= 0;                    // multiclass: קוראים רק את מסכת הרקע (קריאה אחת מה־GPU) והופכים
        const arr = (invert ? ms[bgIndex] : ms[ms.length - 1]).getAsFloat32Array();
        return { data: personFromConfidence(arr, invert), w, h };
      } finally { try { res.close?.(); } catch (_) { /* נסגר כבר */ } }
    },
    close() { try { seg.close(); } catch (_) { /* נסגר כבר */ } },
  };
  // חימום: הקריאה הראשונה מקמפלת shaders ומקצה זיכרון (עד שניות בטלפון). עושים אותה כאן, כדי שהנגינה של הסרטון לא תתחיל לפני שהמודל מוכן
  try { const c = makeCanvas(64, 64); c.getContext('2d').fillRect(0, 0, 64, 64); api.segment(c); api.segment(c); } catch (_) { /* החימום לא קריטי */ }
  api.ms = performance.now() - t0;
  return api;
}

class SegHost {
  constructor(opts) { this.opts = opts; this.pending = new Map(); this.id = 0; this.mode = null; this.delegate = null; }
  async init() {
    const o = this.opts;
    if (o.useWorker !== false && typeof Worker !== 'undefined') {
      try {
        this.worker = new Worker(new URL('./background.worker.js', import.meta.url), { type: 'module' });
        await new Promise((resolve, reject) => {
          this.worker.onerror = (e) => reject(new Error(e.message || 'worker'));
          this.worker.onmessage = (e) => {
            const m = e.data;
            if (m.type === 'ready') { this.delegate = m.delegate; this.mode = 'worker'; this.initMs = m.ms; this.labels = m.labels; resolve(); }
            else if (m.type === 'error') reject(new Error(m.message));
          };
          this.worker.postMessage({ type: 'init', base: o.base, model: o.model, delegate: o.delegate });
        });
        this.worker.onerror = (e) => this.failAll(new Error(e.message || 'worker'));
        this.worker.onmessage = (e) => this.onMessage(e.data);
        return;
      } catch (err) {
        try { this.worker?.terminate(); } catch (_) { /* נעלם */ }
        this.worker = null;
        this.workerError = String((err && err.message) || err);
      }
    }
    this.det = await createSegmenter(o);                    // גיבוי: אותו מודל על הת'רד הזה
    this.delegate = this.det.delegate; this.mode = 'main'; this.initMs = this.det.ms; this.labels = this.det.labels;
  }
  onMessage(m) {
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.type === 'mask') p.resolve({ data: m.mask, w: m.w, h: m.h, ms: m.ms });
    else if (m.type === 'error') p.reject(new Error(m.message));
  }
  failAll(err) { for (const p of this.pending.values()) p.reject(err); this.pending.clear(); }
  segment(bitmap) {
    const id = ++this.id;
    if (this.worker) return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker.postMessage({ type: 'frame', id, bitmap }, [bitmap]); });
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      try { const r = this.det.segment(bitmap); resolve({ ...r, ms: performance.now() - t0 }); } catch (e) { reject(e); } finally { bitmap.close?.(); }
    });
  }
  close() {
    try { this.worker?.postMessage({ type: 'close' }); } catch (_) { /* נעלם */ }
    setTimeout(() => { try { this.worker?.terminate(); } catch (_) { /* נעלם */ } }, 200);
    try { this.det?.close(); } catch (_) { /* נעלם */ }
  }
}

// ----------------------------------------------------------------------------------------------------------------- תמונות מהסרטון
function once(el, ev, errEv = 'error') {
  return new Promise((resolve, reject) => {
    const ok = () => { el.removeEventListener(ev, ok); el.removeEventListener(errEv, bad); resolve(); };
    const bad = () => { el.removeEventListener(ev, ok); el.removeEventListener(errEv, bad); reject(new Error(HE.badFile)); };
    el.addEventListener(ev, ok); el.addEventListener(errEv, bad);
  });
}

/** אחרי seek: מחכה לפריים החדש (ב־Safari "seeked" מגיע לפני שהפריים מצויר). אם requestVideoFrameCallback לא מגיע (דף מוסתר), מפסיקים לחכות לו בהמשך. */
async function seekTo(video, t) {
  const done = once(video, 'seeked');
  video.currentTime = t;
  await done;
  if (video.requestVideoFrameCallback && !video._noRvfc && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) {
    const got = await new Promise((resolve) => { const to = setTimeout(() => resolve(false), 250); video.requestVideoFrameCallback(() => { clearTimeout(to); resolve(true); }); });
    if (!got) video._noRvfc = true;
  }
}

/** בתים של תמונת סביבה אחת (RGB) בגודל env.side. */
const ew0 = (env, srcW, srcH) => env.side * Math.max(4, Math.round((env.side * srcH) / srcW));

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

/**
 * עובר על [start, end] של הסרטון ומחשב מסכת אדם בערך fps פעמים בשנייה (מוקטנת, צלע ארוכה = side).
 * env (אופציונלי) = {side, fps, radius, passes, look}: בנוסף שומר כמה פעמים בשנייה תמונת סביבה מטושטשת (ראו buildEnvRgb).
 * -> {times: [t מקור], frames: [Uint8Array w*h], cover: [0..1], env: {w, h, times, rgb} | null, w, h, srcW, srcH, stats}
 */
async function collectMasks({ file, start, end, fps, side, modelUrl, delegate, useWorker, base, onProgress, signal, decoder, env = null }) {
  let bestF = 0;                                              // ההתקדמות לא חוזרת אחורה (השלמת חורים דוגמת זמנים מוקדמים)
  const say = (f, t) => { bestF = Math.max(bestF, f); try { onProgress?.(clamp(bestF, 0, 1), t); } catch (_) { /* בעיה של הקורא */ } };
  const check = () => { if (signal?.aborted) throw abortError(); };
  const T0 = performance.now();
  const url = typeof file === 'string' ? file : URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true; video.defaultMuted = true; video.playsInline = true; video.preload = 'auto';
  video.setAttribute('playsinline', ''); video.setAttribute('muted', '');
  Object.assign(video.style, { position: 'fixed', left: '0', top: '0', width: '2px', height: '2px', opacity: '0.01', pointerEvents: 'none' });
  document.body.appendChild(video);
  const det = new SegHost({ base, model: modelUrl, delegate, useWorker });
  const onAbort = () => { try { video.pause(); } catch (_) { /* נעלם */ } };
  signal?.addEventListener('abort', onAbort);
  try {
    say(0, 'פותחים את הסרטון…');
    const loaded = once(video, 'loadedmetadata');
    video.src = url;
    const initP = det.init();                              // המודל נטען בזמן שהסרטון נפתח
    initP.catch(() => {});
    await loaded;
    check();
    const srcW = video.videoWidth, srcH = video.videoHeight, duration = video.duration;
    if (!srcW || !srcH || !(duration > 0)) throw new Error(HE.badFile);
    const a = clamp(+start || 0, 0, duration), b = clamp(Number.isFinite(+end) ? +end : duration, 0, duration);
    if (!(b - a > 0.05)) throw new Error(HE.badRange);
    say(0.02, 'טוענים את מודל הפרדת הרקע…');
    await initP.catch(() => { throw new Error(HE.model); });
    check();
    const { w: mw, h: mh } = maskSize(srcW, srcH, side);
    const useFps = chooseMaskFps(fps, b - a, mw * mh + (env ? (ew0(env, srcW, srcH) * env.fps * 3) / fps : 0));
    const step = 1 / useFps;
    const cv = makeCanvas(mw, mh), cx = cv.getContext('2d', { alpha: false });
    cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'medium';
    let ecv = null, ecx = null, ew = 0, eh = 0, envMs = 0;
    const envBuckets = new Set();                          // תמונת סביבה אחת לכל 1/env.fps שניות, בלי קשר לסדר הדגימה
    const envItems = [];
    if (env) {
      ew = env.side; eh = Math.max(4, Math.round((env.side * srcH) / srcW));
      ecv = makeCanvas(ew, eh); ecx = ecv.getContext('2d', { willReadFrequently: true });
      ecx.imageSmoothingQuality = 'high';
    }
    await seekTo(video, a);

    const times = [], frames = [], cover = [];
    let filled = 0, inflight = 0, drops = 0, nFrames = 0, inferMs = 0, grabMs = 0, failed = 0, usedDecoder = decoder;
    const waiters = [];
    const release = () => { inflight--; waiters.splice(0).forEach((f) => f()); };
    const room = async (max) => { while (inflight >= max) { check(); await new Promise((r) => waiters.push(r)); } };
    const progress = (t) => say(0.05 + 0.85 * clamp((t - a) / (b - a), 0, 1), `מזהים את הדובר בשנייה ${Math.floor(t - a)} מתוך ${Math.ceil(b - a)}…`);

    const take = (t) => {
      const g0 = performance.now();
      cx.drawImage(video, 0, 0, mw, mh);
      const bmp = cv.transferToImageBitmap ? cv.transferToImageBitmap() : null;
      const pBitmap = bmp ? Promise.resolve(bmp) : createImageBitmap(cv);
      grabMs += performance.now() - g0;
      const slot = frames.length;
      frames.push(null); times.push(t); cover.push(0);
      let envPx = null;
      if (env && !envBuckets.has(Math.round(t * env.fps))) {   // תמונת סביבה: הפריים הזה בגודל קטן, נשלם כשהמסכה תחזור
        const e0 = performance.now();
        envBuckets.add(Math.round(t * env.fps));
        ecx.drawImage(video, 0, 0, ew, eh);
        envPx = ecx.getImageData(0, 0, ew, eh).data;
        grabMs += performance.now() - e0;
      }
      inflight++; nFrames++;
      pBitmap.then((bm) => det.segment(bm)).then((r) => {
        inferMs += r.ms;
        frames[slot] = r.data.length === mw * mh ? r.data : null;
        cover[slot] = frames[slot] ? coverOf(frames[slot]) : 0;
        if (envPx && frames[slot]) {
          const e0 = performance.now();
          envItems.push({ t, rgb: buildEnvRgb(envPx, frames[slot], mw, mh, ew, eh, env) });
          envMs += performance.now() - e0;
        }
      }, () => { failed++; }).finally(release);
      progress(t);
    };

    const runSeek = async (from) => {
      for (let t = from; t < b - 1e-6; t += step) {
        check();
        await room(2);
        await seekTo(video, Math.min(t, b - 0.001));
        take(video.currentTime);
      }
    };

    const runPlay = async (from) => {
      // rVFC נקרא לכל היותר פעם ברענון המסך (60Hz), ובכל קריאה זמן המדיה מתקדם ב־rate/fps. לכן המהירות ההתחלתית נבחרת כך שהצעד לא יעלה על step, ואז מותאמת
      let rate = clamp(0.85 * 60 * step, 0.5, 8), nextT = from, lastFrameAt = performance.now(), prevT = from, stalled = false, winTaken = 0, winDrops = 0, winStride = 0;
      video.playbackRate = rate;
      await video.play();
      await new Promise((resolve, reject) => {
        const finish = () => { try { video.pause(); } catch (_) { /* נעלם */ } resolve(); };
        const watchdog = setInterval(() => {                // הפריימים נעצרו (טאב ברקע, מפענח שוויתר): משלימים ב־seek
          if (performance.now() - lastFrameAt > 2500) { clearInterval(watchdog); stalled = true; finish(); }
        }, 500);
        const cb = (now, md) => {
          lastFrameAt = performance.now();
          const t = md.mediaTime;
          if (signal?.aborted) { clearInterval(watchdog); return reject(abortError()); }
          if (t >= b - 1e-3 || video.ended) { clearInterval(watchdog); return finish(); }
          winStride = Math.max(winStride, t - prevT); prevT = t;
          if (t >= nextT - 0.25 * step) {
            if (inflight >= 2) { drops++; winDrops++; } else { take(t); winTaken++; }
            nextT = Math.max(nextT + step, t + step * 0.5);
          }
          if (winTaken + winDrops >= 6) {                    // מתאימים את המהירות: איטי יותר כשהמודל לא מספיק או כשהצעד גדול מדי, מהיר יותר כשיש מרווח
            rate = clamp(winDrops || winStride > step * 1.15 ? rate * 0.8 : rate * 1.12, 0.25, 8);
            video.playbackRate = rate; winTaken = winDrops = 0; winStride = 0;
          }
          video.requestVideoFrameCallback(cb);
        };
        video.requestVideoFrameCallback(cb);
        video.addEventListener('ended', () => { clearInterval(watchdog); finish(); }, { once: true });
      });
      if (stalled) { usedDecoder = 'seek'; return nextT; }
      return b;
    };

    const canPlay = typeof video.requestVideoFrameCallback === 'function';
    let mode = decoder === 'auto' ? (canPlay ? 'play' : 'seek') : decoder;
    if (mode === 'play' && !canPlay) mode = 'seek';
    usedDecoder = mode;
    if (mode === 'play') {
      let resume;
      try { resume = await runPlay(a); } catch (e) { if (e.name === 'AbortError') throw e; resume = times.length ? times[times.length - 1] + step : a; usedDecoder = 'seek'; }
      if (resume < b - step) { await seekTo(video, resume); await runSeek(resume); }
    } else {
      await runSeek(a);
    }
    // חורים (המודל לא הספיק, או שהדף הוסתר והפריימים הגיעו לאט): משלימים ב־seek
    const holes = gapTimes(times, a, b - 1e-3, step);
    for (const t of holes) {
      check();
      await room(2);
      await seekTo(video, Math.min(t, b - 0.001));
      take(video.currentTime);
    }
    filled = holes.length;
    while (inflight > 0) { check(); await new Promise((r) => waiters.push(r)); }
    // פריימים שנכשלו: משלימים מהשכן הקרוב; אם רובם נכשלו, זו שגיאה
    const ok = frames.filter(Boolean).length;
    if (!ok || failed > frames.length / 2) throw new Error(HE.segFail);
    for (let i = 0; i < frames.length; i++) {
      if (frames[i]) continue;
      let k = 1;
      while (!(frames[i - k] || frames[i + k]) && k < frames.length) k++;
      frames[i] = frames[i - k] ? frames[i - k] : frames[i + k];
    }
    const order = times.map((t, i) => i).sort((x, y) => times[x] - times[y]);       // בדרך כלל כבר מסודר
    const sorted = order.every((v, i) => v === i);
    const seconds = (performance.now() - T0) / 1000;
    return {
      times: sorted ? times : order.map((i) => times[i]), frames: sorted ? frames : order.map((i) => frames[i]), cover: sorted ? cover : order.map((i) => cover[i]),
      env: env && envItems.length ? { w: ew, h: eh, times: envItems.sort((x, y) => x.t - y.t).map((e) => e.t), rgb: envItems.map((e) => e.rgb) } : null,
      w: mw, h: mh, srcW, srcH, range: { start: a, end: b },
      stats: {
        envSamples: envItems.length, envMsPerSample: envMs / Math.max(1, envItems.length),
        seconds, perVideoSecond: seconds / (b - a), decoder: usedDecoder, delegate: det.delegate, workerMode: det.mode, workerError: det.workerError || null,
        frames: nFrames, drops, filled, failedFrames: failed, maskFps: nFrames / (b - a), modelMs: det.initMs, grabMsPerFrame: grabMs / Math.max(1, nFrames), inferMsPerFrame: inferMs / Math.max(1, nFrames),
        mask: `${mw}x${mh}`, labels: det.labels,
      },
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try { video.pause(); } catch (_) { /* נעלם */ }
    video.removeAttribute('src'); video.load?.();
    video.remove();
    if (typeof file !== 'string') URL.revokeObjectURL(url);
    det.close();
  }
}

// ----------------------------------------------------------------------------------------------------------------- הרקע עצמו
/** מקור הרקע החדש: מזהה מובנה -> {kind:'builtin', id}; תמונה (Blob/File/ImageBitmap/תמונה/כתובת) -> {kind:'image', bitmap}. */
async function loadBackgroundSource(image) {
  if (image === undefined || image === null || image === '') return { kind: 'builtin', id: 'studio-dark' };
  if (typeof image === 'string' && BUILTIN[image]) return { kind: 'builtin', id: image };
  if (typeof image === 'string' && /^(blob:|data:|https?:|\/|\.\/|\.\.\/)/.test(image)) {
    try { const r = await fetch(image); if (!r.ok) throw new Error('http'); return { kind: 'image', bitmap: await createImageBitmap(await r.blob()) }; } catch (_) { throw new Error(HE.badImage); }
  }
  if (typeof image === 'string') throw new Error(`${HE.badBg}: ${image}`);
  try {
    if (typeof Blob !== 'undefined' && image instanceof Blob) return { kind: 'image', bitmap: await createImageBitmap(image) };
    if (image.width && image.height) return { kind: 'image', bitmap: image };
  } catch (_) { /* נופל להודעה */ }
  throw new Error(HE.badImage);
}

function paintRamp(ctx, ramp, W, H) {
  const [kind, geo, stops] = ramp;
  ctx.save();
  let grad;
  if (kind === 'lin') {
    ctx.setTransform(W, 0, 0, H, 0, 0);
    grad = ctx.createLinearGradient(geo[0], geo[1], geo[2], geo[3]);
  } else {                                                   // אליפסה: רדיוס 1 במרחב מוגדל
    ctx.setTransform(geo[2] * W, 0, 0, geo[3] * H, geo[0] * W, geo[1] * H);
    grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  }
  for (const [p, c] of stops) grad.addColorStop(p, c);
  ctx.fillStyle = grad;
  ctx.fillRect(-1e5, -1e5, 2e5, 2e5);
  ctx.restore();
}

/** הרקע החדש (תמונה סטטית בגודל הפלט): מזהה מובנה או התמונה של המשתמש, מכוסה ובמעט מחוץ לפוקוס. נשמר במטמון לפי גודל. */
function staticBackground(bg, W, H) {
  const key = `${W}x${H}`;
  if (bg._pic && bg._pic.key === key) return bg._pic.cv;
  const cv = makeCanvas(W, H), cx = cv.getContext('2d');
  const src = bg._source;
  if (src.kind === 'builtin') {
    paintRamp(cx, BUILTIN[src.id].ramp, W, H);
    const id = cx.getImageData(0, 0, W, H), d = id.data;     // רעש עדין נגד פסים בגרדיאנט (כמו noise ב־segment.py)
    let s = 123456789;
    for (let i = 0; i < d.length; i += 4) {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      const n = ((s >>> 0) % 5) - 2;
      d[i] = clamp(d[i] + n, 0, 255); d[i + 1] = clamp(d[i + 1] + n, 0, 255); d[i + 2] = clamp(d[i + 2] + n, 0, 255);
    }
    cx.putImageData(id, 0, 0);
  } else {
    const bm = src.bitmap, c = coverRect(bm.width, bm.height, W, H);
    const small = makeCanvas(Math.max(2, W >> 1), Math.max(2, H >> 1)), sx = small.getContext('2d');
    sx.imageSmoothingQuality = 'high';
    sx.drawImage(bm, c.sx, c.sy, c.sw, c.sh, 0, 0, small.width, small.height);   // חצי רזולוציה ואז חזרה: טשטוש קל
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(small, 0, 0, W, H);
  }
  bg._pic = { key, cv };
  return cv;
}

function scratch(bg, name, w, h, readback = false) {
  const s = bg._cache[name];
  if (s && s.w === w && s.h === h) return s;
  const cv = makeCanvas(w, h), cx = cv.getContext('2d', readback ? { willReadFrequently: true } : undefined);
  const n = { cv, cx, w, h, img: null };
  bg._cache[name] = n;
  return n;
}

function frameSize(f) {
  if (typeof VideoFrame !== 'undefined' && f instanceof VideoFrame) return [f.displayWidth || f.codedWidth, f.displayHeight || f.codedHeight];
  if (f.videoWidth) return [f.videoWidth, f.videoHeight];
  if (f.naturalWidth) return [f.naturalWidth, f.naturalHeight];
  return [f.width, f.height];
}

function sourceTimeOf(bg, tOut, frame, opts) {
  if (Number.isFinite(opts.tSource)) return opts.tSource;
  if (bg.plan) { const t = planToSource(bg.plan, tOut); if (t !== null) return t; }
  if (opts.cropped) return bg.range.start + tOut;           // פריים שהוא תוצר של הרינדור: הזמן שעליו הוא זמן פלט, לא זמן מקור
  const lo = bg.range.start - 0.5, hi = bg.range.end + 0.5;
  const ts = frame && typeof frame.timestamp === 'number' ? frame.timestamp / 1e6 : NaN;
  if (Number.isFinite(ts) && ts >= lo && ts <= hi) return ts;
  const ct = frame && typeof frame.currentTime === 'number' ? frame.currentTime : NaN;
  if (Number.isFinite(ct) && ct >= lo && ct <= hi) return ct;
  return bg.range.start + tOut;
}

function noteTime(bg, key, ms) {
  const T = bg.timing;
  T[key] = T[key] === undefined ? ms : T[key] * 0.9 + ms * 0.1;
}

/**
 * מצייר את שכבת הרקע החדש: רקע מוכן (או הסביבה המטושטשת) שהאדם נחתך ממנו, מעל מה שכבר ב־ctx.
 * ctx: קנבס הפלט (או השכבה השקופה של render.js); frameSource: null (ברירת המחדל, ה־ctx כבר מכיל פריים או שהוא שכבה שמורכבת מעל פריים), או VideoFrame | ImageBitmap | <video> | קנבס:
 * אז הפריים החתוך מצויר קודם, והפונקציה עובדת גם על קנבס ריק. tOut: זמן פלט (שניות). rect: {x,y,w,h} מנורמל במקור (camera.rectAt(tOut)), או null לפריים כולו.
 * opts: {dest: {x,y,w,h} בפיקסלים של ה־ctx, tSource: זמן המקור של הפריים, cropped: הפריים כבר חתוך לפי המצלמה (render({overlayFrame:true})): מצויר כולו אל dest,
 * וה־rect ממשיך לקבוע איזה חלק מהמסכה נלקח (המסכות במרחב המקור, ולכן rect הוא camera.rectAt(tOut) ולא הפריים כולו)}.
 * מחזיר true כשהוחל אפקט, false כשלא (אין אדם בפריים, mode:'none', או bg סגור): אז לא נוגעים ב־ctx (חוץ מציור הפריים, אם נשלח).
 */
export function drawWithBackground(ctx, frameSource, tOut, bg, rect = null, opts = {}) {
  const tr = bg && !bg.closed && bg.mode !== 'none' ? bg.track : null;
  const cvs = ctx.canvas, W = cvs.width, H = cvs.height;
  const dest = opts.dest || { x: 0, y: 0, w: W, h: H };
  const [fw, fh] = frameSource ? frameSize(frameSource) : tr ? [tr.srcW, tr.srcH] : [1, 1];
  const g = tr ? cropGeometry(rect, fw, fh, tr.w, tr.h, dest) : null;
  const drawFrame = () => {
    if (!frameSource) return;
    if (opts.cropped) { ctx.drawImage(frameSource, 0, 0, fw, fh, dest.x, dest.y, dest.w, dest.h); return; }   // כבר חתוך: כולו אל היעד
    const q = cropGeometry(rect, fw, fh, 1, 1, dest);
    if (q) ctx.drawImage(frameSource, q.sx, q.sy, q.sw, q.sh, q.dx, q.dy, q.dw, q.dh);
  };
  if (!tr || !g) { drawFrame(); return false; }
  const T0 = performance.now();
  const mw = tr.w, mh = tr.h;
  const tSrc = sourceTimeOf(bg, tOut, frameSource, opts);
  const pair = maskPair(tr.times, tSrc);
  const k = pair ? presenceFade(coverAt(tr, pair)) : 0;
  if (!(k > 0.002)) { drawFrame(); return false; }          // אין אדם בצילום הזה: לא נוגעים בו

  // 1. המסכה: ערבוב שתי מסכות סמוכות, ריכוך, והעברה לקנבס קטן
  const alpha = bg._alpha;
  blendMasks(tr.frames[pair.i], tr.frames[pair.j], pair.f, alpha, bg._lut);
  if (bg.options.feather > 0) featherMask(alpha, mw, mh, bg.options.feather, alpha, bg._tmp);
  const mk = scratch(bg, 'mask', mw, mh);
  if (!mk.img) { mk.img = mk.cx.createImageData(mw, mh); mk.img.data.fill(255); }
  const md = mk.img.data;
  for (let i = 0, j = 3; i < alpha.length; i++, j += 4) md[j] = alpha[i];
  mk.cx.putImageData(mk.img, 0, 0);
  const t1 = performance.now();

  // 2. הרקע: הסביבה המטושטשת (טשטוש), או תמונה מוכנה (החלפה, עם מעט מהסביבה)
  const L = scratch(bg, 'layer', W, H);
  const lx = L.cx;
  lx.globalAlpha = 1;
  // הטיפה מהסביבה (החלפה) רק כשהפריים ממלא את כל היעד; בפריסת fit היא הייתה משאירה מלבן בהיר סביב הפריים
  const fills = g.dx <= dest.x + 1 && g.dy <= dest.y + 1 && g.dx + g.dw >= dest.x + dest.w - 1 && g.dy + g.dh >= dest.y + dest.h - 1;
  const useEnv = tr.env && (bg.mode === 'blur' || (bg.options.tint > 0 && fills));
  // הציור הראשון בשכבה הוא 'copy': מחליף את כל מה שהיה בה (חוסך clearRect). בלי ציור ראשון מנקים
  lx.globalCompositeOperation = bg.mode === 'replace' || useEnv ? 'copy' : 'source-over';
  if (bg.mode === 'replace') { lx.drawImage(staticBackground(bg, W, H), dest.x, dest.y, dest.w, dest.h, dest.x, dest.y, dest.w, dest.h); lx.globalCompositeOperation = 'source-over'; }
  else if (!useEnv) lx.clearRect(0, 0, W, H);
  if (useEnv) {
    const ep = maskPair(tr.env.times, tSrc, 2);
    const E = scratch(bg, 'env', tr.env.w, tr.env.h);
    if (!E.img) E.img = E.cx.createImageData(tr.env.w, tr.env.h);
    lerpRgbToRgba(tr.env.rgb[ep.i], ep.f > 0 ? tr.env.rgb[ep.j] : null, ep.f, E.img.data);
    E.cx.putImageData(E.img, 0, 0);
    lx.globalAlpha = bg.mode === 'blur' ? 1 : bg.options.tint;
    lx.drawImage(E.cv, g.u0 * tr.env.w, g.v0 * tr.env.h, (g.u1 - g.u0) * tr.env.w, (g.v1 - g.v0) * tr.env.h, g.dx, g.dy, g.dw, g.dh);
    lx.globalAlpha = 1; lx.globalCompositeOperation = 'source-over';
  }
  const t2 = performance.now();

  // 3. ההרכבה: מוציאים מהרקע את מקום האדם, ומניחים מעל הפריים
  lx.globalCompositeOperation = 'destination-out';
  lx.drawImage(mk.cv, g.mx, g.my, g.mw, g.mh, g.dx, g.dy, g.dw, g.dh);
  lx.globalCompositeOperation = 'source-over';
  drawFrame();
  const ga = ctx.globalAlpha, op = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = ga * k;
  ctx.drawImage(L.cv, dest.x, dest.y, dest.w, dest.h, dest.x, dest.y, dest.w, dest.h);
  ctx.globalAlpha = ga; ctx.globalCompositeOperation = op;
  const t3 = performance.now();

  bg.timing.n++;
  noteTime(bg, 'mask', t1 - T0); noteTime(bg, 'bg', t2 - t1); noteTime(bg, 'compose', t3 - t2); noteTime(bg, 'total', t3 - T0);
  return true;
}

function coverAt(tr, p) {
  const a = tr.cover[p.i], b = tr.cover[p.j];
  return a + (b - a) * p.f;
}

// ----------------------------------------------------------------------------------------------------------------- prepareBackground
function makeBg(fields) {
  const bg = {
    mode: 'none', background: null, range: { start: 0, end: 0 }, track: null, plan: null, closed: false,
    options: { feather: 0, tint: TINT_ALPHA, edgeLo: EDGE_LO, edgeHi: EDGE_HI },
    stats: null, timing: { n: 0 }, notes: [], found: 0,
    _cache: {}, _pic: null, _source: null, _alpha: null, _tmp: null, _lut: featherLut(),
    setPlan(plan) { bg.plan = plan || null; return bg; },
    /** מחליף את טווח הריכוך (0..1): lo = מתחתיו רקע, hi = מעליו אדם. */
    setEdge(lo, hi) { bg.options.edgeLo = lo; bg.options.edgeHi = hi; bg._lut = featherLut(lo, hi); return bg; },
    close() {
      bg.closed = true; bg.track = null; bg._cache = {}; bg._pic = null;
      try { bg._source?.bitmap?.close?.(); } catch (_) { /* נסגר כבר */ }
    },
    ...fields,
  };
  return bg;
}

/** מסתיר את הפעלת האפקט כשהמשתמש לא ביקש רקע: אובייקט ריק שמציירים איתו (לא עושה כלום). */
export function releaseBackground(bg) { bg?.close?.(); }

/**
 * מכין את הרקע של הקטע [start, end] (שניות, זמני מקור) של `file`.
 * opts: mode 'blur' | 'replace' | 'none'; image (ל־replace): מזהה מובנה (BACKGROUNDS) או Blob/File/ImageBitmap/כתובת; plan (מיפוי זמן פלט -> מקור, אפשר גם אחר כך ב־bg.setPlan);
 * quality 'auto'|'fast'|'high' (מודל; ברירת מחדל auto: high, וב־fast למכשיר חלש) או model:'selfie'|'landscape'|'multiclass'; smooth {radius, sigma} או false (בלי ממוצע נע); fps (מסכות בשנייה: 10 ב־high, 15 ב־fast, ולא יותר מ־700 מסכות לקליפ); side (256); delegate ('GPU'|'CPU'); useWorker; onProgress(fraction, textHe); signal.
 */
export async function prepareBackground(file, start = 0, end = Infinity, opts = {}) {
  const { mode = 'blur', image, plan = null, onProgress, signal } = opts;
  if (!['blur', 'replace', 'none'].includes(mode)) throw new Error(`${HE.badMode}: ${mode}`);
  if (signal?.aborted) throw abortError();
  if (mode === 'none') return makeBg({ mode: 'none', range: { start: +start || 0, end: Number.isFinite(+end) ? +end : 0 }, plan });
  if (typeof document === 'undefined') throw new Error(HE.noBrowser);
  const source = mode === 'replace' ? await loadBackgroundSource(image) : null;
  const quality = QUALITY_MODEL[opts.quality] ? opts.quality : pickQuality();
  const modelId = opts.model || QUALITY_MODEL[quality];
  const model = MODELS[modelId];
  if (!model) throw new Error(`${HE.badMode}: ${modelId}`);
  try {
    const m = await collectMasks({
      file, start, end, fps: opts.fps || (opts.model ? MASK_FPS : QUALITY_FPS[quality]), side: opts.side || MASK_SIDE, modelUrl: opts.modelUrl || model.url, delegate: opts.delegate || 'GPU',
      useWorker: opts.useWorker, base: opts.base || MEDIAPIPE_BASE, onProgress, signal, decoder: opts.decoder || 'auto',
      env: mode === 'blur' ? ENV_BLUR : opts.tint === 0 ? null : ENV_TINT,
    });
    onProgress?.(0.92, 'מחליקים את הקצוות בזמן…');
    const t0 = performance.now();
    const flickerRaw = edgeFlicker(m.frames);
    const cover = smoothSeries(m.cover, 3);                     // כיסוי האדם מוחלק, כדי שהאפקט לא יידלק ויכבה בין פריים לפריים
    const sm = createTemporalSmoother(opts.smooth || {});
    for (let i = 0; opts.smooth !== false && i < m.frames.length; i += 100) {
      if (signal?.aborted) throw abortError();
      sm.run(m.frames, i, Math.min(m.frames.length, i + 100));
      await new Promise((r) => setTimeout(r, 0));               // נותנים לממשק לנשום
    }
    const smoothMs = performance.now() - t0;
    const flicker = { raw: flickerRaw, smoothed: edgeFlicker(m.frames) };
    const bg = makeBg({
      mode, background: mode === 'blur' ? 'blur' : source.kind === 'builtin' ? source.id : 'custom', range: m.range, plan,
      track: { times: m.times, frames: m.frames, cover, env: m.env, w: m.w, h: m.h, srcW: m.srcW, srcH: m.srcH },
      stats: { ...m.stats, smoothMs, flicker, model: model.id, modelBytes: model.bytes },
      _source: source,
    });
    if (opts.tint !== undefined) bg.options.tint = opts.tint;
    bg._alpha = new Uint8Array(m.w * m.h);
    bg._tmp = new Uint8Array(m.w * m.h);
    bg.found = cover.filter((c) => presenceFade(c) > 0.5).length / Math.max(1, cover.length);
    if (bg.found < 0.05) bg.notes.push('לא זוהה אדם בקטע, ולכן הרקע לא שונה');
    onProgress?.(1, 'הרקע מוכן');
    return bg;
  } catch (e) {
    if (source?.bitmap) try { source.bitmap.close?.(); } catch (_) { /* נסגר כבר */ }
    throw e;
  }
}

export const _internal = { collectMasks, SegHost, staticBackground, makeBg, EDGE_LO, EDGE_HI, TEMPORAL_RADIUS, TEMPORAL_SIGMA, ENV_BLUR, ENV_TINT, TINT_ALPHA };
