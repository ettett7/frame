// engine/media.js: עוזרי רינדור (סוכן 3, סבב 8).
// החלק הראשון טהור לגמרי (עובד ב־node, ב־worker ובדף): ציר זמן, גיאומטריה, bitrate.
// החלק האחרון טוען את mp4box.js באופן עצל (import דינמי) ולכן node לא נוגע ב־CDN.

export const MP4BOX_URL = 'https://cdn.jsdelivr.net/npm/mp4box@0.5.4/+esm';
export const MP4_MUXER_URL = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/build/mp4-muxer.mjs';
// מקודד AAC-LC ב־WASM (FFmpeg, ‏MPL-2.0 ועליו LGPL של FFmpeg ללא רכיבי GPL), למכשירים בלי AudioEncoder.
// זה קובץ CommonJS מהודר עם WASM משובץ, ולכן נטען כטקסט ומורץ (ראו loadWasmAac). נטען רק כשצריך.
export const AAC_WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediabunny/aac-encoder@1.52.2/dist/modules/build/aac.js';

// ───────────────────────── הודעות בעברית ─────────────────────────
export const HE = {
  exporting: 'מייצא',
  preparing: 'מכינים את הייצוא',
  cancelled: 'הייצוא בוטל',
  emptyPlan: 'אין מה לייצא: התוכנית ריקה',
  noVideo: 'לא נמצא וידאו בקובץ',
  badFile: 'לא הצלחנו לקרוא את הקובץ. נסו סרטון אחר',
  codecUnsupported: 'הדפדפן אינו תומך בפורמט הווידאו של הסרטון',
  noWebCodecs: 'הדפדפן אינו תומך בייצוא המהיר',
  encoderUnsupported: 'הדפדפן אינו מצליח לקודד וידאו בגודל הזה',
  encodeFailed: 'הייצוא נכשל',
  recorderUnsupported: 'הדפדפן אינו תומך בהקלטת וידאו',
  playbackBlocked: 'הדפדפן חסם ניגון ברקע. אפשר לכבות מצב חיסכון בסוללה ולנסות שוב',
  stalled: 'הייצוא נתקע. נסו שוב',
  libLoad: 'לא הצלחנו לטעון רכיב נדרש. בדקו את החיבור לאינטרנט ונסו שוב',
  audioEncoder: 'לא הצלחנו לקודד את הקול',
  thumbFailed: 'לא הצלחנו להפיק תמונה מהסרטון',
};

export function heError(message, code, cause) {
  const e = new Error(message);
  e.code = code || 'failed';
  if (cause) e.cause = cause;
  return e;
}

export function abortError() {
  const e = new Error(HE.cancelled);
  e.name = 'AbortError';
  e.code = 'aborted';
  return e;
}

export function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError();
}

export function progressText(fraction, label = HE.exporting) {
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  return `${label} · ${Math.round(f * 100)}%`;
}

// ───────────────────────── ציר זמן ─────────────────────────
const EPS = 1e-9;

// plan.segments = [[s0,s1],...] בזמני מקור, לפי הסדר. הזמן בפלט מצטבר.
export function compilePlan(plan) {
  if (plan && Array.isArray(plan.segs) && typeof plan.duration === 'number' && plan.compiled) return plan;
  const segs = [];
  let t = 0;
  const raw = (plan && plan.segments) || [];
  for (let i = 0; i < raw.length; i++) {
    const s0 = Number(raw[i][0]);
    const s1 = Number(raw[i][1]);
    if (!Number.isFinite(s0) || !Number.isFinite(s1) || !(s1 - s0 > 1e-6)) continue;
    const len = s1 - s0;
    segs.push({ index: segs.length, planIndex: i, srcStart: s0, srcEnd: s1, outStart: t, outEnd: t + len, length: len });
    t += len;
  }
  return { compiled: true, segs, duration: t };
}

export function planDuration(plan) {
  return compilePlan(plan).duration;
}

// הקטע שפריים בזמן tOut שייך אליו, או null מחוץ לטווח. הקטעים חצי־פתוחים: [outStart, outEnd).
export function segmentAt(plan, tOut) {
  const { segs, duration } = compilePlan(plan);
  if (!segs.length || !(tOut >= 0) || tOut >= duration - EPS) return null;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].outStart <= tOut + EPS) lo = mid;
    else hi = mid - 1;
  }
  return segs[lo];
}

// זמן המקור שמתאים לזמן פלט. מחוץ לטווח: null (או קיבוע לקצוות עם {clamp:true}).
export function sourceTime(plan, tOut, { clamp = false } = {}) {
  const c = compilePlan(plan);
  if (!c.segs.length) return null;
  const seg = segmentAt(c, tOut);
  if (!seg) {
    if (!clamp || !Number.isFinite(tOut)) return null;
    return tOut < 0 ? c.segs[0].srcStart : c.segs[c.segs.length - 1].srcEnd;
  }
  return Math.min(seg.srcEnd, seg.srcStart + (tOut - seg.outStart));
}

