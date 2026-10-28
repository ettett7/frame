// FRAME לטלפון: שכבת אפקטים "ויראלית" (סוכן 11). מתכננים מראש, מציירים מהר.
// נגזר מ־fx.py (אופי המעברים), מ־audio_fx.auto_events (הרווחים והתקרות לסאונד) ומ־genres.py (צפיפות לפי סוג תוכן) במק.
// ES module בלי תלויות. התכנון (planEffects) והמצלמה (effectsCamera, effectsAudio) טהורים ורצים גם ב־node וב־Worker; הציור (drawEffects) צריך canvas 2D.
// כל הזמנים בשניות בציר הפלט (זמן בקליפ הערוך). אובייקט ה־Effects הוא JSON טהור (בלי פונקציות ובלי typed arrays), אז אפשר לשמור אותו ב־IndexedDB
// בתוך clip.state ולהעביר ל־Worker ב־postMessage. מטמוני הריצה (אינדקסים, bitmap של אימוג'י) חיים בנפרד ב־WeakMap.
//
// ממשק (החתימות המלאות והתיעוד ליד כל פונקציה):
//   planEffects(words, moment, {genre, keywords, beats, density, cuts, transitions, plan, duration, loud, off, force}) -> Effects
//   effectsCamera(camera, effects) -> Camera          // עוטף את rectAt (ואת split.topAt / bottomAt): זום הדגשה, פולסים על הביט ורעידה, ברכות
//   drawEffects(ctx, tOut, effects, {brand, layers}) // פלאש, גשם אימוג'י, כוכבי POP ו־BOOM, לוגו ו־@כינוי
//   effectsAudio(effects) -> [{t, sfx, gain, kind, at, gainDb}]
//
// ממשק לאודיו (בלי לגעת ב־audio.js): effectsAudio מחזיר רשימה ממוינת של צלילים לערבוב.
//   t / at     שניות בציר הפלט שבהן צריך ליפול שיא הצליל (mixSfx מיישר את peakAt של הצליל אל at).
//   sfx / kind 'whoosh' | 'boom' | 'pop' (הקבצים assets/sfx/<kind>.wav, והם כבר ב־SFX_DB של audio.js).
//   gain       0..1 ליניארי, יחסית לעוצמה הרגילה של הצליל; gainDb = 20*log10(gain) (תמיד <= 0).
//   החיבור: buildTrack({..., sfx: effectsAudio(fx)}) עובד כמו שהוא, כי לכל פריט יש kind ו־at. עוצמה לכל אירוע (gainDb) עדיין לא נקראת ב־mixSfx
//   (שם רק gainDb לצליל שלם); כדי להפעיל אותה מספיק לכפול ב־lin(ev.gainDb ?? 0).
//   התקרה לדקה והרווח המינימלי בין צלילים כבר מחושבים בתכנון (לפי genre וצפיפות), ואין צורך לסנן שוב.

export const VERSION = 1;
export const MAX_ZOOM = 1.32;          // תקרה לסך הזום (זום + רעידה + פולס), כדי שהתמונה לא תתנפח מדי
export const MIN_ZOOM_GAP = 3;         // זום הדגשה: לא יותר מאחד לכל 3 שניות, בכל צפיפות
export const SFX_MIN_AT = 0.4;         // כמו audio_fx: לא מתחילים צלילים בשבריר הראשון
export const EFFECT_NAMES = ['zoom', 'shake', 'flash', 'emoji', 'stars', 'sfx'];

// ------------------------------------------------------------------ טבלאות: צפיפות וסוג תוכן

/** צפיפות: רווחים מינימליים (שניות) ותקרות לכל חלון של 60 שניות. */
export const DENSITY = {
  low: { zoomGap: 5.0, zoomPerMin: 6, shakeGap: 5.0, shakePerMin: 2, flashGap: 6.0, flashPerMin: 4, rainGap: 7.0, rainPerMin: [0, 1, 2], starGap: 6.0, starPerMin: 2, sfxPerMin: 5 },
  normal: { zoomGap: 3.6, zoomPerMin: 10, shakeGap: 3.5, shakePerMin: 4, flashGap: 3.5, flashPerMin: 8, rainGap: 5.0, rainPerMin: [0, 2, 3], starGap: 4.5, starPerMin: 3, sfxPerMin: 8 },
  high: { zoomGap: 3.0, zoomPerMin: 14, shakeGap: 2.5, shakePerMin: 6, flashGap: 2.2, flashPerMin: 12, rainGap: 4.0, rainPerMin: [0, 3, 5], starGap: 3.5, starPerMin: 5, sfxPerMin: 11 },
};

/**
 * פרופיל אפקטים לכל סוג תוכן, בהתאם ל־genres.py ול־audio_fx.SFX_GENRE:
 *  density  הצפיפות ברירת המחדל.   zoom 'dynamic' | 'subtle' (עוצמת הזום, כמו options.zoom).
 *  shake    0 בלי רעידה, 1 רק שיא וצעקות, 2 גם פאנץ'ים (אחרי צחוק).
 *  flash    0 רק במעברים מפורשים, 1 גם בחיתוכים (בדלילות), 2 חיתוכים בצפיפות מלאה (transition: flash / glitch).
 *  rain     0 בלי גשם אימוג'י, 1 דל, 2 מלא (emojiRain ב־genres.py: אוכל, מתיחות, קומדיה וספורט).
 *  stars    כוכבי POP ו־BOOM (מתיחות וקומדיה בלבד).
 *  sfx      המרווח המינימלי בין צלילים בשניות (SFX_GENRE), או null כשהסוג שקט (פודקאסט, מוטיבציה, טיפים וולוג: autoSfx כבוי).
 *  beats    פולס מצלמה קטן על הביט (extras.beats: כושר).
 */
export const GENRE_FX = {
  auto: { density: 'normal', zoom: 'dynamic', shake: 1, flash: 1, rain: 1, stars: false, sfx: 3.0, beats: false },
  podcast: { density: 'low', zoom: 'subtle', shake: 0, flash: 0, rain: 0, stars: false, sfx: null, beats: false },
  food: { density: 'normal', zoom: 'dynamic', shake: 1, flash: 1, rain: 2, stars: false, sfx: 2.4, beats: false },
  prank: { density: 'high', zoom: 'dynamic', shake: 2, flash: 2, rain: 2, stars: true, sfx: 2.2, beats: false },
  fitness: { density: 'high', zoom: 'dynamic', shake: 2, flash: 2, rain: 1, stars: false, sfx: 3.0, beats: true },
  tips: { density: 'normal', zoom: 'subtle', shake: 0, flash: 0, rain: 0, stars: false, sfx: null, beats: false },
  motivation: { density: 'low', zoom: 'subtle', shake: 0, flash: 0, rain: 0, stars: false, sfx: null, beats: false },
  comedy: { density: 'high', zoom: 'dynamic', shake: 2, flash: 1, rain: 2, stars: true, sfx: 2.4, beats: false },
  review: { density: 'normal', zoom: 'dynamic', shake: 1, flash: 1, rain: 1, stars: false, sfx: 3.0, beats: false },
  vlog: { density: 'normal', zoom: 'dynamic', shake: 0, flash: 1, rain: 1, stars: false, sfx: null, beats: false },
  sports: { density: 'high', zoom: 'dynamic', shake: 2, flash: 1, rain: 2, stars: false, sfx: 3.0, beats: false },
};

const ZOOM_SCALE = { dynamic: [1.1, 1.18], subtle: [1.05, 1.08] };   // שיא הזום לפי ציון המילה
const ZOOM_IN = 0.22, ZOOM_OUT = 0.4;                                 // רכות: כניסה ויציאה
const SHAKE_DUR = 0.5, SHAKE_AMP = 0.016;                             // רעידה: חלק מגודל המלבן
const FLASH_ATTACK = 0.05, FLASH_DECAY = 0.2;
const PULSE_DUR = 0.28, PULSE_SCALE = 1.035;
const SFX_BASE_GAIN = { boom: 1, pop: 0.8, whoosh: 0.85 };
const SFX_PRIORITY = { boom: 0, pop: 1, whoosh: 2 };                  // בדחיסות הצליל החשוב נשאר

// ------------------------------------------------------------------ כלים

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const round3 = (x) => Math.round(x * 1000) / 1000;
const fin = Number.isFinite;

