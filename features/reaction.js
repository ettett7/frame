// תגובה ודואט: מנגנים סרטון ומצלמים את עצמנו בסנכרון, ואז מרכיבים קובץ אחד שאפשר לתת ל־render.
//
//   const rx = startReaction(el, sourceFile, {layout:'split'});   // ממשק הקלטה
//   rx.onRecorded(async (selfBlob, info) => {
//     const r = await makeReaction(sourceFile, selfBlob, {layout:'split', offset: info.offset, selfDuration: info.duration});
//     // r = {file, plan, camera, overlay, audio, duration, ...}  ->  render({file: r.file, plan: r.plan, camera: r.camera, overlay: r.overlay, audio: ...})
//   });
//
// ===== החלטת תכנון: איך מעבירים שני מקורות ל־render, שמקבל קובץ אחד =====
// נבחרה ההרכבה לקובץ אחד, בזמן אמת: שני אלמנטי <video> מנוגנים בסנכרון, מצוירים על קנבס אחד לפי הפריסה
// (split = למעלה הסרטון ולמטה אני; pip = הסרטון במסך מלא ואני בעיגול בפינה), והקנבס נקלט עם MediaRecorder
// יחד עם הקול המעורבב (קול המשתמש מעל קול הסרטון המונמך). התוצאה היא קובץ וידאו רגיל עם אודיו.
// לכן plan הוא קטע אחד מלא, camera הוא 'fit' מלא, ו־overlay הוא פונקציה ריקה: אין מה לצייר מעל, הכול כבר בפנים.
//
// למה לא overlay שמצייר את הקובץ השני מתוך <video>?
//   ה־overlay של render הוא (ctx, tOut, frame) => void, סינכרוני. כדי להציג פריים מסוים של <video> צריך
//   להזיז את currentTime ולחכות ל־'seeked' (אסינכרוני), ובפועל זה איטי (עשרות אלפיות לכל פריים) ולא מדויק.
//   פענוח מראש של כל פריימי המצלמה לזיכרון לא מתאים לאייפון (עשרות או מאות מגה). לכן לא נבחר.
// המחיר של הבחירה: ההרכבה רצה בקצב אמת (קליפ של 30 שניות = 30 שניות המתנה, והלשונית חייבת להישאר גלויה),
// ויש דור נוסף של דחיסה. בתמורה היא פשוטה, עובדת בכל דפדפן עם MediaRecorder, והפלט הוא קובץ אחד עם קול,
// כך שתמלול, ניתוח אודיו וכתוביות עובדים עליו כרגיל.
// בנוסף מוחזר audio (AudioBuffer) עם התערובת, למי שמעדיף לרנדר אותה בנפרד ולא את הקול שבקובץ.

import { openCamera, stopStream, pickRecorderMime, MSG as TP_MSG } from './teleprompter.js';

export const RX_MSG = {
  badLayout: (l) => `מצב תצוגה לא מוכר: ${l}. אפשר split או pip.`,
  noDuration: 'לא הצלחנו לקרוא את משך הסרטון.',
  noRecorder: 'הרכבת תגובה דורשת הקלטה בדפדפן (MediaRecorder). עדכנו את הדפדפן ונסו שוב.',
  noSource: 'חסר סרטון מקור לתגובה.',
  noSelf: 'חסרה ההקלטה של המצלמה.',
  composing: 'מרכיבים את התגובה. השאירו את המסך פתוח.',
  headphones: 'מומלץ להשתמש באוזניות, כדי שקול הסרטון לא ייכנס להקלטה.',
  aborted: 'ההרכבה בוטלה.',
  sourceFailed: 'לא ניתן לנגן את סרטון המקור.',
};

// ------------------------------------------------------------------------------------------ גיאומטריה (טהור)

/**
 * חישוב מלבני המקור והיעד ל־ctx.drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh).
 * mode 'cover' ממלא את המלבן וחותך, 'contain' מכניס את כל התמונה עם פסים. focus = נקודת המיקוד בחיתוך (0..1).
 */
export function fitRect(srcW, srcH, dx, dy, dw, dh, mode = 'cover', focus = { x: 0.5, y: 0.5 }) {
  if (!(srcW > 0 && srcH > 0)) return { sx: 0, sy: 0, sw: 0, sh: 0, dx, dy, dw, dh };
  if (mode === 'contain') {
    const k = Math.min(dw / srcW, dh / srcH);
    const w = srcW * k, h = srcH * k;
    return { sx: 0, sy: 0, sw: srcW, sh: srcH, dx: dx + (dw - w) / 2, dy: dy + (dh - h) / 2, dw: w, dh: h };
  }
  const k = Math.max(dw / srcW, dh / srcH);
  const sw = dw / k, sh = dh / k;
  return { sx: (srcW - sw) * focus.x, sy: (srcH - sh) * focus.y, sw, sh, dx, dy, dw, dh };
}

/** חיתוך (cover) או פסים (contain): cover רק אם נשארים לפחות 75% מהתמונה. */
export function autoFit(srcW, srcH, slotW, slotH) {
  if (!(srcW > 0 && srcH > 0)) return 'contain';
  const a = srcW / srcH, b = slotW / slotH;
  return Math.min(a / b, b / a) >= 0.75 ? 'cover' : 'contain';
}

const even = (n) => Math.round(n / 2) * 2;

/**
 * פריסת התגובה על קנבס width x height (ברירת מחדל 1080x1920).
 * layout 'split': הסרטון למעלה, המצלמה למטה. 'pip': הסרטון על כל המסך, המצלמה בעיגול (או מלבן) בפינה.
 * opts: {sourceW, sourceH, selfW, selfH, sourceFit:'auto'|'cover'|'contain', topShare=0.5, pipCorner:'tl'|'tr'|'bl'|'br'='tl',
 *        pipScale=0.34, pipShape:'circle'|'rect'='circle', selfFocusY=0.38}
 * מחזיר {width, height, layout, source:{...fitRect, mode}, self:{...fitRect, shape, radius}, pip?}
 */
