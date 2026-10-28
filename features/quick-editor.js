// עורך מהיר (סוכן 15, סבב 8).
// אחרי שקליפ נוצר, המשתמש מתקן אותו בתצוגה חיה על קנבס, בלי לחכות לרינדור. רק "ייצוא" מרנדר.
//
//   mountQuickEditor(el, { clipState, onExport, onChange?, brand?, modules?, fullscreen? }) -> editor
//   clipState = { file, plan, camera, captionSpec, audioOptions, effects, brand?, moment?, ...}  (מה ש־pipeline מחזיר ב־clip.state)
//   onExport(newState, { onProgress(fraction, textHe), signal }) -> Promise|void
//     newState = clipState אחרי העריכות, בדיוק במבנה ש־pipeline.renderState(state, {onProgress, signal}) מצפה לו:
//       plan (אחרי קיצוץ), camera (עם overrides של המסגור, בלי זום האפקטים, כי renderState מוסיף אותו), captionSpec (מילים מתוקנות, סגנון, hook,
//       duration), audioOptions ({music, loudness, musicGainDb, level}), effects (מוזז לפי הקיצוץ), ושאר השדות כמו שהיו.
//     בנוסף: `edits` (רשומת העריכות, JSON, אפשר לשמור ולשחזר עם session.restore) ו־`trim` ({start, end, offset, duration, applied}).
//   modules (אופציונלי, לבדיקות): { captions, fx } להזרקת מודולים במקום import דינמי; null = stub.
//
// המסמך בנוי משלושה חלקים:
//   א. לוגיקה טהורה (בלי DOM, נבדקת ב־node): מיפוי זמנים, override של מצלמה, עריכת מילים, קיצוץ, היסטוריית ביטול.
//   ב. עזרים לממשק (מחוות, ציר זמן, בקרת איכות), גם הם טהורים.
//   ג. הממשק עצמו (DOM + קנבס), שנטען רק כשקוראים ל־mountQuickEditor.
//
// עיקרון: ה־clipState המקורי לא משתנה. כל עריכה היא רשומה קטנה ב־`edits`, והמצב הסופי נגזר מהם
// (`applyEdits`). כך ביטול הוא פשוט, והתצוגה המקדימה והייצוא תמיד מראים אותו דבר.

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// א. קבועים ועזרים קטנים
// ═════════════════════════════════════════════════════════════════════════════════════════════════

export const MIN_CLIP = 1;            // אורך מינימלי של קליפ אחרי קיצוץ (שניות)
export const MIN_SHOT = 0.15;         // קטע מצלמה קצר מזה מתמזג עם שכנו
export const MIN_PIECE = 0.08;        // מילה מפוצלת לא תהיה קצרה מזה (שניות)
export const ZOOM_MIN = 0.4;
export const ZOOM_MAX = 4;
export const WORD_MAX_CHARS = 32;
export const HISTORY_LIMIT = 200;

/** שלוש רמות עוצמה. loudness ו־musicGainDb עוברים ל־buildTrack; volume הוא קירוב לתצוגה המקדימה בלבד. */
export const LEVELS = {
  quiet: { id: 'quiet', nameHe: 'שקטה', loudness: -18, musicGainDb: -4, volume: 0.5 },
  normal: { id: 'normal', nameHe: 'רגילה', loudness: -14, musicGainDb: 0, volume: 0.8 },
  loud: { id: 'loud', nameHe: 'חזקה', loudness: -11, musicGainDb: 2, volume: 1 },
};

export const MUSIC = [
  { id: '', nameHe: 'בלי מוזיקה' },
  { id: 'lofi', nameHe: 'לואו-פיי' },
  { id: 'drive', nameHe: 'אנרגטי' },
  { id: 'playful', nameHe: 'שובב' },
  { id: 'epic', nameHe: 'אפי' },
  { id: 'ambient', nameHe: 'אווירה רגועה' },
];

/** סגנונות כתוביות לגיבוי, כשמודול הכתוביות (סוכן 5) עוד לא נטען. */
export const FALLBACK_STYLES = [
  { id: 'clean', name: 'נקי' },
  { id: 'bold', name: 'מודגש' },
  { id: 'punch', name: 'בולט' },
  { id: 'karaoke', name: 'קריוקי' },
  { id: 'neon', name: 'ניאון' },
];

const EPS = 1e-9;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const r3 = (x) => Math.round(x * 1000) / 1000;
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** מחרוזת יציבה (מפתחות ממוינים) להשוואת עריכות. */
export function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// א1. מיפוי זמנים: מקור <-> פלט
// ═════════════════════════════════════════════════════════════════════════════════════════════════

/** [{a, b, off, len}]: קטעי המקור שנשארו, ואיפה כל אחד מתחיל בפלט. */
export function planSegments(plan) {
  const out = [];
  let off = 0;
  for (const s of plan?.segments || []) {
    const a = Number(s?.[0]); const b = Number(s?.[1]);
    if (!(b > a)) continue;
    out.push({ a, b, off, len: b - a });
    off += b - a;
  }
  return out;
}

export const planLength = (plan) => planSegments(plan).reduce((t, s) => t + s.len, 0);

/** זמן מקור של זמן פלט. מחוץ לטווח: צמוד לקצה. */
export function outToSource(plan, tOut) {
  const segs = planSegments(plan);
  if (!segs.length) return Math.max(0, tOut);
  const total = segs[segs.length - 1].off + segs[segs.length - 1].len;
  const t = clamp(tOut, 0, total);
  for (const s of segs) if (t < s.off + s.len - EPS) return s.a + (t - s.off);
  return segs[segs.length - 1].b;
}

/** זמן פלט של זמן מקור, או null כשהזמן נחתך (או מחוץ לקליפ). tol הוא סבילות בשניות. */
export function sourceToOut(plan, tSrc, tol = 1e-3) {
  for (const s of planSegments(plan)) if (tSrc >= s.a - tol && tSrc <= s.b + tol) return s.off + clamp(tSrc - s.a, 0, s.len);
  return null;
}

/**
 * מה לעשות עכשיו בניגון לפי plan.segments. בסוף קטע קופצים לתחילת הבא. אחרי האחרון: חוזרים להתחלה (loop) או עוצרים.
 * -> { action: 'play'|'jump'|'end', to?, index?, wrapped? }
 */
export function playbackStep(plan, tSrc, { lookahead = 0.02, loop = true } = {}) {
  const segs = planSegments(plan);
  if (!segs.length) return { action: 'play' };
  if (tSrc < segs[0].a - 0.05) return { action: 'jump', to: segs[0].a, index: 0 };
  let i = 0;
  for (let k = 0; k < segs.length; k++) { if (segs[k].a <= tSrc + EPS) i = k; else break; }
  const s = segs[i];
  if (tSrc < s.b - lookahead) return { action: 'play', index: i };
  const next = segs[i + 1];
  if (next) {
    if (next.a - s.b < 0.02) return { action: 'play', index: i };   // קטעים רצופים במקור: אין צורך בקפיצה
    return { action: 'jump', to: next.a, index: i + 1 };
  }
  return loop ? { action: 'jump', to: segs[0].a, index: 0, wrapped: true } : { action: 'end', index: i };
}

/** מקצץ את התוכנית לטווח [a, b] בזמן פלט. */
export function trimPlan(plan, a, b) {
  const out = [];
  for (const s of planSegments(plan)) {
    const lo = Math.max(a, s.off); const hi = Math.min(b, s.off + s.len);
    if (hi - lo > 1e-6) out.push([r6(s.a + (lo - s.off)), r6(s.a + (hi - s.off))]);
  }
  return { ...plan, segments: out, duration: r6(out.reduce((t, [x, y]) => t + y - x, 0)) };
}

/** טווח הקיצוץ בצורה תקינה, או null כשאין קיצוץ בפועל. */
export function normTrim(trim, duration) {
  if (!trim || !(duration > MIN_CLIP)) return null;
  const a = clamp(Number(trim.start) || 0, 0, duration - MIN_CLIP);
  const b = clamp(isNum(trim.end) ? trim.end : duration, a + MIN_CLIP, duration);
  if (a < 0.0005 && b > duration - 0.0005) return null;
  return { start: r3(a), end: r3(b) };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// א2. מצלמה: קטעים (shots) ו־override של מסגור
// ═════════════════════════════════════════════════════════════════════════════════════════════════

/** גבולות הקטעים בפלט: חיתוכי המצלמה, קפיצות ה־plan, ומעברי split. -> [{i, a, b}] */
export function shotsOf(camera, plan, duration) {
  const pts = [0, duration];
  for (const c of camera?.cuts || []) if (isNum(c)) pts.push(c);
  for (const s of planSegments(plan).slice(1)) pts.push(s.off);
  for (const iv of camera?.split?.intervals || []) { if (isNum(iv.start)) pts.push(iv.start); if (isNum(iv.end)) pts.push(iv.end); }
  const sorted = [...new Set(pts.filter((t) => t >= 0 && t <= duration).map(r3))].sort((x, y) => x - y);
  const bs = [0];
  for (const t of sorted) {
    if (t <= bs[bs.length - 1]) continue;
    if (t - bs[bs.length - 1] < MIN_SHOT) continue;
    bs.push(t);
  }
  if (bs[bs.length - 1] < duration) {
    if (duration - bs[bs.length - 1] < MIN_SHOT && bs.length > 1) bs[bs.length - 1] = duration; else bs.push(duration);
  }
  const out = [];
  for (let i = 0; i + 1 < bs.length; i++) out.push({ i, a: bs[i], b: bs[i + 1] });
  return out.length ? out : [{ i: 0, a: 0, b: duration }];
}

export function shotIndexAt(shots, t) {
  let lo = 0; let hi = shots.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (shots[m].a <= t + EPS) lo = m; else hi = m - 1; }
  return lo;
}

export const overrideKey = (part, start) => `${part}@${r3(start)}`;

/** חיתוך באמצע בגודל המקסימלי, ביחס של הפלט (כשהמצלמה במצב "התאמה" והמלבן הוא כל הפריים). */
export function fitCropRect(srcAspect, outAspect) {
  if (outAspect <= srcAspect) { const w = outAspect / srcAspect; return { x: (1 - w) / 2, y: 0, w, h: 1 }; }
  const h = srcAspect / outAspect;
  return { x: 0, y: (1 - h) / 2, w: 1, h };
}

/** מפעיל override {dx, dy, zoom} על מלבן (מנורמל במקור): הזזת המרכז וזום, בלי לצאת מהפריים. */
export function applyFraming(rect, ov) {
  if (!ov) return rect;
  const z = clamp(Number(ov.zoom) || 1, 0.05, 40);
  let w = rect.w / z; let h = rect.h / z;
  const big = Math.max(w, h);
  if (big > 1) { w /= big; h /= big; }
  const cx = rect.x + rect.w / 2 + (Number(ov.dx) || 0);
  const cy = rect.y + rect.h / 2 + (Number(ov.dy) || 0);
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
}

/** האם ה־override כמעט זהה ללא override. */
export const isIdentityOverride = (ov) => !ov || (Math.abs(ov.dx || 0) < 1e-4 && Math.abs(ov.dy || 0) < 1e-4 && Math.abs((ov.zoom || 1) - 1) < 1e-3);

/**
 * גרירה: הזזת התמונה באצבע (כמו במפה). fx, fy = חלק מרוחב וגובה האזור המוצג (כלומר פיקסלים חלקי גודל הקנבס).
 * התמונה זזה עם האצבע, אז החלון במקור זז בכיוון ההפוך. rect = המלבן של המצלמה בלי override.
 */
export function panOverride(ov, rect, fx, fy) {
  const cur = applyFraming(rect, ov);
  const cx = cur.x + cur.w / 2 - fx * cur.w;
  const cy = cur.y + cur.h / 2 - fy * cur.h;
  const nx = clamp(cx - cur.w / 2, 0, 1 - cur.w);
  const ny = clamp(cy - cur.h / 2, 0, 1 - cur.h);
  return {
    zoom: ov?.zoom || 1,
    dx: r6(nx + cur.w / 2 - (rect.x + rect.w / 2)),
    dy: r6(ny + cur.h / 2 - (rect.y + rect.h / 2)),
  };
}

/** זום סביב נקודה (u, v בין 0 ל־1 בתוך האזור המוצג): הנקודה שמתחת לאצבעות נשארת במקומה. */
export function zoomOverride(ov, rect, factor, u = 0.5, v = 0.5, { min = ZOOM_MIN, max = ZOOM_MAX } = {}) {
  const cur = applyFraming(rect, ov);
  const z0 = ov?.zoom || 1;
  let z1 = clamp(z0 * factor, min, max);
  z1 = Math.max(z1, Math.max(rect.w, rect.h));          // אי אפשר להרחיק מעבר לפריים המלא
  const w2 = rect.w / z1; const h2 = rect.h / z1;
  const px = cur.x + u * cur.w; const py = cur.y + v * cur.h;
  const nx = clamp(px - u * w2, 0, 1 - w2);
  const ny = clamp(py - v * h2, 0, 1 - h2);
  return {
    zoom: r6(z1),
    dx: r6(nx + w2 / 2 - (rect.x + rect.w / 2)),
    dy: r6(ny + h2 / 2 - (rect.y + rect.h / 2)),
  };
}

/** המלבן של המצלמה (בלי override) בזמן פלט t, לחלק main/top/bottom. */
export function baseRectOf(camera, part, t, { srcAspect = 16 / 9, outAspect = 9 / 16 } = {}) {
  if (part === 'top' && camera?.split?.topAt) return camera.split.topAt(t);
  if (part === 'bottom' && camera?.split?.bottomAt) return camera.split.bottomAt(t);
  if (!camera || camera.layout === 'fit') return fitCropRect(srcAspect, outAspect);
  return camera.rectAt(t);
}

/** מעדכן מפה של overrides: ערך זהה לברירת מחדל מוחק את הרשומה. */
export function withFraming(framing, key, ov, shot) {
  const next = { ...(framing || {}) };
  if (!ov || isIdentityOverride(ov)) delete next[key];
  else next[key] = { start: shot ? r3(shot.a) : ov.start, end: shot ? r3(shot.b) : ov.end, dx: r6(ov.dx || 0), dy: r6(ov.dy || 0), zoom: r6(ov.zoom || 1) };
  return next;
}