/** פונקציות easing: כולן מקבלות u בטווח 0..1 ומחזירות 0..1 (outBack חורג קלות מעל 1 בכוונה). */
export const ease = {
  linear: (u) => clamp01(u),
  smooth: (u) => { u = clamp01(u); return u * u * (3 - 2 * u); },
  inCubic: (u) => { u = clamp01(u); return u * u * u; },
  outCubic: (u) => { u = clamp01(u); const v = 1 - u; return 1 - v * v * v; },
  inOutCubic: (u) => { u = clamp01(u); return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; },
  outBack: (u, s = 1.70158) => { u = clamp01(u); const v = u - 1; return 1 + (s + 1) * v * v * v + s * v * v; },
};

/** hash דטרמיניסטי: (seed, n) -> [0,1). משמש לחלקיקים, כדי שה־Effects יישאר JSON קטן בלי מערכי חלקיקים. */
export function rnd(seed, n) {
  let h = ((seed | 0) ^ Math.imul(n + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const seedOf = (t, salt = 0) => (Math.imul(Math.round(t * 1000) + 1, 2654435761) ^ Math.imul(salt + 7, 40503)) >>> 0;

/** נירמול מילה: אותיות קטנות, בלי ניקוד, גרשיים או פיסוק (נשארים אותיות, ספרות ומטבעות). */
export function normalize(text) {
  return String(text ?? '').toLowerCase().replace(/[֑-ׇ]/g, '').replace(/[׳״'"’`]/g, '').replace(/[^\p{L}\p{N}$₪€£]+/gu, '');
}

function nearest(sorted, t, tol) {
  if (!sorted.length) return null;
  let lo = 0, hi = sorted.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < t) lo = m + 1; else hi = m; }
  let best = null, bd = tol + 1e-9;
  for (const k of [lo - 1, lo]) if (k >= 0 && k < sorted.length && Math.abs(sorted[k] - t) < bd) { bd = Math.abs(sorted[k] - t); best = sorted[k]; }
  return best;
}

const sortedFinite = (arr) => (Array.isArray(arr) ? arr.map(Number).filter((x) => fin(x) && x >= 0).sort((a, b) => a - b) : []);

/** האם אפשר להוסיף t לרשימה ממוינת בלי שיהיו יותר מ־cap אירועים בחלון של window שניות? */
function fitsWindow(times, t, cap, window) {
  if (cap <= 0) return false;
  if (times.length < cap) return true;
  let pos = 0;
  while (pos < times.length && times[pos] < t) pos++;
  const s = times.slice();
  s.splice(pos, 0, t);
  for (let i = Math.max(0, pos - cap); i <= pos && i + cap < s.length; i++) if (s[i + cap] - s[i] < window - 1e-9) return false;
  return true;
}

/**
 * בוחר מתוך מועמדים [{t, prio?, score?}] את אלה שמרווחים לפחות gap זה מזה ושלא עוברים perMin בכל חלון של window שניות.
 * סדר העדיפות: prio עולה (0 החשוב ביותר), ציון יורד, זמן עולה. מחזיר את הנבחרים ממוינים לפי זמן.
 */
export function selectSpaced(cands, { gap = 0, perMin = Infinity, window = 60 } = {}) {
  const order = cands.slice().sort((a, b) => ((a.prio ?? 0) - (b.prio ?? 0)) || ((b.score ?? 0) - (a.score ?? 0)) || (a.t - b.t));
  const taken = [];
  const times = [];
  for (const c of order) {
    if (taken.some((x) => Math.abs(x.t - c.t) < gap - 1e-9)) continue;
    if (!fitsWindow(times, c.t, perMin, window)) continue;
    taken.push(c);
    let pos = times.length;
    while (pos > 0 && times[pos - 1] > c.t) pos--;
    times.splice(pos, 0, c.t);
  }
  return taken.sort((a, b) => a.t - b.t);
}

// ------------------------------------------------------------------ מילונים: אימוג'י, הדגשה, צעקות

const set = (text) => new Set(text.split(/\s+/).filter(Boolean));
const PREFIX = 'והבלמשכ';
const CATEGORIES = {
  money: { en: set('money cash dollar dollars bucks million millions billion billions rich wealthy millionaire salary profit profits'),
    he: set('כסף כספים שקל שקלים דולר דולרים מיליון מיליונים מיליארד מיליארדים עשיר עשירה עשירים משכורת רווח רווחים מזומן מזומנים'), emoji: ['💰', '💸'] },
  love: { en: set('love loved loves loving adore adored'), he: set('אוהב אוהבת אוהבים אוהבות אהבה אהבתי אהבנו אהבת אהוב אהובה אהובים'), emoji: ['❤️', '😍'] },
  fire: { en: set('fire fires flame flames lit insane crazy'), he: set('אש להבה להבות מטורף מטורפת מטורפים מטורפות שרוף'), emoji: ['🔥', '🔥'] },
  laugh: { emoji: ['😂', '🤣'] },
};
const CAT_ORDER = ['money', 'love', 'fire'];
const LAUGH_STRONG = /^(?:ha){2,}h?$|^(?:he){2,}h?$|^lol+$|^lmao+$|^rofl$|^ח{2,}\w*$|^ה{3,}$|^laugh(?:s|ter|ing|ed)?$|^giggl\w*$|^צוחק\w*$|^צחקנו$|^צחקתי$/;
const LAUGH_WEAK = /^funny$|^hilarious$|^צחוק$|^מצחיק\w*$|^הצחיק\w*$/;
const EMPHASIS = {
  en: set('never always secret secrets best worst biggest greatest insane crazy amazing incredible unbelievable huge free stop mistake mistakes truth lie wrong million billion love hate wow omg impossible ultimate perfect'),
  he: set('מעולם לעולם תמיד סוד סודות הכי טעות טעויות אמת שקר מטורף מטורפת מדהים מדהימה מדהימים מיליון מיליארד אהבה שונא וואו אסור חובה חינם מושלם מושלמת אש עצור'),
};
const ACRONYMS = set('USA UK CEO TV AI USB PDF FAQ DIY ASAP NBA NFL FBI CIA GPS HTML');

function stems(tok) {
  const out = [tok];
  if (tok.length > 2 && PREFIX.includes(tok[0]) && /^[א-ת]/.test(tok)) {
    out.push(tok.slice(1));
    if (tok.length > 4 && tok[0] === 'ו' && PREFIX.includes(tok[1])) out.push(tok.slice(2));
  }
  return out;
}

function inLexicon(lex, tok) {
  if (lex.en.has(tok)) return true;
  for (const s of stems(tok)) if (lex.he.has(s)) return true;
  return false;
}

/** קטגוריית אימוג'י של מילה: {cat, weight} או null. צחוק קודם לכול; כסף, אהבה ואש לפי מילון (עברית עם קידומת, ואנגלית). */
export function categoryOf(tok) {
  if (!tok) return null;
  if (LAUGH_STRONG.test(tok)) return { cat: 'laugh', weight: 3 };
  if (LAUGH_WEAK.test(tok)) return { cat: 'laugh', weight: 2 };
  if (/[$₪€£]/.test(tok)) return { cat: 'money', weight: 3 };
  for (const cat of CAT_ORDER) if (inLexicon(CATEGORIES[cat], tok)) return { cat, weight: cat === 'money' ? 3 : 2 };
  return null;
}

function emphasisBonus(w) {
  let b = 0;
  if (EMPHASIS.en.has(w.tok) || stems(w.tok).some((s) => EMPHASIS.he.has(s))) b += 0.8;
  if (/\d/.test(w.tok)) b += 0.5;
  if (/[!！]/.test(w.text)) b += 0.6;
  if (/(.)\1{2,}/u.test(w.tok) && w.tok.length >= 4) b += 0.3;
  return b + Math.min(0.4, Math.max(0, (w.tok.length - 3) * 0.05));
}

/** אינדקסי מילות הדגשה לפי מילון, כשלא הגיעו מילות מפתח מבחוץ (pickKeywords של הכתוביות). */
export function emphasisIndices(words) {
  const ws = cleanWords(words);
  const out = [];
  ws.forEach((w, i) => { if (w && w.tok.length >= 3 && emphasisBonus(w) >= 0.8) out.push(i); });
  return out;
}

function cleanWords(words) {
  const out = [];
  (Array.isArray(words) ? words : []).forEach((w, i) => {
    const start = Number(w?.start), end = Number(w?.end);
    const text = String(w?.text ?? '');
    if (!w || typeof w !== 'object' || !fin(start) || start < 0 || !text.trim()) { out.push(null); return; }
    out.push({ i, text, tok: normalize(text), start, end: fin(end) && end >= start ? end : start + 0.25 });
  });
  return out;
}

/** מילים שנאמרו בצעקה: סימן קריאה, אותיות רישיות באנגלית (3+), או הארכה ("nooooo", "וואווווו"). */
function shoutScore(w) {
  if (!w.tok || LAUGH_STRONG.test(w.tok)) return 0;
  let s = 0;
  if (/[!！]/.test(w.text)) s += 1;
  if (/^[A-Z]{3,}[!?.,]*$/.test(w.text.trim()) && !ACRONYMS.has(w.text.trim().replace(/[!?.,]+$/, ''))) s += 1.2;
  if (w.tok.length >= 4 && /(.)\1{2,}/u.test(w.tok)) s += 1;
  return s;
}

// ------------------------------------------------------------------ מיפוי זמני שיא

function sourceToOut(plan, t) {
  if (!plan?.segments?.length || !fin(t)) return null;
  let acc = 0;
  for (const [a, z] of plan.segments) {
    if (t >= a - 1e-9 && t <= z + 1e-9) return acc + (Math.min(t, z) - a);
    acc += z - a;
  }
  return null;
}

/**
 * זמני שיא בציר הפלט. moment.peak הוא בזמן מקור (כמו כל ה־Moment): ממפים אותו דרך opts.plan; בלי plan, שיא שנופל בתוך [moment.start, moment.end]
 * נחשב כקליפ בלי חיתוכים (peak - start); ושיא מחוץ לטווח נחשב כבר בזמן פלט. opts.peakOut מכריע (זמן פלט מפורש).
 */
function peaksOut(moment, o, D) {
  const out = [];
  const add = (t, source) => { if (fin(t) && t >= 0.2 && t <= D - 0.25) out.push({ t: round3(t), source }); };
  if (fin(Number(o.peakOut))) add(Number(o.peakOut), 'peakOut');
  const raw = moment?.peak;
  for (const p of Array.isArray(raw) ? raw : raw == null ? [] : [raw]) {
    const pn = Number(p && typeof p === 'object' ? p.t : p);
    if (!fin(pn)) continue;
    let t = null;
    if (o.plan?.segments?.length) t = sourceToOut(o.plan, pn);
    else if (fin(moment?.start) && pn >= moment.start - 1e-6 && pn <= (fin(moment?.end) ? moment.end : Infinity) + 1e-6) t = pn - moment.start;
    else if (pn >= 0 && pn <= D) t = pn;
    add(t, 'moment');
  }
  return out;
}

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
}

// ------------------------------------------------------------------ תקציב צפיפות

export const CLUSTER_WINDOW = 1.0;     // שניות: אפקטים שהתחילו קרוב זה לזה נחשבים אשכול אחד
export const CLUSTER_FAMILIES = 2;     // מקסימום סוגי אפקט שונים באשכול (זום, רעידה, כוכבים, אימוג'י, פלאש)

/**
 * מסנן את המערכים במקום. הנבחרים הם החשובים ביותר, ובכל חלון נע של CLUSTER_WINDOW שניות יש לכל היותר CLUSTER_FAMILIES סוגי אפקט שונים.
 * השיא (BOOM ורעידת שיא) נבחר ראשון, ושני הסוגים שלו ממלאים את התקציב: סביב השיא אין עוד זום, אימוג'י או פלאש.
 */
function resolveClusters(lists) {
  const items = [];
  const add = (fam, list, imp, at) => (list || []).forEach((ev) => items.push({ fam, ev, imp: imp(ev), t: at(ev) }));
  add('zoom', lists.zooms, () => 2, (z) => z.t + z.in * 0.5);
  add('shake', lists.shakes, (e) => (e.kind === 'peak' ? 9 : e.kind === 'punch' ? 4 : 3.3), (e) => e.t);
  add('stars', lists.stars, (e) => (e.kind === 'boom' ? 9 : 3.2), (e) => e.t);
  add('emoji', lists.emojis, (e) => (e.cat === 'laugh' || e.cat === 'money' ? 4.5 : 3.5), (e) => e.t + 0.1);
  add('flash', lists.flashes, (e) => (e.kind === 'transition' ? 6 : 1), (e) => e.t + e.attack);
  items.sort((a, b) => (b.imp - a.imp) || (a.t - b.t));
  const kept = [];
  for (const it of items) {
    const near = kept.filter((k) => Math.abs(k.t - it.t) < CLUSTER_WINDOW);
    // כל חלון [s, s + W) שמכיל את it: מתחיל באחד האירועים הקרובים שלפניו (או בו עצמו)
    let ok = true;
    for (const s of [it, ...near.filter((k) => k.t <= it.t)]) {
      const fams = new Set([it.fam]);
      for (const k of near) if (k.t >= s.t && k.t < s.t + CLUSTER_WINDOW) fams.add(k.fam);
      if (fams.size > CLUSTER_FAMILIES) { ok = false; break; }
    }
    if (ok) kept.push(it);
  }
  const keep = new Set(kept.map((k) => k.ev));
  for (const list of Object.values(lists)) for (let i = list.length - 1; i >= 0; i--) if (!keep.has(list[i])) list.splice(i, 1);
}

// ------------------------------------------------------------------ התכנון

/**
 * מתכנן את כל האפקטים של קליפ אחד.
 *  words    מילים בזמני פלט: [{text, start, end}] (כמו CaptionSpec.words). כל אינדקס ב־keywords מתייחס למערך הזה.
 *  moment   ה־Moment (זמני מקור). משתמשים רק ב־moment.peak (מספר או מערך) וב־start/end למיפוי.
 *  opts:
 *    genre      סוג התוכן ('auto' כברירת מחדל): קובע צפיפות, מה פעיל ובאיזו עוצמה (GENRE_FX).
 *    density    'low' | 'normal' | 'high': גובר על הצפיפות של ה־genre.
 *    keywords   אינדקסי מילות מפתח (pickKeywords). חסר או ריק: מילון הדגשה מובנה. false: בלי זום הדגשה.
 *    beats      זמני ביט בציר הפלט: זום ופלאש מתיישרים לביט (עד 0.12 שנ'), ובסוגים עם beats (כושר) יש פולס קטן על כל ביט רביעי.
 *    cuts       חיתוכים קשים בציר הפלט (camera.cuts): פלאש בחיתוך, וזום שמתיישר לחיתוך. אפשר גם opts.camera.
 *    transitions מעברים מפורשים (למשל מההוק לגוף הקליפ): פלאש תמיד, גם בסוגים שבלי פלאש בחיתוכים.
 *    plan, duration  ה־Plan (למיפוי moment.peak ולאורך הקליפ) או אורך בשניות. בלעדיהם האורך נגזר מהמילים.
 *    peakOut    זמן שיא בציר הפלט (מכריע על moment.peak).
 *    punches    זמני פאנץ' בציר הפלט (בנוסף לאלה שמזוהים לפי צחוק בתמלול).
 *    loud       קטעי קול חזקים בציר הפלט [{start, end, db}] (כמו AudioInfo.loud): קטע חריג מהחציון הוא צעקה, והחריג ביותר הוא שיא כשאין moment.peak.
 *    off        שמות אפקטים לכבות: 'zoom' | 'shake' | 'flash' | 'emoji' | 'stars' | 'sfx'.   force: אפקטים להפעיל גם אם ה־genre לא כולל אותם.
 * מחזיר Effects (JSON טהור): zooms, pulses, shakes, flashes, emojis, stars, sfx, peaks, stats.
 */
export function planEffects(words, moment, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const genre = GENRE_FX[o.genre] ? o.genre : 'auto';
  const prof = GENRE_FX[genre];
  const density = DENSITY[o.density] ? o.density : prof.density;
  const dn = DENSITY[density];
  const off = new Set(Array.isArray(o.off) ? o.off : []);
  const force = new Set(Array.isArray(o.force) ? o.force : []);
  const enabled = (name, base) => !off.has(name) && (!!base || force.has(name));

  const ws = cleanWords(words);
  const valid = ws.filter(Boolean);
  const lastEnd = valid.reduce((m, w) => Math.max(m, w.end), 0);
  const span = fin(moment?.start) && fin(moment?.end) && moment.end > moment.start ? moment.end - moment.start : 0;
  const D = fin(Number(o.duration)) && Number(o.duration) > 0 ? Number(o.duration)
    : o.plan?.duration > 0 ? o.plan.duration
      : Math.max(lastEnd + 0.5, o.plan ? 0 : span);

  const cuts = sortedFinite(o.cuts ?? o.camera?.cuts).filter((t) => t > 0.05 && t < D - 0.05);
  const transitions = sortedFinite(o.transitions).filter((t) => t > 0.05 && t < D - 0.05);
  const beats = sortedFinite(o.beats).filter((t) => t < D);

  // ----- שיאים, פאנץ'ים וצעקות
  const peaks = peaksOut(moment, o, D);
  const loud = (Array.isArray(o.loud) ? o.loud : []).filter((s) => fin(Number(s?.start)) && fin(Number(s?.end)) && fin(Number(s?.db)));
  const med = median(loud.map((s) => Number(s.db)));
  const loudShouts = loud.filter((s) => Number(s.db) >= med + 5 && s.end - s.start >= 0.15 && loud.length >= 3).map((s) => ({ t: Number(s.start), score: (Number(s.db) - med) / 6, why: 'loud' }));
  const shouts = [];
  for (const w of valid) { const sc = shoutScore(w); if (sc > 0) shouts.push({ t: w.start, score: sc, why: 'shout' }); }
  shouts.push(...loudShouts);
  const punches = sortedFinite(o.punches).map((t) => ({ t, score: 1.5, why: 'punch' }));
  let lastLaugh = -9;
  valid.forEach((w, k) => {
    if (!LAUGH_STRONG.test(w.tok) || w.start - lastLaugh < 1.5) return;
    lastLaugh = w.start;
    const prev = valid.slice(0, k).reverse().find((p) => !LAUGH_STRONG.test(p.tok));
    punches.push({ t: prev && w.start - prev.end <= 1.2 ? prev.end : w.start, score: 1.5, why: 'laugh' });
  });
  if (!peaks.length && loudShouts.length) {
    // אין שיא מפורש: רק קטע קול חריג מאוד (7dB ומעלה מעל החציון) נחשב לשיא; טקסט בלבד (צחוק, סימן קריאה) אינו מספיק
    const strongest = loudShouts.slice().sort((a, b) => b.score - a.score)[0];
    if (strongest.score >= 1.2 && strongest.t >= 0.2 && strongest.t <= D - 0.25 && strongest.t >= 0.15 * D) peaks.push({ t: round3(strongest.t), source: 'loud' });
  }

  // ----- זום הדגשה
  const zooms = [];
  if (enabled('zoom', true)) {
    let idx = [];
    if (o.keywords !== false) {
      const given = new Set();
      for (const k of Array.isArray(o.keywords) ? o.keywords : []) {
        if (Number.isInteger(k) && ws[k]) given.add(k);
        else if (typeof k === 'string') { const n = normalize(k); ws.forEach((w, i) => { if (w && w.tok === n) given.add(i); }); }
      }
      idx = given.size ? [...given] : emphasisIndices(words);
    }
    const [zLo, zHi] = ZOOM_SCALE[prof.zoom] || ZOOM_SCALE.dynamic;
    const cands = [];
    for (const k of idx) {
      const w = ws[k];
      let t = Math.max(0, w.start - 0.08);
      const nc = nearest(cuts, t, 0.12);
      if (nc !== null) t = nc;
      else { const nb = nearest(beats, t + ZOOM_IN, 0.12); if (nb !== null) t = Math.max(0, nb - ZOOM_IN); }
      if (t < 0.3 || D - t < 0.9) continue;
      cands.push({ t, score: 1 + emphasisBonus(w), w });
    }
    for (const c of selectSpaced(cands, { gap: Math.max(MIN_ZOOM_GAP, dn.zoomGap), perMin: dn.zoomPerMin })) {
      const w = c.w;
      let hold = clamp(w.end - w.start - 0.05, 0.3, 1.0);
      let out = ZOOM_OUT;
      const room = D - c.t - 0.05 - ZOOM_IN;
      if (hold + out > room) { const f = Math.max(0.2, room) / (hold + out); hold *= f; out *= f; }
      zooms.push({ t: round3(c.t), in: ZOOM_IN, hold: round3(hold), out: round3(out), scale: round3(zLo + (zHi - zLo) * clamp01((c.score - 1) / 1.4)), w: w.i });
    }
  }

  // ----- פולסים על הביט (כושר): כל ביט רביעי, בלי להתנגש בזום
  const pulses = [];
  if (prof.beats && !off.has('zoom') && beats.length) {
    const bars = beats.filter((b, i) => i % 4 === 0 && b >= 0.5 && b <= D - 0.4);
    const free = bars.filter((b) => !zooms.some((z) => b > z.t - 0.35 && b < z.t + z.in + z.hold + z.out + 0.15));
    for (const c of selectSpaced(free.map((t) => ({ t })), { gap: 1.6, perMin: 18 })) pulses.push({ t: round3(c.t), dur: PULSE_DUR, scale: PULSE_SCALE });
  }

  // ----- רעידה: שיא, פאנץ' וצעקה
  const shakes = [];
  const shakeLevel = enabled('shake', prof.shake) ? Math.max(prof.shake, force.has('shake') ? 2 : 0) : 0;
  if (shakeLevel > 0) {
    const cands = peaks.map((p) => ({ t: p.t, prio: 0, score: 3, kind: 'peak', k: 1 }));
    for (const s of shouts) if (s.t >= 0.3 && s.t <= D - 0.4) cands.push({ t: s.t, prio: 2, score: s.score, kind: 'shout', k: 0.6 });
    if (shakeLevel >= 2) for (const p of punches) if (p.t >= 0.3 && p.t <= D - 0.4) cands.push({ t: p.t, prio: 1, score: p.score, kind: 'punch', k: 0.85 });
    for (const c of selectSpaced(cands, { gap: dn.shakeGap, perMin: dn.shakePerMin })) {
      shakes.push({ t: round3(c.t), dur: SHAKE_DUR, amp: round3(SHAKE_AMP * c.k), kind: c.kind, seed: seedOf(c.t, 1) });
    }
  }

  // ----- פלאש לבן: חיתוכים ומעברים. לעולם לא יותר מפעם בשנייה (רגישות לאור מהבהב)
  const flashes = [];
  if (enabled('flash', true)) {
    const level = prof.flash;
    const nearPeak = (t) => peaks.some((p) => Math.abs(p.t - t) < 0.45);
    const cands = transitions.map((t) => ({ t, prio: 0, score: 1, kind: 'transition', alpha: 0.65 }));
    if (level >= 1 || force.has('flash')) {
      const alpha = level >= 2 ? 0.5 : 0.38;
      for (const t of cuts) if (!nearPeak(t)) cands.push({ t, prio: 1, score: 1, kind: 'cut', alpha });
    }
    const gap = Math.max(1.2, level >= 2 ? dn.flashGap : dn.flashGap * 1.8);
    for (const c of selectSpaced(cands.filter((c) => c.t > 0.1 && c.t < D - 0.15), { gap, perMin: dn.flashPerMin })) {
      flashes.push({ t: round3(Math.max(0, c.t - FLASH_ATTACK)), attack: FLASH_ATTACK, decay: FLASH_DECAY, alpha: c.alpha, kind: c.kind });
    }
  }

  // ----- גשם אימוג'י: צחוק, כסף, אהבה, אש
  const emojis = [];
  if (enabled('emoji', prof.rain > 0)) {
    const level = Math.max(1, prof.rain);
    const cands = [];
    for (const w of valid) {
      const c = categoryOf(w.tok);
      if (c && w.start >= 0.3 && w.start <= D - 1.0) cands.push({ t: w.start, prio: 3 - c.weight, score: 1, cat: c.cat, w });
    }
    for (const c of selectSpaced(cands, { gap: dn.rainGap, perMin: dn.rainPerMin[level] })) {
      const rain = c.cat === 'laugh' || c.cat === 'money';
      const em = CATEGORIES[c.cat].emoji;
      const seed = seedOf(c.t, 2);
      emojis.push({
        t: round3(Math.max(0, c.t - 0.04)), dur: rain ? 1.9 : 1.5, kind: rain ? 'rain' : 'burst', cat: c.cat, emoji: em[0], alt: em[1], count: rain ? 18 : 12,
        size: rain ? 0.095 : 0.11, x: rain ? 0.5 : round3(0.5 + (rnd(seed, 1) - 0.5) * 0.3), y: rain ? 0 : 0.68, g: c.cat === 'love' ? 0.35 : 1.5, seed, w: c.w.i,
      });
    }
  }

  // ----- תקציב צפיפות: בכל חלון נע של שנייה לא יותר משני סוגי אפקט חזותיים, כדי שמילה אחת לא תקבל הכול בבת אחת.
  // סבב ראשון בלי הכוכבים; אחר כך ה־POP נבחר רק איפה שנשאר מקום (סוג אחד לכל היותר סביבו), ואז סבב סופי שמבטיח את השיא.
  resolveClusters({ zooms, shakes, emojis, flashes });

  // ----- כוכבי POP ו־BOOM (מתיחות וקומדיה)
  const stars = [];
  if (enabled('stars', prof.stars)) {
    const cands = peaks.map((p) => ({ t: p.t, prio: 0, score: 3, kind: 'boom' }));
    // מי חשוב מה־POP ולכן לא יפנה לו מקום: רעידה, אימוג'י ומעבר מפורש. זום וחיתוך רגיל חשובים פחות, והסבב הסופי יוותר עליהם
    const busy = [...emojis.map((e) => ({ t: e.t + 0.1, f: 'emoji' })), ...flashes.filter((f) => f.kind === 'transition').map((f) => ({ t: f.t + f.attack, f: 'flash' })), ...shakes.map((e) => ({ t: e.t, f: 'shake' }))];
    const roomFor = (t) => { const fams = new Set(); for (const e of busy) if (Math.abs(e.t - t) < CLUSTER_WINDOW) fams.add(e.f); return fams.size <= 1; };
    for (const s of [...punches, ...shouts]) if (s.t >= 0.3 && s.t <= D - 0.6 && !peaks.some((p) => Math.abs(p.t - s.t) < 1.2) && roomFor(s.t)) cands.push({ t: s.t, prio: 1, score: s.score, kind: 'pop' });
    for (const c of selectSpaced(cands, { gap: dn.starGap, perMin: dn.starPerMin })) {
      const seed = seedOf(c.t, 3);
      const boom = c.kind === 'boom';
      const side = rnd(seed, 0) < 0.5 ? -1 : 1;
      stars.push({
        t: round3(c.t), dur: boom ? 1.0 : 0.75, kind: c.kind, text: boom ? 'BOOM!' : 'POP!', x: round3(boom ? 0.5 + side * 0.06 : 0.5 + side * (0.2 + 0.08 * rnd(seed, 1))),
        y: round3(boom ? 0.3 : 0.34 + 0.05 * rnd(seed, 2)), rot: round3(side * -(0.1 + 0.07 * rnd(seed, 3))), scale: boom ? 1 : 0.62, sparks: boom ? 9 : 6, seed,
      });
    }
  }

  resolveClusters({ zooms, shakes, stars, emojis, flashes });

  // ----- סאונד: whoosh בזום, boom בשיא, pop באימוג'י. רווח לפי סוג התוכן ותקרה לדקה
  const sfx = [];
  if (enabled('sfx', prof.sfx !== null)) {
    const gap = prof.sfx ?? 3.0;
    const cands = [];
    const mk = (t, kind, src, ref, g) => { if (t >= SFX_MIN_AT && t <= D - 0.25) cands.push({ t, prio: SFX_PRIORITY[kind], score: 1, sfx: kind, src, ref, gain: g }); };
    peaks.forEach((p, i) => mk(p.t, 'boom', 'peak', i, SFX_BASE_GAIN.boom));
    emojis.forEach((e, i) => mk(e.t + 0.05, 'pop', 'emoji', i, SFX_BASE_GAIN.pop));
    zooms.forEach((z, i) => mk(z.t + z.in * 0.5, 'whoosh', 'zoom', i, SFX_BASE_GAIN.whoosh * (0.8 + 0.2 * clamp01((z.scale - 1.04) / 0.14))));
    for (const c of selectSpaced(cands, { gap: Math.max(gap, 0.5), perMin: dn.sfxPerMin })) {
      sfx.push({ t: round3(c.t), sfx: c.sfx, gain: round3(c.gain), src: c.src, ref: c.ref });
    }
  }

  return {
    version: VERSION, genre, density, duration: round3(D),
    zooms, pulses, shakes, flashes, emojis, stars, sfx,
    peaks,
    stats: { zooms: zooms.length, pulses: pulses.length, shakes: shakes.length, flashes: flashes.length, emojis: emojis.length, stars: stars.length, sfx: sfx.length },
  };
}

// ------------------------------------------------------------------ אודיו

/**
 * הצלילים של האפקטים לערבוב: [{t, sfx, gain, kind, at, gainDb}] ממוין לפי זמן (ראו התיעוד בראש הקובץ).
 * מחזיר עותקים חדשים בכל קריאה (אפשר לשנות אותם בלי לפגוע ב־Effects).
 */
export function effectsAudio(effects) {
  const list = Array.isArray(effects?.sfx) ? effects.sfx : [];
  return list
    .filter((e) => e && fin(e.t) && SFX_PRIORITY[e.sfx] !== undefined)
    .map((e) => { const gain = clamp(Number(e.gain) || 0, 0, 1); return { t: e.t, sfx: e.sfx, gain, kind: e.sfx, at: e.t, gainDb: gain > 0 ? round3(20 * Math.log10(gain)) : -120 }; })
    .sort((a, b) => a.t - b.t);
}

// ------------------------------------------------------------------ אינדקס ריצה (מטמון נפרד מה־JSON)

const RT = new WeakMap();

function indexOf(list, durOf) {
  const n = list.length;
  const starts = new Float64Array(n), ends = new Float64Array(n);
  let maxDur = 0;
  for (let i = 0; i < n; i++) { const d = durOf(list[i]); starts[i] = list[i].t; ends[i] = list[i].t + d; if (d > maxDur) maxDur = d; }
  return { starts, ends, maxDur, list, n };
}

const zoomDur = (z) => z.in + z.hold + z.out;
const flashDur = (f) => f.attack + f.decay;
const durOf = (e) => e.dur;

function runtime(fx) {
  let r = RT.get(fx);
  const sizes = fx.zooms.length + fx.pulses.length * 7 + fx.shakes.length * 13 + fx.flashes.length * 31 + fx.emojis.length * 61 + fx.stars.length * 127;
  if (!r || r.sizes !== sizes) {
    r = {
      sizes,
      zoom: indexOf(fx.zooms, zoomDur), pulse: indexOf(fx.pulses, durOf), shake: indexOf(fx.shakes, durOf),
      flash: indexOf(fx.flashes, flashDur), emoji: indexOf(fx.emojis, durOf), star: indexOf(fx.stars, durOf),
    };
    RT.set(fx, r);
  }
  return r;
}

/** מנקה את מטמון הריצה של Effects. קוראים לזה אחרי שמשנים ידנית אירוע קיים (הוספה והסרה מזוהות לבד). */
export function invalidateEffects(effects) { if (effects && typeof effects === 'object') RT.delete(effects); }

/** האינדקס האחרון ש־starts[k] <= t, או -1. */
function lastAtOrBefore(starts, n, t) {
  let lo = 0, hi = n - 1, at = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (starts[m] <= t) { at = m; lo = m + 1; } else hi = m - 1; }
  return at;
}

function validEffects(fx) {
  return !!fx && typeof fx === 'object' && Array.isArray(fx.zooms) && Array.isArray(fx.pulses) && Array.isArray(fx.shakes) && Array.isArray(fx.flashes)
    && Array.isArray(fx.emojis) && Array.isArray(fx.stars);
}

// ------------------------------------------------------------------ תנועה: זום ורעידה

/** מעטפת הזום (0..1): כניסה רכה, החזקה, יציאה רכה. */
export function zoomEnvelope(z, t) {
  const u = t - z.t;
  if (u <= 0) return 0;
  if (u < z.in) return ease.inOutCubic(u / z.in);
  if (u < z.in + z.hold) return 1;
  const v = (u - z.in - z.hold) / z.out;
  return v >= 1 ? 0 : 1 - ease.inOutCubic(v);
}

/** מעטפת הרעידה (0..1): עלייה מהירה וחלקה, ודעיכה ריבועית. */
export function shakeEnvelope(s, t) {
  const u = t - s.t;
  if (u <= 0 || u >= s.dur) return 0;
  const k = 1 - u / s.dur;
  return ease.smooth(u / 0.04) * k * k;
}

const motion = { scale: 1, dx: 0, dy: 0 };

/** ממלא את motion במצב התנועה ב־t: scale (>= 1), dx ו־dy כחלק מגודל המלבן. בלי הקצאות. */
function motionInto(rt, t) {
  let add = 0, sh = 0, dx = 0, dy = 0;
  const z = rt.zoom;
  for (let k = lastAtOrBefore(z.starts, z.n, t); k >= 0 && z.starts[k] > t - z.maxDur; k--) {
    if (t < z.ends[k]) add += (z.list[k].scale - 1) * zoomEnvelope(z.list[k], t);
  }
  const p = rt.pulse;
  for (let k = lastAtOrBefore(p.starts, p.n, t); k >= 0 && p.starts[k] > t - p.maxDur; k--) {
    if (t < p.ends[k]) { const e = p.list[k]; add += (e.scale - 1) * Math.sin(Math.PI * (t - e.t) / e.dur); }
  }
  const s = rt.shake;
  for (let k = lastAtOrBefore(s.starts, s.n, t); k >= 0 && s.starts[k] > t - s.maxDur; k--) {
    if (t >= s.ends[k]) continue;
    const e = s.list[k];
    const env = shakeEnvelope(e, t);
    const u = t - e.t;
    const ph = e.seed;
    dx += e.amp * env * (0.65 * Math.sin(6.2832 * 11 * u + 6.2832 * rnd(ph, 0)) + 0.35 * Math.sin(6.2832 * 17 * u + 6.2832 * rnd(ph, 1)));
    dy += e.amp * env * (0.65 * Math.sin(6.2832 * 13 * u + 6.2832 * rnd(ph, 2)) + 0.35 * Math.sin(6.2832 * 19 * u + 6.2832 * rnd(ph, 3)));
    sh += 2.2 * e.amp * ease.smooth(Math.min(1, u / 0.06)) * (1 - ease.smooth(clamp01((u - 0.3) / (e.dur - 0.3))));
  }
  motion.scale = Math.min(MAX_ZOOM, 1 + add + sh);
  motion.dx = dx;
  motion.dy = dy;
  return motion;
}

/** מצב התנועה של האפקטים ב־tOut: {scale, dx, dy}. שימושי לבדיקות ולשכבות שרוצות לזוז עם המצלמה. */
export function motionAt(effects, tOut) {
  if (!validEffects(effects) || !fin(tOut)) return { scale: 1, dx: 0, dy: 0 };
  const m = motionInto(runtime(effects), tOut);
  return { scale: m.scale, dx: m.dx, dy: m.dy };
}

function applyMotion(rect, m) {
  if (!rect || !fin(rect.w) || !fin(rect.h) || rect.w <= 0 || rect.h <= 0) return rect;
  if (m.scale <= 1.000001 && m.dx === 0 && m.dy === 0) return rect;
  const w = rect.w / m.scale, h = rect.h / m.scale;
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  return {
    x: clamp(cx - w / 2 + m.dx * w, 0, Math.max(0, 1 - w)),
    y: clamp(cy - h / 2 + m.dy * h, 0, Math.max(0, 1 - h)),
    w, h,
  };
}

/**
 * עוטף מצלמה: rectAt (ואם יש, גם split.topAt ו־split.bottomAt) מחזירים מלבן מוקטן סביב המרכז לזום ההדגשה, לפולס ולרעידה, עם easing.
 * המלבן נשאר באותו יחס גובה־רוחב ובתוך [0,1]. לא משנה את המצלמה המקורית; שאר השדות (layout, cuts, info, split.active...) נשמרים.
 * עטיפה חוזרת לא מכפילה את הזום: תמיד עוטפים את המצלמה המקורית.
 */
export function effectsCamera(camera, effects) {
  if (!camera || typeof camera.rectAt !== 'function') throw new Error('חסרה מצלמה (rectAt) לעטיפת האפקטים');
  const base = camera._fxBase || camera;
  if (!validEffects(effects)) return base;
  const wrap = (fn) => (t) => {
    const r = fn(t);
    const tt = Number(t);
    return fin(tt) ? applyMotion(r, motionInto(runtime(effects), tt)) : r;
  };
  const out = { ...base, rectAt: wrap(base.rectAt) };
  if (base.split && typeof base.split.topAt === 'function' && typeof base.split.bottomAt === 'function') {
    out.split = { ...base.split, topAt: wrap(base.split.topAt), bottomAt: wrap(base.split.bottomAt) };
  }
  Object.defineProperty(out, '_fxBase', { value: base, enumerable: false });
  out.effects = effects;
  return out;
}

// ------------------------------------------------------------------ ציור: sprites ומטמון

const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji","Twemoji Mozilla",sans-serif';
const COMIC_FONT = '900 {px}px Impact,"Arial Black","Heebo","Rubik",system-ui,sans-serif';
const BRAND_FONT = '700 {px}px "Heebo","Rubik",system-ui,-apple-system,"Segoe UI",sans-serif';

let canvasFactory = (w, h) => {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined' && document.createElement) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  return null;
};
let spriteCreations = 0;

/** מחליף את יצרן ה־canvas (בדיקות ב־node, או סביבה בלי OffscreenCanvas). הפונקציה מקבלת (w, h) ומחזירה canvas או null. */
export function setCanvasFactory(fn) { canvasFactory = fn; clearSpriteCache(); }

const sprites = new Map();
let brandSprite = null;

export function clearSpriteCache() { sprites.clear(); brandSprite = null; }
/** כמה sprites נוצרו עד עכשיו (לבדיקת המטמון). */
export function spriteStats() { return { created: spriteCreations, cached: sprites.size + (brandSprite ? 1 : 0) }; }

function spriteFor(key, w, h, paint) {
  let s = sprites.get(key);
  if (s !== undefined) return s;
  const c = canvasFactory(w, h);
  const g = c && c.getContext && c.getContext('2d');
  if (!g) { sprites.set(key, null); return null; }
  paint(g, w, h);
  spriteCreations++;
  if (sprites.size > 80) sprites.delete(sprites.keys().next().value);
  s = { canvas: c, w, h };
  sprites.set(key, s);
  return s;
}

const emojiPx = (W) => clamp(Math.round(W * 0.125 / 16) * 16, 48, 192);
const comicPx = (W) => clamp(Math.round(W * 0.5 / 32) * 32, 192, 640);

function emojiSprite(emoji, px) {
  return spriteFor(`e|${emoji}|${px}`, px, px, (g) => {
    g.direction = 'ltr';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `${Math.round(px * 0.78)}px ${EMOJI_FONT}`;
    g.fillText(emoji, px / 2, px / 2 + px * 0.04);
  });
}

function burstPath(g, cx, cy, R, spikes, seed, inner = 0.64) {
  g.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const a = (Math.PI * i) / spikes - Math.PI / 2;
    const r = i % 2 === 0 ? R * (0.9 + 0.1 * rnd(seed, i)) : R * inner * (0.94 + 0.06 * rnd(seed, i + 40));
    if (i === 0) g.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); else g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  g.closePath();
}