export function layoutRects(layout, opts = {}) {
  if (layout !== 'split' && layout !== 'pip') throw new Error(RX_MSG.badLayout(layout));
  const W = opts.width ?? 1080, H = opts.height ?? 1920;
  const sw = opts.sourceW || 1920, sh = opts.sourceH || 1080;
  const fw = opts.selfW || 1080, fh = opts.selfH || 1920;
  const focus = { x: 0.5, y: opts.selfFocusY ?? 0.38 };
  if (layout === 'split') {
    const share = Math.min(0.7, Math.max(0.3, opts.topShare ?? 0.5));
    const h1 = even(H * share);
    const mode = !opts.sourceFit || opts.sourceFit === 'auto' ? autoFit(sw, sh, W, h1) : opts.sourceFit;
    return {
      width: W, height: H, layout,
      source: { ...fitRect(sw, sh, 0, 0, W, h1, mode), mode },
      self: { ...fitRect(fw, fh, 0, h1, W, H - h1, 'cover', focus), mode: 'cover', shape: 'rect', radius: 0 },
      divider: { y: h1 },
    };
  }
  const mode = !opts.sourceFit || opts.sourceFit === 'auto' ? autoFit(sw, sh, W, H) : opts.sourceFit;
  const src = { ...fitRect(sw, sh, 0, 0, W, H, mode), mode };
  const full = mode === 'cover';
  const anchor = full ? { x: 0, y: 0, w: W, h: H } : { x: src.dx, y: src.dy, w: src.dw, h: src.dh };
  const d = even(Math.min(anchor.w, W) * (opts.pipScale ?? 0.34));
  const m = even(anchor.w * 0.04);
  const mTop = full ? even(H * 0.1) : m;            // במסך מלא משאירים מקום לסרגל העליון של האפליקציות
  const corner = opts.pipCorner || 'tl';
  const x = corner.endsWith('l') ? anchor.x + m : anchor.x + anchor.w - m - d;
  const y = corner.startsWith('t') ? anchor.y + mTop : anchor.y + anchor.h - m - d;
  const shape = opts.pipShape || 'circle';
  const pip = { x, y, w: d, h: d };
  return {
    width: W, height: H, layout, source: src, pip,
    self: { ...fitRect(fw, fh, x, y, d, d, 'cover', focus), mode: 'cover', shape, radius: shape === 'circle' ? d / 2 : Math.round(d * 0.12) },
  };
}

// ------------------------------------------------------------------------------------------ אודיו (טהור)

/**
 * ערבוב קול: קול המשתמש מעל קול הסרטון, והסרטון מונמך (ועוד יותר כשהמשתמש מדבר).
 * source / self = {channels:[Float32Array...], sampleRate} או null.
 * ציר הזמן של הפלט הוא ציר הסרטון: זמן פלט t = זמן סרטון t = זמן הקלטה t+offset.
 * offset חיובי = ההקלטה התחילה לפני הסרטון (מדלגים על ההתחלה שלה); שלילי = היא התחילה אחריו.
 * opts: {duration, sampleRate, offset, sourceGain=0.5, duckGain=0.2, selfGain=1, duck=true}
 * מחזיר {channels:[L,R], sampleRate, length, duration, numberOfChannels:2, peak, getChannelData(i)}
 */
export function mixReactionAudio({ source = null, self = null, offset = 0, duration, sampleRate, sourceGain = 0.5, duckGain = 0.2, selfGain = 1, duck = true } = {}) {
  const sr = sampleRate || source?.sampleRate || self?.sampleRate || 48000;
  let dur = duration;
  if (!(dur > 0)) dur = source ? source.channels[0].length / source.sampleRate : self ? self.channels[0].length / self.sampleRate - offset : 0;
  const n = Math.max(0, Math.round(dur * sr));
  const place = (clip, off) => {
    const outs = [new Float32Array(n), new Float32Array(n)];
    if (!clip || !clip.channels?.length) return outs;
    const ratio = clip.sampleRate / sr;
    clip.channels.slice(0, 2).forEach((data, c) => {
      const out = outs[c];
      const last = data.length - 1;
      for (let i = 0; i < n; i++) {
        const p = i * ratio + off * clip.sampleRate;
        if (p < 0 || p > last) { out[i] = 0; continue; }
        const i0 = Math.floor(p), f = p - i0;
        out[i] = f === 0 || i0 >= last ? data[i0] : data[i0] * (1 - f) + data[i0 + 1] * f;
      }
    });
    if (clip.channels.length === 1) outs[1].set(outs[0]);
    return outs;
  };
  const [sL, sR] = place(source, 0);
  const [fL, fR] = place(self, offset);

  // מעטפת קול המשתמש (RMS כל 10ms) -> בקרת הנמכה חלקה של הסרטון
  const hop = Math.max(1, Math.round(sr * 0.01));
  const blocks = Math.ceil(n / hop) + 1;
  const gate = new Float32Array(blocks);
  if (duck && self) {
    const atk = 1 - Math.exp(-0.01 / 0.03), rel = 1 - Math.exp(-0.01 / 0.35);
    let g = 0;
    for (let b = 0; b < blocks; b++) {
      const a = b * hop, e = Math.min(n, a + hop);
      let acc = 0;
      for (let i = a; i < e; i++) { const m = 0.5 * (fL[i] + fR[i]); acc += m * m; }
      const rms = e > a ? Math.sqrt(acc / (e - a)) : 0;
      const db = 20 * Math.log10(rms + 1e-9);
      const x = Math.min(1, Math.max(0, (db + 48) / 12));
      const target = x * x * (3 - 2 * x);
      g += (target - g) * (target > g ? atk : rel);
      gate[b] = g;
    }
  }
  const L = new Float32Array(n), R = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const b = Math.floor(i / hop), f = (i - b * hop) / hop;
    const g = duck ? gate[b] * (1 - f) + gate[Math.min(blocks - 1, b + 1)] * f : 0;
    const sg = sourceGain + (duckGain - sourceGain) * g;
    const l = sL[i] * sg + fL[i] * selfGain;
    const r = sR[i] * sg + fR[i] * selfGain;
    L[i] = l; R[i] = r;
    const m = Math.max(Math.abs(l), Math.abs(r));
    if (m > peak) peak = m;
  }
  if (peak > 0.98) {                                  // הגנה מפני קליפינג: מקטינים הכול ביחס אחד
    const k = 0.98 / peak;
    for (let i = 0; i < n; i++) { L[i] *= k; R[i] *= k; }
    peak = 0.98;
  }
  const channels = [L, R];
  return { channels, sampleRate: sr, length: n, duration: n / sr, numberOfChannels: 2, peak, getChannelData: (i) => channels[i] };
}