/**
 * מצלמה חדשה שבה הקטעים עם override מוזזים ומוגדלים. המצלמה המקורית לא משתנה.
 * מצלמה במצב "התאמה" (fit) שמקבלת override הופכת ל־tracked: שאר הקטעים בחיתוך מרכזי.
 */
export function cameraWithOverrides(camera, framing, { shots, srcAspect = 16 / 9, outAspect = 9 / 16 } = {}) {
  const keys = framing ? Object.keys(framing) : [];
  if (!camera || !keys.length) return camera;
  const env = { srcAspect, outAspect };
  const find = (t) => shots[shotIndexAt(shots, t)];
  const wrap = (part, get) => (t) => {
    const base = get(t);
    const ov = framing[overrideKey(part, find(t).a)];
    return ov ? applyFraming(base, ov) : base;
  };
  const isFit = camera.layout === 'fit';
  const hasMain = keys.some((k) => k.startsWith('main@'));
  const out = { ...camera };
  out.rectAt = wrap('main', (t) => baseRectOf(camera, 'main', t, env));
  if (isFit && hasMain) out.layout = 'tracked';
  if (camera.split && keys.some((k) => k.startsWith('top@') || k.startsWith('bottom@'))) {
    out.split = {
      ...camera.split,
      topAt: wrap('top', (t) => camera.split.topAt(t)),
      bottomAt: wrap('bottom', (t) => camera.split.bottomAt(t)),
    };
  }
  out.info = { ...(camera.info || {}), edited: true };
  out.overrides = clone(framing);
  return out;
}

/** מזיז את ציר הזמן של המצלמה: מה שהיה ב־offset הופך ל־0. duration = אורך הקליפ החדש. */
export function shiftCamera(camera, offset, duration) {
  if (!camera || !(offset > 0 || isNum(duration))) return camera;
  const cam = { ...camera };
  cam.rectAt = (t) => camera.rectAt(t + offset);
  cam.cuts = (camera.cuts || []).map((c) => r3(c - offset)).filter((c) => c > 0.001 && (!isNum(duration) || c < duration - 0.001));
  delete cam.path;
  if (camera.split) {
    const sp = camera.split;
    cam.split = {
      ...sp,
      intervals: (sp.intervals || []).map((iv) => ({ start: Math.max(0, r3(iv.start - offset)), end: Math.min(isNum(duration) ? duration : Infinity, r3(iv.end - offset)) })).filter((iv) => iv.end > iv.start),
      active: (t) => sp.active(t + offset),
      topAt: (t) => sp.topAt(t + offset),
      bottomAt: (t) => sp.bottomAt(t + offset),
    };
  }
  cam.info = { ...(camera.info || {}), trimOffset: offset };
  return cam;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// א3. מילים: תיקון כתיב בלי לשבור את התזמון
// ═════════════════════════════════════════════════════════════════════════════════════════════════

/** מנקה טקסט של מילה: בלי תווי בקרה ובלי תווי כיוון מסוכנים, רווחים בודדים. */
export function sanitizeWordText(raw) {
  let s = String(raw ?? '');
  s = s.replace(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > WORD_MAX_CHARS * 4) s = s.slice(0, WORD_MAX_CHARS * 4).trim();
  return s;
}

/** מפצל טקסט שהוקלד לכמה מילים בתוך אותו טווח זמן. הקצה הראשון והאחרון נשארים בדיוק כמו במילה המקורית. */
function splitWordSpan(text, w) {
  let parts = text.split(' ').filter(Boolean).map((p) => p.slice(0, WORD_MAX_CHARS));
  if (!parts.length) return [];
  const span = w.end - w.start;
  const maxN = Math.max(1, Math.floor(span / MIN_PIECE));
  if (parts.length > maxN) parts = [...parts.slice(0, maxN - 1), parts.slice(maxN - 1).join(' ')];
  if (parts.length === 1) return [{ ...w, text: parts[0] }];
  // כל חלק מקבל לפחות MIN_PIECE, והשאר מתחלק לפי אורך הטקסט
  const weights = parts.map((p) => Math.max(1, [...p].length));
  const total = weights.reduce((a, b) => a + b, 0);
  const spare = span - parts.length * MIN_PIECE;
  let acc = 0; let prev = w.start;
  return parts.map((p, k) => {
    acc += weights[k];
    const end = k === parts.length - 1 ? w.end : r6(w.start + (k + 1) * MIN_PIECE + spare * (acc / total));
    const piece = { ...w, text: p, start: prev, end };
    prev = end;
    return piece;
  });
}

/**
 * מחיל תיקוני מילים: edits = { [אינדקס]: טקסט חדש }. התזמון נשמר:
 *  - תיקון רגיל מחליף רק את הטקסט;
 *  - כמה מילים באותה מילה מתחלקות לפי אורך באותו טווח;
 *  - טקסט ריק מסיר את המילה מהכתוביות.
 * keywords (אינדקסים של מילות מפתח) מותאמים לרשימה החדשה. -> { words, keywords, map: אינדקס מקורי -> אינדקסים חדשים }
 */
export function applyWordEdits(words, keywords = [], edits = {}) {
  const src = Array.isArray(words) ? words : [];
  const dirty = edits && Object.keys(edits).length > 0;
  const out = []; const map = new Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const w = src[i];
    if (!dirty || !hasOwn(edits, i)) { map[i] = [out.length]; out.push(w); continue; }
    const pieces = splitWordSpan(sanitizeWordText(edits[i]), w);
    map[i] = pieces.map((_, k) => out.length + k);
    out.push(...pieces);
  }
  const kw = [...new Set((keywords || []).flatMap((k) => map[k] || []))].sort((a, b) => a - b);
  return { words: out, keywords: kw, map };
}