const COMIC = {
  boom: { spikes: 15, inner: 0.62, fill: ['#fff4a8', '#ffcc00'], rim: '#ff7a00', text: '#e8102e', textStroke: '#ffffff' },
  pop: { spikes: 11, inner: 0.7, fill: ['#d9f8ff', '#34c8ff'], rim: '#0a7fb8', text: '#ff2d7a', textStroke: '#ffffff' },
};

/** בועת קומיקס עם טקסט (BOOM! / POP!): ציור אחד למטמון, אחר כך רק drawImage. */
function comicSprite(kind, text, px) {
  const sp = COMIC[kind] || COMIC.boom;
  return spriteFor(`c|${kind}|${text}|${px}`, px, px, (g, S) => {
    const cx = S / 2, cy = S / 2, R = S * 0.46, seed = kind === 'boom' ? 11 : 23;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.direction = 'ltr';   // הדף בעברית (rtl), והטקסט כאן באנגלית: בלי זה "BOOM!" יוצא "!BOOM"
    // צל קשיח מוסט, כמו בדפוס קומיקס
    g.fillStyle = 'rgba(0,0,0,0.38)';
    burstPath(g, cx + S * 0.018, cy + S * 0.026, R, sp.spikes, seed, sp.inner);
    g.fill();
    // גוף: מילוי רדיאלי, קו מתאר עבה כהה וקו פנימי בצבע
    const grad = g.createRadialGradient(cx, cy, S * 0.04, cx, cy, R);
    grad.addColorStop(0, sp.fill[0]);
    grad.addColorStop(1, sp.fill[1]);
    burstPath(g, cx, cy, R, sp.spikes, seed, sp.inner);
    g.fillStyle = grad;
    g.fill();
    g.lineWidth = S * 0.034;
    g.strokeStyle = '#17120c';
    g.stroke();
    burstPath(g, cx, cy, R * 0.86, sp.spikes, seed, sp.inner);
    g.lineWidth = S * 0.012;
    g.strokeStyle = sp.rim;
    g.stroke();
    // טקסט: התאמה לרוחב, קו מתאר לבן ואז שחור
    let fs = S * 0.3;
    g.font = COMIC_FONT.replace('{px}', String(Math.round(fs)));
    const tw = g.measureText(text).width;
    const maxW = S * 0.66;
    if (tw > maxW) { fs *= maxW / tw; g.font = COMIC_FONT.replace('{px}', String(Math.round(fs))); }
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.save();
    g.translate(cx, cy + S * 0.012);
    g.rotate(-0.06);
    g.lineWidth = fs * 0.2;
    g.strokeStyle = '#17120c';
    g.strokeText(text, 0, 0);
    g.lineWidth = fs * 0.1;
    g.strokeStyle = sp.textStroke;
    g.strokeText(text, 0, 0);
    g.fillStyle = sp.text;
    g.fillText(text, 0, 0);
    g.restore();
  });
}