/** ממיר את התערובת ל־AudioBuffer אם יש בסביבה (דפדפן), אחרת מחזיר את האובייקט כמו שהוא (node). */
export function toAudioBuffer(mix, AB = globalThis.AudioBuffer) {
  if (!AB || !mix.length) return mix;
  try {
    const buf = new AB({ length: mix.length, sampleRate: mix.sampleRate, numberOfChannels: 2 });
    buf.copyToChannel(mix.channels[0], 0);
    buf.copyToChannel(mix.channels[1], 1);
    return buf;
  } catch { return mix; }
}

// ------------------------------------------------------------------------------------------ plan / camera / overlay (טהור)

/** Plan של קובץ התגובה: קטע אחד מלא. */
export function reactionPlan(duration) {
  const d = Math.round(duration * 1000) / 1000;
  return { segments: [[0, d]], duration: d, removed: 0 };
}

/** Camera מזהה: הקובץ כבר מורכב ואנכי, אז ה־render רק מכניס אותו (fit) בלי מסגור. */
export function reactionCamera() {
  return { layout: 'fit', rectAt: () => ({ x: 0, y: 0, w: 1, h: 1 }), cuts: [] };
}

/** overlay ריק (החוזה דורש פונקציה): ההרכבה כבר בתוך הקובץ. */
export function reactionOverlay() {
  const f = () => {};
  f.noop = true;
  return f;
}

/** היסט סנכרון בשניות: כמה זמן אחרי תחילת ההקלטה התחיל הסרטון להתנגן. */
export function computeOffset({ recorderStartMs, playingMs, latencyMs = 0 }) {
  return Math.round(((playingMs - recorderStartMs) - latencyMs)) / 1000;
}

// ------------------------------------------------------------------------------------------ בדיקת מדיה ופענוח אודיו (דפדפן)

function newVideo(doc, blob, attach = true) {
  const v = doc.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.preload = 'auto';
  v.crossOrigin = 'anonymous';
  v.src = URL.createObjectURL(blob);
  if (attach) {
    v.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:.01;pointer-events:none';
    doc.body.appendChild(v);
  }
  return v;
}
function disposeVideo(v) {
  try { v.pause(); } catch { /* אין */ }
  const u = v.src;
  v.removeAttribute('src');
  try { v.load(); } catch { /* אין */ }
  if (u?.startsWith('blob:')) URL.revokeObjectURL(u);
  v.remove();
}
const once = (target, ev, ms = 15000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { target.removeEventListener(ev, ok); target.removeEventListener('error', bad); reject(new Error(RX_MSG.sourceFailed)); }, ms);
  const ok = () => { clearTimeout(t); target.removeEventListener('error', bad); resolve(); };
  const bad = () => { clearTimeout(t); target.removeEventListener(ev, ok); reject(new Error(RX_MSG.sourceFailed)); };
  target.addEventListener(ev, ok, { once: true });
  target.addEventListener('error', bad, { once: true });
});

/** משך ומידות של קובץ וידאו. כולל תיקון למשך אינסופי של webm שנקלט בדפדפן. */
export async function probeMedia(file, { fallbackDuration } = {}) {
  const v = newVideo(document, file);
  try {
    if (v.readyState < 1) await once(v, 'loadedmetadata');
    let d = v.duration;
    if (!Number.isFinite(d)) {                          // MediaRecorder של Chrome לא כותב משך: קופצים לסוף כדי שהדפדפן יחשב
      v.currentTime = 1e7;
      await once(v, 'durationchange', 4000).catch(() => {});
      d = Number.isFinite(v.duration) ? v.duration : fallbackDuration;
    }
    return { duration: d, width: v.videoWidth, height: v.videoHeight };
  } finally { disposeVideo(v); }
}

/** מפענח את האודיו של קובץ או Blob ל־{channels, sampleRate} (48kHz). null אם אין אודיו או שהפענוח נכשל. */
export async function decodeAudio(blob) {
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OAC) return null;
  try {
    const ab = await blob.arrayBuffer();
    const ctx = new OAC(2, 1, 48000);
    const buf = await ctx.decodeAudioData(ab);
    const channels = [];
    for (let i = 0; i < Math.min(2, buf.numberOfChannels); i++) channels.push(buf.getChannelData(i).slice());
    return { channels, sampleRate: buf.sampleRate };
  } catch { return null; }
}

// ------------------------------------------------------------------------------------------ הרכבה בזמן אמת (דפדפן)