/** מקצץ מילים לטווח [start, end] בזמן פלט ומזיז אותן ל־0. מילה שרובה בחוץ נעלמת. */
export function trimWords(words, keywords, start, end) {
  const out = []; const map = new Array(words.length).fill(null);
  words.forEach((w, i) => {
    const s = Math.max(w.start, start); const e = Math.min(w.end, end);
    if (e - s < 0.5 * (w.end - w.start) - 1e-9 || e <= s) return;
    map[i] = out.length;
    out.push({ ...w, start: r3(s - start), end: r3(e - start) });
  });
  const kw = (keywords || []).map((k) => map[k]).filter((k) => k !== null && k !== undefined);
  return { words: out, keywords: kw };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// א4. אפקטים: הזזת זמנים (היוריסטית, כי המבנה של Effects שייך לסוכן 11)
// ═════════════════════════════════════════════════════════════════════════════════════════════════

const POINT_KEYS = new Set(['t', 'at', 'time', 'tOut']);
const START_KEYS = new Set(['start', 'from', 'begin']);
const END_KEYS = new Set(['end', 'to', 'until']);
const LIST_KEYS = new Set(['beats', 'cuts', 'times', 'marks', 'hits', 'flashes', 'drops']);

/**
 * מזיז את כל שדות הזמן של מבנה (אפקטים) ב־dt- שניות, וחותך ל־[0, duration].
 * מזהה: t/at/time (נקודה), start/end/from/to (טווח), ורשימות כמו beats. פריט שנופל כולו מחוץ לטווח נמחק מהמערך שהוא בו.
 * אם ל־fx יש `shiftEffects(effects, dt, duration)` משלו, עדיף להשתמש בו (העורך עושה זאת אוטומטית).
 */
export function shiftTimes(value, dt, duration = Infinity) {
  const DROP = Symbol('drop');
  const walk = (v, inArray) => {
    if (Array.isArray(v)) {
      const out = [];
      for (const item of v) { const r = walk(item, true); if (r !== DROP) out.push(r); }
      return out;
    }
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      const o = {};
      let tPoint = null; let tStart = null; let tEnd = null;
      for (const [k, x] of Object.entries(v)) {
        if (isNum(x) && POINT_KEYS.has(k)) { o[k] = r3(x - dt); tPoint = o[k]; }
        else if (isNum(x) && START_KEYS.has(k)) { o[k] = x - dt; tStart = o[k]; }
        else if (isNum(x) && END_KEYS.has(k)) { o[k] = x - dt; tEnd = o[k]; }
        else if (Array.isArray(x) && LIST_KEYS.has(k) && x.every(isNum)) o[k] = x.map((n) => r3(n - dt)).filter((n) => n >= 0 && n < duration);
        else o[k] = walk(x, false);
      }
      if (tPoint !== null && inArray && (tPoint < -0.001 || tPoint >= duration)) return DROP;
      if (tEnd !== null && inArray && (tEnd <= 0 || (tStart !== null && tStart >= duration))) return DROP;
      if (tStart !== null) { for (const k of START_KEYS) if (isNum(o[k])) o[k] = r3(Math.max(0, o[k])); }
      if (tEnd !== null) { for (const k of END_KEYS) if (isNum(o[k])) o[k] = r3(Math.min(duration, o[k])); }
      return o;
    }
    return v;
  };
  return walk(value, false);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// א5. מצב קליפ, עריכות, והמצב הסופי
// ═════════════════════════════════════════════════════════════════════════════════════════════════

const fullCamera = () => ({ layout: 'fit', rectAt: () => ({ x: 0, y: 0, w: 1, h: 1 }), cuts: [] });

/** מאחד את clipState לצורה קבועה, וזורק שגיאה בעברית כשחסר משהו הכרחי. */
export function normalizeClipState(cs) {
  if (!cs || typeof cs !== 'object') throw new Error('חסר מצב קליפ לעריכה');
  const spec = cs.captionSpec && typeof cs.captionSpec === 'object' ? cs.captionSpec : null;
  let plan = cs.plan && Array.isArray(cs.plan.segments) && planSegments(cs.plan).length ? cs.plan : null;
  if (!plan) {
    const d = Number(spec?.duration);
    if (!(d > 0)) throw new Error('בקליפ חסרה תוכנית חיתוך, ולכן אי אפשר לערוך אותו');
    plan = { segments: [[0, d]], duration: d, removed: 0 };
  }
  const duration = r6(planLength(plan));
  const camera = cs.camera && typeof cs.camera.rectAt === 'function' ? cs.camera : fullCamera();
  const specOk = spec ? { ...spec, words: Array.isArray(spec.words) ? spec.words : [], keywords: Array.isArray(spec.keywords) ? spec.keywords : [] } : null;
  return {
    ...cs,
    plan: { ...plan, duration },
    camera,
    captionSpec: specOk,
    audioOptions: { music: '', loudness: -14, ...(cs.audioOptions || {}) },
    effects: cs.effects ?? null,
    duration,
  };
}

/** כותרות (hooks) לבחירה, מכל מקום סביר ב־clipState. */
export function hooksOf(cs) {
  const list = cs?.hooks || cs?.moment?.hooks || cs?.clip?.hooks || cs?.meta?.hooks || [];
  return [...new Set((Array.isArray(list) ? list : []).map((x) => String(x ?? '').trim()).filter(Boolean))].slice(0, 3);
}

export const emptyEdits = () => ({ words: {}, framing: {} });

const defaultHookSeconds = (duration) => r3(clamp(duration * 0.15, 1.5, 3));

function makeHook(value, prev, duration) {
  if (value === null) return null;
  const text = sanitizeWordText(typeof value === 'string' ? value : value?.text).slice(0, 120);
  if (!text) return null;
  const seconds = isNum(value?.seconds) ? value.seconds : (isNum(prev?.seconds) ? prev.seconds : defaultHookSeconds(duration));
  return { text, seconds: r3(Math.min(seconds, duration)) };
}

function trimSpec(spec, trim) {
  const dur = r3(trim.end - trim.start);
  const { words, keywords } = trimWords(spec.words, spec.keywords, trim.start, trim.end);
  const splits = (spec.splits || []).map((s) => ({ start: r3(Math.max(0, s.start - trim.start)), end: r3(Math.min(dur, s.end - trim.start)) })).filter((s) => s.end > s.start);
  const hook = spec.hook ? { ...spec.hook, seconds: r3(Math.min(spec.hook.seconds, dur)) } : null;
  return { ...spec, words, keywords, splits, hook, duration: dur };
}

/** אחרי הזזת אפקטים: אורך הקליפ וספירת האירועים (stats) מתעדכנים. */
function fixEffects(fx, duration) {
  if (!fx || typeof fx !== 'object' || Array.isArray(fx)) return fx;
  if (isNum(fx.duration)) fx.duration = duration;
  if (fx.stats && typeof fx.stats === 'object') for (const k of Object.keys(fx.stats)) if (Array.isArray(fx[k])) fx.stats[k] = fx[k].length;
  return fx;
}

/**
 * המצב הסופי של הקליפ: מקור + עריכות. לא משנה את המקור.
 * edits = { words:{i:text}, style?, hook?, framing:{key:{start,end,dx,dy,zoom}}, trim?:{start,end}, music?, level? }
 * env = { srcAspect, outAspect, shots }, memo = אובייקט לשימוש חוזר ב־captionSpec כשלא השתנה.
 */
export function applyEdits(base, edits, env = {}, memo = {}) {
  const e = edits || emptyEdits();
  const dur = base.duration;
  const trim = normTrim(e.trim, dur);
  const outDur = trim ? r3(trim.end - trim.start) : dur;

  // כתוביות
  let captionSpec = null;
  if (base.captionSpec) {
    const key = stable([e.words, e.style, e.hook === undefined ? '__' : e.hook, trim]);
    if (memo.specKey === key && memo.spec) captionSpec = memo.spec;
    else {
      const s0 = base.captionSpec;
      const w = applyWordEdits(s0.words, s0.keywords, e.words);
      let spec = {
        ...s0, words: w.words, keywords: w.keywords,
        style: e.style ?? s0.style,
        hook: e.hook === undefined ? (s0.hook || null) : makeHook(e.hook, s0.hook, dur),
      };
      if (trim) spec = trimSpec(spec, trim);
      captionSpec = spec; memo.specKey = key; memo.spec = spec;
    }
  }

  // מצלמה: קודם override בזמן המקור-פלט, ואז הזזה לפי הקיצוץ
  let camera = cameraWithOverrides(base.camera, e.framing, { shots: env.shots || shotsOf(base.camera, base.plan, dur), srcAspect: env.srcAspect, outAspect: env.outAspect });
  if (trim) camera = shiftCamera(camera, trim.start, outDur);

  // תוכנית ואפקטים
  const plan = trim ? trimPlan(base.plan, trim.start, trim.end) : base.plan;
  let effects = base.effects;
  if (trim && effects) {
    const custom = env.shiftEffects;
    effects = typeof custom === 'function' ? custom(effects, trim.start, outDur) : fixEffects(shiftTimes(effects, trim.start, outDur), outDur);
  }

  // שמע
  let audioOptions = base.audioOptions;
  if (e.music !== undefined || e.level) {
    const lv = LEVELS[e.level];
    audioOptions = { ...audioOptions };
    if (e.music !== undefined) audioOptions.music = e.music;
    if (lv) { audioOptions.loudness = lv.loudness; audioOptions.musicGainDb = lv.musicGainDb; audioOptions.level = lv.id; }
  }

  return {
    ...base,
    plan, camera, captionSpec, audioOptions, effects,
    duration: outDur,
    trim: { start: trim ? trim.start : 0, end: trim ? trim.end : dur, offset: trim ? trim.start : 0, duration: outDur, applied: !!trim },
    edited: true,
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// א6. סשן עריכה: היסטוריה, ביטול, ושינויים חיים
// ═════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * createSession(clipState) -> סשן. עריכה = apply(patch). שינוי חי (בזמן גרירה) = setLive(patch) ואז commitLive().
 * patch הוא חלק מ־edits, והוא מחליף את השדות שהוא מזכיר.
 */
export function createSession(clipState, opts = {}) {
  const base = normalizeClipState(clipState);
  const specW = base.captionSpec?.width || base.size?.width; const specH = base.captionSpec?.height || base.size?.height;
  const env = {
    srcAspect: Number(opts.srcAspect) > 0 ? Number(opts.srcAspect) : (base.source?.width > 0 && base.source?.height > 0 ? base.source.width / base.source.height : 16 / 9),
    outAspect: Number(opts.outAspect) > 0 ? Number(opts.outAspect) : (specW > 0 && specH > 0 ? specW / specH : 9 / 16),
    shots: null,
    shiftEffects: opts.shiftEffects || null,
  };
  env.shots = shotsOf(base.camera, base.plan, base.duration);
  const limit = opts.historyLimit || HISTORY_LIMIT;
  const now = opts.now || (() => Date.now());

  let edits = emptyEdits(); let live = null;
  const undoStack = []; const redoStack = [];
  const listeners = new Set();
  let version = 0; let cache = null; const memo = {};
  let lastKey = null; let lastAt = 0;

  const effective = () => (live ? { ...edits, ...live } : edits);
  const notify = (kind) => { version++; for (const fn of [...listeners]) { try { fn(kind); } catch (_) { /* מאזין תקול לא מפיל את העריכה */ } } };
  const same = (a, b) => stable(a) === stable(b);

  /** מנקה patch: ערכים ריקים מוחקים את השדה (undefined = ללא שינוי). */
  function merge(patch) {
    const next = { ...edits, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === null && k !== 'hook') delete next[k];
    if (!next.words) next.words = {};
    if (!next.framing) next.framing = {};
    if (next.trim && !normTrim(next.trim, base.duration)) delete next.trim;
    if (next.trim) next.trim = normTrim(next.trim, base.duration);
    return next;
  }

  const api = {
    base, env,
    get shots() { return env.shots; },
    get edits() { return edits; },
    get live() { return live; },
    get version() { return version; },
    get canUndo() { return undoStack.length > 0; },
    get canRedo() { return redoStack.length > 0; },
    get historyLength() { return undoStack.length; },

    /** המצב הסופי (כולל שינוי חי, אם יש). */
    get state() {
      if (cache && cache.version === version) return cache.value;
      const value = applyEdits(base, effective(), env, memo);
      cache = { version, value };
      return value;
    },

    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /** עריכה קבועה, עם כניסה אחת בהיסטוריה. key: עריכות רצופות עם אותו מפתח בתוך 800ms מתמזגות. */
    apply(patch, { key = null } = {}) {
      if (live) { live = null; }
      const next = merge(patch);
      if (same(next, edits)) { notify('noop'); return false; }
      const t = now();
      if (key && key === lastKey && t - lastAt < 800 && undoStack.length) { /* ממזגים עם הכניסה הקודמת */ }
      else { undoStack.push(edits); if (undoStack.length > limit) undoStack.shift(); }
      lastKey = key; lastAt = t;
      redoStack.length = 0;
      edits = next;
      notify('commit');
      return true;
    },

    setLive(patch) { live = patch; notify('live'); },
    cancelLive() { if (!live) return; live = null; notify('live'); },
    /** מקבע את השינוי החי כעריכה אחת בהיסטוריה. מחזיר false כשלא היה שינוי בפועל. */
    commitLive(key = null) {
      if (!live) return false;
      const patch = live; live = null;
      return api.apply(patch, { key });
    },

    undo() {
      if (live) { api.cancelLive(); return true; }
      if (!undoStack.length) return false;
      redoStack.push(edits); edits = undoStack.pop(); lastKey = null;
      notify('undo'); return true;
    },
    redo() {
      if (!redoStack.length) return false;
      undoStack.push(edits); edits = redoStack.pop(); lastKey = null;
      notify('redo'); return true;
    },

    /** משחזר עריכות שנשמרו (JSON). נכנס להיסטוריה כעריכה אחת. */
    restore(saved) { return api.apply({ ...emptyEdits(), ...clone(saved || {}) }); },
    reset() { return api.apply({ words: {}, framing: {}, style: undefined, hook: undefined, trim: undefined, music: undefined, level: undefined }); },

    setSource(width, height) {
      if (!(width > 0 && height > 0)) return;
      const a = width / height;
      if (Math.abs(a - env.srcAspect) < 1e-4) return;
      env.srcAspect = a; notify('env');
    },

    // — עריכות מוכנות —
    wordText(i) {
      const w = base.captionSpec?.words?.[i];
      if (!w) return '';
      const ed = effective().words;
      return hasOwn(ed, i) ? sanitizeWordText(ed[i]) : w.text;
    },
    isWordEdited(i) { return hasOwn(effective().words, i); },

    /** תיקון מילה. טקסט זהה למקור מבטל את התיקון. */
    editWord(i, text, opts2 = {}) { return api.apply(wordsPatch(i, text), opts2); },
    liveWord(i, text) { api.setLive(wordsPatch(i, text)); },

    setStyle(id) { return api.apply({ style: id === base.captionSpec?.style ? undefined : id }); },
    /** value: טקסט, {text, seconds}, null (בלי כותרת), או undefined (חזרה למקור). טקסט זהה לכותרת המקורית מבטל את העריכה. */
    setHook(value) {
      const orig = base.captionSpec?.hook?.text || '';
      const text = typeof value === 'string' ? sanitizeWordText(value) : value?.text;
      if (value !== null && value !== undefined && text === orig && !isNum(value?.seconds)) return api.apply({ hook: undefined });
      return api.apply({ hook: value });
    },
    setTrim(start, end, opts2 = {}) { return api.apply({ trim: { start, end } }, opts2); },
    liveTrim(start, end) { api.setLive({ trim: { start, end } }); },
    setMusic(id) { return api.apply({ music: id === (base.audioOptions?.music || '') ? undefined : id }); },
    setLevel(id) { return api.apply({ level: LEVELS[id] ? id : undefined }); },

    framingFor(key) { return effective().framing[key] || null; },
    setFraming(key, ov, shot, opts2 = {}) { return api.apply({ framing: withFraming(edits.framing, key, ov, shot) }, opts2); },
    liveFraming(key, ov, shot) { api.setLive({ framing: withFraming(edits.framing, key, ov, shot) }); },
    clearFraming() { return api.apply({ framing: {} }); },

    /** המצב לייצוא: עותק עם רשומת העריכות, בלי שינוי חי שלא נשמר. */
    exportState() {
      api.cancelLive();
      return { ...api.state, edits: clone(edits) };
    },
  };

  function wordsPatch(i, text) {
    const words = { ...effective().words };
    const w = base.captionSpec?.words?.[i];
    if (!w) return { words };
    const clean = sanitizeWordText(text);
    if (clean === sanitizeWordText(w.text)) delete words[i]; else words[i] = clean;
    return { words };
  }

  return api;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// ב. עזרים לממשק (טהורים)
// ═════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * מזהה מחוות מאירועי מצביע: הקשה, גרירה, וצביטה (pinch).
 * אירועים: { type: 'begin' } בתחילת גרירה/צביטה, { type: 'pan', dx, dy, x, y } (פיקסלים מאז האירוע הקודם),
 * { type: 'zoom', factor, x, y } (יחס מרחק בין האצבעות מאז האירוע הקודם), { type: 'end' } בסיום, ו־{ type: 'tap', x, y }.
 */
export function createGestureTracker({ slop = 8, tapMs = 350 } = {}) {
  const pts = new Map();
  let mode = 'idle'; let began = false; let startT = 0; let start = null; let last = null; let lastDist = 1;
  const two = () => [...pts.values()].slice(0, 2);
  const centroid = () => { const [p, q] = two(); return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }; };
  const dist = () => { const [p, q] = two(); return Math.max(1, Math.hypot(p.x - q.x, p.y - q.y)); };
  const begin = (out) => { if (!began) { began = true; out.push({ type: 'begin' }); } };
  return {
    get mode() { return mode; },
    down(id, x, y, t = 0) {
      const out = [];
      pts.set(id, { x, y });
      if (pts.size === 1) { mode = 'press'; began = false; startT = t; start = { x, y }; last = { x, y }; }
      else if (pts.size === 2) { mode = 'pinch'; begin(out); last = centroid(); lastDist = dist(); }
      return out;
    },
    move(id, x, y) {
      const out = [];
      if (!pts.has(id)) return out;
      pts.set(id, { x, y });
      if (mode === 'press') {
        if (Math.hypot(x - start.x, y - start.y) < slop) return out;
        mode = 'pan'; begin(out);
        out.push({ type: 'pan', dx: x - last.x, dy: y - last.y, x, y });
        last = { x, y };
      } else if (mode === 'pan') {
        out.push({ type: 'pan', dx: x - last.x, dy: y - last.y, x, y });
        last = { x, y };
      } else if (mode === 'pinch' && pts.size >= 2) {
        const c = centroid(); const d = dist();
        if (c.x !== last.x || c.y !== last.y) out.push({ type: 'pan', dx: c.x - last.x, dy: c.y - last.y, x: c.x, y: c.y });
        if (d !== lastDist) out.push({ type: 'zoom', factor: d / lastDist, x: c.x, y: c.y });
        last = c; lastDist = d;
      }
      return out;
    },
    up(id, x, y, t = 0) {
      const out = [];
      if (!pts.has(id)) return out;
      pts.delete(id);
      if (pts.size === 0) {
        if (mode === 'press' && t - startT <= tapMs) out.push({ type: 'tap', x, y });
        else if (began) out.push({ type: 'end' });
        mode = 'idle'; began = false;
      } else if (pts.size === 1) {
        mode = 'pan';
        const p = [...pts.values()][0];
        last = { x: p.x, y: p.y };
      }
      return out;
    },
    cancel() {
      const out = began ? [{ type: 'end', cancelled: true }] : [];
      pts.clear(); mode = 'idle'; began = false;
      return out;
    },
  };
}

/** ציר הזמן: המרה בין זמן לפיקסל. */
export const timeToX = (t, duration, width) => (duration > 0 ? clamp(t / duration, 0, 1) * width : 0);
export const xToTime = (x, duration, width) => (width > 0 ? clamp(x / width, 0, 1) * duration : 0);

/** גורר ידית קיצוץ ('start' או 'end') לזמן חדש, בלי לעבור את הידית השנייה ובלי לרדת מאורך מינימלי. */
export function dragTrimHandle(which, t, trim, duration, minLen = MIN_CLIP) {
  const cur = { start: trim?.start ?? 0, end: trim?.end ?? duration };
  if (which === 'start') return { start: r3(clamp(t, 0, Math.max(0, cur.end - minLen))), end: cur.end };
  return { start: cur.start, end: r3(clamp(t, Math.min(duration, cur.start + minLen), duration)) };
}

/** האינדקס של הפריט שהמרכז שלו הכי קרוב למרכז הנתון (לקרוסלת הסגנונות). */
export function nearestToCenter(rects, center) {
  let best = -1; let bd = Infinity;
  rects.forEach((r, i) => { const d = Math.abs((r.left + r.right) / 2 - center); if (d < bd) { bd = d; best = i; } });
  return best;
}

/** בקרת איכות: כשהציור איטי מורידים את רזולוציית הקנבס, וכשיש מרווח מעלים בחזרה. */
export function governScale(scale, avgDrawMs, { budgetMs = 9, min = 0.5, max = 1 } = {}) {
  if (avgDrawMs > budgetMs * 1.4) return Math.max(min, r3(scale * 0.8));
  if (avgDrawMs < budgetMs * 0.5 && scale < max) return Math.min(max, r3(scale * 1.15));
  return scale;
}

/**
 * מנרמל את STYLES של מודול הכתוביות (מילון או מערך) לרשימה [{id, name, desc, preview}].
 * preview = { text, fill, accent, stroke } לדוגמה קטנה בכרטיס, או null.
 */
export function normalizeStyles(S) {
  let list = [];
  if (Array.isArray(S)) list = S;
  else if (S && typeof S === 'object') list = Object.entries(S).map(([id, v]) => (v && typeof v === 'object' ? { id, ...v } : { id, name: String(v) }));
  return list
    .map((s) => {
      const id = String(s?.id ?? s?.key ?? s?.name ?? '');
      const pv = s?.preview && typeof s.preview === 'object' ? s.preview : null;
      const fill = pv?.fill || s?.fill || s?.color || null;
      const preview = fill || pv?.accent ? { text: String(pv?.text || 'אבג'), fill, accent: pv?.accent || s?.accent || null, stroke: pv?.stroke || null } : null;
      return { id, name: String(s?.nameHe || s?.name || s?.label || s?.title || s?.he || id), desc: String(s?.blurb || s?.desc || ''), preview };
    })
    .filter((s) => s.id);
}

/** מפעיל את המילה לפי זמן בסיס: האינדקס של המילה שמדברים בה עכשיו, או -1. hint = האינדקס הקודם (לחיפוש מהיר). */
export function wordIndexAt(words, t, hint = 0) {
  const n = words.length;
  if (!n) return -1;
  const inside = (i) => i >= 0 && i < n && t >= words[i].start - 1e-6 && t < words[i].end + 1e-6;
  if (inside(hint)) return hint;
  if (inside(hint + 1)) return hint + 1;
  for (let i = 0; i < n; i++) if (inside(i)) return i;
  return -1;
}

/** זמן לתצוגה, למשל 0:07.3 */
export function fmtTime(t) {
  const x = Math.max(0, t || 0);
  const m = Math.floor(x / 60); const s = x - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// ג. גיבוי (stub) לכתוביות ולאפקטים, כשהמודולים של סוכנים 5 ו־11 עוד לא קיימים
// ═════════════════════════════════════════════════════════════════════════════════════════════════

const STUB_LOOKS = {
  clean: { fill: '#ffffff', hi: '#ffffff', stroke: 'rgba(0,0,0,.65)', weight: 700, bg: null },
  bold: { fill: '#ffffff', hi: '#ffd60a', stroke: '#000000', weight: 900, bg: null },
  punch: { fill: '#ffffff', hi: '#ff4d6d', stroke: '#000000', weight: 900, bg: 'rgba(0,0,0,.55)' },
  karaoke: { fill: '#9be7ff', hi: '#ffffff', stroke: '#06283d', weight: 800, bg: null },
  neon: { fill: '#b6ffcf', hi: '#39ff88', stroke: '#003d1c', weight: 800, bg: null },
};

function stubPrepare(spec) {
  const words = spec.words || [];
  const groups = [];
  for (let i = 0; i < words.length; i += 3) {
    const part = words.slice(i, i + 3);
    groups.push({ from: i, words: part, start: part[0].start, end: part[part.length - 1].end });
  }
  groups.forEach((g, k) => { g.end = Math.min(groups[k + 1] ? groups[k + 1].start : g.end + 0.4, g.end + 0.4); });
  return { stub: true, spec, groups, look: STUB_LOOKS[spec.style] || STUB_LOOKS.bold, dispose() {} };
}

function stubDraw(ctx, t, p) {
  const { spec, look } = p; const W = spec.width; const H = spec.height;
  const rtl = spec.direction !== 'ltr';
  ctx.save();
  ctx.direction = rtl ? 'rtl' : 'ltr';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  if (spec.hook?.text && t >= 0 && t < spec.hook.seconds) {
    const fs = Math.round(W * 0.062);
    ctx.font = `800 ${fs}px Heebo, Rubik, system-ui, sans-serif`;
    const y = H * ((spec.safeZone?.top ?? 8) / 100) + fs;
    const w = Math.min(W * 0.9, ctx.measureText(spec.hook.text).width + fs * 1.2);
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    ctx.beginPath(); ctx.roundRect?.(W / 2 - w / 2, y - fs * 0.85, w, fs * 1.7, fs * 0.4); ctx.fill();
    ctx.fillStyle = '#ffd60a';
    ctx.fillText(spec.hook.text, W / 2, y, W * 0.86);
  }
  const g = p.groups.find((x) => t >= x.start - 1e-6 && t < x.end);
  if (g) {
    const fs = Math.round(W * 0.09);
    const y = H - H * ((spec.safeZone?.bottom ?? 18) / 100) - fs;
    ctx.font = `${look.weight} ${fs}px Heebo, Rubik, system-ui, sans-serif`;
    const ordered = rtl ? [...g.words].reverse() : g.words;      // בעברית המילה הראשונה בימין
    const gap = fs * 0.28;
    const widths = ordered.map((w) => ctx.measureText(w.text).width);
    const total = widths.reduce((a, b) => a + b, 0) + gap * (ordered.length - 1);
    if (look.bg) { ctx.fillStyle = look.bg; ctx.beginPath(); ctx.roundRect?.(W / 2 - total / 2 - fs * 0.4, y - fs * 0.75, total + fs * 0.8, fs * 1.5, fs * 0.3); ctx.fill(); }
    let x = W / 2 - total / 2;
    ctx.textAlign = 'left';
    ordered.forEach((w, i) => {
      const active = t >= w.start - 1e-6 && t < w.end;
      ctx.lineWidth = fs * 0.2; ctx.strokeStyle = look.stroke; ctx.strokeText(w.text, x, y);
      ctx.fillStyle = active ? look.hi : look.fill; ctx.fillText(w.text, x, y);
      x += widths[i] + gap;
    });
  }
  ctx.restore();
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// ד. הממשק (DOM + קנבס). כל מה שמתחת נוגע ב־document רק מתוך mountQuickEditor
// ═════════════════════════════════════════════════════════════════════════════════════════════════

const T = {
  title: 'עורך מהיר',
  export: 'ייצוא',
  exporting: 'מייצאים…',
  exported: 'הקליפ נשלח לייצוא.',
  exportFailed: 'הייצוא נכשל. אפשר לנסות שוב.',
  undo: 'ביטול הפעולה האחרונה',
  redo: 'שחזור הפעולה שבוטלה',
  play: 'ניגון', pause: 'השהיה',
  tabs: { words: 'מילים', style: 'סגנון', hook: 'כותרת', frame: 'מסגור', sound: 'סאונד' },
  wordsHint: 'הקישו על מילה כדי לתקן אותה. התזמון נשאר כפי שהוא.',
  noCaptions: 'בקליפ הזה אין כתוביות.',
  wordEdit: 'תיקון מילה', save: 'שמירה', cancel: 'ביטול', del: 'מחיקת המילה', restore: 'שחזור המקור',
  prevWord: 'הקודמת', nextWord: 'הבאה',
  original: 'במקור', until: 'עד',
  wordSaved: 'המילה תוקנה.', wordDeleted: 'המילה הוסרה מהכתוביות.',
  styleHint: 'החליקו הצידה כדי להחליף סגנון.',
  hookHint: 'בחרו כותרת, או כתבו אחת משלכם.',
  hookNone: 'בלי כותרת', hookCustom: 'כותרת משלכם', hookApply: 'החלה', hookCurrent: 'הנוכחית',
  frameHint: 'גררו את התמונה כדי להזיז את המסגרת, וצבטו כדי לקרב. השינוי חל על הקטע הנוכחי.',
  zoomIn: 'קרבו', zoomOut: 'הרחיקו', resetShot: 'איפוס הקטע', resetAll: 'איפוס כל המסגור',
  shotOf: (i, n) => `קטע ${i} מתוך ${n}`,
  fitConverted: 'המסגור עבר מ"התאמה" לחיתוך. אפשר לבטל.',
  music: 'מוזיקה', level: 'עוצמה',
  trimStart: 'ידית קיצוץ התחלה', trimEnd: 'ידית קיצוץ סוף',
  trimMin: 'הקליפ חייב להימשך לפחות שנייה.',
  secs: 'שנ׳',
  loadFail: 'לא הצלחנו לטעון את הסרטון לתצוגה מקדימה.',
  noVideo: 'אין סרטון לתצוגה. אפשר לערוך, אבל לא לראות את התוצאה.',
  capsFail: 'הכתוביות לא נטענו, ולכן מוצג עיצוב זמני.',
  dragHint: 'גררו להזזה, צבטו לקירוב',
  reset: 'איפוס',
};

const ICONS = {
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  play: '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  left: '<path d="m15 6-6 6 6 6"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
};

const CSS = `
.qe{--qe-bg:#0e1014;--qe-panel:#171a21;--qe-chip:#2b3242;--qe-line:#2c323e;--qe-fg:#f1f3f7;--qe-mut:#9aa3b2;--qe-acc:#ffd60a;--qe-acc-fg:#14161a;--qe-ok:#35c46a;--qe-bad:#ff6b6b;--qe-seg:#3b4660;
position:relative;display:grid;grid-template-rows:auto minmax(0,1fr) auto auto auto;height:100%;min-height:0;background:var(--qe-bg);color:var(--qe-fg);
font:16px/1.4 Heebo,Rubik,system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden;overflow:clip;direction:rtl;-webkit-text-size-adjust:100%;user-select:none;-webkit-user-select:none;padding-top:env(safe-area-inset-top)}
.qe.qe-full{height:var(--qe-h,100dvh)}
@media (prefers-color-scheme:light){.qe{--qe-bg:#f4f5f8;--qe-panel:#ffffff;--qe-chip:#e3e7ef;--qe-line:#d6dbe5;--qe-fg:#14171c;--qe-mut:#5a6372;--qe-seg:#8fa0c4}}
.qe *{box-sizing:border-box}
.qe [hidden]{display:none!important}
.qe button{font:inherit;color:inherit;background:none;border:0;padding:0;margin:0;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation}
.qe button:focus-visible,.qe input:focus-visible{outline:3px solid var(--qe-acc);outline-offset:2px}
.qe-top{display:flex;align-items:center;gap:8px;padding:6px 10px;min-height:60px}
.qe-ic{width:48px;height:48px;border-radius:14px;display:grid;place-items:center;background:var(--qe-panel);flex:none}
.qe-ic:disabled{opacity:.3}
.qe-ic svg{width:24px;height:24px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.qe-title{flex:1;text-align:center;font-weight:700;font-size:1rem;color:var(--qe-mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qe-export{position:relative;overflow:hidden;min-width:104px;height:48px;padding:0 22px;border-radius:14px;background:var(--qe-acc);color:var(--qe-acc-fg);font-weight:800;font-size:1.05rem;flex:none}
.qe-export:disabled{opacity:.85;cursor:progress}
.qe-export i{position:absolute;inset:0;transform-origin:right center;transform:scaleX(0);background:rgba(0,0,0,.2);transition:transform .15s}
.qe-export span{position:relative}
.qe-stage{position:relative;min-height:0;display:grid;place-items:center;background:#05060a;overflow:hidden}
.qe-cwrap{position:relative;border-radius:10px;overflow:hidden;box-shadow:0 0 0 1px rgba(255,255,255,.07)}
.qe-canvas{display:block;width:100%;height:100%;touch-action:none;background:#000;cursor:grab}
.qe-video{position:absolute;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none}
.qe-pill{position:absolute;z-index:3;padding:4px 10px;border-radius:999px;background:rgba(0,0,0,.55);color:#fff;font-size:.8rem;font-weight:600;pointer-events:none;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}
.qe-pill.shot{top:8px;right:8px}
.qe-pill.time{top:8px;left:8px;direction:ltr;font-variant-numeric:tabular-nums}
.qe-pill.hint{bottom:10px;left:50%;transform:translateX(-50%);white-space:nowrap;transition:opacity .6s}
.qe-pill.gone{opacity:0}
.qe-cwrap.narrow .qe-pill{font-size:.68rem;padding:2px 8px}
.qe-cwrap.narrow .qe-pill.shot{display:none}
.qe-chip-reset{position:absolute;z-index:4;bottom:8px;left:50%;transform:translateX(-50%);min-height:44px;padding:0 18px;border-radius:999px;background:var(--qe-acc);color:var(--qe-acc-fg);font-weight:800;font-size:.95rem;white-space:nowrap;box-shadow:0 2px 10px #0008}
.qe-chip-reset[hidden]{display:none}
.qe-bigplay{position:absolute;inset:0;margin:auto;width:76px;height:76px;border-radius:50%;background:rgba(0,0,0,.5);color:#fff;display:grid;place-items:center;pointer-events:none;transition:opacity .15s;z-index:2}
.qe-bigplay svg{width:36px;height:36px}
.qe-bigplay.off{opacity:0}
.qe-tl{direction:ltr;display:grid;grid-template-columns:52px 1fr;gap:6px;align-items:center;padding:8px 12px 2px}
.qe-play{width:52px;height:52px;border-radius:50%;background:var(--qe-fg);color:var(--qe-bg);display:grid;place-items:center}
.qe-play svg{width:26px;height:26px}
.qe-tl-main{min-width:0}
.qe-track{position:relative;height:52px;margin:0 22px;touch-action:none;cursor:pointer}
.qe-shots{position:absolute;inset:10px 0;border-radius:8px;overflow:hidden;background:var(--qe-line)}
.qe-shot{position:absolute;top:0;bottom:0;background:var(--qe-seg);border-right:2px solid var(--qe-bg)}
.qe-shot.ov{background:linear-gradient(0deg,var(--qe-acc) 0 4px,var(--qe-seg) 4px)}
.qe-shot.cur{filter:brightness(1.25)}
.qe-dim{position:absolute;top:10px;bottom:10px;background:rgba(0,0,0,.62);pointer-events:none;z-index:1}
.qe-h{position:absolute;top:0;height:52px;width:44px;margin-left:-22px;touch-action:none;cursor:ew-resize;z-index:3}
.qe-h::before{content:"";position:absolute;left:50%;top:3px;bottom:3px;width:14px;margin-left:-7px;border-radius:6px;background:var(--qe-acc)}
.qe-h::after{content:"";position:absolute;left:50%;top:18px;bottom:18px;width:2px;margin-left:-1px;border-radius:2px;background:var(--qe-acc-fg);opacity:.7}
.qe-ph{position:absolute;top:4px;bottom:4px;width:3px;margin-left:-1.5px;background:#fff;border-radius:2px;pointer-events:none;box-shadow:0 0 0 1px rgba(0,0,0,.55);z-index:2}
.qe-tl-info{grid-column:2;display:flex;justify-content:space-between;font-size:.78rem;color:var(--qe-mut);padding:0 22px;font-variant-numeric:tabular-nums}
.qe-tabs{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:4px;padding:6px 10px 4px}
.qe-tab{height:48px;border-radius:12px;color:var(--qe-mut);font-weight:700}
.qe-tab[aria-selected=true]{background:var(--qe-panel);color:var(--qe-fg);box-shadow:inset 0 -3px 0 var(--qe-acc)}
.qe-tab:disabled{opacity:.3}
.qe-panel{height:clamp(136px,23dvh,230px);overflow:auto;padding:10px 12px calc(12px + env(safe-area-inset-bottom));background:var(--qe-panel);overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
.qe-panel[hidden],.qe-pane[hidden]{display:none}
.qe-hint{margin:0 0 8px;color:var(--qe-mut);font-size:.88rem}
.qe-chips{display:flex;flex-wrap:wrap;gap:8px}
.qe-chip{min-height:46px;min-width:46px;padding:8px 14px;border-radius:12px;background:var(--qe-chip);box-shadow:inset 0 0 0 1px var(--qe-line);font-weight:600;font-size:1.02rem}
.qe-chip.on{background:var(--qe-acc);color:var(--qe-acc-fg);box-shadow:none}
.qe-chip.edited{box-shadow:inset 0 -3px 0 var(--qe-ok)}
.qe-chip.on.edited{box-shadow:inset 0 -3px 0 var(--qe-ok)}
.qe-chip.gone{text-decoration:line-through;opacity:.6}
.qe-chip.out{opacity:.35}
.qe-btn{min-height:48px;padding:0 18px;border-radius:14px;background:var(--qe-chip);box-shadow:inset 0 0 0 1px var(--qe-line);font-weight:700;display:inline-flex;align-items:center;justify-content:center;gap:6px}
.qe-btn svg{width:22px;height:22px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.qe-btn.primary{background:var(--qe-acc);color:var(--qe-acc-fg);box-shadow:none}
.qe-btn.danger{color:var(--qe-bad)}
.qe-btn:disabled{opacity:.35}
.qe-row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px}
.qe-styles{display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;padding:6px calc(50% - 60px) 10px;scrollbar-width:none;scroll-behavior:smooth;overscroll-behavior-x:contain}
.qe-styles::-webkit-scrollbar{display:none}
.qe-style{flex:none;width:120px;height:78px;scroll-snap-align:center;border-radius:16px;background:var(--qe-chip);display:grid;place-items:center;align-content:center;gap:2px;font-weight:700;border:2px solid transparent}
.qe-style b{font-size:1.45rem;line-height:1;font-weight:900;-webkit-text-stroke:1px rgba(0,0,0,.55)}
.qe-style span{font-size:.85rem;color:var(--qe-mut)}
.qe-style.on{border-color:var(--qe-acc)}
.qe-style.on span{color:var(--qe-fg)}
.qe-input{width:100%;height:56px;border-radius:14px;border:2px solid var(--qe-line);background:var(--qe-bg);color:var(--qe-fg);font:700 22px/1 Heebo,Rubik,system-ui,sans-serif;padding:0 14px;user-select:text;-webkit-user-select:text}
.qe-input.sm{height:50px;font-size:18px;font-weight:600}
.qe-sheet{position:absolute;inset-inline:0;bottom:0;z-index:30;background:var(--qe-panel);border-radius:22px 22px 0 0;padding:14px 14px calc(14px + env(safe-area-inset-bottom));box-shadow:0 -14px 40px rgba(0,0,0,.5);transform:translateY(105%);visibility:hidden;transition:transform .2s ease,visibility 0s .2s}
.qe-sheet.open{transform:none;visibility:visible;transition:transform .2s ease}
.qe-sheet h3{margin:0 0 8px;font-size:1rem;color:var(--qe-mut);font-weight:700;display:flex;justify-content:space-between;gap:8px;min-width:0}
.qe-sheet .qe-btn{min-height:50px;padding:0 14px}
.qe-sheet .qe-row{margin:10px 0 0}
.qe-sheet .grow{flex:1}
.qe-toast{position:absolute;z-index:40;top:max(70px,calc(env(safe-area-inset-top) + 62px));left:50%;transform:translate(-50%,-8px);max-width:90%;padding:10px 16px;border-radius:12px;background:#000d;color:#fff;font-weight:600;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;text-align:center}
.qe-toast.show{opacity:1;transform:translate(-50%,0)}
.qe-sub{margin:10px 0 6px;font-size:.88rem;color:var(--qe-mut);font-weight:700}
@media (orientation:landscape) and (max-height:540px){
.qe.qe-full{grid-template-columns:minmax(0,1fr) minmax(310px,46%);grid-template-rows:auto auto auto minmax(0,1fr)}
.qe.qe-full .qe-top{grid-column:1/-1;min-height:52px;padding-block:2px}
.qe.qe-full .qe-stage{grid-column:1;grid-row:2/5}
.qe.qe-full .qe-tl{grid-column:2;grid-row:2;padding-top:2px}
.qe.qe-full .qe-tabs{grid-column:2;grid-row:3;padding-top:2px}
.qe.qe-full .qe-panel{grid-column:2;grid-row:4;height:auto;min-height:0}
.qe.qe-full .qe-pill.hint{display:none}
}
@media (prefers-reduced-motion:reduce){.qe *{transition:none!important}.qe-styles{scroll-behavior:auto}}
`;

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name] || '';      // קבועים מהקובץ הזה בלבד, אף פעם לא קלט של משתמש
  return s;
}

async function loadModules(inject = {}) {
  const grab = async (name, path) => {
    if (inject[name] !== undefined) return inject[name];
    try { return await import(path); } catch (_) { return null; }
  };
  const [cap, fx] = await Promise.all([grab('captions', '../engine/captions.js'), grab('fx', '../engine/fx.js')]);
  const out = {
    prepareCaptions: typeof cap?.prepareCaptions === 'function' ? cap.prepareCaptions : stubPrepare,
    drawCaptions: typeof cap?.drawCaptions === 'function' ? cap.drawCaptions : (ctx, t, p) => (p?.stub ? stubDraw(ctx, t, p) : undefined),
    drawEffects: typeof fx?.drawEffects === 'function' ? fx.drawEffects : null,
    effectsCamera: typeof fx?.effectsCamera === 'function' ? fx.effectsCamera : null,
    shiftEffects: typeof fx?.shiftEffects === 'function' ? fx.shiftEffects : null,
    styles: normalizeStyles(cap?.STYLES),
    real: { captions: typeof cap?.prepareCaptions === 'function' && typeof cap?.drawCaptions === 'function', fx: typeof fx?.drawEffects === 'function' },
  };
  if (!out.styles.length) out.styles = normalizeStyles(FALLBACK_STYLES);
  return out;
}

/**
 * מרכיב את העורך המהיר בתוך el.
 * options: { clipState, onExport, onChange?(state), brand?, modules?:{captions, fx}, srcAspect?, fullscreen? }
 * מחזיר שליטה: { ready, session, state, undo(), redo(), play(), pause(), seek(tOut), export(), stats(), destroy(), ... }
 */
export function mountQuickEditor(el, options = {}) {
  if (!el) throw new Error('חסר אלמנט להצגת העורך');
  const { onExport, onChange, brand = null } = options;
  const session = createSession(options.clipState, { srcAspect: options.srcAspect });
  const base = session.base;
  // כתוביות כבויות בקליפ (captions:false) או בלי מילים: לשוניות הכתוביות לא פעילות
  const hasCaps = !!base.captionSpec && options.clipState?.captions !== false && base.captionSpec.words.length > 0;
  const outAspect = session.env.outAspect;
  const specW = base.captionSpec?.width || base.size?.width || 1080;
  const specH = base.captionSpec?.height || base.size?.height || Math.round(specW / outAspect);
  const baseHooks = hooksOf(options.clipState);

  // ── סגנון ──
  if (!document.getElementById('qe-style')) { const st = document.createElement('style'); st.id = 'qe-style'; st.textContent = CSS; document.head.append(st); }

  // ── מצב זמן ריצה ──
  let st = session.state;
  let drawCam = st.camera; let camSig = null;
  let mods = null; let prepared = null; let prepSeq = 0; let specSeen = null; let prepTimer = 0; let capsFailed = false; let fxFailed = false; let tplFailed = false;
  let playing = false; let dirty = true; let raf = 0; let destroyed = false; let scrubbing = false;
  let view = null; let quality = 1; let tab = hasCaps ? 'words' : 'frame';
  let selectedWord = -1; let activeWord = -1; let lastShot = -1; let fgesture = null; let wheelTimer = 0;
  let exporting = false; let exportCtl = null; let toastTimer = 0; let styleScrollTimer = 0; let styleProgrammatic = 0;
  let objectUrl = null; let lastPaintT = -1; let lastPaintAt = 0; let framesSincePaint = 0; let jumpPending = 0; let jumpAt = 0; let painted = false; let musicEl = null; let musicId = ''; let chipsSig = '';
  const shots = session.shots;
  const stats = { draw: [], frame: [], last: 0, qualityChanges: 0 };
  const gesture = createGestureTracker();
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);

  // ── DOM ──
  const root = h('div', { class: `qe${options.fullscreen === false ? '' : ' qe-full'}`, lang: 'he', dir: 'rtl', role: 'application', 'aria-label': T.title });
  const video = h('video', { class: 'qe-video', playsinline: true, preload: 'auto', 'webkit-playsinline': true, 'aria-hidden': 'true', tabindex: '-1' });
  video.playsInline = true; video.muted = false;
  const canvas = h('canvas', { class: 'qe-canvas', 'aria-label': 'תצוגה מקדימה של הקליפ' });
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  const cwrap = h('div', { class: 'qe-cwrap' }, canvas);
  const bigPlay = h('div', { class: 'qe-bigplay', 'aria-hidden': 'true' }, icon('play'));
  const pillShot = h('div', { class: 'qe-pill shot' });
  const pillTime = h('div', { class: 'qe-pill time' }, '0:00.0');
  const pillHint = h('div', { class: 'qe-pill hint' }, T.dragHint);
  const resetShotBtn = h('button', { class: 'qe-chip-reset', type: 'button', hidden: true, onclick: () => resetCurrentShot() }, T.resetShot);
  cwrap.append(bigPlay, pillShot, pillTime, pillHint, resetShotBtn);
  const stage = h('div', { class: 'qe-stage' }, cwrap);

  const undoBtn = h('button', { class: 'qe-ic', type: 'button', 'aria-label': T.undo, title: T.undo, onclick: () => doUndo() }, icon('undo'));
  const redoBtn = h('button', { class: 'qe-ic', type: 'button', 'aria-label': T.redo, title: T.redo, onclick: () => doRedo() }, icon('redo'));
  const exportFill = h('i');
  const exportLabel = h('span', {}, T.export);
  const exportBtn = h('button', { class: 'qe-export', type: 'button', 'aria-label': T.export, onclick: () => doExport() }, exportFill, exportLabel);
  if (typeof onExport !== 'function') exportBtn.hidden = true;
  const top = h('div', { class: 'qe-top' }, undoBtn, redoBtn, h('div', { class: 'qe-title' }, T.title), exportBtn);

  // ציר זמן
  const playBtn = h('button', { class: 'qe-play', type: 'button', 'aria-label': T.play, onclick: () => toggle() }, icon('play'));
  const shotEls = shots.map((s) => h('div', { class: 'qe-shot' }));
  const shotsBox = h('div', { class: 'qe-shots' }, shotEls);
  const dimL = h('div', { class: 'qe-dim' }); const dimR = h('div', { class: 'qe-dim' });
  const hStart = h('div', { class: 'qe-h', role: 'slider', 'aria-label': T.trimStart, tabindex: '0' });
  const hEnd = h('div', { class: 'qe-h', role: 'slider', 'aria-label': T.trimEnd, tabindex: '0' });
  const ph = h('div', { class: 'qe-ph' });
  const track = h('div', { class: 'qe-track' }, shotsBox, dimL, dimR, ph, hStart, hEnd);
  const infoStart = h('span'); const infoLen = h('span'); const infoEnd = h('span');
  const tl = h('div', { class: 'qe-tl' }, playBtn, h('div', { class: 'qe-tl-main' }, track), h('div', { class: 'qe-tl-info' }, infoStart, infoLen, infoEnd));

  // לשוניות
  const tabDefs = [['words', hasCaps], ['style', hasCaps], ['hook', hasCaps], ['frame', true], ['sound', true]];
  const tabBtns = {};
  const tabs = h('div', { class: 'qe-tabs', role: 'tablist' }, tabDefs.map(([id, on]) => {
    const b = h('button', { class: 'qe-tab', type: 'button', role: 'tab', disabled: !on, dataset: { tab: id }, onclick: () => setTab(id) }, T.tabs[id]);
    tabBtns[id] = b; return b;
  }));

  // לשונית מילים
  const chipsEl = h('div', { class: 'qe-chips', role: 'group', 'aria-label': 'מילות הכתוביות', onclick: (e) => { const b = e.target.closest?.('.qe-chip'); if (b) openWordEditor(Number(b.dataset.i)); } });
  const paneWords = h('div', { class: 'qe-pane', dataset: { pane: 'words' } }, h('p', { class: 'qe-hint' }, hasCaps ? T.wordsHint : T.noCaptions), chipsEl);

  // לשונית סגנון
  const stylesEl = h('div', { class: 'qe-styles', role: 'listbox', 'aria-label': T.tabs.style, onscroll: () => onStyleScroll() });
  const styleDesc = h('p', { class: 'qe-hint' }, T.styleHint);
  const paneStyle = h('div', { class: 'qe-pane', dataset: { pane: 'style' } }, styleDesc, stylesEl);

  // לשונית כותרת (hook)
  const hookList = h('div', { class: 'qe-chips' });
  const hookInput = h('input', { class: 'qe-input sm', type: 'text', maxlength: '120', placeholder: T.hookCustom, enterkeyhint: 'done', autocomplete: 'off', dir: 'auto', lang: 'he', 'aria-label': T.hookCustom,
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); applyCustomHook(); hookInput.blur(); } } });
  const hookApplyBtn = h('button', { class: 'qe-btn primary', type: 'button', onclick: () => applyCustomHook() }, T.hookApply);
  const paneHook = h('div', { class: 'qe-pane', dataset: { pane: 'hook' } }, h('p', { class: 'qe-hint' }, T.hookHint), hookList, h('div', { class: 'qe-row', style: 'margin-top:10px;flex-wrap:nowrap' }, hookInput, hookApplyBtn));

  // לשונית מסגור
  const frameInfo = h('p', { class: 'qe-hint' }, T.frameHint);
  const mkBtn = (label, ic, fn) => h('button', { class: 'qe-btn', type: 'button', 'aria-label': label, title: label, onclick: fn }, ic ? icon(ic) : null, label);
  const arrowBtn = (ic, label, fx, fy) => h('button', { class: 'qe-btn', type: 'button', 'aria-label': `הזזה ${label}`, title: `הזזה ${label}`, style: 'min-width:68px', onclick: () => nudgePan(fx, fy) }, icon(ic));
  const paneFrame = h('div', { class: 'qe-pane', dataset: { pane: 'frame' } }, frameInfo,
    h('div', { class: 'qe-row' }, mkBtn(T.zoomIn, 'plus', () => nudgeZoom(1.18)), mkBtn(T.zoomOut, 'minus', () => nudgeZoom(1 / 1.18)), mkBtn(T.resetShot, null, () => resetCurrentShot()), mkBtn(T.resetAll, null, () => resetAllFraming())),
    // בסדר ימין לשמאל: ימינה, למטה, למעלה, שמאלה (כלומר בפועל מהשמאל לימין: ← ↑ ↓ →)
    h('div', { class: 'qe-row' }, arrowBtn('right', 'ימינה', -0.06, 0), arrowBtn('down', 'למטה', 0, -0.06), arrowBtn('up', 'למעלה', 0, 0.06), arrowBtn('left', 'שמאלה', 0.06, 0)));

  // לשונית סאונד
  const musicEl2 = h('div', { class: 'qe-chips' });
  const levelEl = h('div', { class: 'qe-chips' });
  const paneSound = h('div', { class: 'qe-pane', dataset: { pane: 'sound' } }, h('div', { class: 'qe-sub', style: 'margin-top:0' }, T.music), musicEl2, h('div', { class: 'qe-sub' }, T.level), levelEl);

  const panes = { words: paneWords, style: paneStyle, hook: paneHook, frame: paneFrame, sound: paneSound };
  const panel = h('div', { class: 'qe-panel', role: 'tabpanel' }, Object.values(panes));

  // גיליון תיקון מילה
  const wInput = h('input', { class: 'qe-input', type: 'text', maxlength: '140', enterkeyhint: 'done', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'true', dir: 'auto', lang: 'he', 'aria-label': T.wordEdit,
    oninput: () => onWordInput(),
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); saveWord(); } else if (e.key === 'Escape') { e.preventDefault(); closeWordEditor(true); } } });
  const wTiming = h('span'); const wOrig = h('span');
  const wRestore = h('button', { class: 'qe-btn', type: 'button', onclick: () => { wInput.value = base.captionSpec.words[selectedWord].text; onWordInput(); wInput.focus(); } }, T.restore);
  const wDelete = h('button', { class: 'qe-btn danger', type: 'button', 'aria-label': T.del, title: T.del, onclick: () => { wInput.value = ''; saveWord(); } }, icon('trash'), T.del);
  const sheet = h('div', { class: 'qe-sheet', role: 'dialog', 'aria-label': T.wordEdit },
    h('h3', {}, h('span', {}, T.wordEdit), wTiming), wInput,
    h('div', { class: 'qe-row' },
      h('button', { class: 'qe-btn primary grow', type: 'button', onclick: () => saveWord() }, T.save),
      h('button', { class: 'qe-btn', type: 'button', onclick: () => closeWordEditor(true) }, T.cancel)),
    h('div', { class: 'qe-row' },
      h('button', { class: 'qe-btn grow', type: 'button', onclick: () => stepWord(-1) }, icon('right'), T.prevWord),
      h('button', { class: 'qe-btn grow', type: 'button', onclick: () => stepWord(1) }, T.nextWord, icon('left')),
      wDelete),
    h('div', { class: 'qe-row', style: 'align-items:center;justify-content:space-between;margin-top:8px' }, h('h3', { style: 'margin:0' }, wOrig), wRestore));
  const toastEl = h('div', { class: 'qe-toast', role: 'status', 'aria-live': 'polite' });

  root.append(top, stage, tl, tabs, panel, sheet, toastEl, video);
  el.append(root);

  // ── מקור הווידאו ──
  const src = options.clipState?.file || options.clipState?.blob || null;
  if (src instanceof Blob) { objectUrl = URL.createObjectURL(src); video.src = objectUrl; }
  else if (typeof options.clipState?.url === 'string') video.src = options.clipState.url;
  else if (typeof src === 'string') video.src = src;
  const hasVideo = !!video.getAttribute('src');
  if (!hasVideo) setTimeout(() => toast(T.noVideo), 400);

  // ── עזרים ──
  function toast(msg, ms = 2400) {
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  const schedule = () => { if (!raf && !destroyed) raf = requestAnimationFrame(frame); };
  const markDirty = () => { dirty = true; schedule(); };

  /** זמן הפלט הנוכחי (במצב הסופי, אחרי קיצוץ), לפי מיקום ה־video. */
  function nowOut() {
    if (!hasVideo) return clamp(manualT, 0, st.duration);
    const t = sourceToOut(st.plan, video.currentTime, 0.06);
    return t === null ? (lastOut ?? 0) : t;
  }
  let manualT = 0; let lastOut = 0;
  const baseTimeOf = (tOut) => tOut + st.trim.offset;

  // ── נגן ──
  function play() {
    if (playing || destroyed) return;
    playing = true; updatePlayUi();
    if (hasVideo) {
      if (sourceToOut(st.plan, video.currentTime, 0.06) === null || nowOut() >= st.duration - 0.05) video.currentTime = outToSource(st.plan, 0);
      const p = video.play(); if (p?.catch) p.catch(() => { playing = false; updatePlayUi(); });
    }
    syncMusic(); pillHint.classList.add('gone'); schedule();
  }
  function pause() {
    if (!playing) { return; }
    playing = false; if (hasVideo) video.pause();
    updatePlayUi(); syncMusic(); markDirty();
  }
  const toggle = () => (playing ? pause() : play());
  function seek(tOut) {
    const t = clamp(tOut, 0, st.duration);
    manualT = t; lastOut = t;
    if (hasVideo) { const s = outToSource(st.plan, t); if (Math.abs(video.currentTime - s) > 0.001) { jumpPending = 1; jumpAt = performance.now(); video.currentTime = s; } }
    markDirty();
  }
  function updatePlayUi() {
    playBtn.replaceChildren(icon(playing ? 'pause' : 'play'));
    playBtn.setAttribute('aria-label', playing ? T.pause : T.play);
    bigPlay.classList.toggle('off', playing);
  }
  video.addEventListener('seeked', () => { jumpPending = 0; markDirty(); });
  video.addEventListener('loadeddata', () => { markDirty(); });
  video.addEventListener('ended', () => { if (playing) { video.currentTime = outToSource(st.plan, 0); const p = video.play(); p?.catch?.(() => {}); } });
  video.addEventListener('error', () => { toast(T.loadFail, 4000); });
  document.addEventListener('visibilitychange', onVisibility);
  function onVisibility() { if (document.hidden) pause(); }

  // מוזיקה לתצוגה: קובץ הצלילים של המוזיקה שנבחרה, בלולאה, בעוצמה נמוכה. רק בקירוב, הסנכרון לא נדרש.
  function syncMusic() {
    const id = st.audioOptions?.music || '';
    const lv = LEVELS[st.audioOptions?.level] || LEVELS.normal;
    try { video.volume = lv.volume; } catch (_) { /* באייפון volume הוא לקריאה בלבד */ }
    if (!id || !playing) { musicEl?.pause(); return; }
    if (!musicEl) { musicEl = new Audio(); musicEl.loop = true; musicEl.preload = 'auto'; }
    if (musicId !== id) { musicId = id; musicEl.src = new URL(`../assets/music/${id}.m4a`, import.meta.url).href; }
    musicEl.volume = clamp(0.28 * lv.volume * Math.pow(10, (st.audioOptions?.musicGainDb || 0) / 20), 0, 1);
    const p = musicEl.play(); p?.catch?.(() => {});
  }

  // ── קנבס ──
  function layoutCanvas() {
    const r = stage.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return;
    const pad = 12;
    const aw = r.width - pad; const ah = r.height - pad;
    const cssW = Math.max(40, Math.min(aw, ah * outAspect)); const cssH = cssW / outAspect;
    cwrap.style.width = `${Math.floor(cssW)}px`; cwrap.style.height = `${Math.floor(cssH)}px`;
    const W = Math.max(96, Math.round(Math.min(cssW * dpr, 720) * quality)); const H = Math.round(W / outAspect);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    cwrap.classList.toggle('narrow', cssW < 200);
    view = { cssW, cssH, W, H, k: W / specW };
    markDirty();
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => layoutCanvas()) : null;
  ro?.observe(stage);
  const onWinResize = () => layoutCanvas();
  window.addEventListener('resize', onWinResize);
  const vv = window.visualViewport;
  const onVV = () => { if (options.fullscreen !== false && vv) { root.style.setProperty('--qe-h', `${Math.round(vv.height)}px`); } };
  if (vv) { vv.addEventListener('resize', onVV); onVV(); }

  const blurCanvas = document.createElement('canvas'); blurCanvas.width = 24; blurCanvas.height = Math.max(24, Math.round(24 / outAspect));
  const blurCtx = blurCanvas.getContext('2d');

  function drawCrop(c, r, dx, dy, dw, dh) {
    const vw = video.videoWidth; const vh = video.videoHeight;
    c.drawImage(video, r.x * vw, r.y * vh, r.w * vw, r.h * vh, dx, dy, dw, dh);
  }

  function drawVideoLayer(t) {
    const { W, H, k } = view; const cam = drawCam; const vw = video.videoWidth; const vh = video.videoHeight;
    if (cam.split && cam.split.active?.(t)) {
      const hh = Math.round((cam.split.halfHeight || specH / 2 - 4) * k);
      ctx.fillStyle = '#0b0c10'; ctx.fillRect(0, 0, W, H);
      drawCrop(ctx, cam.split.topAt(t), 0, 0, W, hh);
      drawCrop(ctx, cam.split.bottomAt(t), 0, H - hh, W, hh);
      return;
    }
    const r = cam.rectAt(t);
    if (cam.layout === 'fit') {
      // רקע מטושטש זול: הפריים מוקטן לקנבס זעיר ומתוח בחזרה
      blurCtx.drawImage(video, 0, 0, blurCanvas.width, blurCanvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(blurCanvas, 0, 0, W, H);
      ctx.fillStyle = 'rgba(0,0,0,.38)'; ctx.fillRect(0, 0, W, H);
      const ar = (r.w * vw) / (r.h * vh);
      let dw = W; let dh = W / ar;
      if (dh > H) { dh = H; dw = H * ar; }
      drawCrop(ctx, r, (W - dw) / 2, (H - dh) / 2, dw, dh);
      return;
    }
    drawCrop(ctx, r, 0, 0, W, H);
  }

  /**
   * השכבות מעל הווידאו, בסדר של הייצוא (pipeline.makeOverlay): אפקט תבנית מתחת, כתוביות, אפקט תבנית מעל, ואז אפקטים ומותג.
   * הכתוביות והתבנית מצוירות במידות הפלט (spec) ומוקטנות לקנבס. drawEffects מאפס טרנספורם בעצמו, ולכן מקבל את מידות הקנבס.
   */
  function paintOverlays(t) {
    const { W, H, k } = view;
    const info = { ...(st.tplInfo || {}), width: specW, height: specH, fps: base.captionSpec?.fps || 30, duration: st.plan.duration, moment: st.moment, options: st.options };
    ctx.save(); ctx.scale(k, k);
    if (typeof st.overlayUnder === 'function' && !tplFailed) { try { st.overlayUnder(ctx, t, info, video); } catch (e) { tplFailed = true; console.warn('overlayUnder', e); } }
    if (prepared && !capsFailed) { try { mods.drawCaptions(ctx, t, prepared); } catch (e) { capsFailed = true; console.warn('drawCaptions', e); } }
    if (typeof st.overlayExtra === 'function' && !tplFailed) { try { st.overlayExtra(ctx, t, info, video); } catch (e) { tplFailed = true; console.warn('overlayExtra', e); } }
    ctx.restore();
    if ((st.effects || st.brand || brand) && mods.drawEffects && !fxFailed) {
      try { mods.drawEffects(ctx, t, st.effects, { brand: st.brand || brand, width: W, height: H }); } catch (e) { fxFailed = true; console.warn('drawEffects', e); }
    }
  }

  /** מצייר פריים אחד. מחזיר false כשהווידאו באמצע קפיצה (אז משאירים את הציור הקודם כדי שלא יהיו הבהובים). */
  function paint(t, withOverlays = true) {
    if (!view) return false;
    const t0 = performance.now();
    const ready2 = hasVideo && video.readyState >= 2 && video.videoWidth;
    if (ready2 && video.seeking && painted) return false;
    if (ready2) drawVideoLayer(t);
    else { ctx.fillStyle = '#10131a'; ctx.fillRect(0, 0, view.W, view.H); }
    if (withOverlays) paintOverlays(t);
    painted = true;
    const dt = performance.now() - t0;
    stats.draw.push(dt); if (stats.draw.length > 120) stats.draw.shift();
    return true;
  }

  let prevFrameAt = 0;
  function frame(now) {
    raf = 0;
    if (destroyed) return;
    if (jumpPending && now - jumpAt > 500) jumpPending = 0;
    if (!hasVideo && playing) {
      manualT += prevFrameAt ? (now - prevFrameAt) / 1000 : 0;
      if (manualT >= st.duration) manualT = 0;
    }
    prevFrameAt = playing ? now : 0;
    if (playing && hasVideo && !jumpPending) {
      const step = playbackStep(st.plan, video.currentTime, { loop: true });
      if (step.action === 'jump') { jumpPending = 1; jumpAt = now; video.currentTime = step.to; }
    }
    const t = nowOut();
    lastOut = t;
    // בצגי 120Hz מציירים רק כל פריים שני בניגון: 60fps מספיקים, וזה חוסך סוללה
    if (playing && !dirty && now - lastPaintAt < 14.5) { schedule(); return; }
    if (playing || dirty || t !== lastPaintT) {
      dirty = false; lastPaintT = t; lastPaintAt = now;
      if (paint(t, !handleDrag)) {
        uiTick(t);
        if (stats.last) { stats.frame.push(now - stats.last); if (stats.frame.length > 120) stats.frame.shift(); }
        stats.last = playing ? now : 0;
        if (playing && ++framesSincePaint >= 45) {
          framesSincePaint = 0;
          const q = governScale(quality, avgOf(stats.draw.slice(-45)));
          if (q !== quality) { quality = q; stats.qualityChanges++; layoutCanvas(); }
        }
      }
    }
    if (playing || dirty) schedule();
  }
  const avgOf = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

  // ── עדכוני ממשק לכל פריים (רק כשיש שינוי) ──
  function uiTick(t) {
    const tb = baseTimeOf(t);
    const dur = base.duration;
    ph.style.left = `${(tb / dur) * 100}%`;
    pillTime.textContent = `${fmtTime(t)} / ${fmtTime(st.duration)}`;
    const si = shotIndexAt(shots, tb);
    if (si !== lastShot) { lastShot = si; updateShotUi(); }
    if (hasCaps && tab === 'words') {
      const i = wordIndexAt(base.captionSpec.words, tb, activeWord);
      if (i !== activeWord) { setActiveChip(i); }
    }
  }
  function updateShotUi() {
    pillShot.textContent = T.shotOf(lastShot + 1, shots.length);
    shotEls.forEach((e, i) => e.classList.toggle('cur', i === lastShot));
    syncResetBtn();
  }
  /** גולל את הלוח התחתון (רק אותו) כך שהאלמנט יהיה גלוי. scrollIntoView היה גולל גם את העורך כולו. */
  function revealInPanel(elm) {
    const pr = panel.getBoundingClientRect(); const er = elm.getBoundingClientRect();
    if (er.top < pr.top + 4) panel.scrollTop += er.top - pr.top - 8;
    else if (er.bottom > pr.bottom - 4) panel.scrollTop += er.bottom - pr.bottom + 12;
  }
  /** גולל את קרוסלת הסגנונות כך שהכרטיס יהיה במרכז (גם בכיוון RTL, כי scrollBy הוא פיזי). */
  function centerCard(card, smooth) {
    const box = stylesEl.getBoundingClientRect(); const r = card.getBoundingClientRect();
    const delta = (r.left + r.right) / 2 - (box.left + box.right) / 2;
    if (Math.abs(delta) > 1) stylesEl.scrollBy({ left: delta, behavior: smooth ? 'smooth' : 'auto' });
  }
  function setActiveChip(i) {
    const els = chipsEl.children;
    if (els[activeWord]) els[activeWord].classList.remove('on');
    activeWord = i;
    const c = els[i];
    if (c) { c.classList.add('on'); if (playing && !chipsEl.matches(':active')) revealInPanel(c); }
  }

  function renderTimelineStatic() {
    const dur = base.duration;
    shots.forEach((s, i) => { const e = shotEls[i]; e.style.left = `${(s.a / dur) * 100}%`; e.style.width = `${((s.b - s.a) / dur) * 100}%`; });
  }
  function renderTrimUi() {
    const dur = base.duration; const a = st.trim.start; const b = st.trim.end;
    const pa = (a / dur) * 100; const pb = (b / dur) * 100;
    hStart.style.left = `${pa}%`; hEnd.style.left = `${pb}%`;
    dimL.style.left = '0'; dimL.style.width = `${pa}%`;
    dimR.style.left = `${pb}%`; dimR.style.width = `${100 - pb}%`;
    infoStart.textContent = fmtTime(a); infoEnd.textContent = fmtTime(b);
    infoLen.textContent = `${(b - a).toFixed(1)} ${T.secs}`;
    hStart.setAttribute('aria-valuenow', String(a)); hEnd.setAttribute('aria-valuenow', String(b));
  }
  function renderShotsOverride() {
    shots.forEach((s, i) => {
      const ov = ['main', 'top', 'bottom'].some((p) => session.framingFor(overrideKey(p, s.a)));
      shotEls[i].classList.toggle('ov', ov);
    });
    syncResetBtn();
  }
  function syncResetBtn() {
    const on = hasOverrideAt(lastShot);
    resetShotBtn.hidden = !on;
    pillHint.style.visibility = on ? 'hidden' : '';
  }
  const hasOverrideAt = (i) => i >= 0 && ['main', 'top', 'bottom'].some((p) => session.framingFor(overrideKey(p, shots[i].a)));

  // ── לשוניות ──
  function setTab(id) {
    if (!panes[id] || tabBtns[id].disabled) return;
    tab = id;
    for (const [k, p] of Object.entries(panes)) p.hidden = k !== id;
    for (const [k, b] of Object.entries(tabBtns)) b.setAttribute('aria-selected', String(k === id));
    if (id === 'style') centerStyle(false);
    if (id === 'words') { activeWord = -1; markDirty(); }
  }

  // ── לשונית מילים ──
  function renderChips() {
    if (!hasCaps) return;
    const words = base.captionSpec.words;
    const frag = document.createDocumentFragment();
    words.forEach((w, i) => {
      const txt = session.wordText(i);
      const out = w.end <= st.trim.start + 0.001 || w.start >= st.trim.end - 0.001;
      frag.append(h('button', { class: `qe-chip${session.isWordEdited(i) ? ' edited' : ''}${txt ? '' : ' gone'}${out ? ' out' : ''}`, type: 'button', dataset: { i }, dir: 'auto' }, txt || w.text));
    });
    chipsEl.replaceChildren(frag);
    activeWord = -1;
  }

  function openWordEditor(i) {
    const w = base.captionSpec?.words?.[i];
    if (!w) return;
    pause();
    selectedWord = i;
    const tOut = clamp(w.start - st.trim.offset + (w.end - w.start) * 0.3, 0, st.duration);
    seek(tOut);
    wInput.value = session.wordText(i);
    wOrig.textContent = `${T.original}: ${w.text}`;
    wTiming.textContent = `${fmtTime(w.start)} ${T.until} ${fmtTime(w.end)}`;
    wRestore.hidden = !session.isWordEdited(i);
    sheet.classList.add('open');
    // focus חייב לרוץ באותה קריאה של אירוע המשתמש, אחרת באייפון המקלדת לא נפתחת
    try { wInput.focus({ preventScroll: true }); wInput.select(); } catch (_) { /* ignore */ }
  }
  function onWordInput() {
    if (selectedWord < 0) return;
    session.liveWord(selectedWord, wInput.value);
  }
  function saveWord() {
    if (selectedWord < 0) return;
    const i = selectedWord;
    const text = wInput.value;
    session.liveWord(i, text);
    const empty = !sanitizeWordText(text);
    session.commitLive();
    toast(empty ? T.wordDeleted : T.wordSaved, 1400);
    closeWordEditor(false);
  }
  function closeWordEditor(cancel) {
    if (cancel) session.cancelLive();
    sheet.classList.remove('open');
    selectedWord = -1;
    wInput.blur();
  }
  function stepWord(dir) {
    if (selectedWord < 0) return;
    const n = base.captionSpec.words.length; const next = clamp(selectedWord + dir, 0, n - 1);
    if (next === selectedWord) return;
    session.liveWord(selectedWord, wInput.value); session.commitLive();
    openWordEditor(next);
  }

  // ── לשונית סגנון ──
  function renderStyles() {
    if (!hasCaps) return;
    const cur = st.captionSpec.style;
    stylesEl.replaceChildren(...mods.styles.map((x) => {
      const pv = x.preview;
      const sample = h('b', {}, pv?.text || 'אבג');
      if (pv) {
        sample.style.color = cssColor(pv.fill || pv.accent || '#fff');
        sample.style.textShadow = `0 0 0 ${cssColor(pv.accent || 'transparent')}, 0 2px 0 ${cssColor(pv.stroke || '#000')}`;
        if (pv.accent) sample.style.borderBottom = `3px solid ${cssColor(pv.accent)}`;
      }
      const b = h('button', { class: `qe-style${x.id === cur ? ' on' : ''}`, type: 'button', role: 'option', 'aria-selected': String(x.id === cur), title: x.desc || x.name, dataset: { id: x.id },
        onclick: () => centerCard(b, true) }, sample, h('span', {}, x.name));
      return b;
    }));
    updateStyleDesc();
  }
  function updateStyleDesc() {
    const x = mods.styles.find((y) => y.id === st.captionSpec?.style);
    styleDesc.textContent = x?.desc || T.styleHint;
  }
  function centerStyle(smooth) {
    const cur = stylesEl.querySelector('.qe-style.on');
    if (!cur) return;
    styleProgrammatic = performance.now() + 450;
    stylesEl.style.scrollBehavior = 'auto';
    centerCard(cur, false);
    stylesEl.style.scrollBehavior = '';
  }
  function onStyleScroll() {
    if (performance.now() < styleProgrammatic) return;
    clearTimeout(styleScrollTimer);
    styleScrollTimer = setTimeout(() => {
      const items = [...stylesEl.children]; if (!items.length) return;
      const box = stylesEl.getBoundingClientRect();
      const i = nearestToCenter(items.map((x) => x.getBoundingClientRect()), (box.left + box.right) / 2);
      const id = items[i]?.dataset.id;
      if (id && id !== st.captionSpec.style) session.setStyle(id);
    }, 110);
  }
  const cssColor = (c) => String(c).replace(/[^#a-zA-Z0-9(),.%\s-]/g, '');

  // ── לשונית כותרת ──
  function renderHooks() {
    if (!hasCaps) return;
    const cur = st.captionSpec.hook?.text || '';
    const list = [...baseHooks];
    if (cur && !list.includes(cur)) list.unshift(cur);
    const chips = list.map((txt) => h('button', { class: `qe-chip${txt === cur ? ' on' : ''}`, type: 'button', dir: 'auto', onclick: () => { session.setHook(txt); hookInput.value = ''; } }, txt));
    chips.push(h('button', { class: `qe-chip${cur ? '' : ' on'}`, type: 'button', onclick: () => { session.setHook(null); hookInput.value = ''; } }, T.hookNone));
    hookList.replaceChildren(...chips);
  }
  function applyCustomHook() {
    const v = sanitizeWordText(hookInput.value);
    if (!v) return;
    session.setHook(v); hookInput.value = '';
  }

  // ── לשונית סאונד ──
  function renderSound() {
    const cur = st.audioOptions?.music || '';
    musicEl2.replaceChildren(...MUSIC.map((m) => h('button', { class: `qe-chip${m.id === cur ? ' on' : ''}`, type: 'button', onclick: () => { session.setMusic(m.id); if (!playing && m.id) play(); } }, m.nameHe)));
    const lv = st.audioOptions?.level || (st.audioOptions?.loudness != null ? closestLevel(st.audioOptions.loudness) : 'normal');
    levelEl.replaceChildren(...Object.values(LEVELS).map((l) => h('button', { class: `qe-chip${l.id === lv ? ' on' : ''}`, type: 'button', onclick: () => session.setLevel(l.id) }, l.nameHe)));
  }
  const closestLevel = (db) => Object.values(LEVELS).reduce((a, b) => (Math.abs(b.loudness - db) < Math.abs(a.loudness - db) ? b : a)).id;

  // ── מסגור ──
  /** החלקים שהמסגור חל עליהם עכשיו: main, או top ו־bottom כשהמסך מפוצל. */
  function activeParts() {
    const tb = baseTimeOf(lastOut);
    return base.camera.split?.active?.(tb) ? ['top', 'bottom'] : ['main'];
  }
  function gestureContext(clientY) {
    const rect = canvas.getBoundingClientRect();
    const yf = clamp((clientY - rect.top) / rect.height, 0, 1);
    const tb = baseTimeOf(lastOut);
    const sp = base.camera.split;
    const shot = shots[shotIndexAt(shots, tb)];
    let part = 'main';
    if (sp?.active?.(tb)) part = yf < 0.5 ? 'top' : 'bottom';
    return { part, shot, key: overrideKey(part, shot.a) };
  }
  /** גבולות האזור (בחלקי קנבס) של החלק, כדי לחשב אצבע -> מקור. */
  function partBox(part) {
    if (part === 'main') return { y0: 0, hFrac: 1 };
    const hh = (base.camera.split?.halfHeight || specH / 2 - 4) / specH;
    return part === 'top' ? { y0: 0, hFrac: hh } : { y0: 1 - hh, hFrac: hh };
  }
  const envOf = () => ({ srcAspect: session.env.srcAspect, outAspect });

  function beginFraming(clientY) {
    const g = gestureContext(clientY);
    fgesture = { ...g, ov: session.framingFor(g.key) || { dx: 0, dy: 0, zoom: 1 }, wasFit: base.camera.layout === 'fit' };
  }
  function applyFramingStep(fn) {
    if (!fgesture) return;
    const tb = baseTimeOf(lastOut);
    const rect = baseRectOf(base.camera, fgesture.part, tb, envOf());
    fgesture.ov = fn(fgesture.ov, rect);
    session.liveFraming(fgesture.key, fgesture.ov, fgesture.shot);
  }
  function endFraming(commit = true) {
    if (!fgesture) return;
    const f = fgesture; fgesture = null;
    if (commit) {
      const had = base.camera.layout === 'fit' && !Object.keys(session.edits.framing).some((k) => k.startsWith('main@'));
      if (session.commitLive(`framing:${f.key}`) && had && f.part === 'main') toast(T.fitConverted, 3200);
    } else session.cancelLive();
  }
  function pointerFrac(e) {
    const r = canvas.getBoundingClientRect();
    return { u: clamp((e.clientX - r.left) / r.width, 0, 1), v: clamp((e.clientY - r.top) / r.height, 0, 1) };
  }

  function handleGestureEvents(evs, e) {
    for (const ev of evs) {
      if (ev.type === 'begin') { pillHint.classList.add('gone'); if (!sheet.classList.contains('open')) beginFraming(e.clientY); }
      else if (ev.type === 'pan') {
        if (!fgesture) continue;
        const r = canvas.getBoundingClientRect(); const box = partBox(fgesture.part);
        const fx = ev.dx / r.width; const fy = ev.dy / (r.height * box.hFrac);
        applyFramingStep((ov, rect) => panOverride(ov, rect, fx, fy));
      } else if (ev.type === 'zoom') {
        if (!fgesture) continue;
        const r = canvas.getBoundingClientRect(); const box = partBox(fgesture.part);
        const u = clamp((ev.x - r.left) / r.width, 0, 1);
        const v = clamp(((ev.y - r.top) / r.height - box.y0) / box.hFrac, 0, 1);
        applyFramingStep((ov, rect) => zoomOverride(ov, rect, ev.factor, u, v));
      } else if (ev.type === 'end') endFraming(!ev.cancelled);
      else if (ev.type === 'tap') { if (!sheet.classList.contains('open')) toggle(); }
    }
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    handleGestureEvents(gesture.down(e.pointerId, e.clientX, e.clientY, e.timeStamp), e);
  });
  canvas.addEventListener('pointermove', (e) => handleGestureEvents(gesture.move(e.pointerId, e.clientX, e.clientY), e));
  const onUp = (e) => handleGestureEvents(gesture.up(e.pointerId, e.clientX, e.clientY, e.timeStamp), e);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', (e) => { handleGestureEvents(gesture.cancel(), e); });
  canvas.addEventListener('wheel', (e) => {
    if (sheet.classList.contains('open')) return;
    e.preventDefault();
    if (!fgesture) beginFraming(e.clientY);
    const { u, v } = pointerFrac(e); const box = partBox(fgesture.part);
    const factor = Math.exp(-e.deltaY * 0.0016);
    applyFramingStep((ov, rect) => zoomOverride(ov, rect, factor, u, clamp((v - box.y0) / box.hFrac, 0, 1)));
    clearTimeout(wheelTimer); wheelTimer = setTimeout(() => endFraming(true), 320);
  }, { passive: false });

  /** מפעיל פעולה על כל החלקים הפעילים בקטע הנוכחי, כעריכה אחת בהיסטוריה. */
  function nudgeFraming(fn, tag) {
    const tb = baseTimeOf(lastOut); const shot = shots[shotIndexAt(shots, tb)];
    let framing = { ...session.edits.framing };
    const firstFit = base.camera.layout === 'fit' && !Object.keys(framing).some((k) => k.startsWith('main@'));
    for (const part of activeParts()) {
      const key = overrideKey(part, shot.a);
      const ov0 = session.framingFor(key) || { dx: 0, dy: 0, zoom: 1 };
      const rect = baseRectOf(base.camera, part, tb, envOf());
      framing = withFraming(framing, key, fn(ov0, rect), shot);
    }
    session.apply({ framing }, { key: `${tag}:${shot.a}` });
    if (firstFit) toast(T.fitConverted, 3200);
  }
  const nudgeZoom = (factor) => nudgeFraming((ov, rect) => zoomOverride(ov, rect, factor, 0.5, 0.5), 'zoom');
  const nudgePan = (fx, fy) => nudgeFraming((ov, rect) => panOverride(ov, rect, fx, fy), 'pan');
  function resetCurrentShot() {
    const tb = baseTimeOf(lastOut); const shot = shots[shotIndexAt(shots, tb)];
    const next = { ...session.edits.framing };
    for (const p of ['main', 'top', 'bottom']) delete next[overrideKey(p, shot.a)];
    session.apply({ framing: next });
  }
  function resetAllFraming() { session.clearFraming(); }

  // ── ציר זמן: גרירת ידיות וסריקה ──
  function trackGeom() { const r = track.getBoundingClientRect(); return { left: r.left, width: r.width }; }
  let handleDrag = null;
  for (const [el2, which] of [[hStart, 'start'], [hEnd, 'end']]) {
    el2.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      try { el2.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      pause(); handleDrag = { which, id: e.pointerId };
    });
    el2.addEventListener('pointermove', (e) => {
      if (!handleDrag || handleDrag.id !== e.pointerId) return;
      const g = trackGeom(); const t = xToTime(e.clientX - g.left, base.duration, g.width);
      const cur = session.live?.trim || session.edits.trim || { start: 0, end: base.duration };
      const nt = dragTrimHandle(which, t, cur, base.duration);
      if ((which === 'start' && t > cur.end - MIN_CLIP + 0.05) || (which === 'end' && t < cur.start + MIN_CLIP - 0.05)) toast(T.trimMin, 1200);
      session.liveTrim(nt.start, nt.end);
      // תצוגה של הפריים שבידית: זמן בסיס t -> זמן פלט אחרי הקיצוץ החי
      const tOut = clamp((which === 'start' ? nt.start : nt.end) - st.trim.offset, 0, st.duration);
      if (hasVideo) { const s = outToSource(st.plan, tOut); if (video.fastSeek && !video.seeking) video.fastSeek(s); else video.currentTime = s; }
      lastOut = tOut; manualT = tOut; markDirty();
    });
    const finish = (e) => {
      if (!handleDrag || handleDrag.id !== e.pointerId) return;
      handleDrag = null;
      session.commitLive('trim');
      seek(0);
    };
    el2.addEventListener('pointerup', finish);
    el2.addEventListener('pointercancel', (e) => { if (handleDrag) { handleDrag = null; session.cancelLive(); seek(0); } });
    el2.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 1 : 0.1; const cur = session.edits.trim || { start: 0, end: base.duration };
      let d = 0; if (e.key === 'ArrowRight') d = step; else if (e.key === 'ArrowLeft') d = -step; else return;
      e.preventDefault();
      const t = (which === 'start' ? cur.start : cur.end) + d;
      const nt = dragTrimHandle(which, t, cur, base.duration);
      session.setTrim(nt.start, nt.end, { key: 'trim-key' }); seek(0);
    });
  }
  track.addEventListener('pointerdown', (e) => {
    if (e.target === hStart || e.target === hEnd) return;
    try { track.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    scrubbing = true; pause(); scrubTo(e);
  });
  track.addEventListener('pointermove', (e) => { if (scrubbing) scrubTo(e); });
  const endScrub = () => { scrubbing = false; };
  track.addEventListener('pointerup', endScrub); track.addEventListener('pointercancel', endScrub);
  function scrubTo(e) {
    const g = trackGeom(); const tb = xToTime(e.clientX - g.left, base.duration, g.width);
    seek(clamp(tb - st.trim.offset, 0, st.duration));
  }

  // ── ייצוא, ביטול ושחזור ──
  function doUndo() { if (session.undo()) toast(T.undo, 900); }
  function doRedo() { if (session.redo()) toast(T.redo, 900); }
  async function doExport() {
    if (exporting || typeof onExport !== 'function') return;
    closeWordEditor(false); pause();
    exporting = true; exportCtl = new AbortController(); exportBtn.disabled = true; exportLabel.textContent = T.exporting; exportFill.style.transform = 'scaleX(0)';
    const onProgress = (f, text) => { exportFill.style.transform = `scaleX(${clamp(Number(f) || 0, 0, 1)})`; if (text) exportLabel.textContent = String(text); };
    try {
      await onExport(session.exportState(), { onProgress, signal: exportCtl.signal });
      toast(T.exported);
    } catch (e) {
      if (e?.name !== 'AbortError') toast(e?.message && /[֐-׿]/.test(e.message) ? e.message : T.exportFailed, 4200);
    } finally {
      exporting = false; exportBtn.disabled = false; exportLabel.textContent = T.export; exportFill.style.transform = 'scaleX(0)'; exportCtl = null;
    }
  }

  // ── כתוביות: הכנה מחדש כשהמפרט משתנה ──
  function scheduleCaptions(immediate = false) {
    clearTimeout(prepTimer);
    if (!mods) return;
    prepTimer = setTimeout(refreshCaptions, immediate ? 0 : 90);
  }
  async function refreshCaptions() {
    const spec = st.captionSpec;
    if (!spec || !hasCaps) { prepared?.dispose?.(); prepared = null; markDirty(); return; }
    const seq = ++prepSeq;
    try {
      const p = mods.prepareCaptions(spec);
      if (p && typeof p.ready?.then === 'function') await p.ready;          // גופנים ופריסה, לפני הציור הראשון
      if (seq !== prepSeq || destroyed) { try { p?.dispose?.(); } catch (_) { /* ignore */ } return; }
      const old = prepared; prepared = p; capsFailed = false;
      try { old?.dispose?.(); } catch (_) { /* ignore */ }
      try { p?.warm?.(0, Infinity)?.then?.(() => markDirty()); } catch (_) { /* חימום הוא אופציונלי */ }
    } catch (e) {
      if (seq !== prepSeq) return;
      console.warn('prepareCaptions', e);
      if (!prepared?.stub) { prepared = stubPrepare(spec); toast(T.capsFail, 3200); } else prepared = stubPrepare(spec);
    }
    markDirty();
  }

  /** המצלמה לציור: המצלמה הערוכה, ועליה זום ההדגשה והרעידה של האפקטים (כמו בייצוא, ב־pipeline.renderTail). */
  function refreshCam() {
    drawCam = st.camera;
    if (st.effects && mods?.effectsCamera) {
      try { const c = mods.effectsCamera(st.camera, st.effects); if (c && typeof c.rectAt === 'function') drawCam = c; } catch (e) { console.warn('effectsCamera', e); }
    }
  }

  // ── תגובה לשינויים בסשן ──
  session.subscribe((kind) => {
    const prevOffset = st.trim.offset; const prevPlanSig = JSON.stringify(st.plan.segments);
    st = session.state; refreshCam();
    if (st.captionSpec !== specSeen) { specSeen = st.captionSpec; scheduleCaptions(); }
    if (kind !== 'live') {
      undoBtn.disabled = !session.canUndo && !session.live; redoBtn.disabled = !session.canRedo;
      const sig = stable([session.edits.words, st.trim]);
      if (sig !== chipsSig) { chipsSig = sig; renderChips(); }
      renderHooks(); renderSound(); renderShotsOverride();
      if (hasCaps) { for (const b of stylesEl.children) { const on = b.dataset.id === st.captionSpec.style; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); } updateStyleDesc(); if (kind === 'undo' || kind === 'redo') centerStyle(true); }
      syncMusic();
      if (JSON.stringify(st.plan.segments) !== prevPlanSig) {
        // התוכנית השתנתה (קיצוץ או ביטול קיצוץ): נשארים באותו רגע בקליפ אם הוא עדיין בפנים, אחרת מההתחלה
        const tBase = lastOut + prevOffset;
        const tNew = tBase - st.trim.offset;
        seek(tNew >= 0 && tNew <= st.duration ? tNew : 0);
      }
      options.onChange?.(st, kind);
    }
    renderTrimUi();
    markDirty();
  });

  // ── מקלדת (בדפדפן שולחני) ──
  function onKey(e) {
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); }
    else if (e.key === ' ' && tag !== 'button') { e.preventDefault(); toggle(); }
  }
  document.addEventListener('keydown', onKey);

  // ── פתיחה ──
  const ready = (async () => {
    mods = await loadModules(options.modules || {});
    if (options.modules?.shiftEffects) session.env.shiftEffects = options.modules.shiftEffects;
    else if (mods.shiftEffects) session.env.shiftEffects = mods.shiftEffects;
    st = session.state; refreshCam();
    specSeen = st.captionSpec;
    renderTimelineStatic(); renderTrimUi(); renderChips(); renderStyles(); renderHooks(); renderSound(); renderShotsOverride(); updateShotUi();
    undoBtn.disabled = true; redoBtn.disabled = true;
    setTab(tab);
    layoutCanvas();
    await refreshCaptions();
    if (hasVideo) {
      if (video.readyState < 1) await new Promise((res) => { const done = () => res(); video.addEventListener('loadedmetadata', done, { once: true }); video.addEventListener('error', done, { once: true }); setTimeout(done, 8000); });
      if (video.videoWidth) session.setSource(video.videoWidth, video.videoHeight);
      st = session.state; refreshCam();
      seek(0);
      if (video.requestVideoFrameCallback) {
        const arm = () => { if (destroyed) return; video.requestVideoFrameCallback(() => { if (!playing) markDirty(); arm(); }); };
        arm();
      }
    }
    layoutCanvas(); markDirty();
    return api;
  })();

  function destroy() {
    if (destroyed) return;
    destroyed = true; playing = false;
    cancelAnimationFrame(raf); clearTimeout(prepTimer); clearTimeout(toastTimer); clearTimeout(styleScrollTimer); clearTimeout(wheelTimer);
    exportCtl?.abort();
    document.removeEventListener('keydown', onKey); document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('resize', onWinResize); vv?.removeEventListener('resize', onVV); ro?.disconnect();
    try { video.pause(); video.removeAttribute('src'); video.load(); } catch (_) { /* ignore */ }
    try { musicEl?.pause(); } catch (_) { /* ignore */ }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    try { prepared?.dispose?.(); } catch (_) { /* ignore */ }
    root.remove();
  }

  const api = {
    ready, session, el: root, video, canvas,
    get state() { return session.state; },
    get clipState() { return session.state; },
    get playing() { return playing; },
    get modules() { return mods ? { ...mods.real } : null; },
    get time() { return lastOut; },
    get musicElement() { return musicEl; },
    getState: () => session.exportState(),
    undo: doUndo, redo: doRedo, play, pause, toggle, seek,
    setTab, export: doExport, destroy,
    openWordEditor, closeWordEditor,
    stats() {
      const d = stats.draw; const f = stats.frame;
      const sorted = [...d].sort((a, b) => a - b);
      const af = avgOf(f);
      return { drawMs: avgOf(d), drawP95: sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0, fps: af ? 1000 / af : 0, quality, qualityChanges: stats.qualityChanges, canvas: view ? { w: view.W, h: view.H } : null };
    },
  };
  return api;
}
