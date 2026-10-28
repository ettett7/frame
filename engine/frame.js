// frame.js: smart framing in the browser (the phone version of reframe.py).
//   analyzeFaces(file, start, end, {fps, onProgress, signal}) -> FaceSamples   (MediaPipe FaceLandmarker in a worker, a hidden <video> for the pictures)
//   cameraFor(samples, plan, {outW, outH, layout}) -> Camera                   (pure: node can run it)
// Same ideas as reframe.py: a virtual 9:16 (or 4:5 / 1:1 / 16:9) camera follows the active speaker (mouth movement), glides inside a shot and cuts between far-apart speakers,
// splits the screen for a two-person conversation, and shows the whole picture on a blurred background when there is no stable face.
// Everything the module touches in the browser is created inside analyzeFaces(), so importing it (and cameraFor) works in node.

export const MEDIAPIPE_VERSION = '0.10.35';
export const MEDIAPIPE_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;
export const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

// ----------------------------------------------------------------------------------------------------------------- constants (from reframe.py)
const SCENE = 12;          // frame-change score (percent) that counts as a cut
const MINSHOT = 0.3;       // cuts closer than this are one cut
const HOLD = 1.4;          // minimum seconds on a speaker before switching
const HARD = 0.3;          // speaker switch farther than this x crop width is a hard cut, not a pan
const MINACT = 0.015;      // mouth activity that counts as speech
const FACEMIN = 0.35;      // share of samples with faces below which the clip is shown whole on a blurred background
const PUNCH = 1.12, PUSH = 0.06, ZMAX = 1.2;
const SPLITMIN = 5, SPLITGAP = 3, SPLITEDGE = 2, SPLITFACE = 0.08, SPLITZ = 0.27, DIV = 6;
const SMOOTH = [[0.7, 0.12, 0.03, 0.8], [1.0, 0.12, 0.03, 0.3]];   // per axis: smooth time s, dead-zone enter, leave (x size), max speed (size/s)
export const CAMERA_FPS = 30;

// ----------------------------------------------------------------------------------------------------------------- small helpers
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const ss = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };
function bisectLeft(a, x, lo = 0, hi = a.length) { while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
function bisectRight(a, x, lo = 0, hi = a.length) { while (lo < hi) { const m = (lo + hi) >> 1; if (x < a[m]) hi = m; else lo = m + 1; } return lo; }
const framesOf = (ts, fps) => [...new Set(ts.map((t) => Math.max(0, Math.ceil(t * fps - 2e-3))))].sort((a, b) => a - b);
const p90 = (v) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]; };
const median = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; };
const abortError = () => { const e = new Error('הפעולה בוטלה'); e.name = 'AbortError'; return e; };

/** Output size of the two halves of a split picture: both halves an even number of rows, the divider takes the rest. */
export function halves(outH) {
  const hh = Math.floor(Math.floor((outH - DIV) / 2) / 2) * 2;
  return { hh, divider: outH - 2 * hh };
}

// ----------------------------------------------------------------------------------------------------------------- faces from landmarks
/** Face box (normalized) and mouth openness (inner-lip gap / face height) of one MediaPipe face: lm = 478 {x,y,z} landmarks, 13/14 = inner lips. */
export function faceOf(lm) {
  if (!lm || lm.length < 15) return null;
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (let i = 0; i < lm.length; i++) {
    const p = lm[i];
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
  }
  const w = x1 - x0, h = y1 - y0;
  if (!(w > 0 && h > 0)) return null;
  // the landmarks stop at the hairline and the chin: give the box the forehead and the sides that Vision's face rectangles have
  const top = Math.max(0, y0 - 0.1 * h), side = 0.04 * w;
  const bx = Math.max(0, x0 - side), bw = Math.min(1, x1 + side) - bx, bh = y1 - top;
  return { x: bx, y: top, w: bw, h: bh, mouth: Math.min(1, Math.abs(lm[14].y - lm[13].y) / h) };
}

// ----------------------------------------------------------------------------------------------------------------- frame-change (cuts) and ids
/** Mean absolute difference of two luma thumbnails, in percent of full scale. */
export function lumaDiff(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += Math.abs(a[i] - b[i]);
  return n ? (s / n) * (100 / 255) : 0;
}

/** Cut times from the frame-change of consecutive samples: [{t, d}] -> [t]. Same rule as ffmpeg's scdet: min(change, change of the change) >= SCENE; the cut is put in the middle of the gap. */
export function cutsFromDiffs(diffs, minGap = MINSHOT) {
  const out = [];
  let prevD = 0, prevT = null;
  for (const { t, d } of diffs) {
    const score = Math.min(d, Math.abs(d - prevD));
    if (prevT !== null && score >= SCENE) {
      const c = (prevT + t) / 2;
      if (!out.length || c - out[out.length - 1] >= minGap) out.push(c);
    }
    prevD = d; prevT = t;
  }
  return out;
}

/** Gives every face an `id` that stays the same for the same person from sample to sample (tracks never cross a cut). Mutates and returns `samples`. */
export function assignIds(samples, cuts = [], aspect = 16 / 9) {
  const cs = [...cuts].sort((a, b) => a - b);
  let live = [], prevT = null, next = 1;
  for (const s of samples) {
    if (prevT !== null && bisectRight(cs, s.t) > bisectRight(cs, prevT)) live = [];
    const pairs = [];
    s.faces.forEach((f, j) => {
      const cx = (f.x + f.w / 2) * aspect, cy = f.y + f.h / 2, w = f.w * aspect;
      for (const tr of live) {
        const dt = s.t - tr.t;
        if (dt > 0.9) continue;
        const d = Math.hypot(cx - tr.cx, cy - tr.cy) / Math.max(w, tr.w, 1e-6);
        const r = w / Math.max(tr.w, 1e-6);
        if (d < 0.9 + 1.6 * dt && r > 0.5 && r < 2) pairs.push({ d, j, tr });
      }
    });
    pairs.sort((a, b) => a.d - b.d);
    const used = new Set(), taken = new Set();
    for (const { j, tr } of pairs) {
      if (used.has(j) || taken.has(tr.id)) continue;
      used.add(j); taken.add(tr.id);
      const f = s.faces[j];
      f.id = tr.id;
      Object.assign(tr, { t: s.t, cx: (f.x + f.w / 2) * aspect, cy: f.y + f.h / 2, w: f.w * aspect });
    }
    s.faces.forEach((f, j) => {
      if (used.has(j)) return;
      f.id = next++;
      live.push({ id: f.id, t: s.t, cx: (f.x + f.w / 2) * aspect, cy: f.y + f.h / 2, w: f.w * aspect });
    });
    live = live.filter((tr) => s.t - tr.t <= 0.9);
    prevT = s.t;
  }
  return samples;
}

// ----------------------------------------------------------------------------------------------------------------- small faces
// MediaPipe's detector looks at the picture squeezed into 128 x 128: it finds faces that are at least about a tenth of the picture high. In a wide shot of two people sitting back (a podcast, an
// interview) the faces are half of that. So, on wide pictures, faces that were seen small are looked at again in a crop around them (ROI), and while none is known a row of tiles is searched now and then.

/** Intersection over union of two boxes {x, y, w, h}. */
export function iou(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0), u = a.w * a.h + b.w * b.h - i;
  return u > 0 ? i / u : 0;
}

/** Faces found in the whole picture and in crops -> one list in picture coordinates. parts = [{faces, rect | null}], rect = the crop {x, y, w, h} in the picture (normalized); the first part wins a duplicate. */
export function mergeFaces(parts, nms = 0.3) {
  const out = [];
  for (const { faces, rect } of parts) {
    for (const f of faces) {
      const g = rect ? { x: rect.x + f.x * rect.w, y: rect.y + f.y * rect.h, w: f.w * rect.w, h: f.h * rect.h, mouth: f.mouth } : { ...f };
      const cx = g.x + g.w / 2, cy = g.y + g.h / 2;
      if (!out.some((o) => iou(o, g) > nms || (Math.abs(o.x + o.w / 2 - cx) < 0.4 * Math.max(o.w, g.w) && Math.abs(o.y + o.h / 2 - cy) < 0.4 * Math.max(o.h, g.h)))) out.push(g);
    }
  }
  return out;
}