// כמה פריימים בפלט. מעגלים לפריים הקרוב, כך שהאורך שונה מהמבוקש בפחות מחצי פריים.
export function framesOf(plan, fps) {
  const d = compilePlan(plan).duration;
  if (!(d > 0) || !(fps > 0)) return 0;
  return Math.max(1, Math.round(d * fps - 1e-9));
}

// חלוקת פריימי הפלט לקטעים: כל פריים שייך בדיוק לקטע אחד. [firstFrame, endFrame)
export function frameRanges(plan, fps) {
  const c = compilePlan(plan);
  const n = framesOf(c, fps);
  const out = [];
  let first = 0;
  for (let k = 0; k < c.segs.length; k++) {
    const s = c.segs[k];
    const last = k === c.segs.length - 1;
    let end = last ? n : Math.min(n, Math.ceil(s.outEnd * fps - 1e-6));
    if (end < first) end = first;
    out.push({ ...s, firstFrame: first, endFrame: end, frames: end - first });
    first = end;
  }
  return out;
}

// זמן המקור של פריים פלט מספר i בתוך קטע (ממוקם בתוך הקטע)
export function frameSourceTime(range, i, fps) {
  const t = range.srcStart + (i / fps - range.outStart);
  return Math.min(range.srcEnd, Math.max(range.srcStart, t));
}

// ───────────────────────── גיאומטריה ─────────────────────────
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function evenFloor(v) {
  const n = Math.floor(v);
  return n - (n % 2);
}

export function evenRound(v) {
  return Math.round(v / 2) * 2;
}

export function normalizeRotation(deg) {
  const d = Math.round((Number(deg) || 0) / 90) * 90;
  return ((d % 360) + 360) % 360;
}

// מטריצת tkhd של mp4 (16.16, שורה ראשונה a,b ושנייה c,d). מחזיר סיבוב בכיוון השעון: 0/90/180/270
export function rotationFromMatrix(m) {
  if (!m || m.length < 5) return 0;
  const a = Number(m[0]);
  const b = Number(m[1]);
  if (!a && !b) return 0;
  return normalizeRotation((Math.atan2(b, a) * 180) / Math.PI);
}

export function rotatedSize(w, h, rotation) {
  return normalizeRotation(rotation) % 180 ? { w: h, h: w } : { w, h };
}

// crop מנורמל (0..1) לפיקסלים שלמים. רוחב וגובה (וגם x ו־y) זוגיים כברירת מחדל, בתוך התמונה.
export function cropPixels(rect, srcW, srcH, { even = true } = {}) {
  const r = rect && Number.isFinite(rect.w) && Number.isFinite(rect.h) ? rect : { x: 0, y: 0, w: 1, h: 1 };
  const unit = even ? 2 : 1;
  const maxW = Math.max(unit, Math.floor(srcW / unit) * unit);
  const maxH = Math.max(unit, Math.floor(srcH / unit) * unit);
  const x0 = clamp(Number(r.x) || 0, 0, 1) * srcW;
  const y0 = clamp(Number(r.y) || 0, 0, 1) * srcH;
  const x1 = clamp((Number(r.x) || 0) + r.w, 0, 1) * srcW;
  const y1 = clamp((Number(r.y) || 0) + r.h, 0, 1) * srcH;
  const w = Math.min(maxW, Math.max(unit, Math.round((x1 - x0) / unit) * unit));
  const h = Math.min(maxH, Math.max(unit, Math.round((y1 - y0) / unit) * unit));
  let x = Math.round(x0 / unit) * unit;
  let y = Math.round(y0 / unit) * unit;
  x = Math.floor(clamp(x, 0, srcW - w) / unit) * unit;
  y = Math.floor(clamp(y, 0, srcH - h) / unit) * unit;
  return { x, y, w, h };
}

// מתאים מלבן בפיקסלים ליחס ממדים מבוקש (חיתוך סביב המרכז, ללא עיוות), ושומר אותו בתוך התמונה
export function coverRect(r, aspect, srcW, srcH) {
  let { x, y, w, h } = r;
  if (!(w > 0) || !(h > 0)) {
    x = 0;
    y = 0;
    w = srcW;
    h = srcH;
  }
  if (w / h > aspect) {
    const nw = h * aspect;
    x += (w - nw) / 2;
    w = nw;
  } else {
    const nh = w / aspect;
    y += (h - nh) / 2;
    h = nh;
  }
  if (w > srcW) {
    w = srcW;
    h = w / aspect;
  }
  if (h > srcH) {
    h = srcH;
    w = h * aspect;
  }
  x = clamp(x, 0, srcW - w);
  y = clamp(y, 0, srcH - h);
  return { sx: x, sy: y, sw: w, sh: h };
}

