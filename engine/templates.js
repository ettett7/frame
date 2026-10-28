// תבניות ויראליות לקליפים: top3, pov, waitForIt, beforeAfter.
// כל תבנית: { id, nameHe, descHe, adjustOptions?(options) -> options, momentsNeeded?(options) -> number,
//             apply(options, moments) -> { moments, overlayExtra(ctx,tOut,info), overlayUnder?(ctx,tOut,info), safeZone?, captionHook?, notes? } }
//
// - adjustOptions רץ לפני חיפוש הרגעים (למשל: top3 צריכה שלושה רגעים קצרים).
// - apply מקבלת את הרגעים שנמצאו ומחזירה את הרגעים שהופכים לקליפים. רגע עם `parts` הוא קליפ שמורכב מכמה רגעים (top3).
// - overlayUnder מצויר לפני הכתוביות, overlayExtra אחרי הכתוביות (מעליהן). שכבת העל של render.js שקופה, כך שאפשר רק לצייר מעל הווידאו ולא לשנות אותו.
// - info (פרמטר שלישי, מגיע מ־pipeline.js): { width, height, fps, duration, moment, parts:[{startOut,endOut,rank?,moment}], clipIndex, clips }.
//   כשאין info הפונקציות עדיין עובדות לפי גודל ה־canvas.
// הקובץ טהור: אין בו DOM ואין רשת. הציור הוא Canvas 2D בלבד, ולכן הוא עובד גם ב־Worker (OffscreenCanvas).

export const FONT = 'Heebo, Rubik, "Noto Sans Hebrew", system-ui, -apple-system, "Segoe UI", sans-serif';
export const ACCENT = '#FFD60A';

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const easeOut = (t) => 1 - (1 - clamp(t)) ** 3;
const easeOutBack = (t) => { const x = clamp(t); const c1 = 1.70158; const c3 = c1 + 1; return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2; };
const smooth = (t) => { const x = clamp(t); return x * x * (3 - 2 * x); };
const hasHebrew = (s) => /[֐-׿]/.test(String(s || ''));

function sizeOf(ctx, info) {
  const cw = ctx?.canvas?.width; const ch = ctx?.canvas?.height;
  return { W: cw > 0 ? cw : (info?.width || 720), H: ch > 0 ? ch : (info?.height || 1280) };
}

function pillPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** שבירת שורות לפי רוחב. אם יש יותר שורות מהמותר, השורה האחרונה נחתכת ב־"…". */
export function wrapLines(ctx, text, maxWidth, maxLines = 2) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const next = cur ? `${cur} ${words[i]}` : words[i];
    if (!cur || ctx.measureText(next).width <= maxWidth) { cur = next; continue; }
    lines.push(cur); cur = words[i];
    if (lines.length === maxLines) { cur = ''; lines[maxLines - 1] += ' …'; break; }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, maxLines);
}