/** The crop to look at again around a face: a square (in pixels) k times the face, normalized in the picture. aspect = picture width / height. */
export function roiRect(face, aspect, k = 3.2, minSide = 0.14) {
  const side = clamp(Math.max(face.h, face.w / aspect) * k, minSide, 1);
  const w = Math.min(1, side / aspect), h = side;
  return { x: clamp(face.x + face.w / 2 - w / 2, 0, 1 - w), y: clamp(face.y + face.h / 2 - h / 2, 0, 1 - h), w, h };
}

/** A row of overlapping square tiles across the band where faces sit in a wide picture. */
export function searchRects(aspect, side = 0.5, top = 0.16) {
  const w = side / aspect, rects = [], step = w * 0.7;
  if (w >= 1) return [{ x: 0, y: top, w: 1, h: side }];
  for (let x = 0; x + w < 1 - 1e-9; x += step) rects.push({ x, y: top, w, h: side });
  rects.push({ x: 1 - w, y: top, w, h: side });
  return rects;
}

/** Which crops to look at for the next sample: ROIs around the small faces known, and (picture wide) a tile search every `every` samples while nothing is known, every 10 while something is. */
export function planCrops(known, index, aspect, { bigFace = 0.2, every = 4 } = {}) {
  if (aspect < 1.3) return [];
  const rects = known.filter((f) => f.h < bigFace).map((f) => roiRect(f, aspect));
  if (index % (known.length ? 10 : every) === 0) rects.push(...searchRects(aspect));
  return rects;
}

// ----------------------------------------------------------------------------------------------------------------- the detector (a worker, or this thread when workers cannot run it)
/** Runs MediaPipe's classic WASM loader script in the global scope of a module worker (what importScripts would have done), so `ModuleFactory` exists when the model is created. */
async function primeModuleWorker(fileset) {
  const inWorker = typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope;
  if (!inWorker || self.ModuleFactory || !fileset?.wasmLoaderPath) return;
  const r = await fetch(fileset.wasmLoaderPath);
  if (!r.ok) throw new Error(`wasm loader ${r.status}`);
  (0, eval)(await r.text());
}

/** MediaPipe FaceLandmarker (IMAGE mode). Used by frame.worker.js and as the main-thread fallback. -> {delegate, loader, ms, detect(bitmap, tsMs, crops) -> Promise<faces[]>, close()} */
export async function createDetector({ base = MEDIAPIPE_BASE, model = FACE_MODEL, delegate = 'GPU', numFaces = 3, moduleWorker = false, ways = null } = {}) {
  const t0 = performance.now();
  const { FaceLandmarker, FilesetResolver } = await import(`${base}/vision_bundle.mjs`);
  const make = (fileset, d, mode) => FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: model, delegate: d },
    runningMode: mode, numFaces,
    outputFaceBlendshapes: false, outputFacialTransformationMatrixes: false,
    minFaceDetectionConfidence: 0.35, minFacePresenceConfidence: 0.35, minTrackingConfidence: 0.35,
  });
  // In a module worker MediaPipe cannot load its WASM loader (a classic script, which it expects importScripts for) and fails with "ModuleFactory not set". Two ways round it, tried in turn:
  //   'module': the ES-module build of the loader that ships in the package;  'prime': run the classic loader in the worker's global scope ourselves before the model is created.
  const order = ways || (moduleWorker ? ['module', 'prime'] : ['default']);
  let used = delegate, lm = null, loader = null, lastErr = null;
  for (const way of order) {
    try {
      const fileset = await FilesetResolver.forVisionTasks(`${base}/wasm`);
      if (way === 'module') {
        fileset.wasmLoaderPath = `${base}/wasm/vision_wasm_module_internal.js`;
        fileset.wasmBinaryPath = `${base}/wasm/vision_wasm_module_internal.wasm`;
      } else if (way === 'prime') await primeModuleWorker(fileset);
      try { lm = await make(fileset, delegate, 'IMAGE'); used = delegate; } catch (err) {
        if (delegate !== 'GPU') throw err;
        lm = await make(fileset, 'CPU', 'IMAGE'); used = 'CPU';        // no WebGL here: the WASM build still works
      }
      loader = way;
      break;
    } catch (err) { lastErr = err; }
  }
  if (!lm) throw lastErr || new Error('MediaPipe');
  // IMAGE mode, one landmarker for the whole picture and for the crops: a second instance in a module worker cannot load MediaPipe's WASM a second time, and VIDEO mode's tracking between
  // unrelated crops would only confuse it. (The samples are 0.2 s apart: there is little for the tracker to reuse anyway.)
  const facesOf = (res) => { const faces = []; for (const l of res.faceLandmarks || []) { const f = faceOf(l); if (f) faces.push(f); } return faces; };
  return {
    delegate: used, loader, ms: performance.now() - t0,
    /** The whole picture and, when given, crops [{bitmap, rect}] -> faces in picture coordinates. */
    async detect(bitmap, _tsMs, crops = []) {
      const parts = [{ faces: facesOf(lm.detect(bitmap)), rect: null }];
      for (const c of crops) { parts.push({ faces: facesOf(lm.detect(c.bitmap)), rect: c.rect }); c.bitmap.close?.(); }
      return crops.length ? mergeFaces(parts) : parts[0].faces;
    },
    close() { try { lm.close(); } catch (_) { /* closed already */ } },
  };
}

class FaceWorker {
  constructor(opts) { this.opts = opts; this.pending = new Map(); this.id = 0; this.delegate = null; this.mode = null; }
  async init() {
    const o = this.opts;
    if (o.useWorker !== false && typeof Worker !== 'undefined') {
      try {
        this.worker = new Worker(new URL('./frame.worker.js', import.meta.url), { type: 'module' });
        await new Promise((resolve, reject) => {
          this.worker.onerror = (e) => reject(new Error(e.message || 'worker'));
          this.worker.onmessage = (e) => {
            const m = e.data;
            if (m.type === 'ready') { this.delegate = m.delegate; this.loader = m.loader; this.mode = 'worker'; this.initMs = m.ms; resolve(); }
            else if (m.type === 'error') reject(new Error(m.message));
          };
          this.worker.postMessage({ type: 'init', base: o.base, model: o.model, delegate: o.delegate, numFaces: o.numFaces, ways: o.ways });
        });
        this.worker.onerror = (e) => this.failAll(new Error(e.message || 'worker'));
        this.worker.onmessage = (e) => this.onMessage(e.data);
        return;
      } catch (err) {
        try { this.worker?.terminate(); } catch (_) { /* gone */ }
        this.worker = null;
        this.workerError = String(err && err.message || err);
      }
    }
    this.det = await createDetector(o);               // fallback: the same detector on this thread
    this.delegate = this.det.delegate; this.loader = this.det.loader; this.mode = 'main'; this.initMs = this.det.ms;
  }
  onMessage(m) {
    const p = this.pending.get(m.id);
    if (m.type === 'faces' && p) { this.pending.delete(m.id); p.resolve({ faces: m.faces, ms: m.ms }); }
    else if (m.type === 'error' && p) { this.pending.delete(m.id); p.reject(new Error(m.message)); }
  }
  failAll(err) { for (const p of this.pending.values()) p.reject(err); this.pending.clear(); }
  /** bitmap = the whole picture, crops = [{bitmap, rect}] -> Promise<{faces, ms}> */
  detect(bitmap, tsMs, crops = []) {
    const id = ++this.id;
    if (this.worker) {
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.worker.postMessage({ type: 'frame', id, ts: tsMs, bitmap, crops }, [bitmap, ...crops.map((c) => c.bitmap)]);
      });
    }
    const t0 = performance.now();
    return this.det.detect(bitmap, tsMs, crops).then((faces) => ({ faces, ms: performance.now() - t0 })).finally(() => bitmap.close?.());
  }
  close() {
    try { this.worker?.postMessage({ type: 'close' }); } catch (_) { /* gone */ }
    setTimeout(() => { try { this.worker?.terminate(); } catch (_) { /* gone */ } }, 200);
    try { this.det?.close(); } catch (_) { /* gone */ }
  }
}

