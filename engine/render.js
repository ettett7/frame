// engine/render.js: ייצוא MP4 בתוך הדפדפן (סוכן 3, סבב 8).
//
//   probe(file)      -> {duration, width, height, fps, hasAudio, rotation, source, codec, webcodecs}
//                       width/height הם מידות התצוגה (אחרי סיבוב), rotation הוא סיבוב המיכל בכיוון השעון.
//                       webcodecs=true אם הדפדפן מפענח את הקודק הזה במסלול המהיר.
//   render({file, plan, camera, overlay, audio, width=1080, height=1920, fps=30, bitrate,
//           quality:'draft'|'normal'|'high', onProgress(fraction, textHe), signal,
//           path:'auto'|'webcodecs'|'webcodecs-video'|'mediarecorder', fallback:true,
//           overlayFrame:false, overlayFrameScale:1}) -> Blob
//                     Blob.type הוא video/mp4 (בגיבוי של Chrome ללא mp4: video/webm).
//                     blob.frameInfo = {path, container, ext, mime, realtime, ...} (גם render.lastInfo).
//   thumbnail(file,t)-> Blob (image/jpeg, צד ארוך עד 720)
//   unlockAudio()    -> לקרוא בתוך לחיצה של המשתמש (חשוב באייפון, למסלול הגיבוי)
//   capabilities()   -> מה הדפדפן יודע לעשות (WebCodecs, H.264, AAC, MediaRecorder)
//
// סדר המסלולים (path:'auto'):
//   1. WebCodecs מלא: וידאו ואודיו (AAC) ממקודדי המערכת, ב־Worker. מהיר ביותר.
//   2. webcodecs-video: וידאו מהיר ב־WebCodecs, ואודיו AAC מקודד ב־WASM (FFmpeg, נטען מה־CDN רק אז).
//      זה המסלול למכשירים בלי AudioEncoder (אייפון לפני iOS 26), או כשהמקודד שלהם פגום.
//   3. גיבוי בזמן אמת: <video> מוסתר + canvas.captureStream + MediaRecorder. עובד בכל מקום.
//
// overlayFrame:true: ה־overlay מקבלת פריים רביעי, ‏frame, שהוא ImageBitmap של התמונה אחרי ה־crop בגודל הפלט
// (או מוקטן ב־overlayFrameScale, 0.1..1). אפשר לצייר עליו שכבה אטומה שמכסה את הווידאו (למשל החלפת רקע).
// ה־frame משוחרר (close) אחרי כל קריאה, ולכן אין לשמור אותו. ‏overlay יכולה להיות async. בגיבוי, frame הוא קנבס
// עם close() ריק. ‏render.OVERLAY_GIVES_FRAME === true מסמן שהיכולת קיימת.
//
// על overlay(ctx, tOut, frameIndex): פונקציות לא עוברות ל־Worker, ולכן במסלול המהיר היא רצה בדף
// על קנבס שקוף בגודל הפלט, וה־ImageBitmap שלו מונח מעל הווידאו (source-over) בלי להאט את הקידוד.
// לכן אפקטים שקוראים את הווידאו שמתחת (blend, getImageData) אינם נתמכים שם. בגיבוי היא מציירת ישירות על הפריים.
// אותו דבר ל־camera: rectAt נדגמת לכל פריים מראש (מנורמל, בקואורדינטות תצוגה אחרי סיבוב).
import {
  AAC_SAMPLE_RATES,
  HE,
  abortError,
  chooseAudioBitrate,
  chooseBitrate,
  clamp,
  compilePlan,
  createCompositor,
  extForMime,
  framesOf,
  heError,
  openMp4,
  opsForFrame,
  overlayFrameSize,
  pickRecorderMime,
  progressText,
  sampleCamera,
  throwIfAborted,
} from './media.js';

const WORKER_URL = new URL('./render.worker.js', import.meta.url);

// ───────────────────────── עזרים ─────────────────────────
const tick = () =>
  new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(0);
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function once(el, ok, bad, ms, what) {
  return new Promise((resolve, reject) => {
    let t = 0;
    const off = () => {
      clearTimeout(t);
      el.removeEventListener(ok, onOk);
      if (bad) el.removeEventListener(bad, onBad);
    };
    const onOk = () => {
      off();
      resolve();
    };
    const onBad = () => {
      off();
      reject(heError(HE.badFile, 'media'));
    };
    el.addEventListener(ok, onOk);
    if (bad) el.addEventListener(bad, onBad);
    t = setTimeout(() => {
      off();
      reject(heError(HE.stalled, 'timeout', what));
    }, ms);
  });
}

