// טלפרומפטר: מצלמה קדמית + טקסט גדול שנגלל, והקלטה ל־Blob.
// בלי תלויות. כל ה־DOM נבנה רק ב־mountTeleprompter, לכן הקובץ נטען גם ב־node (לבדיקות הלוגיקה הטהורה).
//
//   const tp = mountTeleprompter(el, {text, speed, mirror, countdown});
//   tp.onRecorded((blob, info) => ...);      // info = {duration, mimeType, width, height}
//   await tp.start();  ...  const blob = await tp.stop();  tp.destroy();
//
// הערות:
//  - mirror = היפוך הטקסט אופקית (לטלפרומפטר עם זכוכית מחזירה). תצוגת המצלמה תמיד "מראה" (selfie), וההקלטה עצמה לא הפוכה.
//  - speed = רמה 1..10. רמה 1 = רבע שורה בשנייה, רמה 4 = שורה בשנייה בערך (קצב דיבור נוח).
//  - הקובץ שנוצר: mp4 כשהדפדפן מקליט mp4 (Safari, Chrome 126+), אחרת webm. ב־webm של Chrome חסר משך בכותרת, ו־info.duration מדויק יותר.
//  - getStream (אופציונלי) מחליף את getUserMedia, לבדיקות עם זרם מדומה (למשל canvas.captureStream).

export const SPEED_MIN = 1;
export const SPEED_MAX = 10;
export const SPEED_STEP = 0.5;
export const LINES_PER_LEVEL = 0.25;     // שורות בשנייה לכל רמת מהירות

export const MSG = {
  noPermission: 'אין הרשאה למצלמה או למיקרופון. אשרו גישה בהגדרות הדפדפן ונסו שוב.',
  noCamera: 'לא נמצאה מצלמה במכשיר.',
  noMic: 'לא נמצא מיקרופון במכשיר.',
  inUse: 'המצלמה או המיקרופון בשימוש באפליקציה אחרת. סגרו אותה ונסו שוב.',
  insecure: 'הגישה למצלמה דורשת חיבור מאובטח (https).',
  unsupported: 'הדפדפן הזה לא מאפשר גישה למצלמה. נסו ב־Safari או ב־Chrome מעודכנים.',
  generic: 'לא הצלחנו להפעיל את המצלמה. נסו לרענן את הדף.',
  noRecorder: 'ההקלטה בדפדפן הזה לא נתמכת. עדכנו את הדפדפן ונסו שוב.',
  emptyRecording: 'ההקלטה יצאה ריקה. נסו להקליט שוב.',
  speed: (n) => `מהירות ${fmtSpeed(n)}`,
  finished: 'הטקסט הסתיים',
  recorded: (sec) => `ההקלטה מוכנה (${Math.max(1, Math.round(sec))} שניות)`,
  noText: 'אין טקסט להקרין. הדביקו טקסט ונסו שוב.',
};

const fmtSpeed = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

// ------------------------------------------------------------------------------------------ לוגיקה טהורה

export function clampSpeed(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 4;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(n * 2) / 2));
}

/** פיקסלים לשנייה לפי רמת מהירות וגובה שורה. */
export function speedToPxPerSec(speed, lineHeightPx) {
  return clampSpeed(speed) * LINES_PER_LEVEL * lineHeightPx;
}

export const MAX_DT = 1;   // שניות: הגלילה לפי זמן אמיתי, גם כשהמכשיר עמוס ומצייר מעט פריימים. חזרה מרקע מטופלת בנפרד (visibilitychange)

/** קידום מיקום הגלילה לפי הזמן שעבר (dt בשניות), לא לפי מספר הפריימים. מחזיר {pos, finished}. */
export function advance(pos, dt, { speed, lineHeightPx, maxPos }) {
  const step = speedToPxPerSec(speed, lineHeightPx) * Math.min(Math.max(dt, 0), MAX_DT);
  const next = Math.min(maxPos, pos + step);
  return { pos: next, finished: next >= maxPos };
}