/** Several detectors side by side: a frame goes to the one with the fewest waiting. (Each has its own copy of the model: memory for speed.) */
class FacePool {
  constructor(opts, n) { this.items = Array.from({ length: Math.max(1, n) }, () => new FaceWorker(opts)); }
  async init() { await Promise.all(this.items.map((w) => w.init())); }
  get delegate() { return this.items[0].delegate; }
  get mode() { return this.items[0].mode; }
  get loader() { return this.items[0].loader; }
  get initMs() { return Math.max(...this.items.map((w) => w.initMs || 0)); }
  get workerError() { return this.items.map((w) => w.workerError).find(Boolean) || null; }
  get size() { return this.items.length; }
  detect(bitmap, ts, crops) {
    let best = this.items[0];
    for (const w of this.items) if (w.pending.size < best.pending.size) best = w;
    return best.detect(bitmap, ts, crops);
  }
  close() { this.items.forEach((w) => w.close()); }
}

// ----------------------------------------------------------------------------------------------------------------- pictures from the video
const LUMA_W = 32, LUMA_H = 18, CROP = 192, CUT_FPS = 15;

function once(el, ev, errEv = 'error') {
  return new Promise((resolve, reject) => {
    const ok = () => { el.removeEventListener(ev, ok); el.removeEventListener(errEv, bad); resolve(); };
    const bad = () => { el.removeEventListener(ev, ok); el.removeEventListener(errEv, bad); reject(new Error('לא ניתן לפענח את הסרטון בדפדפן הזה')); };
    el.addEventListener(ev, ok); el.addEventListener(errEv, bad);
  });
}

/** After a seek: wait until the new picture can be drawn. */
async function seekTo(video, t) {
  const done = once(video, 'seeked');
  video.currentTime = t;
  await done;
  if (!video.requestVideoFrameCallback) return false;
  // Safari draws the old picture right after "seeked": wait for the frame that is really presented. (-> whether requestVideoFrameCallback answered at all)
  return new Promise((resolve) => { const to = setTimeout(() => resolve(false), 250); video.requestVideoFrameCallback(() => { clearTimeout(to); resolve(true); }); });
}

/**
 * Where the speed goes on a phone, measured by benchmarkDecoders(): 'seek' = set currentTime for every sample (each seek decodes from the keyframe before it),
 * 'play' = let the video play fast and take the frames requestVideoFrameCallback hands out (the decoder runs straight through, nothing is decoded twice).
 */
function makeGrabber(video, W, H, maxSide) {
  const sc = Math.min(1, maxSide / Math.max(W, H));
  const sw = Math.max(16, Math.round(W * sc)), sh = Math.max(16, Math.round(H * sc));
  const mk = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));
  const big = mk(sw, sh), tiny = mk(LUMA_W, LUMA_H);
  const cc = mk(CROP, CROP);
  const bctx = big.getContext('2d', { alpha: false }), tctx = tiny.getContext('2d', { willReadFrequently: true, alpha: false }), cctx = cc.getContext('2d', { alpha: false });
  return {
    sw, sh,
    /** Draws the current picture for the detector: -> {bitmap}. Synchronous: call it while the frame is current. */
    grab() {
      bctx.drawImage(video, 0, 0, sw, sh);
      const bitmap = big.transferToImageBitmap ? big.transferToImageBitmap() : null;
      return { bitmap: bitmap || big, isCanvas: !bitmap };
    },
    /** A 32 x 18 luma thumbnail of the current picture (for the cut detector; much cheaper than a detection, so it can look at more pictures). */
    luma() {
      tctx.drawImage(video, 0, 0, LUMA_W, LUMA_H);
      const px = tctx.getImageData(0, 0, LUMA_W, LUMA_H).data, luma = new Uint8Array(LUMA_W * LUMA_H);
      for (let i = 0, j = 0; i < px.length; i += 4, j++) luma[j] = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
      return luma;
    },
    async bitmapOf(g) { return g.isCanvas ? createImageBitmap(g.bitmap) : g.bitmap; },
    /** A square-in-pixels crop {x, y, w, h} (normalized) of the current picture at source resolution -> ImageBitmap (or a promise of one). */
    crop(r) {
      cctx.drawImage(video, r.x * W, r.y * H, r.w * W, r.h * H, 0, 0, CROP, CROP);
      return cc.transferToImageBitmap ? cc.transferToImageBitmap() : createImageBitmap(cc);
    },
  };
}

/**
 * Analyse the faces of file[start, end]. -> FaceSamples = { fps, width, height, duration, samples: [{t, faces: [{x, y, w, h, mouth, id}]}], cuts: [t], stats }
 * (normalized in the source picture, times in source seconds). `cuts` are the scene changes found on the way (cameraFor uses them).
 * opts: fps (5), onProgress(fraction, textHe), signal, decoder ('auto' | 'play' | 'seek'), delegate ('GPU' | 'CPU'), numFaces (3), maxSide (480), rate (first playback speed, 4), ways (how MediaPipe's WASM loader is loaded in the worker: ['module', 'prime'] by default), workers (detectors side by side: 'auto' = 2 on a device with 6 cores or more that is not an iPhone, else 1), small (look for small faces in crops, true), debug, useWorker.
 */