// מלבן בקואורדינטות תצוגה (אחרי סיבוב) אל מלבן בקואורדינטות הפריים המקודד
export function displayRectToCoded(r, codedW, codedH, rotation) {
  const rot = normalizeRotation(rotation);
  if (rot === 0) return { x: r.x, y: r.y, w: r.w, h: r.h };
  const map = (xd, yd) => {
    if (rot === 90) return [yd, codedH - xd];
    if (rot === 180) return [codedW - xd, codedH - yd];
    return [codedW - yd, xd]; // 270
  };
  const [ax, ay] = map(r.x, r.y);
  const [bx, by] = map(r.x + r.w, r.y + r.h);
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

const FULL = { x: 0, y: 0, w: 1, h: 1 };

function toPixelRect(n, srcW, srcH) {
  const r = n && Number.isFinite(n.w) && Number.isFinite(n.h) && n.w > 0 && n.h > 0 ? n : FULL;
  return { x: (Number(r.x) || 0) * srcW, y: (Number(r.y) || 0) * srcH, w: r.w * srcW, h: r.h * srcH };
}

// מה לצייר בפריים: רשימת פעולות {sx,sy,sw,sh,dx,dy,dw,dh} בקואורדינטות תצוגה של המקור
// layout: 'tracked' (מלבן אחד), 'split' (שני חצאים), 'fit' (כל התמונה על רקע מטושטש)
export function layoutOps({ layout = 'tracked', rect, top, bottom, srcW, srcH, outW, outH }) {
  if (layout === 'fit') {
    const scale = Math.min(outW / srcW, outH / srcH);
    const dw = Math.min(outW, evenRound(srcW * scale));
    const dh = Math.min(outH, evenRound(srcH * scale));
    const dx = Math.floor((outW - dw) / 2);
    const dy = Math.floor((outH - dh) / 2);
    const full = dw >= outW && dh >= outH;
    return {
      layout: 'fit',
      bg: full ? null : coverRect({ x: 0, y: 0, w: srcW, h: srcH }, outW / outH, srcW, srcH),
      draws: [{ sx: 0, sy: 0, sw: srcW, sh: srcH, dx, dy, dw, dh }],
    };
  }
  if (layout === 'split' && top && bottom) {
    const topH = evenFloor(outH / 2);
    const botH = outH - topH;
    const a = coverRect(toPixelRect(top, srcW, srcH), outW / topH, srcW, srcH);
    const b = coverRect(toPixelRect(bottom, srcW, srcH), outW / botH, srcW, srcH);
    return {
      layout: 'split',
      bg: null,
      draws: [
        { ...a, dx: 0, dy: 0, dw: outW, dh: topH },
        { ...b, dx: 0, dy: topH, dw: outW, dh: botH },
      ],
    };
  }
  const c = coverRect(toPixelRect(rect, srcW, srcH), outW / outH, srcW, srcH);
  return { layout: 'tracked', bg: null, draws: [{ ...c, dx: 0, dy: 0, dw: outW, dh: outH }] };
}

// ─────────── דגימת מצלמה: פונקציות לא עוברות ל־worker, ולכן דוגמים כל פריים מראש ───────────
function readRect(fn, t, prev) {
  let r = null;
  try {
    r = fn(t);
  } catch (_) {
    r = null;
  }
  if (r && Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.w) && Number.isFinite(r.h) && r.w > 0 && r.h > 0) {
    return r;
  }
  return prev || FULL;
}

export function sampleCamera(camera, n, fps) {
  const layout = camera && (camera.layout === 'split' || camera.layout === 'fit') ? camera.layout : 'tracked';
  if (layout === 'fit') return { layout, n, rects: null, rects2: null };
  const useSplit = layout === 'split' && camera.split && typeof camera.split.topAt === 'function' && typeof camera.split.bottomAt === 'function';
  const topFn = useSplit ? camera.split.topAt : camera && typeof camera.rectAt === 'function' ? camera.rectAt : () => FULL;
  const rects = new Float32Array(n * 4);
  const rects2 = useSplit ? new Float32Array(n * 4) : null;
  let p1 = null;
  let p2 = null;
  for (let i = 0; i < n; i++) {
    const t = i / fps;
    p1 = readRect(topFn, t, p1);
    rects.set([p1.x, p1.y, p1.w, p1.h], i * 4);
    if (useSplit) {
      p2 = readRect(camera.split.bottomAt, t, p2);
      rects2.set([p2.x, p2.y, p2.w, p2.h], i * 4);
    }
  }
  return { layout: useSplit ? 'split' : 'tracked', n, rects, rects2 };
}