/** יוצר AudioContext ומנסה להפעיל אותו מיד. חייבים לקרוא לזה בתוך המחווה של המשתמש (לפני await), במיוחד ב־iOS. */
export function createAudioContext() {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return null;
  try {
    const ac = new AC();
    ac.resume?.().catch(() => {});
    return ac;
  } catch { return null; }
}

function drawFrame(ctx, vs, vf, rects, o) {
  const { width: W, height: H } = rects;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const s = rects.source;
  if (vs.readyState >= 2 && s.sw > 0) ctx.drawImage(vs, s.sx, s.sy, s.sw, s.sh, s.dx, s.dy, s.dw, s.dh);
  const f = rects.self;
  const live = vf.readyState >= 2 && o.selfVisible();
  if (live) {
    // יחס המקור של המצלמה נקבע לפי המידות בפועל של הווידאו, שעשויות להשתנות מהמידות שנבדקו
    const fr = fitRect(vf.videoWidth, vf.videoHeight, f.dx, f.dy, f.dw, f.dh, 'cover', { x: 0.5, y: 0.38 });
    ctx.save();
    ctx.beginPath();
    if (f.shape === 'circle') ctx.arc(f.dx + f.dw / 2, f.dy + f.dh / 2, f.dw / 2, 0, Math.PI * 2);
    else if (f.radius > 0 && ctx.roundRect) ctx.roundRect(f.dx, f.dy, f.dw, f.dh, f.radius);
    else ctx.rect(f.dx, f.dy, f.dw, f.dh);
    ctx.clip();
    if (o.mirrorSelf) { ctx.translate(f.dx + f.dw / 2, 0); ctx.scale(-1, 1); ctx.translate(-(f.dx + f.dw / 2), 0); }
    ctx.drawImage(vf, fr.sx, fr.sy, fr.sw, fr.sh, f.dx, f.dy, f.dw, f.dh);
    ctx.restore();
  }
  if (rects.layout === 'pip') {
    ctx.save();
    ctx.lineWidth = Math.max(4, W * 0.006);
    ctx.strokeStyle = '#fff';
    ctx.shadowColor = 'rgba(0,0,0,.5)';
    ctx.shadowBlur = 18;
    ctx.beginPath();
    if (f.shape === 'circle') ctx.arc(f.dx + f.dw / 2, f.dy + f.dh / 2, f.dw / 2, 0, Math.PI * 2);
    else if (ctx.roundRect) ctx.roundRect(f.dx, f.dy, f.dw, f.dh, f.radius);
    else ctx.rect(f.dx, f.dy, f.dw, f.dh);
    ctx.stroke();
    ctx.restore();
  } else if (rects.divider) {
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.fillRect(0, rects.divider.y - 2, W, 4);
  }
}

/**
 * מרכיב את שני הסרטונים לקובץ אחד בזמן אמת: קנבס + MediaRecorder + קול מעורבב.
 * חייב לרוץ בלשונית גלויה. מומלץ להפעיל מתוך לחיצה (מחווה של משתמש), כדי ש־AudioContext יתחיל ב־iOS.
 * מחזיר {blob, audioEmbedded}.
 */
export async function composeRealtime({ sourceFile, selfBlob, rects, duration, offset = 0, audio, fps = 30, onProgress, signal, mimeType, mirrorSelf = false, audioContext, MediaRecorder: MRInject }) {
  const doc = document;
  const MR = MRInject || globalThis.MediaRecorder;
  if (!MR) throw new Error(RX_MSG.noRecorder);
  const abortErr = () => { const e = new Error(RX_MSG.aborted); e.name = 'AbortError'; return e; };
  if (signal?.aborted) throw abortErr();

  const ownsAudio = !audioContext;
  const ac = audioContext || createAudioContext();      // עדיף לקבל מבחוץ: נוצר בתוך המחווה של המשתמש

  const vs = newVideo(doc, sourceFile);
  const vf = newVideo(doc, selfBlob);
  let timer = 0, recorder = null, cleaned = false;
  const cv = doc.createElement('canvas');
  cv.width = rects.width; cv.height = rects.height;
  const ctx = cv.getContext('2d', { alpha: false });
  const cleanup = (stopRec = true) => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(timer);
    if (stopRec) try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch { /* כבר נעצר */ }
    disposeVideo(vs); disposeVideo(vf);
    if (ownsAudio) { try { ac?.close(); } catch { /* אין */ } }
  };
  try {
    await Promise.all([vs.readyState >= 2 ? 0 : once(vs, 'loadeddata'), vf.readyState >= 2 ? 0 : once(vf, 'loadeddata')]);
    const seek = async (v, t) => { if (Math.abs(v.currentTime - t) < 0.02) return; v.currentTime = t; await once(v, 'seeked', 8000).catch(() => {}); };
    await Promise.all([seek(vs, 0), seek(vf, Math.max(0, offset))]);
    const selfVisibleAt = { t: 0 };
    const drawOpts = { mirrorSelf, selfVisible: () => selfVisibleAt.t >= 0 };
    drawFrame(ctx, vs, vf, rects, drawOpts);

    const vstream = cv.captureStream(fps);
    let audioEmbedded = false;
    let srcNode = null;
    if (ac && audio?.length) {
      try {
        const dest = ac.createMediaStreamDestination();
        const buf = ac.createBuffer(2, audio.length, audio.sampleRate);
        buf.copyToChannel(audio.channels[0], 0);
        buf.copyToChannel(audio.channels[1], 1);
        srcNode = ac.createBufferSource();
        srcNode.buffer = buf;
        srcNode.connect(dest);
        dest.stream.getAudioTracks().forEach((t) => vstream.addTrack(t));
        audioEmbedded = vstream.getAudioTracks().length > 0;
      } catch { audioEmbedded = false; }
    }
    const mt = mimeType || pickRecorderMime(MR, { audio: audioEmbedded });
    const ropts = { videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 160_000 };
    if (mt) ropts.mimeType = mt;
    try { recorder = new MR(vstream, ropts); } catch { recorder = new MR(vstream); }
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    const started = new Promise((resolve, reject) => { recorder.onstart = resolve; recorder.onerror = (e) => reject(e?.error || new Error(RX_MSG.noRecorder)); });
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    recorder.start(500);
    await started;

    const t0 = performance.now();
    if (ac && ac.state === 'suspended') { try { await ac.resume(); } catch { /* מחווה חסרה */ } }
    if (srcNode) { if (ac.state === 'running') srcNode.start(); else audioEmbedded = false; }
    vs.play().catch(() => {});
    if (offset >= 0) vf.play().catch(() => {});
    let lastFix = 0;
    await new Promise((resolve, reject) => {
      let busy = false;
      const tick = () => {
        if (busy) return;
        busy = true;
        try {
          if (signal?.aborted) { reject(abortErr()); return; }
          const t = (performance.now() - t0) / 1000;
          selfVisibleAt.t = t + offset;
          if (offset < 0 && vf.paused && t >= -offset) vf.play().catch(() => {});
          if (t - lastFix > 0.5) {                      // תיקון סחיפה: הסרטון הוא השעון, המצלמה הולכת אחריו
            lastFix = t;
            if (Math.abs(vs.currentTime - t) > 0.15 && !vs.ended && t < vs.duration) vs.currentTime = t;
            const ft = t + offset;
            if (ft >= 0 && Math.abs(vf.currentTime - ft) > 0.15 && !vf.ended) vf.currentTime = ft;
          }
          drawFrame(ctx, vs, vf, rects, drawOpts);
          onProgress?.(Math.min(1, t / duration), RX_MSG.composing);
          if (t >= duration) resolve();
        } catch (e) { reject(e); } finally { busy = false; }
      };
      timer = setInterval(tick, 1000 / fps);
    });
    clearInterval(timer);
    vs.pause(); vf.pause();
    recorder.stop();
    await stopped;
    const blob = new Blob(chunks, { type: recorder.mimeType || mt || 'video/webm' });
    cleanup(false);
    if (!blob.size) throw new Error('ההרכבה יצאה ריקה. נסו שוב.');
    onProgress?.(1, 'התגובה מוכנה');
    return { blob, audioEmbedded };
  } catch (e) { cleanup(true); throw e; }
}