export async function analyzeFaces(file, start = 0, end = Infinity, opts = {}) {
  const { fps = 5, onProgress, signal, decoder = 'auto', delegate = 'GPU', numFaces = 3, maxSide = 480, rate: rate0 = 4, small = true } = opts;
  const say = (f, t) => { try { onProgress?.(clamp(f, 0, 1), t); } catch (_) { /* the caller's problem */ } };
  const check = () => { if (signal?.aborted) throw abortError(); };
  check();
  if (typeof document === 'undefined') throw new Error('ניתוח פנים פועל רק בדפדפן');
  const T0 = performance.now();
  const url = typeof file === 'string' ? file : URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true; video.defaultMuted = true; video.playsInline = true; video.preload = 'auto';
  video.setAttribute('playsinline', ''); video.setAttribute('muted', '');
  Object.assign(video.style, { position: 'fixed', left: '0', top: '0', width: '2px', height: '2px', opacity: '0.01', pointerEvents: 'none' });
  document.body.appendChild(video);
  const nWorkers = opts.workers === 'auto' || opts.workers === undefined ? defaultWorkers() : Math.max(1, opts.workers | 0);
  const det = new FacePool({ base: opts.base || MEDIAPIPE_BASE, model: opts.model || FACE_MODEL, delegate, numFaces, useWorker: opts.useWorker, ways: opts.ways }, nWorkers);
  const onAbort = () => { try { video.pause(); } catch (_) { /* gone */ } };
  signal?.addEventListener('abort', onAbort);
  try {
    say(0, 'פותחים את הסרטון…');
    const ph = { start: 0 };
    const loaded = once(video, 'loadedmetadata');
    video.src = url;
    const initP = det.init();                       // the model loads while the video opens
    initP.catch(() => {});
    await loaded;
    ph.open = performance.now() - T0;
    check();
    const W = video.videoWidth, H = video.videoHeight, duration = video.duration;
    if (!W || !H || !(duration > 0)) throw new Error('לא ניתן לקרוא את הסרטון');
    const a = clamp(+start || 0, 0, duration), b = clamp(Number.isFinite(+end) ? +end : duration, 0, duration);
    if (!(b - a > 0.05)) throw new Error('טווח הניתוח ריק');
    const canPlay = typeof video.requestVideoFrameCallback === 'function';
    let mode = decoder === 'auto' ? (readChoice() || (canPlay ? 'play' : 'seek')) : decoder;
    const mode0 = mode === 'play' ? 'play' : 'seek';
    say(0.02, 'טוענים את מודל זיהוי הפנים…');
    await initP.catch((e) => { throw new Error('טעינת מודל זיהוי הפנים נכשלה. בדקו את החיבור לאינטרנט ונסו שוב'); });
    ph.model = performance.now() - T0;
    check();
    const rvfcLive = await seekTo(video, mode0 === 'play' ? Math.max(0, a - Math.min(1, a)) : a);       // (a play pass starts a little before the range: see runPlay)
    ph.seek = performance.now() - T0;                 // false: this browser never calls requestVideoFrameCallback (an embedded view, an unseen tab): the playing clock is polled instead
    const grabber = makeGrabber(video, W, H, maxSide);
    const step = 1 / fps, raw = [], diffs = [];
    let prevLuma = null, searchNow = false, firstErr = null, known = [], nCrops = 0, inflight = 0, drops = 0, grabMs = 0, inferMs = 0, nFrames = 0, usedDecoder = decoder, usedPolling = false;
    const waiters = [];
    const release = () => { inflight--; waiters.splice(0).forEach((f) => f()); };
    const cap = nWorkers + 1;                                     // pictures in flight: one per detector and one being drawn
    const room = async (max) => { while (inflight >= max) { check(); await new Promise((r) => waiters.push(r)); } };
    const progress = (t) => say(0.05 + 0.93 * clamp((t - a) / (b - a), 0, 1), `מזהים פנים בשנייה ${Math.floor(t - a)} מתוך ${Math.ceil(b - a)}…`);

    /** The cut detector looks at about 15 pictures a second, whatever the detector can follow: the middle of the gap between two of them is the cut (an error of 30 ms). */
    const lumaTick = (t) => {
      const l = grabber.luma();
      const d = prevLuma ? lumaDiff(prevLuma, l) : 0;
      diffs.push({ t, d });
      prevLuma = l;
      if (d >= 2 * SCENE) { known = []; searchNow = true; }          // a new shot: the faces of the last one are gone, look for the new ones right away
    };
    /** One picture for the detector: draw now (the frame is current), detect in the background. */
    const take = (t) => {
      const g0 = performance.now();
      const g = grabber.grab();
      grabMs += performance.now() - g0;
      const rects = small ? planCrops(known, searchNow ? 0 : nFrames, W / H) : [];
      searchNow = false;
      const cropBms = rects.map((rect) => grabber.crop(rect));             // drawn now, while this picture is the current one
      const rec = { t, faces: [], nc: rects.length, nk: known.length };
      raw.push(rec);
      inflight++;
      nFrames++; nCrops += rects.length;
      Promise.all([grabber.bitmapOf(g), ...cropBms]).then(([bm, ...cb]) => det.detect(bm, Math.round(t * 1000) + raw.length, cb.map((bitmap, i) => ({ bitmap, rect: rects[i] }))))   // ms stamps must grow: the index keeps two samples of one ms apart
        .then((r) => {
          rec.faces = r.faces; inferMs += r.ms;
          known = r.faces.length ? r.faces.map((f) => ({ ...f, t })) : known.filter((f) => t - f.t < 1);
        }, (e) => { rec.error = e; firstErr = firstErr || e; })
        .finally(release);
      progress(t);
    };

    const runSeek = async (from) => {
      for (let t = from; t < b - 1e-6; t += step) {
        check();
        await room(cap);
        await seekTo(video, Math.min(t, b - 0.001));
        lumaTick(video.currentTime);
        take(video.currentTime);
      }
    };

    const runPlay = async (from) => {
      let rate = clamp(rate0, 1, 16), nextT = from, nextLuma = from, lastTick = performance.now(), stalled = false, winTaken = 0, winDrops = 0, rvfcSeen = 0, polling = false, done = false;
      const pre = Math.min(1, from);                              // the first seek already went a little before the range: the first pictures after a play() lag the clock
      let warmed = pre >= 0.5;                                    // no room for a pre-roll (the range starts at the start): play the first second at normal speed instead
      video.playbackRate = warmed ? rate : 1;
      const t0 = performance.now();
      await video.play();
      await new Promise((resolve, reject) => {
        let timer = 0, watchdog = 0, lateStart = 0;
        const finish = (err) => {
          if (done) return; done = true; clearInterval(watchdog); clearTimeout(timer); clearTimeout(lateStart);
          try { video.pause(); } catch (_) { /* gone */ }
          err ? reject(err) : resolve();
        };
        /** A picture is on screen at time t: sample it when it is time. */
        const tick = (t) => {
          lastTick = performance.now();
          if (!warmed && t >= from + 1) { warmed = true; video.playbackRate = rate; }
          if (t < from - 0.02) return;                               // the pre-roll: the decoder is still warming up, its pictures are not where the clock says
          if (signal?.aborted) return finish(abortError());
          if (t >= b - 1e-3 || video.ended) return finish();
          if (t >= nextLuma - 0.5 / 60) { lumaTick(t); nextLuma = Math.max(nextLuma + 1 / CUT_FPS, t + 0.5 / CUT_FPS); }
          if (t >= nextT - 0.5 / Math.max(24, fps)) {
            if (inflight >= cap) { drops++; winDrops++; }              // the detector is behind: skip this one and slow down
            else { take(t); winTaken++; }
            nextT = Math.max(nextT + step, t + step * 0.5);
            if (winTaken + winDrops >= 6) {                           // adapt the speed to what the detector can follow
              rate = clamp(winDrops ? rate * 0.7 : rate * 1.25, 1, 16);
              if (warmed) video.playbackRate = rate;
              winTaken = winDrops = 0;
            }
          }
        };
        const cb = (now, md) => { if (done) return; rvfcSeen++; tick(md.mediaTime); video.requestVideoFrameCallback(cb); };
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(cb);
        // some browsers (a tab nobody sees, an embedded view) play the video without ever calling requestVideoFrameCallback: then the clock is read by polling
        const poll = () => { if (done) return; tick(video.currentTime); timer = setTimeout(poll, 4); };
        if (!rvfcLive) { polling = true; poll(); } else lateStart = setTimeout(() => { if (!done && !rvfcSeen) { polling = true; poll(); } }, 1500);
        watchdog = setInterval(() => {                                // frames stopped (a hidden tab, a decoder that gave up): hand the rest to seeking
          if (performance.now() - lastTick > 2500 && performance.now() - t0 > 3000) { clearTimeout(lateStart); stalled = true; finish(); }
        }, 500);
        video.addEventListener('ended', () => finish(), { once: true });
      });
      usedPolling = polling;
      if (stalled) { usedDecoder = 'seek'; return nextT; }
      return b;
    };

    usedDecoder = mode;
    if (mode === 'play') {
      let resume;
      try { resume = await runPlay(a); } catch (e) { if (e.name === 'AbortError') throw e; resume = raw.length ? raw[raw.length - 1].t + step : a; usedDecoder = 'seek'; }
      if (resume < b - step) { await seekTo(video, resume); await runSeek(resume); }
    } else {
      await runSeek(a);
    }
    while (inflight > 0) { check(); await new Promise((r) => waiters.push(r)); }
    const failed = raw.filter((r) => r.error);
    if (failed.length > raw.length / 2) { const e = new Error('זיהוי הפנים נכשל בדפדפן הזה'); e.detail = String(failed[0].error?.message || failed[0].error); console.warn('frame.js: detection failed:', e.detail); throw e; }
    raw.sort((x, y) => x.t - y.t);
    diffs.sort((x, y) => x.t - y.t);
    const cuts = cutsFromDiffs(diffs);
    const samples = raw.map((r) => ({ ...(opts.debug ? { nc: r.nc, nk: r.nk } : {}), t: +r.t.toFixed(3), faces: r.faces.map((f) => ({ x: +f.x.toFixed(4), y: +f.y.toFixed(4), w: +f.w.toFixed(4), h: +f.h.toFixed(4), mouth: +f.mouth.toFixed(4) })) }));
    assignIds(samples, cuts, W / H);
    const seconds = (performance.now() - T0) / 1000;
    say(1, 'זיהוי הפנים הסתיים');
    return {
      fps, width: W, height: H, duration: b - a, source: { start: a, end: b }, samples, cuts: cuts.map((c) => +c.toFixed(3)), ...(opts.debug ? { diffs } : {}),
      stats: {
        seconds, perVideoSecond: seconds / (b - a), decoder: usedDecoder, polling: usedPolling, delegate: det.delegate, workers: det.size, workerMode: det.mode, loader: det.loader, workerError: det.workerError || null,
        phases: { openMs: ph.open, modelMs: ph.model, seekMs: ph.seek, passMs: performance.now() - T0 - ph.seek },
        frames: nFrames, crops: nCrops, drops, modelMs: det.initMs, grabMsPerFrame: grabMs / Math.max(1, nFrames), inferMsPerFrame: inferMs / Math.max(1, nFrames), failedFrames: failed.length, firstError: firstErr ? String(firstErr.message || firstErr) : null,
        picture: `${grabber.sw}x${grabber.sh}`,
      },
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try { video.pause(); } catch (_) { /* gone */ }
    video.removeAttribute('src'); video.load?.();
    video.remove();
    if (typeof file !== 'string') URL.revokeObjectURL(url);
    det.close();
  }
}

/** Two detectors side by side on a device with six cores or more, one anywhere else (an iPhone has memory for one or two, but gets hot: it gets one unless asked). */
export function defaultWorkers(nav = globalThis.navigator) {
  const cores = nav?.hardwareConcurrency || 4, ios = /iPhone|iPad|iPod/.test(nav?.userAgent || '') || (nav?.platform === 'MacIntel' && nav?.maxTouchPoints > 1);
  return !ios && cores >= 6 ? 2 : 1;
}

// The decoder that won the last benchmark is remembered on the device.
function readChoice() { try { const v = globalThis.localStorage?.getItem('frame.decoder'); return v === 'play' || v === 'seek' ? v : null; } catch (_) { return null; } }
function saveChoice(v) { try { globalThis.localStorage?.setItem('frame.decoder', v); } catch (_) { /* private mode */ } }

/**
 * Times both ways to get pictures out of the video on THIS device, on the first `seconds` of the file, and remembers the faster one for analyzeFaces({decoder:'auto'}).
 * -> {best, seek: {msPerSample, samples}, play: {msPerSample, samples}}. The detector is not involved: this is only the decoding and the drawing.
 */
export async function benchmarkDecoders(file, { seconds = 3, fps = 5, signal, maxSide = 480 } = {}) {
  if (typeof document === 'undefined') throw new Error('המדידה פועלת רק בדפדפן');
  const url = typeof file === 'string' ? file : URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.preload = 'auto'; video.setAttribute('playsinline', '');
  Object.assign(video.style, { position: 'fixed', left: '0', top: '0', width: '2px', height: '2px', opacity: '0.01', pointerEvents: 'none' });
  document.body.appendChild(video);
  try {
    const loaded = once(video, 'loadedmetadata'); video.src = url; await loaded;
    const grabber = makeGrabber(video, video.videoWidth, video.videoHeight, maxSide);
    const n = Math.max(3, Math.floor(Math.min(seconds, video.duration - 0.2) * fps));
    const res = {};
    // seeking
    let t0 = performance.now();
    for (let i = 0; i < n; i++) { if (signal?.aborted) throw abortError(); await seekTo(video, 0.1 + i / fps); grabber.grab().bitmap?.close?.(); }
    res.seek = { msPerSample: (performance.now() - t0) / n, samples: n };
    // playing
    await seekTo(video, 0.1);
    if (typeof video.requestVideoFrameCallback === 'function') {
      let got = 0, nextT = 0.1;
      video.playbackRate = 4;
      t0 = performance.now();
      await video.play();
      await new Promise((resolve) => {
        const cb = (now, md) => {
          if (md.mediaTime >= nextT) { grabber.grab().bitmap?.close?.(); got++; nextT = Math.max(nextT + 1 / fps, md.mediaTime + 0.5 / fps); }
          if (got >= n || md.mediaTime > video.duration - 0.1 || performance.now() - t0 > 15000) return resolve();
          video.requestVideoFrameCallback(cb);
        };
        video.requestVideoFrameCallback(cb);
      });
      video.pause();
      res.play = { msPerSample: (performance.now() - t0) / Math.max(1, got), samples: got };
    } else res.play = null;
    res.best = res.play && res.play.msPerSample < res.seek.msPerSample ? 'play' : 'seek';
    saveChoice(res.best);
    return res;
  } finally {
    try { video.pause(); } catch (_) { /* gone */ }
    video.removeAttribute('src'); video.load?.(); video.remove();
    if (typeof file !== 'string') URL.revokeObjectURL(url);
  }
}

// ================================================================================================================= the camera (pure)

// -- tracks ---------------------------------------------------------------------------------------------------------------------------
/** Mouth activity: mostly the mean absolute change of the lip gap, plus its spread, in a [-0.7 s, +0.8 s] window around each sample. */
function actOf(ts, ms, minN) {
  const o = [];
  for (const T of ts) {
    const lo = bisectLeft(ts, T - 0.7), hi = bisectRight(ts, T + 0.8);
    const v = [];
    for (let i = lo; i < hi; i++) if (ms[i] !== null && ms[i] !== undefined) v.push(ms[i]);
    if (v.length < minN) { o.push(0); continue; }
    const mu = v.reduce((s, x) => s + x, 0) / v.length;
    const sd = Math.sqrt(v.reduce((s, x) => s + (x - mu) ** 2, 0) / v.length);
    let md = 0;
    for (let i = 0; i < v.length - 1; i++) md += Math.abs(v[i + 1] - v[i]);
    md /= Math.max(1, v.length - 1);
    o.push(0.25 * sd + 0.75 * md);
  }
  return o;
}

/** Joins the faces of consecutive samples into tracks. Tracks never cross a cut. fr = [{t, fs: [{cx, cy, w, h, conf, mouth}]}] in pixels. -> {trs, at} */
function link(fr, cuts, minN) {
  const trs = [], at = [];
  let live = [], prev = null;
  for (const { t, fs } of fr) {
    if (prev !== null && bisectRight(cuts, t) > bisectRight(cuts, prev)) live = [];
    prev = t;
    const pairs = [];
    fs.forEach((f, j) => {
      for (const tr of live) {
        const p = tr.pts[tr.pts.length - 1];
        const dt = t - p.t;
        if (dt > 0.9) continue;
        const d = Math.hypot(f.cx - p.cx, f.cy - p.cy) / Math.max(f.w, p.w, 1);
        const r = f.w / Math.max(p.w, 1);
        if (d < 0.9 + 1.6 * dt && r > 0.5 && r < 2) pairs.push({ d, j, tr });
      }
    });
    pairs.sort((a, b) => a.d - b.d);
    const used = new Set(), taken = new Set(), row = [];
    for (const { j, tr } of pairs) {
      if (used.has(j) || taken.has(tr.id)) continue;
      used.add(j); taken.add(tr.id);
      tr.pts.push({ t, cx: fs[j].cx, cy: fs[j].cy, w: fs[j].w, h: fs[j].h, conf: fs[j].conf, mouth: fs[j].mouth });
      row.push({ tr, pi: tr.pts.length - 1 });
    }
    fs.forEach((f, j) => {
      if (used.has(j)) return;
      const tr = { id: trs.length, kind: 0, pts: [{ t, cx: f.cx, cy: f.cy, w: f.w, h: f.h, conf: f.conf, mouth: f.mouth }] };
      trs.push(tr); live.push(tr); row.push({ tr, pi: 0 });
    });
    live = live.filter((tr) => t - tr.pts[tr.pts.length - 1].t <= 0.9);
    at.push(row);
  }
  for (const tr of trs) { tr.ts = tr.pts.map((p) => p.t); tr.ac = actOf(tr.ts, tr.pts.map((p) => p.mouth), minN); }
  return { trs, at };
}

/** Face (cx, cy, w, h) of a track at time T: linear inside, held outside; null when T is more than 1.5 s before the track starts. */
function interp(tr, T) {
  const { ts, pts } = tr;
  if (T < ts[0] - 1.5) return null;
  const i = bisectRight(ts, T);
  if (i === 0) return pts[0];
  if (i === ts.length) return pts[pts.length - 1];
  const a = pts[i - 1], b = pts[i];
  if (b.t - a.t > 1) return a;
  const u = (T - a.t) / (b.t - a.t);
  return { cx: a.cx + (b.cx - a.cx) * u, cy: a.cy + (b.cy - a.cy) * u, w: a.w + (b.w - a.w) * u, h: a.h + (b.h - a.h) * u };
}

function far(tr, prev, t, cw0) {
  const a = interp(prev, t), b = interp(tr, t);
  return !a || !b || Math.abs(a.cx - b.cx) > HARD * cw0;
}

/** The speaker of every shot, with hysteresis. -> [{t, tr, hard}] sorted by time (one entry per shot start plus every switch). */
function choose(trs, at, ts, shots, cw0) {
  const subs = [];
  for (const [a, b] of shots) {
    const i0 = bisectLeft(ts, a), i1 = bisectLeft(ts, b);
    const need = Math.min(4, Math.max(1, Math.floor((i1 - i0) * 0.6)));
    const score = (i) => {
      const el = at[i].filter(({ tr }) => tr.pts.length >= need);
      const hm = Math.max(1, ...el.map(({ tr, pi }) => tr.pts[pi].h));
      const m = new Map();
      for (const { tr, pi } of el) { const p = tr.pts[pi]; m.set(tr.id, { tr, s: tr.ac[pi] * Math.sqrt(p.h / hm) * p.conf, ar: p.w * p.h }); }
      return m;
    };
    let cur = null, tsw = a, seen = a;
    for (let i = i0; i < i1; i++) {
      const t = ts[i], sc = score(i);
      if (!sc.size) continue;
      if (cur === null || (!sc.has(cur.id) && t - seen > 0.8)) {
        const agg = new Map();
        for (let j = i; j < i1; j++) {
          if (ts[j] > t + 2) break;
          for (const [k, v] of score(j)) {
            let o = agg.get(k);
            if (!o) { o = { tr: v.tr, s: 0, ar: 0, n: 0 }; agg.set(k, o); }
            o.s += v.s; o.ar += v.ar; o.n += v.s > 0 ? 1 : 0;
          }
        }
        for (const o of agg.values()) o.s /= Math.max(1, o.n);
        const all = [...agg.values()], live = all.filter((o) => o.s >= MINACT), pool = live.length ? live : all;
        let best = pool[0];
        for (const o of pool) if ((live.length ? o.s : o.ar) > (live.length ? best.s : best.ar)) best = o;
        subs.push({ t: cur === null ? a : t, tr: best.tr, hard: cur === null ? true : far(best.tr, cur, t, cw0) });
        cur = best.tr; tsw = t; seen = t;
        continue;
      }
      if (sc.has(cur.id)) seen = t;
      let c = null;
      for (const v of sc.values()) if (!c || v.s > c.s) c = v;
      if (c.tr !== cur && t - tsw >= HOLD && c.s >= MINACT && c.s > 1.5 * (sc.get(cur.id)?.s ?? 0) + 0.004) {
        subs.push({ t, tr: c.tr, hard: far(c.tr, cur, t, cw0) });
        cur = c.tr; tsw = t;
      }
    }
    if (cur === null) subs.push({ t: a, tr: null, hard: true });
  }
  subs.sort((x, y) => x.t - y.t);
  return subs;
}

/** Zoom ceiling per subject run so the face keeps room: width <= 59% of the crop, height <= 50%. */
function caps(subs, end, cw0, ch0) {
  subs.forEach((s, i) => {
    const t1 = i + 1 < subs.length ? subs[i + 1].t : end;
    if (!s.tr) { s.cap = 1 + PUSH; return; }
    let p = s.tr.pts.filter((q) => s.t <= q.t && q.t < t1);
    if (!p.length) p = s.tr.pts;
    const w = p90(p.map((q) => q.w)), h = p90(p.map((q) => q.h));
    s.cap = Math.min(cw0 / (1.7 * w), ch0 / (2 * h));
  });
}

/** Per frame {cx, cy, fw, fh, cap}; cx = null when there is no subject (centre). */
function targets(N, fps, subs) {
  const st = subs.map((s) => s.t), out = [];
  for (let k = 0; k < N; k++) {
    const T = k / fps;
    const s = subs.length ? subs[Math.max(0, bisectRight(st, T + 1e-6) - 1)] : null;
    const f = s && s.tr ? interp(s.tr, T) : null;
    out.push(f ? { cx: f.cx, cy: f.cy, fw: f.w, fh: f.h, cap: s.cap } : { cx: null, cy: null, fw: 0, fh: 0, cap: s ? s.cap : 1 + PUSH });
  }
  return out;
}

/** Zoom per frame: a slow push-in inside every shot of 6 s or more, a little punch-in on every other shot after a jump cut; never more than the subject's cap. */
function zpath(N, fps, zoom, bounds, joins, tg) {
  const z = new Array(N).fill(1);
  if (zoom === 'off') return z;
  const ed = [...new Set([...bounds, 0, N])].sort((a, b) => a - b);
  for (let e = 0; e + 1 < ed.length; e++) {
    const a = ed[e], b = ed[e + 1], L = (b - a) / fps;
    const base = zoom === 'dynamic' && bisectRight(joins, a) % 2 ? PUNCH : 1;
    for (let k = a; k < Math.min(b, N); k++) {
      const u = L >= 6 ? Math.min(1, (k - a) / fps / Math.min(L, 20)) : 0;
      const r = Math.min(ZMAX, base * (1 + PUSH * u * u * (3 - 2 * u)));
      z[k] = Math.max(1, Math.min(r, tg[k].cap));
    }
  }
  return z;
}

/** One axis of the virtual camera: dead zone, critically damped glide, speed limit. */
function follow(p, v, mv, t, ax, size, dt) {
  const [ts, hi, lo, vm] = [ax[0], ax[1] * size, ax[2] * size, ax[3] * size];
  if (!mv && Math.abs(t - p) > hi) mv = true;
  if (mv) {
    const w = 2 / ts;
    v = Math.max(-vm, Math.min(vm, v + (w * w * (t - p) - 2 * w * v) * dt));
    p += v * dt;
    if (Math.abs(t - p) < lo && Math.abs(v) < vm * 0.02) { mv = false; v = 0; }
  } else v = 0;
  return [p, v, mv];
}

/** Crop windows [x0, y0, cw, ch] (source pixels) per frame. Hard frames reset the camera; otherwise dead zone + critically damped follow, max speed, face kept inside. */
function camera(N, fps, W, H, ar, tg, z, hard) {
  const We = W - (W % 2), He = H - (H % 2), ch0 = Math.min(He, We / ar), dt = 1 / fps;
  const out = [];
  let px = null, py = null, vx = 0, vy = 0, mx = false, my = false, pz = 1;
  for (let k = 0; k < N; k++) {
    const { cx, cy, fw, fh } = tg[k];
    if (px === null || hard.has(k)) pz = z[k]; else pz += Math.max(-0.15 * dt, Math.min(0.15 * dt, z[k] - pz));
    const ch = ch0 / pz, cw = ch * ar;
    const tx = Math.min(Math.max(cx !== null ? cx : We / 2, cw / 2), We - cw / 2);
    const ty = Math.min(Math.max(cy !== null ? Math.min(cy - 0.1 * fh - ch / 3, cy - fh - 0.06 * ch) : (He - ch) / 2, 0), He - ch);   // eyes on the upper third, hair/hat still in frame
    if (px === null || hard.has(k)) { px = tx; py = ty; vx = vy = 0; mx = my = false; }
    else { [px, vx, mx] = follow(px, vx, mx, tx, SMOOTH[0], cw, dt); [py, vy, my] = follow(py, vy, my, ty, SMOOTH[1], ch, dt); }
    let ox = px;
    if (cx !== null) { const lim = Math.max(0.12 * cw, cw / 2 - 0.75 * fw); ox = Math.min(Math.max(px, cx - lim), cx + lim); }
    out.push([Math.min(Math.max(ox - cw / 2, 0), We - cw), Math.min(Math.max(py, 0), He - ch), cw, ch]);
  }
  return out;
}

// -- the split screen -----------------------------------------------------------------------------------------------------------------
const pseudo = (rows) => ({ ts: rows.map((r) => r.t), pts: rows });

/** Per sample the two largest face tracks as {i, a (left point), b (right point)}. */
function pairsOf(at, i0, i1, need) {
  const out = [];
  for (let i = i0; i < i1; i++) {
    const el = at[i].filter(({ tr }) => !tr.kind && tr.pts.length >= need).sort((x, y) => y.tr.pts[y.pi].w * y.tr.pts[y.pi].h - x.tr.pts[x.pi].w * x.tr.pts[x.pi].h).slice(0, 2);
    if (el.length === 2) {
      const [a, b] = el.map((x) => x.tr.pts[x.pi]).sort((p, q) => p.cx - q.cx);
      out.push({ i, a, b });
    }
  }
  return out;
}

function runsOf(ps, gap) {
  const out = [];
  for (const p of ps) {
    if (out.length && p.a.t - out[out.length - 1][out[out.length - 1].length - 1].a.t <= gap) out[out.length - 1].push(p); else out.push([p]);
  }
  return out;
}

function joinIv(iv, gap) {
  const out = [];
  for (const [a, b] of [...iv].sort((x, y) => x[0] - y[0])) {
    if (out.length && a - out[out.length - 1][1] <= gap) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b); else out.push([a, b]);
  }
  return out;
}