export function camRect(table, which, i) {
  const a = which === 2 ? table.rects2 : table.rects;
  if (!a) return null;
  const k = Math.min(Math.max(0, i), table.n - 1) * 4;
  return { x: a[k], y: a[k + 1], w: a[k + 2], h: a[k + 3] };
}

export function opsForFrame(table, i, geom) {
  return layoutOps({
    layout: table.layout,
    rect: camRect(table, 1, i),
    top: camRect(table, 1, i),
    bottom: camRect(table, 2, i),
    srcW: geom.dispW,
    srcH: geom.dispH,
    outW: geom.outW,
    outH: geom.outH,
  });
}

// ───────────────────────── ציור (קנבס) ─────────────────────────
// makeCanvas(w,h) -> קנבס (OffscreenCanvas ב־worker, canvas בדף). נבדק ב־node עם קנבס מדומה.
export function createCompositor({ makeCanvas, outW, outH }) {
  let blurA = null;
  let blurB = null;

  function drawRect(ctx, img, geom, d) {
    const c = displayRectToCoded({ x: d.sx, y: d.sy, w: d.sw, h: d.sh }, geom.codedW, geom.codedH, geom.rotation);
    const rot = normalizeRotation(geom.rotation);
    if (!rot) {
      ctx.drawImage(img, c.x, c.y, c.w, c.h, d.dx, d.dy, d.dw, d.dh);
      return;
    }
    const swap = rot % 180 !== 0;
    const w = swap ? d.dh : d.dw;
    const h = swap ? d.dw : d.dh;
    ctx.save();
    ctx.translate(d.dx + d.dw / 2, d.dy + d.dh / 2);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.drawImage(img, c.x, c.y, c.w, c.h, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  function setupSmoothing(ctx) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
  }

  // טשטוש זול ועובד בכל דפדפן (ctx.filter לא קיים בכל Safari): הקטנה בשני שלבים והגדלה
  function drawBlurBg(ctx, img, geom, bg) {
    const aw = 144;
    const ah = Math.max(2, Math.round((aw * outH) / outW));
    const bw = 36;
    const bh = Math.max(2, Math.round((bw * outH) / outW));
    if (!blurA) {
      blurA = makeCanvas(aw, ah);
      blurB = makeCanvas(bw, bh);
    }
    const ca = blurA.getContext('2d');
    const cb = blurB.getContext('2d');
    setupSmoothing(ca);
    setupSmoothing(cb);
    drawRect(ca, img, geom, { ...bg, dx: 0, dy: 0, dw: aw, dh: ah });
    cb.drawImage(blurA, 0, 0, aw, ah, 0, 0, bw, bh);
    ca.drawImage(blurB, 0, 0, bw, bh, 0, 0, aw, ah);
    ctx.drawImage(blurA, 0, 0, aw, ah, 0, 0, outW, outH);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, outW, outH);
  }

  return {
    // img: VideoFrame / HTMLVideoElement / ImageBitmap. geom: {codedW, codedH, rotation}
    draw(ctx, img, geom, ops) {
      setupSmoothing(ctx);
      if (ops.bg) drawBlurBg(ctx, img, geom, ops.bg);
      for (const d of ops.draws) drawRect(ctx, img, geom, d);
    },
  };
}

// ───────────────────────── קידוד: bitrate ו־codec ─────────────────────────
const BPP = { draft: 0.08, normal: 0.13, high: 0.18 };

// bitrate לווידאו: בערך 0.13 ביט לפיקסל לפריים (1080x1920 ב־30fps: כ־8Mbps)
export function chooseBitrate(width, height, fps, quality = 'normal') {
  const bpp = BPP[quality] || BPP.normal;
  const raw = width * height * fps * bpp;
  return Math.round(clamp(raw, 1.5e6, 20e6) / 1e5) * 1e5;
}

export function chooseAudioBitrate(channels) {
  return channels >= 2 ? 128000 : 96000;
}

// רמות H.264: [level_idc, maxMBPS, maxFS]
const AVC_LEVELS = [
  [30, 40500, 1620],
  [31, 108000, 3600],
  [32, 216000, 5120],
  [40, 245760, 8192],
  [42, 522240, 8704],
  [50, 589824, 22080],
  [51, 983040, 36864],
  [52, 2073600, 36864],
];

export function avcLevel(width, height, fps) {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  for (const [lvl, maxMBPS, maxFS] of AVC_LEVELS) {
    if (mbs <= maxFS && mbs * fps <= maxMBPS) return lvl;
  }
  return 52;
}

const hex2 = (n) => n.toString(16).padStart(2, '0');

// רשימת מחרוזות codec לניסיון, מהעדיפה לפחות: High, Main, Baseline באותה רמה
export function avcCandidates(width, height, fps) {
  const lvl = avcLevel(width, height, fps);
  const l = hex2(lvl);
  return [`avc1.6400${l}`, `avc1.4d00${l}`, `avc1.4200${l}`];
}