// ------------------------------------------------------------------------------------------ makeReaction

/**
 * מרכיב תגובה או דואט מסרטון מקור והקלטת מצלמה.
 * opts: {layout:'split'|'pip'='split', offset=0, selfDuration, duration, width=1080, height=1920, fps=30,
 *        sourceGain=0.5, duckGain=0.2, selfGain=1, duck=true, mirrorSelf=false, layoutOptions, onProgress, signal,
 *        probe(file)->{duration,width,height}, decodeAudio(blob)->{channels,sampleRate}|null, compose(args)->Blob|{blob,audioEmbedded}  (להזרקה בבדיקות)}
 * מחזיר {file, plan, camera, overlay, audio, duration, layout, offset, rects, audioEmbedded, method, sourceDuration, selfDuration}.
 */
export async function makeReaction(sourceFile, selfBlob, opts = {}) {
  if (!sourceFile) throw new Error(RX_MSG.noSource);
  if (!selfBlob) throw new Error(RX_MSG.noSelf);
  const layout = opts.layout || 'split';
  if (layout !== 'split' && layout !== 'pip') throw new Error(RX_MSG.badLayout(layout));
  const offset = Number.isFinite(opts.offset) ? opts.offset : 0;
  const width = opts.width ?? 1080, height = opts.height ?? 1920, fps = opts.fps ?? 30;
  const { onProgress, signal } = opts;
  const abort = () => { if (signal?.aborted) { const e = new Error(RX_MSG.aborted); e.name = 'AbortError'; throw e; } };
  abort();
  const audioContext = opts.audioContext ?? (opts.compose ? null : createAudioContext());   // לפני כל await: בתוך המחווה של המשתמש
  try {
    return await build();
  } finally {
    if (!opts.audioContext) { try { audioContext?.close(); } catch { /* אין */ } }
  }

  async function build() {

  const probe = opts.probe || probeMedia;
  onProgress?.(0, 'בודקים את הקבצים');
  const [src, self] = await Promise.all([probe(sourceFile), probe(selfBlob, { fallbackDuration: opts.selfDuration })]);
  abort();
  if (!Number.isFinite(src?.duration) || src.duration <= 0) throw new Error(RX_MSG.noDuration);
  const selfDuration = Number.isFinite(self?.duration) && self.duration > 0 ? self.duration : opts.selfDuration;
  const duration = Math.min(opts.duration ?? src.duration, src.duration);

  const decode = opts.decodeAudio || decodeAudio;
  onProgress?.(0, 'מערבבים את הקול');
  const [sAud, fAud] = await Promise.all([decode(sourceFile), decode(selfBlob)]);
  abort();
  const mix = mixReactionAudio({ source: sAud, self: fAud, offset, duration, sourceGain: opts.sourceGain, duckGain: opts.duckGain, selfGain: opts.selfGain, duck: opts.duck });
  const rects = layoutRects(layout, { width, height, sourceW: src.width, sourceH: src.height, selfW: self?.width, selfH: self?.height, ...opts.layoutOptions });

  const compose = opts.compose || composeRealtime;
  const out = await compose({ sourceFile, selfBlob, rects, duration, offset, audio: mix, fps, onProgress, signal, mirrorSelf: !!opts.mirrorSelf, mimeType: opts.mimeType, audioContext });
  abort();
  const blob = out?.blob ?? out;
  const audioEmbedded = out?.audioEmbedded ?? false;
  const type = blob.type || 'video/mp4';
  const ext = /mp4/i.test(type) ? 'mp4' : /webm/i.test(type) ? 'webm' : 'mp4';
  const file = typeof File !== 'undefined' && blob instanceof File ? blob : new File([blob], `reaction.${ext}`, { type });

  return {
    file, plan: reactionPlan(duration), camera: reactionCamera(), overlay: reactionOverlay(),
    audio: toAudioBuffer(mix), duration, layout, offset, rects, audioEmbedded,
    method: 'composite-realtime', sourceDuration: src.duration, selfDuration,
  };
  }
}