/** Time ranges of a run where both faces really talk within a window: back and forth, not a monologue. */
function exchange(run, K, win = 6) {
  const ts = run.map((q) => q.a.t);
  const al = actOf(ts, run.map((q) => q.a.mouth), K.minN), ar = actOf(ts, run.map((q) => q.b.mouth), K.minN);
  const lab = run.map((q, i) => {
    const sl = al[i] * q.a.conf, sr = ar[i] * q.b.conf;
    return sl >= MINACT && sl > 1.3 * sr + 0.004 ? 1 : (sr >= MINACT && sr > 1.3 * sl + 0.004 ? 2 : 0);
  });
  const cl = [0], cr = [0];
  for (const v of lab) { cl.push(cl[cl.length - 1] + (v === 1 ? 1 : 0)); cr.push(cr[cr.length - 1] + (v === 2 ? 1 : 0)); }
  const out = [];
  for (let j = 0; j < ts.length; j++) {
    const e = bisectRight(ts, ts[j] + win);
    if (cl[e] - cl[j] >= K.exch && cr[e] - cr[j] >= K.exch) out.push([ts[j], Math.min(ts[j] + win, ts[ts.length - 1])]);
  }
  return out;
}

/** Intervals where two far-apart faces get a vertical split: auto needs a sustained exchange (>= SPLITMIN s) with both faces big enough; forced takes every stretch with two faces. */
function splitPlan(at, ts, shots, He, cw0, forced, end, K) {
  const out = [];
  for (let [a, b] of shots) {
    b = Math.min(b, end);
    const i0 = bisectLeft(ts, a), i1 = bisectLeft(ts, b);
    if (i1 - i0 < K.minShot) continue;
    const ps = pairsOf(at, i0, i1, Math.min(4, Math.max(1, Math.floor((i1 - i0) * 0.6))));
    const ok = ps.filter((p) => {
      const hs = [p.a.h, p.b.h];
      return Math.min(...hs) >= (forced ? 0.05 : SPLITFACE) * He && Math.min(...hs) >= 0.4 * Math.max(...hs) && (forced || p.b.cx + p.b.w / 2 - (p.a.cx - p.a.w / 2) > 0.85 * cw0);
    });
    for (const run of runsOf(ok, 1)) {
      const r0 = run[0].a.t, r1 = run[run.length - 1].a.t;
      const ivs = forced ? [[r0, r1]] : joinIv(exchange(run, K), SPLITGAP);
      for (let [t0, t1] of ivs) {
        if (t0 - a < SPLITEDGE) { if (r0 - a > 0.6) continue; t0 = a; }      // snap to the cut only when both faces are there from the cut; never leave a short single stretch
        if (b - t1 < SPLITEDGE) { if (b - r1 > 0.6) continue; t1 = b; }
        if (t1 - t0 >= (forced ? 2 : SPLITMIN)) {
          const rows = ps.filter((p) => t0 - 1 <= p.a.t && p.a.t <= t1 + 1);
          out.push({ t0, t1, L: pseudo(rows.map((r) => r.a)), R: pseudo(rows.map((r) => r.b)) });
        }
      }
    }
  }
  return out;
}