async function keepAwake() {
  try {
    if (typeof navigator !== 'undefined' && navigator.wakeLock) {
      const s = await navigator.wakeLock.request('screen');
      return () => s.release().catch(() => {});
    }
  } catch (_) {
    /* לא קריטי */
  }
  return () => {};
}

function hiddenHost() {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1';
  document.body.appendChild(host);
  return host;
}

function makeVideoEl(host, url) {
  const v = document.createElement('video');
  v.muted = true;
  v.defaultMuted = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.setAttribute('webkit-playsinline', '');
  v.preload = 'auto';
  v.src = url;
  host.appendChild(v);
  return v;
}

let _actx = null;
function getAudioContext() {
  if (!_actx || _actx.state === 'closed') {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    _actx = new AC();
  }
  return _actx;
}

// באייפון AudioContext מתחיל "מושהה" ומתעורר רק בתוך לחיצה. קוראים לזה מהמטפל בלחיצה של "ייצוא".
export function unlockAudio() {
  try {
    const ctx = getAudioContext();
    if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
    return !!ctx;
  } catch (_) {
    return false;
  }
}

// ───────────────────────── יכולות ─────────────────────────
export function canUseWebCodecs() {
  return (
    typeof VideoEncoder === 'function' &&
    typeof VideoDecoder === 'function' &&
    typeof EncodedVideoChunk === 'function' &&
    typeof VideoFrame === 'function' &&
    typeof OffscreenCanvas === 'function' &&
    typeof Worker === 'function'
  );
}

export async function capabilities() {
  const caps = {
    webcodecs: canUseWebCodecs(),
    h264Encode: false,
    audioAac: false,
    audioOpus: false,
    offscreenCanvas: typeof OffscreenCanvas === 'function',
    mediaRecorder: typeof MediaRecorder === 'function',
    recorder: null,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
  };
  try {
    if (typeof VideoEncoder === 'function') {
      const r = await VideoEncoder.isConfigSupported({ codec: 'avc1.640028', width: 1080, height: 1920, bitrate: 8e6, framerate: 30, avc: { format: 'avc' } });
      caps.h264Encode = !!r.supported;
    }
    if (typeof AudioEncoder === 'function') {
      caps.audioAac = !!(await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 })).supported;
      caps.audioOpus = !!(await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 })).supported;
    }
  } catch (_) {
    /* נשאר false */
  }
  if (caps.mediaRecorder) caps.recorder = pickRecorderMime((m) => MediaRecorder.isTypeSupported(m));
  return caps;
}

// ───────────────────────── probe ─────────────────────────
async function probeViaVideoEl(file) {
  const url = URL.createObjectURL(file);
  const host = hiddenHost();
  try {
    const v = makeVideoEl(host, url);
    v.preload = 'metadata';
    await once(v, 'loadedmetadata', 'error', 20000, 'metadata');
    let hasAudio = true;
    if (v.audioTracks && typeof v.audioTracks.length === 'number') hasAudio = v.audioTracks.length > 0;
    else if (typeof v.mozHasAudio === 'boolean') hasAudio = v.mozHasAudio;
    return {
      duration: v.duration,
      width: v.videoWidth,
      height: v.videoHeight,
      fps: 30,
      hasAudio,
      rotation: 0,
      source: 'video',
      codec: null,
      webcodecs: false,
    };
  } finally {
    host.remove();
    URL.revokeObjectURL(url);
  }
}

// width/height הם מידות התצוגה (אחרי סיבוב), rotation הוא הסיבוב של המיכל בכיוון השעון
export async function probe(file) {
  if (!file || !(file.size > 0)) throw heError(HE.badFile, 'badfile');
  try {
    const m = await openMp4(file);
    if (m.video) {
      let webcodecs = false;
      try {
        if (typeof VideoDecoder === 'function') {
          const cfg = { codec: m.video.codec, codedWidth: m.video.codedW, codedHeight: m.video.codedH };
          if (m.video.description) cfg.description = m.video.description;
          webcodecs = !!(await VideoDecoder.isConfigSupported(cfg)).supported;
        }
      } catch (_) {
        webcodecs = false;
      }
      return {
        duration: m.duration,
        width: m.video.dispW,
        height: m.video.dispH,
        fps: Math.round(m.video.fps * 100) / 100,
        hasAudio: !!m.audio,
        rotation: m.video.rotation,
        source: 'mp4box',
        codec: m.video.codec,
        webcodecs,
        audio: m.audio,
      };
    }
  } catch (_) {
    /* לא MP4 או קובץ מיוחד: ממשיכים ל־<video> */
  }
  return probeViaVideoEl(file);
}