function setText(ctx, px, { weight = 'bold', rtl = true, align = 'center' } = {}) {
  ctx.font = `${weight} ${Math.round(px)}px ${FONT}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  try { ctx.direction = rtl ? 'rtl' : 'ltr'; } catch (_) { /* ctx ישן בלי direction */ }
}

function chip(ctx, text, cx, cy, px, { bg = ACCENT, fg = '#111', rtl = true, padX = 0.7, alpha = 1, scale = 1 } = {}) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(cx, cy); ctx.scale(scale, scale);
  setText(ctx, px, { rtl });
  const w = ctx.measureText(text).width + px * padX * 2;
  const h = px * 1.55;
  ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = px * 0.35; ctx.shadowOffsetY = px * 0.1;
  ctx.fillStyle = bg; pillPath(ctx, -w / 2, -h / 2, w, h, h / 2); ctx.fill();
  ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  ctx.fillStyle = fg; ctx.fillText(text, 0, px * 0.04);
  ctx.restore();
  return { w: w * scale, h: h * scale };
}

function strokedText(ctx, text, x, y, px, { fg = '#fff', rtl = true } = {}) {
  setText(ctx, px, { rtl });
  ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(3, px * 0.16);
  ctx.strokeStyle = 'rgba(0,0,0,0.78)'; ctx.strokeText(text, x, y);
  ctx.fillStyle = fg; ctx.fillText(text, x, y);
}

const noop = () => {};

// ------------------------------------------------------------------------------------------------ top3

const TOP3_PART_DEFAULT = 14;   // שניות לכל חלק כשהאורך "אוטומטי"
const TOP3_PART_MIN = 6;

/** מקצר רגע לחלון סביב השיא, כדי ששלושה חלקים ייכנסו באורך סביר. */
export function trimMoment(m, maxLen) {
  const len = m.end - m.start;
  if (!(maxLen > 0) || len <= maxLen * 1.15) return { ...m };
  const peak = Number.isFinite(m.peak) && m.peak >= m.start && m.peak <= m.end ? m.peak : m.start + len * 0.35;
  let s = peak - maxLen * 0.4;
  s = clamp(s, m.start, m.end - maxLen);
  return { ...m, start: Math.round(s * 100) / 100, end: Math.round((s + maxLen) * 100) / 100 };
}

function drawTop3(ctx, tOut, info = {}) {
  const parts = info.parts;
  if (!parts?.length) return;
  const idx = parts.findIndex((p) => tOut >= p.startOut && tOut < p.endOut);
  if (idx < 0) return;
  const p = parts[idx];
  const { W, H } = sizeOf(ctx, info);
  const rank = p.rank ?? (parts.length - idx);
  const local = tOut - p.startOut;
  const cardLen = Math.min(1.3, Math.max(0.5, (p.endOut - p.startOut) * 0.35));
  ctx.save();
  if (local < cardLen) {
    const a = Math.min(idx === 0 ? 1 : clamp(local / 0.12), clamp((cardLen - local) / 0.25));
    ctx.globalAlpha = a * 0.88;
    ctx.fillStyle = 'rgb(8,8,18)'; ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = a;
    const s = 0.65 + 0.35 * easeOutBack(local / 0.38);
    ctx.save();
    ctx.translate(W / 2, H * 0.46); ctx.scale(s, s);
    ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = W * 0.03;
    setText(ctx, W * 0.42, { weight: '900', rtl: false });
    ctx.fillStyle = ACCENT; ctx.fillText(`#${rank}`, 0, 0);
    ctx.restore();
    setText(ctx, W * 0.07, { rtl: true });
    ctx.fillStyle = '#fff'; ctx.fillText('טופ 3', W / 2, H * 0.27);
    chip(ctx, `מקום ${rank}`, W / 2, H * 0.66, W * 0.06, { bg: 'rgba(255,255,255,0.14)', fg: '#fff' });
  } else {
    const a = smooth((local - cardLen) / 0.25);
    chip(ctx, `#${rank}`, W / 2, H * 0.075, W * 0.07, { rtl: false, alpha: a, padX: 0.9 });
  }
  ctx.restore();
}

export const top3 = {
  id: 'top3',
  nameHe: 'טופ 3',
  descHe: 'שלושת הרגעים הכי חזקים בקליפ אחד, עם כרטיסי #3, #2 ו־#1 ביניהם',
  momentsNeeded: () => 3,
  adjustOptions(options) {
    return { ...options, count: 3, length: 15 };   // חלקים קצרים: כל חלק נחתך אחר כך לפי האורך המבוקש
  },
  apply(options, moments) {
    const list = (moments || []).filter(Boolean);
    const total = typeof options?.length === 'number' ? options.length : null;
    const partMax = Math.max(TOP3_PART_MIN, total ? total / 3 : TOP3_PART_DEFAULT);
    const ranked = [...list].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 3);
    if (ranked.length < 2) {
      return {
        moments: list.slice(0, Math.max(1, options?.count || 1)),
        overlayExtra: noop,
        notes: ['מצאנו פחות משני רגעים חזקים בסרטון, לכן נוצר קליפ רגיל במקום טופ 3'],
      };
    }
    // ranked[0] הוא #1. הקליפ מתנגן בספירה לאחור: #3, #2 ואז #1.
    const parts = ranked.map((m, i) => ({ ...trimMoment(m, partMax), rank: i + 1 })).reverse();
    const best = ranked[0];
    const composite = {
      start: Math.min(...parts.map((p) => p.start)),
      end: Math.max(...parts.map((p) => p.end)),
      score: best.score,
      hook: ranked.length === 3 ? 'טופ 3 הרגעים הכי חזקים' : 'שני הרגעים הכי חזקים',
      hooks: ['טופ 3 הרגעים הכי חזקים', 'שלושה רגעים, ורק אחד מנצח', 'חכו למקום הראשון'],
      reason: 'הרגעים החזקים בסרטון, מהאחרון ועד הראשון',
      peak: best.peak,
      language: best.language,
      parts,
    };
    const notes = ranked.length === 2 ? ['מצאנו רק שני רגעים חזקים, לכן זה טופ 2'] : [];
    return { moments: [composite], overlayExtra: drawTop3, captionHook: false, notes };
  },
};