// ------------------------------------------------------------------------------------------ startReaction (ממשק הקלטה)

const RX_STYLE_ID = 'frame-rx-style';
const RX_CSS = `
.frame-rx-root{position:relative;display:block;overflow:hidden;background:#000;min-height:320px;height:100%;color:#fff;font-family:Heebo,Rubik,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none;touch-action:manipulation}
.frame-rx-root *{box-sizing:border-box}
.frame-rx-root .rx{position:absolute;inset:0}
.frame-rx-root video{position:absolute;background:#0b0b10;object-fit:cover}
.frame-rx-root .rx-src{left:0;right:0;top:0;height:50%;object-fit:contain;background:#000}
.frame-rx-root .rx-cam{left:0;right:0;bottom:0;height:50%;transform:scaleX(-1)}
.frame-rx-root.rx-pip .rx-src{height:100%}
.frame-rx-root.rx-pip .rx-cam{left:auto;right:auto;bottom:auto;inset-inline-start:14px;top:calc(env(safe-area-inset-top,0px) + 70px);width:34%;aspect-ratio:1;height:auto;border-radius:50%;border:3px solid #fff;box-shadow:0 4px 18px rgba(0,0,0,.5)}
.frame-rx-root .rx-line{position:absolute;left:0;right:0;top:50%;height:3px;background:rgba(255,255,255,.85);transform:translateY(-1.5px);pointer-events:none}
.frame-rx-root.rx-pip .rx-line{display:none}
.frame-rx-root button{font:inherit;color:#fff;border:0;cursor:pointer;touch-action:manipulation}
.frame-rx-root .rx-top{position:absolute;top:0;left:0;right:0;display:flex;justify-content:space-between;align-items:center;padding:calc(env(safe-area-inset-top,0px) + 10px) 12px 8px;z-index:3;pointer-events:none}
.frame-rx-root .rx-chip{min-width:84px;height:36px;padding:0 12px;border-radius:18px;background:rgba(30,30,38,.8);display:flex;align-items:center;justify-content:center;gap:8px;font-size:15px;font-weight:700;font-variant-numeric:tabular-nums}
.frame-rx-root .rx-chip i{width:10px;height:10px;border-radius:50%;background:#777;display:inline-block}
.frame-rx-root.rx-rec .rx-chip i{background:#ff3b30;animation:rx-blink 1s steps(2,start) infinite}
@keyframes rx-blink{50%{opacity:.15}}
.frame-rx-root .rx-bottom{position:absolute;left:0;right:0;bottom:0;display:flex;flex-direction:column;align-items:center;gap:8px;padding:10px 16px calc(env(safe-area-inset-bottom,0px) + 16px);z-index:3;background:linear-gradient(180deg,transparent,rgba(0,0,0,.55))}
.frame-rx-root .rx-hint{font-size:14px;opacity:.9;text-align:center;text-shadow:0 1px 6px #000}
.frame-rx-root .rx-rec-btn{width:88px;height:88px;border-radius:50%;background:transparent;border:5px solid #fff;display:grid;place-items:center;padding:0}
.frame-rx-root .rx-rec-btn span{width:62px;height:62px;border-radius:50%;background:#ff3b30;transition:border-radius .18s,width .18s,height .18s}
.frame-rx-root.rx-rec .rx-rec-btn span,.frame-rx-root.rx-counting .rx-rec-btn span{width:34px;height:34px;border-radius:8px}
.frame-rx-root .rx-count{position:absolute;inset:0;display:none;align-items:center;justify-content:center;font-size:min(46vw,220px);font-weight:900;z-index:6;background:rgba(0,0,0,.4);text-shadow:0 4px 24px rgba(0,0,0,.8)}
.frame-rx-root.rx-counting .rx-count{display:flex}
.frame-rx-root .rx-toast{position:absolute;left:50%;top:calc(env(safe-area-inset-top,0px) + 62px);transform:translateX(-50%);max-width:88%;padding:10px 18px;border-radius:20px;background:rgba(20,20,26,.92);font-size:16px;font-weight:700;text-align:center;opacity:0;transition:opacity .2s;pointer-events:none;z-index:5}
.frame-rx-root .rx-toast.on{opacity:1}
.frame-rx-root .rx-err{position:absolute;left:16px;right:16px;top:30%;display:none;padding:18px;border-radius:18px;background:rgba(40,16,16,.94);border:1px solid #ff6b60;text-align:center;font-size:18px;line-height:1.5;z-index:7}
.frame-rx-root .rx-err.on{display:block}
.frame-rx-root .rx-err button{margin-top:12px;min-height:52px;padding:0 24px;border-radius:26px;background:#fff;color:#111;font-size:17px;font-weight:800}
@media (prefers-reduced-motion:reduce){.frame-rx-root.rx-rec .rx-chip i{animation:none}.frame-rx-root .rx-rec-btn span{transition:none}}
`;