// מרווח keyframe: כל שתי שניות
export function gopFrames(fps) {
  return Math.max(1, Math.round(fps * 2));
}

// ───────────────────────── AAC: עזרים טהורים ─────────────────────────
export const AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
// השהיית קידוד (priming) בדגימות: מקודד מערכת (AudioToolbox/MediaCodec) כ־2112, ו־FFmpeg הוא 1024.
export const AAC_PRIMING = { native: 2112, wasm: 1024 };

export function aacSampleRateIndex(sampleRate) {
  return AAC_SAMPLE_RATES.indexOf(sampleRate);
}

// AudioSpecificConfig ל־AAC-LC (שני בייטים): סוג אובייקט 2, אינדקס קצב דגימה, מספר ערוצים
export function makeAacAsc(sampleRate, channels) {
  const idx = aacSampleRateIndex(sampleRate);
  if (idx < 0 || !(channels >= 1 && channels <= 7)) return null;
  const v = (2 << 11) | (idx << 7) | (channels << 3);
  return new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
}

function toU8(x) {
  if (!x) return null;
  if (x instanceof Uint8Array) return x;
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  return null;
}

// קורא את תחילת ה־AudioSpecificConfig, או null אם הבייטים אינם תקינים
export function parseAacAsc(desc) {
  const bytes = toU8(desc);
  if (!bytes || bytes.length < 2) return null;
  const n = Math.min(bytes.length, 4);
  let bits = 0;
  for (let i = 0; i < n; i++) bits = bits * 256 + bytes[i];
  const total = n * 8;
  const take = (len, at) => Math.floor(bits / 2 ** (total - at - len)) % 2 ** len;
  const objectType = take(5, 0);
  const idx = take(4, 5);
  if (objectType === 0 || objectType === 31 || idx > 12) return null; // 15 הוא קצב מפורש, לא נתמך כאן
  return { objectType, sampleRate: AAC_SAMPLE_RATES[idx], channels: take(4, 9) };
}

// ה־description שהמקודד נתן, אם הוא תקין ל־AAC-LC בקצב ובערוצים שביקשנו. אחרת נבנה אחד.
// ב־Safari 26 המקודד מחזיר תוכן של esds במקום AudioSpecificConfig (באג WebKit 302253), וה־MP4 יוצא שקט.
export function aacDescriptionFor(desc, sampleRate, channels) {
  const p = parseAacAsc(desc);
  if (p && p.objectType === 2 && p.sampleRate === sampleRate && p.channels === channels) return toU8(desc).slice();
  return makeAacAsc(sampleRate, channels);
}

// חבילת AAC עטופה ב־ADTS (מתחילה ב־0xFFF): מסירים את הכותרת (7 בייטים, או 9 עם CRC)
export function stripAdts(data) {
  if (data.length > 7 && data[0] === 0xff && (data[1] & 0xf0) === 0xf0) return data.subarray(data[1] & 1 ? 7 : 9);
  return data;
}

// גודל התמונה שמועברת ל־overlay כשמבקשים overlayFrame (קנה מידה 0.1..1, מידות זוגיות)
export function overlayFrameSize(width, height, scale = 1) {
  const s = clamp(Number(scale) || 1, 0.1, 1);
  return { w: Math.max(2, evenRound(width * s)), h: Math.max(2, evenRound(height * s)), scale: s };
}