// ------------------------------------------------------------------------------------------------ pov

function drawPov(ctx, tOut, info = {}) {
  const { W, H } = sizeOf(ctx, info);
  if (tOut < 0) return;
  const a = easeOut(tOut / 0.3);                 // הכותרת נראית כבר בפריים הראשון, ורק גולשת למקומה
  const hook = String(info.moment?.hook || '').trim();
  const rtl = hook ? hasHebrew(hook) : true;
  ctx.save();
  const dy = (1 - a) * -H * 0.02;
  const labelPx = W * 0.075;
  const cy = H * 0.085 + dy;
  const box = chip(ctx, 'POV:', W / 2, cy, labelPx, { rtl: false, padX: 0.8 });
  if (hook) {
    const px = W * 0.058;
    setText(ctx, px, { rtl });
    const lines = wrapLines(ctx, hook, W * 0.84, 2);
    let y = cy + box.h / 2 + px * 1.1;
    for (const line of lines) { strokedText(ctx, line, W / 2, y, px, { rtl }); y += px * 1.3; }
  }
  ctx.restore();
}

export const pov = {
  id: 'pov',
  nameHe: 'POV',
  descHe: 'כותרת "POV:" בראש המסך, עם משפט הפתיחה של הקליפ',
  apply(options, moments) {
    return {
      moments: (moments || []).slice(0, Math.max(1, options?.count || 1)),
      overlayExtra: drawPov,
      safeZone: { top: 26, bottom: 22, left: 6, right: 10 },   // אחוזים, כמו ב־captions.js
      captionHook: false,   // המשפט כבר מוצג בכותרת, בלי כפילות
    };
  },
};

// ------------------------------------------------------------------------------------------------ waitForIt

function drawWaitForIt(ctx, tOut, info = {}) {
  const { W, H } = sizeOf(ctx, info);
  const big = 1 - smooth((tOut - 2.6) / 0.6);          // 1 בשלוש השניות הראשונות, ואז מתכווץ לשבב קטן
  const px = W * (0.052 + 0.034 * big);
  const pulse = 1 + 0.05 * Math.sin(tOut * 7) * big;
  const appear = easeOut(tOut / 0.25);           // קופץ פנימה, אבל נראה כבר בפריים הראשון
  chip(ctx, 'חכו לסוף 👀', W / 2, H * 0.085, px, { scale: pulse * (0.85 + 0.15 * appear) });
  const dur = info.duration;
  if (dur > 0) {
    const p = clamp(tOut / dur);
    const barH = Math.max(6, H * 0.0075);
    const x0 = W * 0.05; const w = W * 0.9; const y = H - H * 0.04 - barH;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.28)'; pillPath(ctx, x0, y, w, barH, barH / 2); ctx.fill();
    if (p > 0) { ctx.fillStyle = ACCENT; pillPath(ctx, x0, y, Math.max(barH, w * p), barH, barH / 2); ctx.fill(); }
    ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = barH;
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x0 + w * p, y + barH / 2, barH * 0.95, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
}

export const waitForIt = {
  id: 'waitForIt',
  nameHe: 'חכו לסוף',
  descHe: 'שבב "חכו לסוף 👀" ובר התקדמות שגורם לצופים להישאר עד הסוף',
  apply(options, moments) {
    return {
      moments: (moments || []).slice(0, Math.max(1, options?.count || 1)),
      overlayExtra: drawWaitForIt,
      safeZone: { top: 16, bottom: 22, left: 6, right: 10 },
    };
  },
};

// ------------------------------------------------------------------------------------------------ beforeAfter

// שכבת העל של render.js שקופה (היא מצוירת מעל הווידאו ולא רואה את הפריים), ולכן "לפני" ו"אחרי" הם שני רגעים בקליפ אחד:
// קודם הרגע המוקדם בסרטון (תווית "לפני"), ואז הרגע המאוחר (תווית "אחרי"), עם קו פיצול שמכסח את המסך בין השניים.
const BA_PART_DEFAULT = 12;
const BA_WIPE = 0.5;