/**
 * ממשק הקלטת תגובה: מנגן את sourceFile ומקליט את המצלמה הקדמית והמיקרופון יחד.
 * opts: {layout:'split'|'pip'='split', countdown=3, getStream, MediaRecorder, mimeType, latencyMs=0, endGraceMs=400}
 * מחזיר {start, stop, destroy, onRecorded, ready, getState}.
 * onRecorded(selfBlob, info): info = {offset, duration, sourceDuration, endedBy:'source'|'manual', mimeType, width, height}
 *   offset = כמה שניות אחרי תחילת ההקלטה התחיל הסרטון (מועבר ל־makeReaction).
 * הערה: ההקלטה היא של המצלמה והמיקרופון בלבד. אם הסרטון מתנגן ברמקול, הקול שלו ייכנס למיקרופון, ולכן מומלצות אוזניות.
 */
export function startReaction(el, sourceFile, opts = {}) {
  if (!el) throw new Error('חסר אלמנט להצבת הממשק.');
  if (!sourceFile) throw new Error(RX_MSG.noSource);
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  if (!doc.getElementById(RX_STYLE_ID)) { const st = doc.createElement('style'); st.id = RX_STYLE_ID; st.textContent = RX_CSS; doc.head.appendChild(st); }
  const MR = 'MediaRecorder' in opts ? opts.MediaRecorder : win.MediaRecorder;
  const layout = opts.layout === 'pip' ? 'pip' : 'split';
  const countdown = Math.max(0, Math.min(10, Math.round(opts.countdown ?? 3)));

  const mk = (tag, attrs = {}, ...kids) => {
    const e = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) { if (v === undefined || v === false) continue; if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else e.setAttribute(k, v === true ? '' : v); }
    kids.forEach((c) => c && e.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c));
    return e;
  };
  el.classList.add('frame-rx-root', layout === 'pip' ? 'rx-pip' : 'rx-split');
  const root = mk('div', { class: 'rx' });
  root.style.cssText = 'position:absolute;inset:0';
  const src = mk('video', { class: 'rx-src', playsinline: true, preload: 'auto' });
  const cam = mk('video', { class: 'rx-cam', playsinline: true, muted: true, autoplay: true, 'aria-hidden': 'true' });
  cam.muted = true;
  const srcUrl = URL.createObjectURL(sourceFile);
  src.src = srcUrl;
  const chipTime = mk('span', { text: '00:00' });
  const chip = mk('div', { class: 'rx-chip' }, mk('i'), chipTime);
  const recBtn = mk('button', { type: 'button', class: 'rx-rec-btn', 'aria-label': 'התחלת הקלטה' }, mk('span'));
  const hint = mk('div', { class: 'rx-hint', text: RX_MSG.headphones });
  const bottom = mk('div', { class: 'rx-bottom' }, hint, recBtn);
  const toast = mk('div', { class: 'rx-toast', role: 'status', 'aria-live': 'polite' });
  const countEl = mk('div', { class: 'rx-count', 'aria-live': 'assertive' });
  const errText = mk('div');
  const errRetry = mk('button', { type: 'button', text: 'נסו שוב' });
  const errEl = mk('div', { class: 'rx-err', role: 'alert' }, errText, errRetry);
  root.append(src, cam, mk('div', { class: 'rx-line' }), mk('div', { class: 'rx-top' }, mk('span'), chip), bottom, toast, countEl, errEl);
  el.appendChild(root);

  let state = 'idle';                    // idle | countdown | recording
  let stream = null, rec = null, chunks = [];
  let recStartMs = 0, offsetSec = 0, countTimer = 0, tick = 0, toastTimer = 0, countCancel = null, destroyed = false, endTimer = 0;
  const listeners = new Set();
  if (typeof opts.onRecorded === 'function') listeners.add(opts.onRecorded);

  const say = (msg, ms = 1800) => { toast.textContent = msg; toast.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('on'), ms); };
  const showError = (msg) => { errText.textContent = msg; errEl.classList.add('on'); };

  let camPromise = null;
  const ensureStream = () => {
    if (stream && stream.getTracks().some((t) => t.readyState === 'live')) return Promise.resolve(stream);
    if (camPromise) return camPromise;
    errEl.classList.remove('on');
    camPromise = openCamera({ getStream: opts.getStream }).then(async (s) => {
      if (destroyed) { stopStream(s); throw new Error('הרכיב נסגר.'); }
      stream = s; cam.srcObject = s;
      try { await cam.play(); } catch { /* תוצג בלחיצה */ }
      return s;
    }).catch((e) => { showError(e.message); throw e; }).finally(() => { camPromise = null; });
    return camPromise;
  };
  errRetry.addEventListener('click', () => { ensureStream().catch(() => {}); });

  const chipUpdate = () => {
    const s = state === 'recording' ? Math.floor((performance.now() - recStartMs) / 1000) : 0;
    chipTime.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  const countdownRun = (n) => new Promise((resolve) => {
    if (n <= 0) { resolve(true); return; }
    el.classList.add('rx-counting');
    let i = n;
    const step = () => {
      countEl.textContent = String(i);
      i -= 1;
      if (i < 0) { el.classList.remove('rx-counting'); countEl.textContent = ''; resolve(true); return; }
      countTimer = setTimeout(step, 1000);
    };
    countCancel = () => { clearTimeout(countTimer); el.classList.remove('rx-counting'); countEl.textContent = ''; resolve(false); };
    step();
  });

  async function finishRecording(endedBy) {
    if (state !== 'recording' || !rec) return null;
    clearInterval(tick); clearTimeout(endTimer);
    const duration = (performance.now() - recStartMs) / 1000;
    state = 'idle';
    el.classList.remove('rx-rec');
    recBtn.setAttribute('aria-label', 'התחלת הקלטה');
    try { src.pause(); } catch { /* אין */ }
    const r = rec; rec = null;
    const type = r.mimeType || opts.mimeType || '';
    await new Promise((resolve) => { r.onstop = resolve; try { r.stop(); } catch { resolve(); } });
    chipTime.textContent = '00:00';
    const blob = new Blob(chunks, { type }); chunks = [];
    if (!blob.size) { showError(TP_MSG.emptyRecording); throw new Error(TP_MSG.emptyRecording); }
    const vt = stream?.getVideoTracks?.()[0]?.getSettings?.() || {};
    const info = { offset: offsetSec, duration, sourceDuration: Number.isFinite(src.duration) ? src.duration : null, endedBy, mimeType: blob.type || type, width: vt.width || 0, height: vt.height || 0 };
    say('ההקלטה מוכנה', 2200);
    for (const cb of [...listeners]) { try { cb(blob, info); } catch (e) { console.error(e); } }
    return blob;
  }

  const api = {
    /** מקליט את המצלמה ומנגן את הסרטון בסנכרון. מחזיר true כשההקלטה התחילה, או null אם בוטלה. */
    async start() {
      if (destroyed || state !== 'idle') return null;
      if (!MR) { showError(TP_MSG.noRecorder); throw new Error(TP_MSG.noRecorder); }
      // "חימום" של הסרטון בתוך המחווה של המשתמש (חשוב ל־iOS): מנגנים מושתק ועוצרים מיד
      src.muted = true;
      const prime = src.play().then(() => { src.pause(); }).catch(() => {});
      const s = await ensureStream();
      await prime;
      state = 'countdown';
      el.classList.add('rx-counting');
      const ok = await countdownRun(countdown);
      if (!ok || destroyed) { state = 'idle'; return null; }
      try { if (src.readyState < 3) await once(src, 'canplay', 10000); } catch { state = 'idle'; showError(RX_MSG.sourceFailed); throw new Error(RX_MSG.sourceFailed); }
      src.currentTime = 0;
      await new Promise((r) => { if (src.seeking) src.addEventListener('seeked', r, { once: true }); else r(); });
      const mimeType = opts.mimeType || pickRecorderMime(MR);
      const ro = { videoBitsPerSecond: opts.videoBitsPerSecond || 5_000_000, audioBitsPerSecond: 128_000 };
      if (mimeType) ro.mimeType = mimeType;
      try { rec = new MR(s, ro); } catch { try { rec = new MR(s); } catch { state = 'idle'; showError(TP_MSG.noRecorder); throw new Error(TP_MSG.noRecorder); } }
      chunks = [];
      rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
      await new Promise((resolve, reject) => { rec.onstart = () => resolve(); rec.onerror = (e) => reject(e?.error || new Error(TP_MSG.noRecorder)); try { rec.start(1000); } catch (e) { reject(e); } })
        .catch(() => { state = 'idle'; showError(TP_MSG.noRecorder); throw new Error(TP_MSG.noRecorder); });
      const tRec = performance.now();
      recStartMs = tRec;
      state = 'recording';
      el.classList.remove('rx-counting');
      el.classList.add('rx-rec');
      recBtn.setAttribute('aria-label', 'עצירת הקלטה');
      src.muted = false;
      const playing = new Promise((r) => src.addEventListener('playing', () => r(performance.now()), { once: true }));   // רגע תחילת הניגון בפועל, לא רגע סיום ה־await
      try { await src.play(); } catch { src.muted = true; await src.play().catch(() => {}); say('הסרטון מנגן בלי קול. נגעו במסך כדי להפעיל קול.', 3000); }
      const playedAt = await Promise.race([playing, new Promise((r) => setTimeout(() => r(performance.now()), 1500))]);
      offsetSec = computeOffset({ recorderStartMs: tRec, playingMs: playedAt, latencyMs: opts.latencyMs ?? 0 });
      src.onended = () => { endTimer = setTimeout(() => { finishRecording('source').catch(() => {}); }, opts.endGraceMs ?? 400); };
      clearInterval(tick);
      tick = setInterval(chipUpdate, 250);
      chipUpdate();
      return true;
    },
    async stop() {
      if (state === 'countdown') { countCancel?.(); state = 'idle'; return null; }
      return finishRecording('manual');
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      countCancel?.();
      clearInterval(tick); clearTimeout(endTimer); clearTimeout(toastTimer);
      try { if (rec && rec.state !== 'inactive') { rec.onstop = null; rec.stop(); } } catch { /* כבר נעצר */ }
      try { src.pause(); } catch { /* אין */ }
      stopStream(stream);
      cam.srcObject = null;
      src.removeAttribute('src');
      URL.revokeObjectURL(srcUrl);
      listeners.clear();
      root.remove();
      el.classList.remove('frame-rx-root', 'rx-pip', 'rx-split', 'rx-rec', 'rx-counting');
    },
    onRecorded(cb) { if (typeof cb !== 'function') return () => {}; listeners.add(cb); return () => listeners.delete(cb); },
    ready: null,
    getState() { return { state, layout, offset: offsetSec, hasStream: !!stream, sourceDuration: Number.isFinite(src.duration) ? src.duration : null }; },
  };
  recBtn.addEventListener('click', () => {
    if (state === 'idle') api.start().catch((e) => say(e.message, 3000));
    else api.stop().catch((e) => say(e.message, 3000));
  });
  api.ready = ensureStream().then(() => true);
  api.ready.catch(() => {});
  return api;
}

/** קיצור: הרכבה ישירות מהמידע ש־onRecorded מחזיר. */
export function reactionFromRecording(sourceFile, selfBlob, info = {}, opts = {}) {
  return makeReaction(sourceFile, selfBlob, { offset: info.offset ?? 0, selfDuration: info.duration, ...opts });
}