// ───────────────────────── edit list לערוץ האודיו ─────────────────────────
// ל־mp4-muxer אין edit list. בלעדיו נגנים משמיעים את ה־priming של ה־AAC (20 עד 44 מ"ש של איחור),
// והשמטת פריימי ה־priming הורסת את הקול בתחילת הקובץ (חסר פריים חופף). לכן מוסיפים edts/elst סטנדרטי
// שאומר לנגן לדלג על ה־priming. הפונקציה משנה את הבייטים במקום (גדלים והיסטים של stco/co64)
// ומחזירה את מה שצריך להוסיף: {pos, insert}. הקובץ החדש הוא bytes[0..pos] + insert + bytes[pos..].
export function patchAudioEditList(u8, { primingSamples, audioFrames, sampleRate }) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const type = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  const box = (o, end) => {
    if (o + 8 > end) return null;
    let size = dv.getUint32(o);
    let hdr = 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(o + 8));
      hdr = 16;
    } else if (size === 0) size = end - o;
    if (size < hdr || o + size > end) return null;
    return { o, size, hdr, type: type(o + 4), end: o + size };
  };
  const children = (b) => {
    const out = [];
    for (let o = b.o + b.hdr; o < b.end; ) {
      const c = box(o, b.end);
      if (!c) break;
      out.push(c);
      o = c.end;
    }
    return out;
  };
  const find = (b, t) => children(b).find((c) => c.type === t) || null;

  let moov = null;
  for (let o = 0; o < u8.length; ) {
    const b = box(o, u8.length);
    if (!b) break;
    if (b.type === 'moov') moov = b;
    o = b.end;
  }
  if (!moov) return null;
  const traks = children(moov).filter((c) => c.type === 'trak');
  let audio = null;
  for (const t of traks) {
    const mdia = find(t, 'mdia');
    const hdlr = mdia && find(mdia, 'hdlr');
    if (hdlr && type(hdlr.o + hdlr.hdr + 8) === 'soun') audio = t;
  }
  if (!audio) return null;
  const tkhd = find(audio, 'tkhd');
  if (!tkhd || find(audio, 'edts')) return null;
  const mvhd = find(moov, 'mvhd');
  const movieTs = mvhd ? dv.getUint32(mvhd.o + mvhd.hdr + 12) : 1000;
  const segDur = Math.max(1, Math.round((audioFrames / sampleRate) * movieTs));

  // edts(36) = [edts hdr 8][elst hdr 8 + ver/flags 4 + count 4 + entry 12]
  const insert = new Uint8Array(36);
  const idv = new DataView(insert.buffer);
  idv.setUint32(0, 36);
  insert.set([0x65, 0x64, 0x74, 0x73], 4); // edts
  idv.setUint32(8, 28);
  insert.set([0x65, 0x6c, 0x73, 0x74], 12); // elst
  idv.setUint32(20, 1); // entry_count
  idv.setUint32(24, segDur); // segment_duration (בסקאלת הסרט)
  idv.setInt32(28, primingSamples); // media_time (בסקאלת המדיה = קצב הדגימה)
  idv.setUint16(32, 1); // media_rate_integer
  idv.setUint16(34, 0);
  const pos = tkhd.end;

  // מעדכנים לפני ההוספה, כי ההיסטים נמדדים בקובץ המקורי
  const shiftOffsets = (b) => {
    for (const t of traks) {
      const mdia = find(t, 'mdia');
      const minf = mdia && find(mdia, 'minf');
      const stbl = minf && find(minf, 'stbl');
      if (!stbl) continue;
      const stco = find(stbl, 'stco');
      const co64 = find(stbl, 'co64');
      if (stco) {
        const n = dv.getUint32(stco.o + stco.hdr + 4);
        for (let i = 0; i < n; i++) {
          const at = stco.o + stco.hdr + 8 + i * 4;
          const v = dv.getUint32(at);
          if (v >= b) dv.setUint32(at, v + insert.length);
        }
      }
      if (co64) {
        const n = dv.getUint32(co64.o + co64.hdr + 4);
        for (let i = 0; i < n; i++) {
          const at = co64.o + co64.hdr + 8 + i * 8;
          const v = dv.getBigUint64(at);
          if (v >= BigInt(b)) dv.setBigUint64(at, v + BigInt(insert.length));
        }
      }
    }
  };
  shiftOffsets(pos);
  dv.setUint32(audio.o, audio.size + insert.length);
  dv.setUint32(moov.o, moov.size + insert.length);

  // משכי הסרט והערוץ לפי האורך האמיתי (ללא ה־priming וללא ריפוד המקודד)
  if (mvhd && u8[mvhd.o + mvhd.hdr] === 0) {
    const cur = dv.getUint32(mvhd.o + mvhd.hdr + 16);
    let longest = 0;
    for (const t of traks) {
      const h = find(t, 'tkhd');
      if (h && u8[h.o + h.hdr] === 0 && t !== audio) longest = Math.max(longest, dv.getUint32(h.o + h.hdr + 20));
    }
    dv.setUint32(mvhd.o + mvhd.hdr + 16, Math.min(cur, Math.max(longest, segDur)));
  }
  if (u8[tkhd.o + tkhd.hdr] === 0) dv.setUint32(tkhd.o + tkhd.hdr + 20, segDur);
  return { pos, insert };
}

// ───────────────────────── MediaRecorder ─────────────────────────
const RECORDER_TYPES = [
  ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'mp4'],
  ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'mp4'],
  ['video/mp4', 'mp4'],
  ['video/webm;codecs=vp9,opus', 'webm'],
  ['video/webm;codecs=vp8,opus', 'webm'],
  ['video/webm', 'webm'],
];

// isSupported(mime) -> bool. מחזיר {mime, ext, container} או null
export function pickRecorderMime(isSupported) {
  for (const [mime, ext] of RECORDER_TYPES) {
    let ok = false;
    try {
      ok = !!isSupported(mime);
    } catch (_) {
      ok = false;
    }
    if (ok) return { mime, ext, container: ext };
  }
  return null;
}

export function extForMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('mp4') || m.includes('quicktime')) return 'mp4';
  if (m.includes('webm')) return 'webm';
  return 'bin';
}

