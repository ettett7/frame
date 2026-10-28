// frame.worker.js: MediaPipe FaceLandmarker in a module worker (the heavy part of analyzeFaces).
// Messages in:  {type:'init', base, model, delegate:'GPU'|'CPU', numFaces}  |  {type:'frame', id, ts, bitmap, crops:[{bitmap, rect}]}  |  {type:'close'}
// Messages out: {type:'ready', delegate, loader:'module'|'prime', ms}  |  {type:'faces', id, ms, faces:[{x,y,w,h,mouth}]}  |  {type:'error', message, fatal, id}  |  {type:'closed'}
// Face boxes are normalized (0..1) in the picture that was sent; the mouth is the inner-lip gap over the face height (the same measure track-faces gives).
import { createDetector } from './frame.js';

let det = null;

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      det = await createDetector({ base: m.base, model: m.model, delegate: m.delegate, numFaces: m.numFaces, moduleWorker: true, ways: m.ways || null });
      self.postMessage({ type: 'ready', delegate: det.delegate, loader: det.loader, ms: det.ms });
    } else if (m.type === 'frame') {
      const t0 = performance.now();
      let faces;
      try { faces = await det.detect(m.bitmap, m.ts, m.crops || []); } finally { m.bitmap.close?.(); }
      self.postMessage({ type: 'faces', id: m.id, ms: performance.now() - t0, faces });
    } else if (m.type === 'close') {
      det?.close(); det = null;
      self.postMessage({ type: 'closed' });
    }
  } catch (err) {
    self.postMessage({ type: 'error', fatal: m.type === 'init', id: m.id, message: String((err && err.message) || err) });
  }
};