/** Crop windows for the top (left person) and bottom (right person) halves, one camera per half and interval; frames outside an interval hold the nearest window. */
function halfPaths(N, fps, W, H, ow, hh, ivs, zf, hard) {
  const arh = ow / hh, We = W - (W % 2), He = H - (H % 2), ch0 = Math.min(He, We / arh);
  const top = new Array(N).fill(null), bot = new Array(N).fill(null), fr = [];
  for (const iv of ivs) {
    const k0 = Math.min(N, framesOf([iv.t0], fps)[0]), k1 = Math.min(N, framesOf([iv.t1], fps)[0]);
    if (k1 - k0 < 2) continue;
    const zs = Math.max(1, Math.min(2, (ch0 * SPLITZ) / ((p90(iv.L.pts.map((r) => r.h)) + p90(iv.R.pts.map((r) => r.h))) / 2)));
    const z = []; for (let k = k0; k < k1; k++) z.push(Math.min(zs * zf[k], 3.2));
    const hl = new Set([0]); for (const h of hard) if (h > k0 && h < k1) hl.add(h - k0);
    for (const [s, arr] of [['L', top], ['R', bot]]) {
      const tg = [];
      for (let k = k0; k < k1; k++) { const f = interp(iv[s], k / fps) || iv[s].pts[0]; tg.push({ cx: f.cx, cy: f.cy, fw: f.w, fh: f.h, cap: 9 }); }
      camera(k1 - k0, fps, W, H, arh, tg, z, hl).forEach((w, i) => { arr[k0 + i] = w; });
    }
    fr.push([k0, k1]);
  }
  if (!fr.length) return null;
  for (const arr of [top, bot]) {
    let last = arr[fr[0][0]];
    for (let k = 0; k < N; k++) { if (arr[k] === null) arr[k] = last; else last = arr[k]; }
  }
  return { top, bot, intervals: joinIv(fr, 0).map(([a, b]) => [Math.round(a), Math.round(b)]) };
}