const SPARK_COLORS = ['#ffd21f', '#ff4d8d', '#35d0ff', '#ffffff'];

/** כוכב חמש קצוות עם קו מתאר: ניצוצות שמתפזרים מהבועה. */
function sparkSprite(color, px) {
  return spriteFor(`s|${color}|${px}`, px, px, (g, S) => {
    const cx = S / 2, cy = S / 2 + S * 0.02, R = S * 0.42, r = R * 0.45;
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = (Math.PI * i) / 5 - Math.PI / 2;
      const rr = i % 2 === 0 ? R : r;
      if (i === 0) g.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); else g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
    g.closePath();
    g.lineJoin = 'round';
    g.lineWidth = S * 0.09;
    g.strokeStyle = '#17120c';
    g.stroke();
    g.fillStyle = color;
    g.fill();
  });
}

// ------------------------------------------------------------------ ציור: מותג

const CORNERS = { tl: [0, 0], tr: [1, 0], bl: [0, 1], br: [1, 1] };
const BRAND_SAFE = { top: 0.075, bottom: 0.17, left: 0.05, right: 0.05 };

function brandKey(brand, W, H) {
  return `${brand.handle || ''}|${W}x${H}`;
}

function logoSize(logo) {
  const w = Number(logo?.width || logo?.naturalWidth || logo?.videoWidth), h = Number(logo?.height || logo?.naturalHeight || logo?.videoHeight);
  return fin(w) && fin(h) && w > 0 && h > 0 ? [w, h] : null;
}