function drawBeforeAfter(ctx, tOut, info = {}) {
  const parts = info.parts;
  if (!parts?.length) return;
  const idx = parts.findIndex((p) => tOut >= p.startOut && tOut < p.endOut);
  if (idx < 0) return;
  const p = parts[idx];
  const { W, H } = sizeOf(ctx, info);
  const after = p.role === 'after';
  const local = tOut - p.startOut;
  const px = W * 0.055;
  ctx.save();
  chip(ctx, after ? 'אחרי' : 'לפני', W / 2, H * 0.075, px, after ? { bg: ACCENT, fg: '#111' } : { bg: 'rgba(20,20,30,0.86)', fg: '#fff' });
  if (after && local < BA_WIPE) {
    // קו פיצול שחולף על המסך מימין לשמאל, עם הבהוב לבן קצר
    const u = easeOut(local / BA_WIPE);
    const x = W * (1 - u);
    ctx.globalAlpha = (1 - u) * 0.28;
    ctx.fillStyle = '#fff'; ctx.fillRect(x, 0, W - x, H);
    ctx.globalAlpha = 1 - smooth((local - BA_WIPE * 0.6) / (BA_WIPE * 0.4));
    ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = W * 0.02;
    ctx.fillStyle = '#fff'; ctx.fillRect(x - 3, 0, 6, H);
  }
  ctx.restore();
}

export const beforeAfter = {
  id: 'beforeAfter',
  nameHe: 'לפני ואחרי',
  descHe: 'שני רגעים בקליפ אחד: קודם "לפני" ואחריו "אחרי", עם קו פיצול ביניהם',
  momentsNeeded: () => 2,
  adjustOptions(options) {
    return { ...options, count: 2, length: 15 };
  },
  apply(options, moments) {
    const list = (moments || []).filter(Boolean);
    const total = typeof options?.length === 'number' ? options.length : null;
    const partMax = Math.max(TOP3_PART_MIN, total ? total / 2 : BA_PART_DEFAULT);
    let parts;
    const notes = [];
    if (list.length >= 2) {
      // שני הרגעים החזקים, לפי הסדר שבו הם מופיעים בסרטון: המוקדם הוא "לפני"
      const two = [...list].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 2).sort((a, b) => a.start - b.start);
      parts = two.map((m, i) => ({ ...trimMoment(m, partMax), role: i === 0 ? 'before' : 'after' }));
    } else if (list.length === 1) {
      // רגע אחד בלבד: תחילתו היא "לפני" וסופו "אחרי"
      const m = list[0]; const len = m.end - m.start;
      const k = Math.min(partMax, len * 0.4);
      parts = [
        { ...m, end: round2(m.start + k), peak: undefined, role: 'before' },
        { ...m, start: round2(m.end - k), peak: m.peak, role: 'after' },
      ];
      notes.push('מצאנו רק רגע אחד, ולכן "לפני" הוא תחילת הרגע ו"אחרי" הוא סופו');
    } else return { moments: [], overlayExtra: noop };
    const best = [...parts].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
    const composite = {
      start: Math.min(...parts.map((p) => p.start)), end: Math.max(...parts.map((p) => p.end)),
      score: best.score, hook: 'לפני ואחרי', hooks: ['לפני ואחרי', 'ההבדל מדהים', 'תראו את ההבדל'],
      reason: 'שני רגעים מהסרטון: מוקדם ומאוחר', peak: parts[1].peak, language: best.language, parts,
    };
    return { moments: [composite], overlayExtra: drawBeforeAfter, captionHook: false, safeZone: { top: 12, bottom: 22, left: 6, right: 10 }, notes };
  },
};

function round2(x) { return Math.round(x * 100) / 100; }

// ------------------------------------------------------------------------------------------------ רישום

export const TEMPLATES = { top3, pov, waitForIt, beforeAfter };

export function getTemplate(id) {
  if (!id) return null;
  return Object.prototype.hasOwnProperty.call(TEMPLATES, id) ? TEMPLATES[id] : null;
}

/** רשימה לממשק: [{id, nameHe, descHe}] */
export function listTemplates() {
  return Object.values(TEMPLATES).map(({ id, nameHe, descHe }) => ({ id, nameHe, descHe }));
}