/** כיוון הטקסט לפי אותיות: עברית וערבית = rtl. */
export function detectDirection(text) {
  const s = String(text ?? '');
  const rtl = (s.match(/[֐-׿؀-ۿיִ-﷿]/g) || []).length;
  const ltr = (s.match(/[A-Za-z]/g) || []).length;
  return rtl >= ltr && rtl > 0 ? 'rtl' : ltr > 0 ? 'ltr' : 'rtl';
}

/** פורמט הקלטה מועדף: mp4 לפני webm. מחזיר '' כשהדפדפן לא יודע לבדוק (אז משתמשים בברירת המחדל שלו). */
export function pickRecorderMime(MR = globalThis.MediaRecorder, { audio = true } = {}) {
  if (!MR || typeof MR.isTypeSupported !== 'function') return '';
  const a = audio ? ',mp4a.40.2' : '';
  const ao = audio ? ',opus' : '';
  const list = [
    `video/mp4;codecs=avc1.640028${a}`, `video/mp4;codecs=avc1.42E01E${a}`, 'video/mp4',
    `video/webm;codecs=h264${ao}`, `video/webm;codecs=vp9${ao}`, `video/webm;codecs=vp8${ao}`, 'video/webm',
  ];
  return list.find((m) => { try { return MR.isTypeSupported(m); } catch { return false; } }) || '';
}

/** ממפה שגיאת getUserMedia להודעה בעברית. info = {hasVideo, hasAudio} מ־enumerateDevices (אם ידוע). */
export function mapMediaError(err, info = {}) {
  const name = err?.name || '';
  let msg;
  let code = 'generic';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') { msg = MSG.noPermission; code = 'permission'; }
  else if (name === 'SecurityError') {
    if (typeof isSecureContext !== 'undefined' && !isSecureContext) { msg = MSG.insecure; code = 'insecure'; }
    else { msg = MSG.noPermission; code = 'permission'; }
  }
  else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    if (info.hasVideo === true && info.hasAudio === false) { msg = MSG.noMic; code = 'no-mic'; }
    else { msg = MSG.noCamera; code = 'no-camera'; }
  }
  else if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') { msg = MSG.inUse; code = 'in-use'; }
  else if (name === 'TypeError') { msg = MSG.unsupported; code = 'unsupported'; }
  else msg = MSG.generic;
  const e = new Error(msg);
  e.code = code;
  e.cause = err;
  return e;
}

/**
 * פותח מצלמה קדמית ומיקרופון. מנסה 1080x1920, ואם המכשיר לא מסוגל מנסה בלי דרישות גודל.
 * opts: {getStream(constraints), facingMode, audio, width, height}. זורק Error בעברית.
 */
export async function openCamera({ getStream, facingMode = 'user', audio = true, width = 1080, height = 1920 } = {}) {
  let gum = getStream;
  if (!gum) {
    const md = globalThis.navigator?.mediaDevices;
    if (!md?.getUserMedia) {
      const e = new Error(globalThis.isSecureContext === false ? MSG.insecure : MSG.unsupported);
      e.code = globalThis.isSecureContext === false ? 'insecure' : 'unsupported';
      throw e;
    }
    gum = (c) => md.getUserMedia(c);
  }
  const aud = audio ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false;
  const attempts = [
    { video: { facingMode, width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30 } }, audio: aud },
    { video: { facingMode }, audio: aud },
    { video: true, audio: aud },
  ];
  let lastErr;
  for (const c of attempts) {
    try { return await gum(c); }
    catch (e) {
      lastErr = e;
      if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError', 'NotReadableError', 'TrackStartError'].includes(e?.name)) break;
    }
  }
  let info = {};
  try {
    const devs = await globalThis.navigator?.mediaDevices?.enumerateDevices?.();
    if (devs) info = { hasVideo: devs.some((d) => d.kind === 'videoinput'), hasAudio: devs.some((d) => d.kind === 'audioinput') };
  } catch { /* אין מידע */ }
  throw mapMediaError(lastErr, info);
}