// -- the timeline: plan segments (source) -> output ------------------------------------------------------------------------------------
/** [{a, b, off}] kept stretches of the source and where each starts in the output; total = output length. */
export function segmentsOf(plan, sourceEnd, range = null) {
  let segs = (plan?.segments || []).filter((s) => Array.isArray(s) && s[1] > s[0]).map(([a, b]) => [+a, +b]);
  if (!segs.length) segs = range && range.end > range.start ? [[range.start, range.end]] : [[0, sourceEnd]];   // no plan: the analysed stretch as it is
  let off = 0;
  const out = segs.map(([a, b]) => { const s = { a, b, off }; off += b - a; return s; });
  return { segs: out, total: off };
}

/** Output seconds of a source time inside the kept stretches, or null when it was cut away. */
export function toOut(segs, tSource) {
  for (const s of segs) if (tSource >= s.a && tSource < s.b) return s.off + tSource - s.a;
  return null;
}

// ----------------------------------------------------------------------------------------------------------------- cameraFor
/**
 * The virtual camera for a clip. samples = FaceSamples (source times), plan = Plan ({segments: [[s0, s1], ...] source seconds in order, duration}; null = the whole source in one piece).
 * -> Camera { layout: 'tracked' | 'split' | 'fit', rectAt(tOut) -> {x, y, w, h} normalized in the source picture, split?: {intervals: [{start, end}] (output seconds), active(tOut), topAt(tOut), bottomAt(tOut), halfHeight, divider},
 *             cuts: [tOut] (every hard cut: scene changes, jump cuts, far speaker switches), info }.
 * Times of rectAt / topAt / bottomAt are OUTPUT times: the camera is built on the output timeline, so the pacing's cuts are cuts of the camera too.
 * opts: outW, outH (1080 x 1920), layout ('auto' | 'fit' | 'split'), zoom ('dynamic' | 'subtle' | 'off').
 */