/** תג מותג (לוגו + @כינוי עם צל רך) כ־sprite אחד, כך שבכל פריים זו קריאת drawImage אחת. */
function makeBrandSprite(brand, W, H) {
  const handle = String(brand.handle || '').trim();
  const text = handle ? (handle.startsWith('@') ? handle : '@' + handle) : '';
  const logo = brand.logoBitmap || null;
  const ls = logo ? logoSize(logo) : null;
  const fs = Math.round(H * 0.0235);
  const lh = ls ? Math.round(H * 0.044) : 0;
  const lw = ls ? Math.min(Math.round(lh * (ls[0] / ls[1])), Math.round(lh * 2.6)) : 0;
  const pad = Math.round(fs * 0.7);
  const c0 = canvasFactory(8, 8);
  const g0 = c0 && c0.getContext && c0.getContext('2d');
  if (!g0) return null;
  g0.font = BRAND_FONT.replace('{px}', String(fs));
  g0.direction = 'ltr';
  const tw = text ? Math.ceil(g0.measureText(text).width) : 0;
  const gap = ls && text ? Math.round(fs * 0.55) : 0;
  const w = pad * 2 + lw + gap + tw, h = pad * 2 + Math.max(lh, text ? Math.round(fs * 1.25) : 0);
  const c = canvasFactory(w, h);
  const g = c && c.getContext && c.getContext('2d');
  if (!g) return null;
  g.shadowColor = 'rgba(0,0,0,0.55)';
  g.shadowBlur = Math.round(fs * 0.45);
  g.shadowOffsetY = Math.round(fs * 0.08);
  if (ls) g.drawImage(logo, pad, Math.round((h - lh) / 2), lw, lh);
  if (text) {
    g.font = BRAND_FONT.replace('{px}', String(fs));
    g.direction = 'ltr';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.fillText(text, pad + lw + gap, Math.round(h / 2) + Math.round(fs * 0.04));
  }
  spriteCreations++;
  return { canvas: c, w, h, key: brandKey(brand, W, H), logo, corner: brand.corner };
}