export function stopStream(stream) {
  try { stream?.getTracks?.().forEach((t) => t.stop()); } catch { /* כבר נעצר */ }
}

// ------------------------------------------------------------------------------------------ סגנון

const STYLE_ID = 'frame-tp-style';
const CSS = `
.frame-tp-root{position:relative;display:block;overflow:hidden;background:#000;min-height:320px;height:100%;color:#fff;font-family:Heebo,Rubik,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none;touch-action:manipulation}
.frame-tp-root *{box-sizing:border-box}
.frame-tp-root .tp-cam{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:scaleX(-1);background:#0b0b10}
.frame-tp-root .tp-shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.62),rgba(0,0,0,.42) 45%,rgba(0,0,0,.62));pointer-events:none}
.frame-tp-root .tp-view{position:absolute;inset:0;overflow:hidden;-webkit-mask-image:linear-gradient(180deg,transparent 0,#000 16%,#000 100%);mask-image:linear-gradient(180deg,transparent 0,#000 16%,#000 100%)}
.frame-tp-root .tp-text{position:absolute;left:0;right:0;top:0;padding-inline:20px;font-size:var(--tp-font,36px);line-height:1.45;font-weight:700;text-shadow:0 2px 8px rgba(0,0,0,.85);will-change:transform;white-space:normal;overflow-wrap:anywhere}
.frame-tp-root .tp-text p{margin:0 0 .55em}
.frame-tp-root .tp-line{position:absolute;left:0;right:0;height:0;border-top:2px solid rgba(255,214,10,.9);pointer-events:none}
.frame-tp-root .tp-line::before,.frame-tp-root .tp-line::after{content:"";position:absolute;top:-9px;border:8px solid transparent}
.frame-tp-root .tp-line::before{left:0;border-left-color:#ffd60a;border-right-width:0}
.frame-tp-root .tp-line::after{right:0;border-right-color:#ffd60a;border-left-width:0}
.frame-tp-root .tp-top{position:absolute;top:0;left:0;right:0;display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center;justify-content:space-between;padding:calc(env(safe-area-inset-top,0px) + 10px) 10px 8px;z-index:3}
.frame-tp-root .tp-tools{display:flex;gap:6px}
.frame-tp-root button{font:inherit;color:#fff;border:0;cursor:pointer;touch-action:manipulation}
.frame-tp-root .tp-tool{min-width:48px;height:50px;padding:0 12px;border-radius:25px;background:rgba(30,30,38,.78);font-size:16px;font-weight:700;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
.frame-tp-root .tp-tool[aria-pressed="true"]{background:#ffd60a;color:#111}
.frame-tp-root .tp-chip{min-width:84px;height:36px;padding:0 12px;border-radius:18px;background:rgba(30,30,38,.78);display:flex;align-items:center;justify-content:center;gap:8px;font-size:15px;font-weight:700;font-variant-numeric:tabular-nums}
.frame-tp-root .tp-chip i{width:10px;height:10px;border-radius:50%;background:#777;display:inline-block}
.frame-tp.tp-rec .tp-chip i{background:#ff3b30;animation:tp-blink 1s steps(2,start) infinite}
@keyframes tp-blink{50%{opacity:.15}}
.frame-tp-root .tp-bottom{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;gap:22px;padding:26px 16px calc(env(safe-area-inset-bottom,0px) + 18px);z-index:3;direction:ltr;background:linear-gradient(180deg,transparent,rgba(0,0,0,.55) 45%)}
.frame-tp-root .tp-sp{width:72px;height:72px;border-radius:36px;background:rgba(30,30,38,.82);font-size:34px;font-weight:700;line-height:1;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
.frame-tp-root .tp-sp:active,.frame-tp-root .tp-tool:active{transform:scale(.94)}
.frame-tp-root .tp-rec-btn{width:88px;height:88px;border-radius:50%;background:transparent;border:5px solid #fff;display:grid;place-items:center;padding:0}
.frame-tp-root .tp-rec-btn span{width:62px;height:62px;border-radius:50%;background:#ff3b30;transition:border-radius .18s,width .18s,height .18s}
.frame-tp.tp-rec .tp-rec-btn span,.frame-tp.tp-counting .tp-rec-btn span{width:34px;height:34px;border-radius:8px}
.frame-tp-root .tp-speedlabel{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(env(safe-area-inset-bottom,0px) + 122px);padding:4px 14px;border-radius:14px;background:rgba(20,20,26,.82);text-align:center;font-size:14px;font-weight:700;pointer-events:none;z-index:3;white-space:nowrap}
.frame-tp-root .tp-toast{position:absolute;left:50%;top:calc(env(safe-area-inset-top,0px) + 74px);transform:translateX(-50%);max-width:88%;padding:10px 18px;border-radius:20px;background:rgba(20,20,26,.92);font-size:17px;font-weight:700;text-align:center;opacity:0;transition:opacity .2s;pointer-events:none;z-index:5}
.frame-tp-root .tp-toast.on{opacity:1}
.frame-tp-root .tp-count{position:absolute;inset:0;display:none;align-items:center;justify-content:center;font-size:min(46vw,220px);font-weight:900;z-index:6;background:rgba(0,0,0,.35);text-shadow:0 4px 24px rgba(0,0,0,.8)}
.frame-tp.tp-counting .tp-count{display:flex}
.frame-tp-root .tp-count b{display:block;animation:tp-pop .9s ease-out both}
@keyframes tp-pop{0%{transform:scale(1.6);opacity:0}25%{opacity:1}100%{transform:scale(.85);opacity:.35}}
.frame-tp-root .tp-err{position:absolute;left:16px;right:16px;top:30%;display:none;padding:18px;border-radius:18px;background:rgba(40,16,16,.94);border:1px solid #ff6b60;text-align:center;font-size:18px;line-height:1.5;z-index:7}
.frame-tp-root .tp-err.on{display:block}
.frame-tp-root .tp-err button{margin-top:12px;min-height:52px;padding:0 24px;border-radius:26px;background:#fff;color:#111;font-size:17px;font-weight:800}
@media (prefers-reduced-motion:reduce){.frame-tp-root .tp-count b,.frame-tp.tp-rec .tp-chip i{animation:none}.frame-tp-root .tp-rec-btn span{transition:none}}
`;