// ───────────────────────── מקודד AAC ב־WASM (לדפדפנים בלי AudioEncoder) ─────────────────────────
let _aacMod = null;
export function loadWasmAac() {
  if (!_aacMod) {
    _aacMod = (async () => {
      const res = await fetch(AAC_WASM_URL);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const code = (await res.text()).replace(/import\.meta\.url/g, JSON.stringify(AAC_WASM_URL));
      const exp = {};
      new Function('exports', code)(exp);
      const mod = await exp.default({});
      const cw = (name, ret, args) => mod.cwrap(name, ret, args);
      return {
        mod,
        init: cw('init_encoder', 'number', ['number', 'number', 'number']),
        frameSize: cw('get_encoder_frame_size', 'number', ['number']),
        extra: cw('get_encoder_extradata', 'number', ['number']),
        extraSize: cw('get_encoder_extradata_size', 'number', ['number']),
        input: cw('get_encode_input_ptr', 'number', ['number', 'number']),
        send: cw('send_frame', 'number', ['number', 'number']),
        recv: cw('receive_packet', 'number', ['number']),
        flushStart: cw('flush_encoder_start', null, ['number']),
        data: cw('get_encoded_data', 'number', ['number']),
        dur: cw('get_encoded_duration', 'number', ['number']),
        close: cw('close_encoder', null, ['number']),
      };
    })().catch((e) => {
      _aacMod = null;
      throw heError(HE.libLoad, 'audio', e);
    });
  }
  return _aacMod;
}

// מקודד AAC-LC. encode(interleavedF32) מקבל בדיוק frameSize פריימים ומחזיר חבילות [{data, duration}].
// החבילה הראשונה היא ה־priming (1024 דגימות), ואותה משאירים: edit list יחתוך אותה בנגן.
export async function createWasmAacEncoder({ sampleRate, channels, bitrate }) {
  const w = await loadWasmAac();
  const ctx = w.init(channels, sampleRate, bitrate);
  if (!ctx) throw heError(HE.audioEncoder, 'audio');
  const frameSize = w.frameSize(ctx);
  const ptr = w.extra(ctx);
  const description = w.mod.HEAPU8.slice(ptr, ptr + w.extraSize(ctx));
  let nextPts = 0;
  const drain = () => {
    const out = [];
    for (let n = w.recv(ctx); n > 0; n = w.recv(ctx)) {
      const p = w.data(ctx);
      out.push({ data: w.mod.HEAPU8.slice(p, p + n), duration: w.dur(ctx) || frameSize });
    }
    return out;
  };
  return {
    frameSize,
    description,
    encode(interleaved) {
      const bytes = new Uint8Array(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength);
      const at = w.input(ctx, bytes.length);
      if (!at) throw heError(HE.audioEncoder, 'audio');
      w.mod.HEAPU8.set(bytes, at);
      const r = w.send(ctx, BigInt(nextPts));
      nextPts += frameSize;
      if (r < 0) throw heError(HE.audioEncoder, 'audio');
      return drain();
    },
    flush() {
      w.flushStart(ctx);
      return drain();
    },
    close() {
      try {
        w.close(ctx);
      } catch (_) {
        /* כבר נסגר */
      }
    },
  };
}

// ───────────────────────── דמוקס MP4 (mp4box.js, טעינה עצלה) ─────────────────────────
let _box = null;
export function loadMp4box() {
  if (!_box) {
    _box = import(/* @vite-ignore */ MP4BOX_URL).catch((e) => {
      _box = null;
      throw heError(HE.libLoad, 'cdn', e);
    });
  }
  return _box;
}

function boxDescription(M, entry) {
  const box = entry && (entry.avcC || entry.hvcC || entry.av1C || entry.vpcC);
  if (!box) return null;
  const stream = new M.DataStream(undefined, 0, M.DataStream.BIG_ENDIAN);
  box.write(stream);
  return new Uint8Array(stream.buffer, 8).slice(); // בלי כותרת הקופסה (8 בייטים)
}

function buildTable(mp4, track) {
  const trak = mp4.getTrackById(track.id);
  const samples = trak.samples || [];
  const n = samples.length;
  const ts = track.timescale;
  const offset = new Float64Array(n);
  const size = new Uint32Array(n);
  const cts = new Float64Array(n);
  const dts = new Float64Array(n);
  const sync = new Uint8Array(n);
  let nSync = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    offset[i] = s.offset;
    size[i] = s.size;
    cts[i] = s.cts / ts;
    dts[i] = s.dts / ts;
    if (s.is_sync) {
      sync[i] = 1;
      nSync++;
    }
  }
  const syncIdx = new Int32Array(nSync);
  for (let i = 0, k = 0; i < n; i++) if (sync[i]) syncIdx[k++] = i;

  // edit list: מסיט את ציר ההצגה (בדרך כלל הפרש B-frames של כמה פריימים)
  let shift = 0;
  let lead = 0;
  const entries = trak.edts && trak.edts.elst && trak.edts.elst.entries;
  if (entries && entries.length) {
    const mvTs = (mp4.moov && mp4.moov.mvhd && mp4.moov.mvhd.timescale) || 1000;
    for (const e of entries) {
      if (e.media_time === -1 || e.media_time === 4294967295) lead += e.segment_duration / mvTs;
      else {
        shift = e.media_time / ts;
        break;
      }
    }
  }
  return { count: n, offset, size, cts, dts, sync, syncIdx, shift: shift - lead, editShift: shift, lead };
}