// ───────────────────────── thumbnail ─────────────────────────
export async function thumbnail(file, t = 0, { maxSide = 720, quality = 0.85 } = {}) {
  const url = URL.createObjectURL(file);
  const host = hiddenHost();
  try {
    const v = makeVideoEl(host, url);
    await once(v, 'loadeddata', 'error', 20000, 'loadeddata');
    const at = clamp(Number(t) || 0, 0, Math.max(0, (v.duration || 0) - 0.05));
    if (at > 0.001 || v.currentTime > 0.001) {
      const seeked = once(v, 'seeked', 'error', 15000, 'seek');
      v.currentTime = at;
      await seeked;
    }
    const w = v.videoWidth;
    const h = v.videoHeight;
    if (!w || !h) throw heError(HE.thumbFailed, 'thumb');
    const s = Math.min(1, maxSide / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(2, Math.round(w * s));
    c.height = Math.max(2, Math.round(h * s));
    const ctx = c.getContext('2d');
    ctx.drawImage(v, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
    if (!blob) throw heError(HE.thumbFailed, 'thumb');
    return blob;
  } finally {
    host.remove();
    URL.revokeObjectURL(url);
  }
}

// ───────────────────────── render: כניסה ─────────────────────────
// opts: {file, plan, camera, overlay(ctx,tOut,frame), audio:AudioBuffer, width=1080, height=1920, fps=30,
//        bitrate, quality:'draft'|'normal'|'high', onProgress(fraction, textHe), signal,
//        path:'auto'|'webcodecs'|'webcodecs-video'|'mediarecorder', fallback:true,
//        overlayFrame:false, overlayFrameScale:1}
export async function render(opts) {
  const o = { width: 1080, height: 1920, fps: 30, quality: 'normal', path: 'auto', fallback: true, ...opts };
  if (!o.file) throw heError(HE.badFile, 'badfile');
  o.compiled = compilePlan(o.plan);
  o.frames = framesOf(o.compiled, o.fps);
  if (!o.frames) throw heError(HE.emptyPlan, 'empty');
  o.width = Math.max(2, Math.round(o.width / 2) * 2);
  o.height = Math.max(2, Math.round(o.height / 2) * 2);
  if (!o.bitrate) o.bitrate = chooseBitrate(o.width, o.height, o.fps, o.quality);
  const progress = typeof o.onProgress === 'function' ? o.onProgress : () => {};
  o.report = (f, label) => progress(clamp(f, 0, 1), progressText(f, label));
  throwIfAborted(o.signal);
  o.report(0);

  const release = await keepAwake();
  const t0 = performance.now();
  try {
    let blob;
    let tried = null;
    const forced = o.path === 'webcodecs' || o.path === 'webcodecs-video';
    if (o.path !== 'mediarecorder' && canUseWebCodecs()) {
      try {
        blob = await renderWebCodecs(o);
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        if (forced || !o.fallback) throw e;
        tried = { path: 'webcodecs', error: (e && e.message) || String(e), code: e && e.code };
        console.warn('[render] מסלול WebCodecs נכשל, עוברים לגיבוי:', e);
      }
    } else if (forced) {
      throw heError(HE.noWebCodecs, 'unsupported');
    }
    if (!blob) {
      throwIfAborted(o.signal);
      blob = await renderFallback(o);
      if (tried) blob.frameInfo.fellBackFrom = tried;
    }
    blob.frameInfo.totalMs = Math.round(performance.now() - t0);
    o.report(1);
    render.lastInfo = blob.frameInfo;
    return blob;
  } finally {
    release();
  }
}
render.lastInfo = null;
// הצינור בודק את זה: כש־overlayFrame:true, ה־overlay מקבל פריים רביעי (ראו למעלה)
render.OVERLAY_GIVES_FRAME = true;

// ───────────────────────── אודיו לקידוד ─────────────────────────
// סדר העדיפויות: מקודד המערכת (AAC), ואם אין אז AAC ב־WASM (מסלול ביניים: וידאו מהיר ואודיו בקידוד תוכנה),
// ורק אחר כך Opus של המערכת (תאימות גרועה יותר בגלריות). כשכל אלה נכשלים נשארים עם הגיבוי בזמן אמת.
// path:'webcodecs-video' כופה את ה־WASM (לבדיקות, ולמכשירים שמקודד המערכת בהם פגום).
async function audioCandidates(audio, o) {
  const ch = Math.max(1, Math.min(2, audio.numberOfChannels));
  const br = chooseAudioBitrate(ch);
  const sr = audio.sampleRate;
  const dbg = o.debug || {};
  const hasNative = typeof AudioEncoder === 'function' && !dbg.noNativeAudio; // noNativeAudio: מדמה אייפון לפני iOS 26
  const supported = async (cfg) => {
    try {
      return !!(await AudioEncoder.isConfigSupported(cfg)).supported;
    } catch (_) {
      return false;
    }
  };
  if (dbg.forceOpus) return [{ kind: 'native', codec: 'opus', sampleRate: 48000, numberOfChannels: ch, bitrate: 128000 }];
  const forceWasm = o.path === 'webcodecs-video' || !!dbg.forceWasmAac;
  const list = [];
  if (hasNative && !forceWasm && !dbg.noNativeAac) {
    for (const rate of [sr, 48000]) {
      const cfg = { codec: 'mp4a.40.2', sampleRate: rate, numberOfChannels: ch, bitrate: br };
      if (await supported(cfg)) {
        list.push({ kind: 'native', ...cfg });
        break;
      }
    }
  }
  if (!dbg.noWasmAac) list.push({ kind: 'wasm', codec: 'mp4a.40.2', sampleRate: AAC_SAMPLE_RATES.includes(sr) ? sr : 48000, numberOfChannels: ch, bitrate: br });
  if (hasNative && !forceWasm) {
    const cfg = { codec: 'opus', sampleRate: 48000, numberOfChannels: ch, bitrate: 128000 };
    if (await supported(cfg)) list.push({ kind: 'native', ...cfg });
  }
  return list;
}

async function audioPayload(audio, cfg, durationSec) {
  let src = audio;
  if (cfg.sampleRate !== audio.sampleRate) {
    const frames = Math.ceil(audio.duration * cfg.sampleRate);
    const off = new OfflineAudioContext(cfg.numberOfChannels, Math.max(1, frames), cfg.sampleRate);
    const node = off.createBufferSource();
    node.buffer = audio;
    node.connect(off.destination);
    node.start();
    src = await off.startRendering();
  }
  const frames = Math.min(src.length, Math.round(durationSec * cfg.sampleRate));
  const channels = [];
  for (let c = 0; c < cfg.numberOfChannels; c++) channels.push(src.getChannelData(Math.min(c, src.numberOfChannels - 1)).slice(0, frames));
  return { sampleRate: cfg.sampleRate, frames, channels };
}

// ───────────────────────── מסלול מהיר: WebCodecs ב־worker ─────────────────────────
function makeOverlayLayer(w, h) {
  if (typeof OffscreenCanvas === 'function') {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d');
    return { ctx, grab: async () => c.transferToImageBitmap() };
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  return {
    ctx,
    grab: async () => {
      const b = await createImageBitmap(c);
      ctx.clearRect(0, 0, w, h);
      return b;
    },
  };
}

// מנסה את המקודדים לפי הסדר. כשל בקידוד האודיו (לא נתמך, או שה־WASM לא נטען) עובר למועמד הבא
async function renderWebCodecs(o) {
  const hasAudio = !!(o.audio && o.audio.length > 0);
  const cands = hasAudio ? await audioCandidates(o.audio, o) : [null];
  if (!cands.length) throw heError(HE.encoderUnsupported, 'unsupported');
  const failures = [];
  for (const cfg of cands) {
    throwIfAborted(o.signal);
    try {
      const blob = await attemptWebCodecs(o, cfg);
      if (failures.length) blob.frameInfo.audioFallbacks = failures;
      return blob;
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      if (!e || e.code !== 'audio' || cfg === cands[cands.length - 1]) throw e;
      failures.push({ kind: cfg.kind, codec: cfg.codec, error: e.message });
      console.warn('[render] קידוד האודיו נכשל, מנסים מקודד אחר:', e);
    }
  }
  throw heError(HE.encodeFailed, 'failed');
}

async function attemptWebCodecs(o, audioCfg) {
  const { file, width, height, fps, signal } = o;
  const n = o.frames;
  const duration = o.compiled.duration;
  const hasOverlay = typeof o.overlay === 'function';
  const frameMode = hasOverlay && !!o.overlayFrame;
  const ovf = frameMode ? overlayFrameSize(width, height, o.overlayFrameScale) : null;
  const camTable = sampleCamera(o.camera, n, fps);

  let audio = null;
  if (audioCfg) {
    audio = await audioPayload(o.audio, audioCfg, duration);
    if (!audio.frames) {
      audio = null;
      audioCfg = null;
    }
  }
  throwIfAborted(signal);

  const worker = new Worker(WORKER_URL, { type: 'module' });
  return await new Promise((resolve, reject) => {
    let finished = false;
    let lastMsg = performance.now();
    let consumed = -1;
    let nextOv = 0;
    let pumping = false;
    let overlayErrors = 0;
    let lastReport = 0;
    let snapChain = Promise.resolve();
    const layer = hasOverlay ? makeOverlayLayer(width, height) : null;
    const LOOK = 6;

    const end = (fn, v) => {
      if (finished) return;
      finished = true;
      clearInterval(dog);
      if (signal) signal.removeEventListener('abort', onAbort);
      worker.terminate();
      fn(v);
    };
    const onAbort = () => {
      try {
        worker.postMessage({ type: 'abort' });
      } catch (_) {
        /* נסגר */
      }
      end(reject, abortError());
    };
    if (signal) signal.addEventListener('abort', onAbort);
    const dog = setInterval(() => {
      if (performance.now() - lastMsg > 45000) end(reject, heError(HE.stalled, 'stalled'));
    }, 2000);

    async function runOverlay(i, frame) {
      let skip = false;
      try {
        skip = (await o.overlay(layer.ctx, i / fps, i, frame)) === false;
      } catch (e) {
        overlayErrors++;
        if (overlayErrors === 1) console.warn('[render] שגיאה בציור שכבת העל:', e);
      }
      return skip ? null : await layer.grab();
    }

    // מצב רגיל: שכבות על מחושבות קדימה, מבלי להמתין ל־worker
    async function pumpOverlays() {
      if (!hasOverlay || frameMode || pumping) return;
      pumping = true;
      try {
        while (!finished && nextOv < n && nextOv <= consumed + LOOK) {
          const i = nextOv++;
          const bm = await runOverlay(i);
          if (finished) {
            if (bm) bm.close();
            break;
          }
          worker.postMessage({ type: 'overlay', i, bitmap: bm }, bm ? [bm] : []);
          await tick();
        }
      } finally {
        pumping = false;
      }
    }

    // מצב overlayFrame: ה־worker שולח את הפריים אחרי ה־crop, ה־overlay מציירת עליו, והפריים משוחרר אחרי כל קריאה
    function onSnap(m) {
      snapChain = snapChain.then(async () => {
        if (finished) {
          m.bitmap.close();
          return;
        }
        let bm = null;
        try {
          bm = await runOverlay(m.i, m.bitmap);
        } finally {
          m.bitmap.close();
        }
        if (finished) {
          if (bm) bm.close();
          return;
        }
        worker.postMessage({ type: 'overlay', i: m.i, bitmap: bm }, bm ? [bm] : []);
      });
    }

    worker.onmessage = (ev) => {
      const m = ev.data;
      lastMsg = performance.now();
      if (m.type === 'frame') {
        consumed = m.i;
        const now = performance.now();
        if (now - lastReport > 80 || m.done === m.total) {
          lastReport = now;
          o.report((m.done / m.total) * 0.97);
        }
        pumpOverlays();
      } else if (m.type === 'snap') {
        onSnap(m);
      } else if (m.type === 'done') {
        o.report(0.99);
        // edit list לערוץ האודיו: מוסיפים 36 בייטים באמצע הקובץ בלי להעתיק אותו (Blob מחבר חלקים)
        const parts = m.patch ? [new Uint8Array(m.buffer, 0, m.patch.pos), m.patch.insert, new Uint8Array(m.buffer, m.patch.pos)] : [m.buffer];
        const blob = new Blob(parts, { type: 'video/mp4' });
        const wasm = m.info.audioEncoder === 'wasm';
        blob.frameInfo = {
          path: wasm ? 'webcodecs-video' : 'webcodecs',
          container: 'mp4',
          ext: 'mp4',
          mime: 'video/mp4',
          realtime: false,
          overlayErrors,
          width,
          height,
          fps,
          frames: n,
          duration,
          bitrate: o.bitrate,
          ...m.info,
        };
        end(resolve, blob);
      } else if (m.type === 'error') {
        end(reject, heError(m.message || HE.encodeFailed, m.code || 'failed'));
      }
    };
    worker.onerror = (ev) => {
      end(reject, heError(HE.noWebCodecs, 'worker', ev && ev.message));
    };
    worker.onmessageerror = () => end(reject, heError(HE.encodeFailed, 'message'));

    const transfer = [];
    if (audio) for (const c of audio.channels) transfer.push(c.buffer);
    if (camTable.rects) transfer.push(camTable.rects.buffer);
    if (camTable.rects2) transfer.push(camTable.rects2.buffer);
    worker.postMessage(
      {
        type: 'start',
        file,
        segments: o.compiled.segs.map((s) => [s.srcStart, s.srcEnd]),
        cam: camTable,
        width,
        height,
        fps,
        bitrate: o.bitrate,
        hasOverlay,
        overlayFrame: ovf ? { w: ovf.w, h: ovf.h } : null,
        audio,
        audioCfg,
        debug: o.debug || {},
      },
      transfer,
    );
    pumpOverlays();
  });
}

// ───────────────────────── גיבוי: <video> + canvas.captureStream + MediaRecorder ─────────────────────────
async function renderFallback(o) {
  const { file, width, height, fps, signal } = o;
  const n = o.frames;
  const segs = o.compiled.segs;
  const total = o.compiled.duration;
  const forceWebm = !!(o.debug && o.debug.forceWebm); // לבדיקות: מדמה דפדפן שאין בו mp4 ב־MediaRecorder
  const pick = typeof MediaRecorder === 'function' ? pickRecorderMime((m) => MediaRecorder.isTypeSupported(m) && (!forceWebm || m.startsWith('video/webm'))) : null;
  if (!pick || typeof HTMLCanvasElement === 'undefined' || !HTMLCanvasElement.prototype.captureStream) throw heError(HE.recorderUnsupported, 'unsupported');

  const camTable = sampleCamera(o.camera, n, fps);
  const url = URL.createObjectURL(file);
  const host = hiddenHost();
  const LEAD = 0.25;
  let recorder = null;
  let actx = null;
  let asrc = null;
  let timer = 0;
  const cleanup = () => {
    clearInterval(timer);
    try {
      if (asrc) asrc.stop();
    } catch (_) {
      /* לא התחיל */
    }
    try {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    } catch (_) {
      /* כבר נעצר */
    }
    for (const v of vids) {
      try {
        v.pause();
        v.removeAttribute('src');
        v.load();
      } catch (_) {
        /* בסדר */
      }
    }
    host.remove();
    URL.revokeObjectURL(url);
  };
  const vids = [makeVideoEl(host, url), makeVideoEl(host, url)];

  try {
    await Promise.all(vids.map((v) => once(v, 'loadedmetadata', 'error', 30000, 'metadata')));
    const vw = vids[0].videoWidth;
    const vh = vids[0].videoHeight;
    if (!vw || !vh) throw heError(HE.noVideo, 'novideo');

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    host.appendChild(canvas);
    const ctx = canvas.getContext('2d', { alpha: false });
    const comp = createCompositor({
      makeCanvas: (w, h) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        return c;
      },
      outW: width,
      outH: height,
    });
    const geom = { codedW: vw, codedH: vh, rotation: 0, dispW: vw, dispH: vh, outW: width, outH: height };

    // אילו אלמנטי וידאו משמשים לאיזה קטע: אותו אלמנט כשהמקור ממשיך ברצף, אחרת מתחלפים
    const elemOf = [];
    for (let k = 0; k < segs.length; k++) {
      if (k === 0) elemOf.push(0);
      else {
        const gap = segs[k].srcStart - segs[k - 1].srcEnd;
        elemOf.push(gap >= -0.001 && gap <= 0.04 ? elemOf[k - 1] : 1 - elemOf[k - 1]);
      }
    }

    // אודיו
    let audioClock = null;
    const stream = canvas.captureStream(fps);
    if (o.audio && o.audio.length > 0) {
      actx = getAudioContext();
      if (actx) {
        if (actx.state !== 'running') await Promise.race([actx.resume().catch(() => {}), sleep(800)]);
        if (actx.state === 'running') {
          const dest = actx.createMediaStreamDestination();
          asrc = actx.createBufferSource();
          asrc.buffer = o.audio;
          asrc.connect(dest);
          dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
          audioClock = true;
        }
      }
    }
    const recOpts = { mimeType: pick.mime, videoBitsPerSecond: o.bitrate };
    if (audioClock) recOpts.audioBitsPerSecond = 128000;
    recorder = new MediaRecorder(stream, recOpts);
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    const stopped = new Promise((resolve, reject) => {
      recorder.onstop = resolve;
      recorder.onerror = (e) => reject(heError(HE.encodeFailed, 'recorder', e && e.error));
    });

    // הכנה: הקטע הראשון
    const seekTo = (v, t) =>
      new Promise((resolve) => {
        const done = () => {
          v.removeEventListener('seeked', done);
          resolve();
        };
        v.addEventListener('seeked', done);
        v.currentTime = Math.max(0, t);
        setTimeout(done, 4000);
      });
    // פרה־רול: הנגן הראשון רץ מעט לפני תחילת הקטע, וההקלטה והקול מתחילים יחד בדיוק כשהוא מגיע אליו.
    // כך אין "פריים קפוא ושקט" בתחילת הקובץ, והקול והתמונה מיושרים כבר מההתחלה.
    const pre = Math.min(0.3, segs[0].srcStart);
    await seekTo(vids[0], segs[0].srcStart - pre);

    const playing = [false, false];
    const lastSeek = [0, 0];
    const startPlay = async (idx) => {
      const v = vids[idx];
      if (playing[idx]) return;
      playing[idx] = true;
      try {
        await v.play();
      } catch (e) {
        playing[idx] = false;
        throw heError(HE.playbackBlocked, 'playback', e);
      }
    };

    let playError = null;
    let prepared = -1; // הקטע הבא שכבר הוכן
    const prepareNext = (k) => {
      if (k >= segs.length || prepared >= k || elemOf[k] === elemOf[k - 1]) return;
      prepared = k;
      const idx = elemOf[k];
      playing[idx] = false;
      vids[idx].pause();
      seekTo(vids[idx], segs[k].srcStart - LEAD);
    };

    const useAudio = !!(asrc && actx);
    let audioT0 = 0;
    let wallT0 = 0;
    const clock = () => (useAudio ? actx.currentTime - audioT0 : (performance.now() - wallT0) / 1000);

    let lastDrawn = -1;
    let segK = 0;
    let lastK = 0;
    // overlayFrame: מרכיבים על קנבס עבודה, נותנים ל־overlay עותק של הפריים (במידה מוקטנת), ורק בסוף
    // מעתיקים לקנבס שמוקלט. כך ההקלטה לא תופסת פריים חצוי. overlay שמצייר שם שכבה אטומה מכסה את הווידאו.
    const frameMode = typeof o.overlay === 'function' && !!o.overlayFrame;
    let work = null;
    let wctx = null;
    let scratch = null;
    let sctx = null;
    let ovf = null;
    if (frameMode) {
      ovf = overlayFrameSize(width, height, o.overlayFrameScale);
      work = document.createElement('canvas');
      work.width = width;
      work.height = height;
      wctx = work.getContext('2d', { alpha: false });
      scratch = document.createElement('canvas');
      scratch.width = ovf.w;
      scratch.height = ovf.h;
      sctx = scratch.getContext('2d');
      scratch.close = () => {}; // ה־overlay רשאית לקרוא ל־frame.close() כמו ב־ImageBitmap
    }
    let busy = false;
    const drawVideo = (target, i, k) => {
      const v = vids[elemOf[k]];
      if (v.readyState >= 2) {
        geom.codedW = geom.dispW = v.videoWidth;
        geom.codedH = geom.dispH = v.videoHeight;
        comp.draw(target, v, geom, opsForFrame(camTable, i, geom));
      }
    };
    const draw = (i, k) => {
      if (!frameMode) {
        drawVideo(ctx, i, k);
        if (typeof o.overlay === 'function') {
          try {
            o.overlay(ctx, i / fps, i);
          } catch (e) {
            if (i === 0) console.warn('[render] שגיאה בציור שכבת העל:', e);
          }
        }
        return null;
      }
      busy = true;
      drawVideo(wctx, i, k);
      sctx.drawImage(work, 0, 0, ovf.w, ovf.h);
      return (async () => {
        try {
          await o.overlay(wctx, i / fps, i, scratch);
        } catch (e) {
          if (i === 0) console.warn('[render] שגיאה בציור שכבת העל:', e);
        }
        ctx.drawImage(work, 0, 0);
      })().finally(() => {
        busy = false;
      });
    };

    await startPlay(elemOf[0]);
    const waitUntil = performance.now() + 2500;
    while (vids[elemOf[0]].currentTime < segs[0].srcStart - 0.005 && performance.now() < waitUntil) {
      throwIfAborted(signal);
      await sleep(3);
    }
    prepareNext(1);
    await draw(0, 0);
    lastDrawn = 0;
    recorder.start(1000);
    if (useAudio) {
      audioT0 = actx.currentTime + 0.03;
      asrc.start(audioT0);
    } else {
      wallT0 = performance.now() + 30;
    }

    await new Promise((resolve, reject) => {
      const onAbort = () => reject(abortError());
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      let lastProgress = 0;
      timer = setInterval(() => {
        try {
          if (playError) throw playError;
          const t = clock();
          if (t < 0) return;
          if (t >= total) {
            resolve();
            return;
          }
          while (segK + 1 < segs.length && t >= segs[segK + 1].outStart) segK++;
          if (segK !== lastK) {
            // עברנו קטע: משחררים את האלמנט הקודם כדי שיוכן לקטע הבא
            const prevIdx = elemOf[lastK];
            if (prevIdx !== elemOf[segK]) {
              vids[prevIdx].pause();
              playing[prevIdx] = false;
            }
            lastK = segK;
          }
          const seg = segs[segK];
          const idx = elemOf[segK];
          const v = vids[idx];
          // מתחילים לנגן את הקטע הבא מעט לפני הגבול, כדי שהחיתוך יהיה רציף
          if (segK + 1 < segs.length && elemOf[segK + 1] !== idx) {
            prepareNext(segK + 1);
            if (t >= segs[segK + 1].outStart - LEAD) startPlay(elemOf[segK + 1]).catch((e) => (playError = e));
          }
          if (!playing[idx]) startPlay(idx).catch((e) => (playError = e));
          // סנכרון: השעון הוא האודיו. סטייה קטנה מתוקנת בהאצה עדינה, גדולה בקפיצה
          const want = seg.srcStart + (t - seg.outStart);
          const now = performance.now();
          if (playing[idx] && v.readyState >= 2) {
            const err = v.currentTime - want;
            if (Math.abs(err) > 0.25) {
              if (now - lastSeek[idx] > 600) {
                lastSeek[idx] = now;
                v.currentTime = want;
              }
            } else {
              const rate = Math.abs(err) < 0.015 ? 1 : clamp(1 - err * 1.2, 0.85, 1.15);
              if (Math.abs(v.playbackRate - rate) > 0.01) v.playbackRate = rate;
            }
          }
          const i = Math.min(n - 1, Math.floor(t * fps + 1e-6));
          if (i !== lastDrawn && !busy) {
            lastDrawn = i;
            draw(i, segK);
          }
          if (now - lastProgress > 120) {
            lastProgress = now;
            o.report((t / total) * 0.98);
          }
        } catch (e) {
          reject(e);
        }
      }, 6);
    });
    clearInterval(timer);
    await sleep(90);
    recorder.stop();
    await stopped;
    const mime = recorder.mimeType || pick.mime;
    const blob = new Blob(chunks, { type: mime.split(';')[0] });
    blob.frameInfo = {
      path: 'mediarecorder',
      container: extForMime(mime),
      ext: extForMime(mime),
      mime,
      realtime: true,
      audio: !!useAudio,
      overlayFrame: frameMode,
      width,
      height,
      fps,
      frames: n,
      duration: total,
      bitrate: o.bitrate,
    };
    return blob;
  } finally {
    cleanup();
  }
}