export function cameraFor(samples, plan, { outW = 1080, outH = 1920, layout = 'auto', zoom = 'dynamic' } = {}) {
  const W = samples?.width || 1920, H = samples?.height || 1080;
  const ar = outW / outH, fps = CAMERA_FPS;
  const list = (samples?.samples || []).filter((s) => s && Number.isFinite(s.t)).sort((a, b) => a.t - b.t);
  const srcEnd = Math.max(plan?.segments?.length ? Math.max(...plan.segments.map((s) => s[1])) : 0, list.length ? list[list.length - 1].t + 1 / (samples.fps || 5) : 0, samples?.duration || 0, 1);
  const { segs, total } = segmentsOf(plan, srcEnd, samples?.source);
  const dur = plan?.duration > 0 ? plan.duration : total;
  const N = Math.max(2, Math.ceil(dur * fps));
  const We = W - (W % 2), He = H - (H % 2);
  const ch0 = Math.min(He, We / ar), cw0 = ch0 * ar;
  const heavy = (ch0 * ch0 * ar) / (We * He) < 0.75;            // the crop would throw away more than a quarter of the picture
  const vertical = H >= 1.2 * W;
  const full = { x: 0, y: 0, w: 1, h: 1 };
  const fitCamera = (why) => ({ layout: 'fit', rectAt: () => ({ ...full }), cuts: [], info: { mode: 'fit', reason: why, faceShare: share } });

  // faces on the output timeline (pixels), the cuts, the jump cuts
  const fr = [];
  let usableN = 0;
  const jumps = segs.slice(1).map((s) => s.off);
  const sceneOut = [];
  for (const c of samples?.cuts || []) { const t = toOut(segs, c); if (t !== null) sceneOut.push(t); }
  for (const s of list) {
    const t = toOut(segs, s.t);
    if (t === null) continue;
    const fs = [];
    for (const f of s.faces || []) {
      if (f.h < 0.03) continue;
      fs.push({ cx: (f.x + f.w / 2) * W, cy: (f.y + f.h / 2) * H, w: f.w * W, h: f.h * H, conf: 1, mouth: Number.isFinite(f.mouth) ? f.mouth : null });
    }
    if (fs.length) usableN++;
    fr.push({ t, fs });
  }
  const share = usableN / Math.max(1, fr.length);
  const faces = share >= FACEMIN;
  if (layout === 'fit') return fitCamera('נבחר מסגור מלא: כל הפריים על רקע מטושטש');
  if (vertical && ar > 1.2) return fitCamera('מקור אנכי בפורמט רחב: מוצג כל הפריים על רקע מטושטש');
  if (heavy && !faces) return fitCamera(fr.length ? `פנים זוהו רק ב-${Math.round(share * 100)}% מהקליפ; מוצג כל הפריים על רקע מטושטש` : 'לא נמצאו פנים; מוצג כל הפריים על רקע מטושטש');

  // the sampling rate decides how many samples "a second of talking" is
  const dts = []; for (let i = 1; i < fr.length; i++) { const d = fr[i].t - fr[i - 1].t; if (d > 0 && d < 1) dts.push(d); }
  const sfps = dts.length ? 1 / median(dts) : (samples?.fps || 5);
  const K = { minN: Math.max(3, Math.round(4 * sfps / 8)), exch: Math.max(3, Math.round(8 * sfps / 8)), minShot: Math.max(4, Math.round(8 * sfps / 8)) };

  const sc0 = [...new Set(sceneOut.map((c) => +c.toFixed(4)))].sort((a, b) => a - b).filter((c) => c > 0.05 && c < dur - 0.05 && jumps.every((j) => Math.abs(c - j) > 0.15));
  const joins = framesOf(jumps, fps);
  const allc = [...new Set([...jumps, ...sc0].map((c) => +c.toFixed(4)))].sort((a, b) => a - b);
  const shots = [0, ...allc].map((a, i) => [a, i < allc.length ? allc[i] : N / fps + 1]);
  const { trs, at } = link(fr, allc, K.minN);
  const ts = fr.map((f) => f.t);
  const subs = choose(trs, at, ts, shots, cw0);
  caps(subs, N / fps + 1, cw0, ch0);
  const tg = targets(N, fps, subs);
  const sc = framesOf(sc0, fps);
  const hard = new Set([...joins, ...sc, ...subs.filter((s) => s.hard).map((s) => framesOf([s.t], fps)[0]), 0]);
  const zm = ['dynamic', 'subtle', 'off'].includes(zoom) ? zoom : 'dynamic';
  const z = zpath(N, fps, zm, new Set([...joins, ...sc]), joins, tg);
  const path = camera(N, fps, W, H, ar, tg, z, hard);

  let split = null;
  if (fr.length && (layout === 'auto' || layout === 'split') && ar <= 0.85) {
    const ivs = splitPlan(at, ts, shots, He, cw0, layout === 'split', N / fps, K);
    if (ivs.length) {
      const { hh } = halves(outH);
      const zf = zpath(N, fps, zm, new Set([...joins, ...sc]), joins, new Array(N).fill({ cap: 9 }));
      split = halfPaths(N, fps, W, H, outW, hh, ivs, zf, hard);
    }
  }

  const norm = (w) => ({ x: w[0] / W, y: w[1] / H, w: w[2] / W, h: w[3] / H });
  const lerp = (arr, t) => {
    const f = clamp(t * fps, 0, N - 1), k = Math.floor(f), u = f - k;
    if (u < 1e-6 || k + 1 >= N || hard.has(k + 1)) return norm(arr[Math.min(k + (u > 0.5 && hard.has(k + 1) ? 1 : 0), N - 1)]);
    const a = norm(arr[k]), b = norm(arr[k + 1]);
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, w: a.w + (b.w - a.w) * u, h: a.h + (b.h - a.h) * u };
  };
  const cuts = [...hard].filter((k) => k > 0).map((k) => +(k / fps).toFixed(3)).sort((a, b) => a - b);
  const cam = {
    layout: split ? 'split' : 'tracked',
    rectAt: (t) => lerp(path, t),
    cuts,
    info: { mode: split ? 'split' : (faces ? 'tracked' : 'center'), faceShare: share, subjects: new Set(subs.filter((s) => s.tr).map((s) => s.tr.id)).size, switches: Math.max(0, subs.length - 1), fps, frames: N, duration: dur },
    path,
  };
  if (split) {
    const { hh, divider } = halves(outH);
    const iv = split.intervals.map(([a, b]) => ({ start: +(a / fps).toFixed(3), end: +(b / fps).toFixed(3) }));
    cam.split = {
      intervals: iv, halfHeight: hh, divider,
      active: (t) => iv.some((x) => t >= x.start - 1e-6 && t < x.end - 1e-6),
      topAt: (t) => lerp(split.top, t), bottomAt: (t) => lerp(split.bot, t),
    };
  }
  return cam;
}

// pieces the tests look at
export const _internal = { link, choose, interp, actOf, camera, zpath, splitPlan, halfPaths, caps, targets, pairsOf, exchange, SCENE, FACEMIN };