// פותח קובץ MP4/MOV, קורא רק את ה־moov (מדלג על mdat) ומחזיר טבלאות דגימות
export async function openMp4(file, { signal } = {}) {
  const M = await loadMp4box();
  const mp4 = M.createFile();
  let info = null;
  let err = null;
  mp4.onReady = (i) => {
    info = i;
  };
  mp4.onError = (e) => {
    err = e;
  };
  const CH = 1024 * 1024;
  let pos = 0;
  for (let guard = 0; !info && !err && pos < file.size && guard < 100000; guard++) {
    throwIfAborted(signal);
    const end = Math.min(file.size, pos + CH);
    const buf = await file.slice(pos, end).arrayBuffer();
    buf.fileStart = pos;
    const next = mp4.appendBuffer(buf);
    if (info || err) break;
    pos = typeof next === 'number' && next > pos ? next : end;
  }
  if (!info) throw heError(HE.badFile, 'parse', err);
  const v = info.videoTracks && info.videoTracks[0];
  const a = info.audioTracks && info.audioTracks[0];
  // MP4 מקוטע (fragmented) אין בו טבלת דגימות ב־moov: משאירים ל־<video> לטפל בו
  if (v && !(v.nb_samples > 0) && !(mp4.getTrackById(v.id).samples || []).length) throw heError(HE.codecUnsupported, 'fragmented');
  const out = {
    mp4,
    info,
    duration: info.duration / info.timescale,
    brands: info.brands,
    video: null,
    audio: a ? { codec: a.codec, sampleRate: a.audio && a.audio.sample_rate, channels: a.audio && a.audio.channel_count } : null,
  };
  if (v) {
    const trak = mp4.getTrackById(v.id);
    const entry = trak.mdia.minf.stbl.stsd.entries[0];
    const rotation = rotationFromMatrix(trak.tkhd && trak.tkhd.matrix);
    const codedW = v.video.width;
    const codedH = v.video.height;
    const disp = rotatedSize(codedW, codedH, rotation);
    const table = buildTable(mp4, v);
    // קצב ממוצע לפי מרווחי זמן הפענוח (מדויק גם כשיש הסטה של B-frames ב־samples_duration)
    const dts = table.dts;
    const span = table.count > 1 ? dts[table.count - 1] - dts[0] : 0;
    const fps = span > 0 ? (table.count - 1) / span : table.count / (out.duration || 1);
    out.video = {
      id: v.id,
      codec: v.codec,
      codedW,
      codedH,
      dispW: disp.w,
      dispH: disp.h,
      rotation,
      fps: Number.isFinite(fps) && fps > 0 ? fps : 30,
      count: table.count,
      description: boxDescription(M, entry),
      table,
    };
  }
  return out;
}

// קורא דגימות מהקובץ בחלונות של כמה מגה־בייט (גישה סדרתית יעילה, בלי להחזיק את הקובץ בזיכרון)
export function createSampleReader(file, table, windowBytes = 2 * 1024 * 1024) {
  let start = -1;
  let end = -1;
  let buf = null;
  return {
    async get(i) {
      const off = table.offset[i];
      const size = table.size[i];
      if (!(off >= start && off + size <= end)) {
        const to = Math.min(file.size, off + Math.max(windowBytes, size));
        buf = new Uint8Array(await file.slice(off, to).arrayBuffer());
        start = off;
        end = to;
      }
      return buf.subarray(off - start, off - start + size);
    },
  };
}

// האינדקס של ה־keyframe האחרון שזמן ההצגה שלו ≤ m (זמן מדיה). אם אין, הראשון
export function keyframeBefore(table, m) {
  const idx = table.syncIdx;
  if (!idx.length) return 0;
  let lo = 0;
  let hi = idx.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (table.cts[idx[mid]] <= m + 1e-6) lo = mid;
    else hi = mid - 1;
  }
  return idx[lo];
}

// מינימום זמן הצגה מאינדקס i ואילך (בסדר פענוח). אומר מתי אפשר להפסיק להזין את המפענח
export function suffixMinCts(table) {
  const n = table.count;
  const out = new Float64Array(n + 1);
  out[n] = Infinity;
  for (let i = n - 1; i >= 0; i--) out[i] = Math.min(out[i + 1], table.cts[i]);
  return out;
}