function drawBrand(ctx, t, brand, W, H) {
  if (!brand || (!brand.handle && !brand.logoBitmap)) return;
  if (!brandSprite || brandSprite.key !== brandKey(brand, W, H) || brandSprite.logo !== (brand.logoBitmap || null)) brandSprite = makeBrandSprite(brand, W, H) || { key: brandKey(brand, W, H), logo: brand.logoBitmap || null };
  const s = brandSprite;
  if (!s.canvas) {
    if (brand.handle) { ctx.globalAlpha = 0.85; ctx.fillStyle = '#fff'; ctx.font = `700 ${Math.round(H * 0.0235)}px sans-serif`; ctx.fillText(String(brand.handle), W * 0.05, H * 0.1); }
    return;
  }
  const safe = { ...BRAND_SAFE, ...(brand.safe || {}) };
  const [cx, cy] = CORNERS[brand.corner] || CORNERS.tr;
  const x = cx ? W - W * safe.right - s.w : W * safe.left;
  const y = cy ? H - H * safe.bottom - s.h : H * safe.top;
  const op = clamp(fin(Number(brand.opacity)) ? Number(brand.opacity) : 0.88, 0, 1);
  ctx.globalAlpha = op * ease.smooth((t - 0.2) / 0.5);
  if (ctx.globalAlpha > 0.003) ctx.drawImage(s.canvas, Math.round(x), Math.round(y), s.w, s.h);
}

