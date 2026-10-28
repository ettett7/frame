// background.worker.js: MediaPipe ImageSegmenter ב־module worker (החלק הכבד של prepareBackground).
// הודעות פנימה:  {type:'init', base, model, delegate:'GPU'|'CPU'}  |  {type:'frame', id, bitmap}  |  {type:'close'}
// הודעות החוצה:  {type:'ready', delegate, ms, labels}  |  {type:'mask', id, ms, w, h, mask: Uint8Array}  |  {type:'error', message, fatal, id}  |  {type:'closed'}
// המסכה היא הסתברות אדם (0..255) בגודל התמונה ששלחו; המאגר שלה מועבר (transfer) בלי העתקה.
import { createSegmenter } from './background.js';

let seg = null;

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      seg = await createSegmenter({ base: m.base, model: m.model, delegate: m.delegate });
      self.postMessage({ type: 'ready', delegate: seg.delegate, ms: seg.ms, labels: seg.labels });
    } else if (m.type === 'frame') {
      const t0 = performance.now();
      let r;
      try { r = seg.segment(m.bitmap); } finally { m.bitmap.close?.(); }
      self.postMessage({ type: 'mask', id: m.id, ms: performance.now() - t0, w: r.w, h: r.h, mask: r.data }, [r.data.buffer]);
    } else if (m.type === 'close') {
      seg?.close(); seg = null;
      self.postMessage({ type: 'closed' });
    }
  } catch (err) {
    self.postMessage({ type: 'error', fatal: m.type === 'init', id: m.id, message: String((err && err.message) || err) });
  }
};