function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const st = doc.createElement('style');
  st.id = STYLE_ID;
  st.textContent = CSS;
  doc.head.appendChild(st);
}

function h(doc, tag, attrs = {}, ...kids) {
  const e = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids) if (c) e.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
  return e;
}

// ------------------------------------------------------------------------------------------ הרכיב

/**
 * מרכיב טלפרומפטר בתוך el (צריך להיות לו גובה, למשל 100dvh).
 * opts: {text, speed=4, mirror=false, countdown=3, dir, lineAt=0.5, autoStop=true, endGraceSec=2,
 *        fontPx, onRecorded, getStream, MediaRecorder, mimeType, videoBitsPerSecond}
 * מחזיר {start, stop, destroy, onRecorded, ready, setSpeed, getSpeed, setText, setMirror, setFontSize, getState}
 */
export function mountTeleprompter(el, opts = {}) {
  if (!el) throw new Error('חסר אלמנט להצבת הטלפרומפטר.');
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  ensureStyle(doc);

  const MR = 'MediaRecorder' in opts ? opts.MediaRecorder : win.MediaRecorder;   // null מפורש = בלי הקלטה (לבדיקות)
  const cfg = {
    speed: clampSpeed(opts.speed ?? 4),
    mirror: !!opts.mirror,
    countdown: Math.max(0, Math.min(10, Math.round(opts.countdown ?? 3))),
    lineAt: Math.min(0.8, Math.max(0.2, opts.lineAt ?? 0.5)),
    autoStop: opts.autoStop !== false,
    endGraceSec: opts.endGraceSec ?? 2,
  };
  let text = String(opts.text ?? '');
  let fontPx = opts.fontPx || 0;
  let state = 'idle';                  // idle | countdown | recording
  let stream = null;
  let rec = null;
  let chunks = [];
  let recStartMs = 0;
  let pos = 0;
  let maxPos = 0;
  let lineH = 52;
  let raf = 0;
  let lastTs = 0;
  let scrolling = false;               // גלילה פעילה (גם בתרגול בלי הקלטה)
  let endTimer = 0;
  let countTimer = 0;
  let countCancel = null;
  let toastTimer = 0;
  let tickTimer = 0;
  let wake = null;
  let destroyed = false;
  const listeners = new Set();
  if (typeof opts.onRecorded === 'function') listeners.add(opts.onRecorded);

  // ---- DOM ----
  const root = h(doc, 'div', { class: 'frame-tp' });
  el.classList.add('frame-tp-root');
  const cam = h(doc, 'video', { class: 'tp-cam', playsinline: true, muted: true, autoplay: true, 'aria-hidden': 'true' });
  cam.muted = true;
  cam.setAttribute('webkit-playsinline', '');
  const shade = h(doc, 'div', { class: 'tp-shade' });
  const view = h(doc, 'div', { class: 'tp-view', role: 'region', 'aria-label': 'טקסט להקראה. לחיצה משהה או ממשיכה את הגלילה' });
  const textEl = h(doc, 'div', { class: 'tp-text' });
  view.appendChild(textEl);
  const line = h(doc, 'div', { class: 'tp-line', 'aria-hidden': 'true' });
  const chipTime = h(doc, 'span', { text: '00:00' });
  const chip = h(doc, 'div', { class: 'tp-chip', 'aria-live': 'off' }, h(doc, 'i'), chipTime);
  const btn = (cls, label, txt, extra = {}) => h(doc, 'button', { type: 'button', class: cls, 'aria-label': label, text: txt, ...extra });
  const bFontDown = btn('tp-tool', 'הקטנת הטקסט', 'א−');
  const bFontUp = btn('tp-tool', 'הגדלת הטקסט', 'א+');
  const bMirror = btn('tp-tool', 'היפוך הטקסט כמראה', 'הפוך', { 'aria-pressed': 'false' });
  const bRestart = btn('tp-tool', 'חזרה לתחילת הטקסט', 'התחלה');
  const top = h(doc, 'div', { class: 'tp-top' }, h(doc, 'div', { class: 'tp-tools' }, bFontDown, bFontUp, bMirror, bRestart), chip);
  const bSlower = btn('tp-sp', 'האטה', '−');
  const bFaster = btn('tp-sp', 'האצה', '+');
  const recBtn = h(doc, 'button', { type: 'button', class: 'tp-rec-btn', 'aria-label': 'התחלת הקלטה' }, h(doc, 'span'));
  const bottom = h(doc, 'div', { class: 'tp-bottom' }, bSlower, recBtn, bFaster);
  const speedLabel = h(doc, 'div', { class: 'tp-speedlabel' });
  const toast = h(doc, 'div', { class: 'tp-toast', role: 'status', 'aria-live': 'polite' });
  const countEl = h(doc, 'div', { class: 'tp-count', 'aria-live': 'assertive' });
  const errText = h(doc, 'div');
  const errRetry = btn('', 'ניסיון חוזר', 'נסו שוב');
  const errEl = h(doc, 'div', { class: 'tp-err', role: 'alert' }, errText, errRetry);
  root.append(cam, shade, view, line, top, speedLabel, bottom, toast, countEl, errEl);
  el.appendChild(root);
  root.style.cssText = 'position:absolute;inset:0';

  // ---- פריסה ----
  function applyDir() {
    const dir = opts.dir || detectDirection(text);
    textEl.setAttribute('dir', dir);
    textEl.style.textAlign = dir === 'rtl' ? 'right' : 'left';
  }
  function renderText() {
    textEl.textContent = '';
    const paras = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    for (const p of paras) textEl.appendChild(h(doc, 'p', { text: p }));
    applyDir();
    layout();
  }
  function layout() {
    const H = root.clientHeight || el.clientHeight || 600;
    const W = root.clientWidth || el.clientWidth || 360;
    if (!fontPx) fontPx = Math.max(28, Math.min(64, Math.round(W * 0.095)));
    el.style.setProperty('--tp-font', `${fontPx}px`);
    lineH = Math.round(fontPx * 1.45);
    const lineY = Math.round(H * cfg.lineAt);
    line.style.top = `${lineY}px`;
    textEl.style.paddingTop = `${Math.max(0, lineY - Math.round(lineH / 2))}px`;
    textEl.style.paddingBottom = `${Math.max(0, H - lineY)}px`;
    const padTop = Math.max(0, lineY - Math.round(lineH / 2));
    const contentH = textEl.scrollHeight - padTop - Math.max(0, H - lineY);
    maxPos = Math.max(0, contentH - lineH);
    pos = Math.min(pos, maxPos);
    paint();
  }
  function paint() {
    const m = cfg.mirror ? ' scaleX(-1)' : '';
    textEl.style.transform = `translate3d(0,${-pos}px,0)${m}`;
  }
  const ro = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(() => { if (!destroyed) layout(); }) : null;
  ro?.observe(el);

  // ---- הודעות ----
  function say(msg, ms = 1600) {
    toast.textContent = msg;
    toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('on'), ms);
  }
  function showError(msg) { errText.textContent = msg; errEl.classList.add('on'); }
  function clearError() { errEl.classList.remove('on'); }
  function setSpeedLabel() { speedLabel.textContent = MSG.speed(cfg.speed); }
  setSpeedLabel();

  // ---- גלילה ----
  function frame(ts) {
    raf = 0;
    if (!scrolling || destroyed) return;
    const dt = lastTs ? (ts - lastTs) / 1000 : 0;
    lastTs = ts;
    const r = advance(pos, dt, { speed: cfg.speed, lineHeightPx: lineH, maxPos });
    pos = r.pos;
    paint();
    if (r.finished) { scrolling = false; onTextEnd(); return; }
    raf = win.requestAnimationFrame(frame);
  }
  function startScroll() {
    if (scrolling || !text.trim()) return;
    scrolling = true;
    lastTs = 0;
    raf = win.requestAnimationFrame(frame);
  }
  function pauseScroll() { scrolling = false; if (raf) win.cancelAnimationFrame(raf); raf = 0; }
  const onVis = () => { lastTs = 0; };                // חזרה מהרקע: לא להקפיץ את הטקסט
  doc.addEventListener('visibilitychange', onVis);
  function onTextEnd() {
    say(MSG.finished, 2200);
    if (state === 'recording' && cfg.autoStop) endTimer = setTimeout(() => { api.stop().catch(() => {}); }, cfg.endGraceSec * 1000);
  }

  // ---- מצלמה ----
  let camPromise = null;
  function ensureStream() {
    if (stream && stream.getTracks().some((t) => t.readyState === 'live')) return Promise.resolve(stream);
    if (camPromise) return camPromise;
    clearError();
    camPromise = openCamera({ getStream: opts.getStream }).then(async (s) => {
      if (destroyed) { stopStream(s); throw new Error('הרכיב נסגר.'); }
      stream = s;
      cam.srcObject = s;
      try { await cam.play(); } catch { /* ההפעלה האוטומטית נחסמה, אין בעיה: התמונה תופיע בלחיצה הראשונה */ }
      return s;
    }).catch((e) => { showError(e.message); throw e; }).finally(() => { camPromise = null; });
    return camPromise;
  }
  errRetry.addEventListener('click', () => { ensureStream().catch(() => {}); });

  async function lockScreen() {
    try { if (win.navigator?.wakeLock) wake = await win.navigator.wakeLock.request('screen'); } catch { wake = null; }
  }
  function unlockScreen() { try { wake?.release?.(); } catch { /* אין */ } wake = null; }

  // ---- ספירה לאחור ----
  function runCountdown(n) {
    return new Promise((resolve) => {
      if (n <= 0) { resolve(true); return; }
      root.classList.add('tp-counting');
      let i = n;
      const tick = () => {
        countEl.textContent = '';
        countEl.appendChild(h(doc, 'b', { text: String(i) }));
        i -= 1;
        if (i < 0) { root.classList.remove('tp-counting'); countEl.textContent = ''; resolve(true); return; }
        countTimer = setTimeout(tick, 1000);
      };
      countCancel = () => { clearTimeout(countTimer); root.classList.remove('tp-counting'); countEl.textContent = ''; resolve(false); };
      tick();
    });
  }

  // ---- הקלטה ----
  function updateChip() {
    const s = state === 'recording' ? Math.floor((performance.now() - recStartMs) / 1000) : 0;
    chipTime.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  const api = {
    /** מתחיל: ספירה לאחור, אחר כך הקלטה וגלילה. מחזיר Promise שמתממש כשההקלטה התחילה (או null אם בוטלה). */
    async start() {
      if (destroyed || state !== 'idle') return null;
      if (!text.trim()) { say(MSG.noText); throw new Error(MSG.noText); }
      if (!MR) { showError(MSG.noRecorder); throw new Error(MSG.noRecorder); }
      const s = await ensureStream();
      state = 'countdown';
      root.classList.add('tp-counting');
      pauseScroll();
      pos = 0; paint();
      const ok = await runCountdown(cfg.countdown);
      if (!ok || destroyed) { state = 'idle'; return null; }
      try {
        const mimeType = opts.mimeType || pickRecorderMime(MR);
        const ro2 = { videoBitsPerSecond: opts.videoBitsPerSecond || 6_000_000, audioBitsPerSecond: 128_000 };
        if (mimeType) ro2.mimeType = mimeType;
        try { rec = new MR(s, ro2); } catch { rec = new MR(s); }
      } catch (e) { state = 'idle'; root.classList.remove('tp-counting'); showError(MSG.noRecorder); throw new Error(MSG.noRecorder); }
      chunks = [];
      rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
      await new Promise((resolve, reject) => {
        rec.onstart = () => resolve();
        rec.onerror = (ev) => reject(ev?.error || new Error(MSG.noRecorder));
        try { rec.start(1000); } catch (e) { reject(e); }
      }).catch((e) => { state = 'idle'; root.classList.remove('tp-counting'); showError(MSG.noRecorder); throw new Error(MSG.noRecorder); });
      recStartMs = performance.now();
      state = 'recording';
      root.classList.remove('tp-counting');
      root.classList.add('tp-rec');
      recBtn.setAttribute('aria-label', 'עצירת הקלטה');
      lockScreen();
      startScroll();
      clearInterval(tickTimer);
      tickTimer = setInterval(updateChip, 250);
      updateChip();
      return true;
    },

    /** עוצר. מחזיר את ה־Blob (ומפעיל את מאזיני onRecorded), או null אם לא הייתה הקלטה. */
    async stop() {
      if (state === 'countdown') { countCancel?.(); state = 'idle'; root.classList.remove('tp-counting'); return null; }
      if (state !== 'recording' || !rec) return null;
      clearTimeout(endTimer);
      clearInterval(tickTimer);
      const duration = (performance.now() - recStartMs) / 1000;
      pauseScroll();
      state = 'idle';
      root.classList.remove('tp-rec');
      recBtn.setAttribute('aria-label', 'התחלת הקלטה');
      unlockScreen();
      const r = rec;
      rec = null;
      const type = r.mimeType || opts.mimeType || '';
      await new Promise((resolve) => { r.onstop = () => resolve(); try { r.stop(); } catch { resolve(); } });
      chipTime.textContent = '00:00';
      const blob = new Blob(chunks, { type });
      chunks = [];
      if (!blob.size) { showError(MSG.emptyRecording); throw new Error(MSG.emptyRecording); }
      const vt = stream?.getVideoTracks?.()[0]?.getSettings?.() || {};
      const info = { duration, mimeType: blob.type || type, width: vt.width || 0, height: vt.height || 0 };
      say(MSG.recorded(duration), 2400);
      for (const cb of [...listeners]) { try { cb(blob, info); } catch (e) { console.error(e); } }
      return blob;
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      pauseScroll();
      countCancel?.();
      clearTimeout(endTimer); clearInterval(tickTimer); clearTimeout(toastTimer);
      try { if (rec && rec.state !== 'inactive') { rec.onstop = null; rec.stop(); } } catch { /* כבר נעצר */ }
      unlockScreen();
      ro?.disconnect();
      doc.removeEventListener('visibilitychange', onVis);
      stopStream(stream);
      cam.srcObject = null;
      listeners.clear();
      root.remove();
      el.classList.remove('frame-tp-root');
      el.style.removeProperty('--tp-font');
    },

    /** רושם מאזין להקלטה שהסתיימה: cb(blob, info). מחזיר פונקציה שמסירה אותו. */
    onRecorded(cb) {
      if (typeof cb !== 'function') return () => {};
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    /** מתממש כשהמצלמה והמיקרופון מוכנים, ונדחה עם Error בעברית אם אין. */
    ready: null,
    setSpeed(v) { cfg.speed = clampSpeed(v); setSpeedLabel(); return cfg.speed; },
    getSpeed() { return cfg.speed; },
    setText(t) { text = String(t ?? ''); pos = 0; renderText(); },
    setMirror(b) { cfg.mirror = !!b; bMirror.setAttribute('aria-pressed', String(cfg.mirror)); paint(); },
    setFontSize(px) { fontPx = Math.max(20, Math.min(96, Math.round(px))); layout(); },
    getState() { return { state, speed: cfg.speed, mirror: cfg.mirror, scrolling, pos, maxPos, fontPx, hasStream: !!stream }; },
  };

  // ---- אירועים ----
  const changeSpeed = (d) => { const v = api.setSpeed(cfg.speed + d); say(MSG.speed(v), 900); };
  bSlower.addEventListener('click', () => changeSpeed(-SPEED_STEP));
  bFaster.addEventListener('click', () => changeSpeed(+SPEED_STEP));
  bFontDown.addEventListener('click', () => api.setFontSize(fontPx - 3));
  bFontUp.addEventListener('click', () => api.setFontSize(fontPx + 3));
  bMirror.addEventListener('click', () => api.setMirror(!cfg.mirror));
  bRestart.addEventListener('click', () => { pos = 0; paint(); if (state === 'idle') pauseScroll(); });
  recBtn.addEventListener('click', () => {
    if (state === 'idle') api.start().catch((e) => say(e.message, 3000));
    else api.stop().catch((e) => say(e.message, 3000));
  });
  view.addEventListener('click', () => {            // נגיעה בטקסט: השהיה והמשך (בלי הקלטה זה "תרגול")
    if (scrolling) { pauseScroll(); say('הגלילה מושהית', 900); } else { startScroll(); }
  });
  root.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); recBtn.click(); }
    else if (e.code === 'ArrowUp') { e.preventDefault(); changeSpeed(+SPEED_STEP); }
    else if (e.code === 'ArrowDown') { e.preventDefault(); changeSpeed(-SPEED_STEP); }
  });
  root.tabIndex = 0;

  renderText();
  api.setMirror(cfg.mirror);
  doc.fonts?.ready?.then(() => { if (!destroyed) layout(); }).catch(() => {});
  api.ready = ensureStream().then(() => true);
  api.ready.catch(() => {});          // השגיאה מוצגת בממשק; מי שמאזין ל־ready יקבל אותה
  return api;
}