// ------------------------------------------------------------------ ציור: אפקטים

function setT(ctx, a, b, c, d, e, f) { ctx.setTransform(a, b, c, d, e, f); }

function drawFlash(ctx, rt, t, W, H) {
  const f = rt.flash;
  for (let k = lastAtOrBefore(f.starts, f.n, t); k >= 0 && f.starts[k] > t - f.maxDur; k--) {
    if (t >= f.ends[k]) continue;
    const e = f.list[k], u = t - e.t;
    const a = u < e.attack ? ease.smooth(u / e.attack) : 1 - ease.outCubic((u - e.attack) / e.decay);
    if (a < 0.004) continue;
    ctx.globalAlpha = e.alpha * a;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
  }
}

function drawEmoji(ctx, rt, t, W, H, px) {
  const ix = rt.emoji;
  for (let k = lastAtOrBefore(ix.starts, ix.n, t); k >= 0 && ix.starts[k] > t - ix.maxDur; k--) {
    if (t >= ix.ends[k]) continue;
    const e = ix.list[k], u = t - e.t;
    const s1 = emojiSprite(e.emoji, px), s2 = e.alt === e.emoji ? s1 : emojiSprite(e.alt, px);
    const base = e.size * W;
    for (let i = 0; i < e.count; i++) {
      const sp = (i & 1) && s2 ? s2 : s1;
      const r0 = rnd(e.seed, i * 6), r1 = rnd(e.seed, i * 6 + 1), r2 = rnd(e.seed, i * 6 + 2), r3 = rnd(e.seed, i * 6 + 3), r4 = rnd(e.seed, i * 6 + 4), r5 = rnd(e.seed, i * 6 + 5);
      let x, y, size, rot, a;
      if (e.kind === 'rain') {
        const v = (u - 0.6 * r1) / (1.0 + 0.5 * r2);
        if (v <= 0 || v >= 1) continue;
        x = (0.05 + 0.9 * r0 + 0.012 * Math.sin(v * 7 + r3 * 6.2832)) * W;
        y = (-0.08 + 1.18 * v * (0.35 + 0.65 * v * v)) * H;
        size = base * (0.65 + 0.7 * r4);
        rot = (r5 - 0.5) * 0.9 + (r5 > 0.5 ? 1 : -1) * v * 1.4;
        a = Math.min(v / 0.06, (1 - v) / 0.1, 1);
      } else {
        const d = u - 0.05 * r2;
        if (d <= 0) continue;
        const ang = -Math.PI / 2 + (r0 - 0.5) * 2.1, speed = 0.5 + 0.75 * r1;
        x = e.x * W + Math.cos(ang) * speed * d * H;
        y = e.y * H + (Math.sin(ang) * speed * d + 0.5 * e.g * d * d) * H;
        const life = d / (e.dur - 0.05);
        size = base * (0.7 + 0.5 * r4) * ease.outBack(d / 0.18) * (1 - 0.35 * ease.smooth(life));
        rot = (r5 - 0.5) * 0.8 + (r5 - 0.5) * d * 1.6;
        a = Math.min(1, (1 - life) / 0.3);
      }
      if (a <= 0.01 || size <= 1 || y > H * 1.1 || x < -size || x > W + size) continue;
      ctx.globalAlpha = a;
      if (sp) {
        const c = Math.cos(rot), s = Math.sin(rot);
        setT(ctx, c, s, -s, c, x, y);
        ctx.drawImage(sp.canvas, -size / 2, -size / 2, size, size);
      } else {
        // בלי canvas ליצירת sprite: טקסט ישירות (איטי יותר, אבל עובד)
        setT(ctx, 1, 0, 0, 1, x, y);
        ctx.font = `${Math.round(size * 0.8)}px ${EMOJI_FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(i & 1 ? e.alt : e.emoji, 0, 0);
      }
    }
  }
  setT(ctx, 1, 0, 0, 1, 0, 0);
}

function sparks4() {
  const out = [];
  for (const c of SPARK_COLORS) { const sp = sparkSprite(c, 64); if (!sp) return null; out.push(sp); }
  return out;
}

function drawStars(ctx, rt, t, W, H) {
  const ix = rt.star;
  for (let k = lastAtOrBefore(ix.starts, ix.n, t); k >= 0 && ix.starts[k] > t - ix.maxDur; k--) {
    if (t >= ix.ends[k]) continue;
    const e = ix.list[k], u = t - e.t, life = u / e.dur;
    // ניצוצות: כוכבים קטנים שנפתחים החוצה, מתעגלים ונעלמים
    const spk = sparks4();
    if (spk && u >= 0) {
      const R = (e.kind === 'boom' ? 0.3 : 0.2) * W * e.scale;
      const a = Math.min(1, (1 - life) / 0.45);
      for (let i = 0; a > 0.01 && i < e.sparks; i++) {
        const ang = (i / e.sparks) * 6.2832 + rnd(e.seed, i) * 0.6;
        const dist = R * (0.75 + 0.45 * rnd(e.seed, i + 20)) * ease.outCubic(u / 0.5);
        const size = W * (0.034 + 0.03 * rnd(e.seed, i + 40)) * e.scale * (1 - 0.4 * life);
        const rot = (rnd(e.seed, i + 60) - 0.5) * 3 + u * (i % 2 ? 4 : -4);
        const c = Math.cos(rot), s = Math.sin(rot);
        ctx.globalAlpha = a;
        setT(ctx, c, s, -s, c, e.x * W + Math.cos(ang) * dist, e.y * H + Math.sin(ang) * dist * 0.8);
        ctx.drawImage(spk[i % 4].canvas, -size / 2, -size / 2, size, size);
      }
    }
    // הבועה: קפיצה פנימה עם overshoot, נשימה קלה, ויציאה בדעיכה
    const sp = comicSprite(e.kind, e.text, comicPx(W));
    if (sp) {
      const pop = ease.outBack(u / 0.16) * (1 + 0.025 * Math.sin(u * 22) * (1 - life));
      const out = u > e.dur - 0.22 ? (u - (e.dur - 0.22)) / 0.22 : 0;
      const size = W * 0.56 * e.scale * Math.max(0.01, pop) * (1 + 0.08 * ease.smooth(out));
      const rot = e.rot + 0.03 * Math.sin(u * 30) * (1 - life);
      const c = Math.cos(rot), s = Math.sin(rot);
      ctx.globalAlpha = 1 - ease.smooth(out);
      setT(ctx, c, s, -s, c, e.x * W, e.y * H);
      ctx.drawImage(sp.canvas, -size / 2, -size / 2, size, size);
    }
  }
  setT(ctx, 1, 0, 0, 1, 0, 0);
}

/**
 * מכין מראש את ה־sprites (אימוג'י, בועות קומיקס, תג מותג) כדי שלא יהיה שבב איטי באמצע הרינדור. אופציונלי: drawEffects יוצר את החסר לבד.
 * opts: width, height (גודל הפלט), brand.
 */
export function prepareEffects(effects, { width = 1080, height = 1920, brand = null } = {}) {
  if (!validEffects(effects)) return;
  const made = [];
  const seen = new Set();
  for (const e of effects.emojis) for (const em of [e.emoji, e.alt]) if (!seen.has(em)) { seen.add(em); made.push(emojiSprite(em, emojiPx(width))); }
  for (const s of effects.stars) made.push(comicSprite(s.kind, s.text, comicPx(width)));
  if (effects.stars.length) for (const c of SPARK_COLORS) made.push(sparkSprite(c, 64));
  if (brand && (brand.handle || brand.logoBitmap)) {
    brandSprite = makeBrandSprite(brand, width, height) || { key: brandKey(brand, width, height), logo: brand.logoBitmap || null };
    if (brandSprite.canvas) made.push(brandSprite);
  }
  // "נוגעים" בכל sprite פעם אחת בקנבס קטן: ההעלאה הראשונה לכרטיס המסך (עד כמה מילישניות) קורית עכשיו ולא באמצע פריים ברינדור
  const scratch = made.some(Boolean) ? canvasFactory(2, 2) : null;
  const g = scratch && scratch.getContext && scratch.getContext('2d');
  if (g) for (const sp of made) if (sp && sp.canvas) { try { g.drawImage(sp.canvas, 0, 0, 1, 1); } catch (e) { /* sprite שבור לא עוצר את ההכנה */ } }
}

/**
 * מצייר את האפקטים של tOut על ctx (בגודל הפלט): פלאש לבן, גשם אימוג'י, כוכבי POP ו־BOOM, ותג מותג בפינה.
 *  brand: {handle, logoBitmap, corner:'tr'|'tl'|'br'|'bl' (ברירת מחדל tr), opacity (0.88), safe:{top,bottom,left,right}} (שיעורים מגודל הפריים)
 *  layers: תת־קבוצה של ['flash','emoji','stars','brand'] (ברירת מחדל: כולן). המלצה: ‎['flash','emoji']‎ לפני הכתוביות ו־‎['stars','brand']‎ אחריהן.
 *  width, height: אם אין ctx.canvas.
 * לא משאיר מצב על ה־ctx (save/restore). כשאין אפקט פעיל ואין מותג העלות היא חיפוש בינארי אחד לכל סוג.
 */
export function drawEffects(ctx, tOut, effects, { brand = null, layers = null, width = 0, height = 0 } = {}) {
  if (!ctx || !validEffects(effects) || !fin(tOut)) return;
  const W = width || ctx.canvas?.width, H = height || ctx.canvas?.height;
  if (!(W > 0) || !(H > 0)) return;
  const rt = runtime(effects);
  const want = (name) => !layers || layers.includes(name);
  const hasBrand = want('brand') && !!brand && !!(brand.handle || brand.logoBitmap);
  const live = (ix) => { const k = lastAtOrBefore(ix.starts, ix.n, tOut); return k >= 0 && tOut < ix.starts[k] + ix.maxDur; };
  const doFlash = want('flash') && live(rt.flash), doEmoji = want('emoji') && live(rt.emoji), doStars = want('stars') && live(rt.star);
  if (!doFlash && !doEmoji && !doStars && !hasBrand) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (doEmoji) drawEmoji(ctx, rt, tOut, W, H, emojiPx(W));
  if (doStars) drawStars(ctx, rt, tOut, W, H);
  if (doFlash) drawFlash(ctx, rt, tOut, W, H);
  if (hasBrand) drawBrand(ctx, tOut, brand, W, H);
  ctx.restore();
}

export const _internal = { GENRE_FX, DENSITY, CATEGORIES, runtime, motionInto, fitsWindow, sourceToOut, peaksOut, cleanWords, shoutScore, emojiPx, comicPx, applyMotion };
