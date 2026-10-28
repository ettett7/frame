// מנוע דמה לפיתוח הממשק: עובד כל עוד engine/pipeline.js עוד לא קיים.
// מדמה התקדמות, ומחזיר קליפים אנכיים קצרים שנוצרים על קנבס (או את קובץ המקור, אם הדפדפן לא מקליט קנבס).
const HOOKS = [
  ['הרגע הזה שינה הכול', 'אף אחד לא ציפה לזה', 'תראו מה קרה כאן'],
  ['זה הסוד שאף אחד לא מספר', 'חכו לסוף, זה שווה את זה', 'בדיוק בגלל זה זה עובד'],
  ['לא האמנתי למראה עיניים', 'הנה מה שבאמת קרה', 'שימו לב לפרט הקטן'],
];
const STEPS = [
  [0.07, 'מכינים את הסרטון…', 500],
  [0.4, 'מתמללים את הדיבור…', 1100],
  [0.55, 'בוחרים את הרגעים החזקים…', 700],
  [0.68, 'מתאימים את המסגור לטלפון…', 600],
  [0.97, 'מוסיפים כתוביות ומרנדרים…', 1300],
];

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(Object.assign(new Error('בוטל'), { name: 'AbortError' })); return; }
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('בוטל'), { name: 'AbortError' })); }, { once: true });
  });
}

function frameCanvas(hue, hook, t = 0) {
  const c = document.createElement('canvas');
  c.width = 360; c.height = 640;
  paint(c.getContext('2d'), hue, hook, t);
  return c;
}
function paint(ctx, hue, hook, t) {
  const g = ctx.createLinearGradient(0, 0, 360, 640);
  g.addColorStop(0, `hsl(${hue},45%,22%)`);
  g.addColorStop(1, `hsl(${(hue + 50) % 360},55%,9%)`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, 360, 640);
  ctx.fillStyle = `hsla(${hue},70%,70%,.25)`;
  ctx.beginPath(); ctx.arc(180 + Math.sin(t * 2) * 50, 250 + Math.cos(t * 1.6) * 30, 96, 0, Math.PI * 2); ctx.fill();
  ctx.direction = 'rtl'; ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
  ctx.font = '700 34px Rubik, Heebo, sans-serif';
  const words = String(hook).split(' '), lines = [];
  let line = '';
  for (const w of words) { if ((line + ' ' + w).trim().length > 14) { lines.push(line); line = w; } else line = (line + ' ' + w).trim(); }
  if (line) lines.push(line);
  lines.forEach((l, i) => ctx.fillText(l, 180, 150 + i * 44));
  ctx.font = '700 30px Rubik, Heebo, sans-serif';
  ctx.fillStyle = '#ffe14d';
  const caption = ['כך', 'נראות', 'הכתוביות'][Math.floor(t * 3) % 3];
  ctx.fillText(caption, 180, 520);
  ctx.font = '600 14px Heebo, sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.55)';
  ctx.fillText('FRAME · תצוגת דמו', 180, 610);
}

async function record(hue, hook, seconds, signal) {
  if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) return null;
  const mime = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) return null;
  const c = frameCanvas(hue, hook), ctx = c.getContext('2d');
  const rec = new MediaRecorder(c.captureStream(24), { mimeType: mime, videoBitsPerSecond: 1_200_000 }), chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((resolve) => { rec.onstop = resolve; });
  rec.start(200);
  const t0 = performance.now(), timer = setInterval(() => paint(ctx, hue, hook, (performance.now() - t0) / 1000), 40);
  try { await sleep(seconds * 1000, signal); } finally { clearInterval(timer); if (rec.state !== 'inactive') rec.stop(); }
  await Promise.race([stopped, sleep(2500)]);
  const blob = new Blob(chunks, { type: rec.mimeType || mime });
  return blob.size > 2000 ? blob : null;
}

function thumb(hue, hook) {
  return new Promise((resolve) => frameCanvas(hue, hook, 0.3).toBlob((b) => resolve(b), 'image/jpeg', 0.8));
}

async function makeOne(file, options, i, signal) {
  const hooks = HOOKS[i % HOOKS.length], hue = (150 + i * 70) % 360, hook = hooks[0];
  const blob = (await record(hue, hook, 1.4, signal)) || file;
  return { blob, url: URL.createObjectURL(blob), duration: 1.4, title: `קליפ ${i + 1}`, hook, hooks, thumbnail: await thumb(hue, hook), moment: { start: i * 20, end: i * 20 + 30, score: 8.4 - i * 0.6, hook, hooks, reason: 'דמו' }, options, demo: true, hue };
}

export async function makeClips(file, options = {}, { onProgress = () => {}, signal } = {}) {
  let from = 0;
  for (const [to, text, ms] of STEPS) {
    const steps = 6;
    for (let k = 1; k <= steps; k++) { await sleep(ms / steps, signal); onProgress(from + ((to - from) * k) / steps, text); }
    from = to;
  }
  const count = Math.min(3, Math.max(1, Number(options.count) || 1)), clips = [];
  for (let i = 0; i < count; i++) clips.push(await makeOne(file, options, i, signal));
  onProgress(1, 'מוכן');
  return clips;
}

// החלפת כותרת: בדמו מרנדרים מחדש את הקליפ הקטן
export async function rehook(clip, hook, { signal } = {}) {
  const blob = (await record(clip.hue || 150, hook, 1.2, signal)) || clip.blob;
  return { ...clip, blob, url: URL.createObjectURL(blob), hook, thumbnail: await thumb(clip.hue || 150, hook) };
}
