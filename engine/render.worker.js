// engine/render.worker.js: מסלול WebCodecs (סוכן 3, סבב 8).
// דמוקס (mp4box) -> VideoDecoder -> OffscreenCanvas -> VideoEncoder (avc1) -> mp4-muxer.
// כל מה שלא ניתן להעביר ל־worker (camera.rectAt, overlay) מגיע מוכן מהדף:
//   המצלמה כטבלת מלבנים לכל פריים, והכתוביות כ־ImageBitmap שקוף לכל פריים.
import {
  AAC_PRIMING,
  HE,
  MP4_MUXER_URL,
  aacDescriptionFor,
  avcCandidates,
  compilePlan,
  createCompositor,
  createSampleReader,
  createWasmAacEncoder,
  frameRanges,
  frameSourceTime,
  framesOf,
  gopFrames,
  heError,
  keyframeBefore,
  opsForFrame,
  openMp4,
  patchAudioEditList,
  rotatedSize,
  stripAdts,
  suffixMinCts,
} from './media.js';

let aborted = false;
let failure = null;
const overlays = new Map();

class Signal {
  constructor() {
    this.waiters = [];
  }
  notify() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }
  wait(ms = 30) {
    return new Promise((resolve) => {
      let t = 0;
      const done = () => {
        clearTimeout(t);
        resolve();
      };
      t = setTimeout(done, ms);
      this.waiters.push(done);
    });
  }
}
const sig = new Signal();

function fail(e) {
  if (!failure) failure = e instanceof Error ? e : new Error(String((e && e.message) || e));
  sig.notify();
}
function check() {
  if (aborted) throw heError(HE.cancelled, 'aborted');
  if (failure) throw failure;
}

self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'start') {
    run(m).catch((e) => {
      self.postMessage({ type: 'error', code: (e && e.code) || 'failed', message: (e && e.message) || HE.encodeFailed });
    });
  } else if (m.type === 'overlay') {
    overlays.set(m.i, m.bitmap);
    sig.notify();
  } else if (m.type === 'abort') {
    aborted = true;
    sig.notify();
  }
};

async function run(m) {
  const t0 = performance.now();
  const { file, width, height, fps, bitrate, hasOverlay, audio, audioCfg, cam, debug = {} } = m;
  const ovf = m.overlayFrame || null; // {w, h}: כשצריך להעביר לדף את הפריים אחרי ה־crop
  const plan = compilePlan({ segments: m.segments });
  const ranges = frameRanges(plan, fps);
  const total = framesOf(plan, fps);
  if (!total) throw heError(HE.emptyPlan, 'empty');

  // ── קובץ המקור ──
  const src = await openMp4(file);
  const V = src.video;
  if (!V) throw heError(HE.noVideo, 'novideo');
  const table = V.table;

  const decCfg = { codec: V.codec, codedWidth: V.codedW, codedHeight: V.codedH };
  if (V.description) decCfg.description = V.description;
  const ds = await VideoDecoder.isConfigSupported(decCfg).catch(() => null);
  if (!ds || !ds.supported) throw heError(HE.codecUnsupported, 'unsupported');

  // ── מקודד ווידאו: הראשון שנתמך מבין High/Main/Baseline ──
  let encCfg = null;
  const hwPrefs = debug.noHardware ? ['no-preference'] : ['prefer-hardware', 'no-preference'];
  outer: for (const hw of hwPrefs) {
    for (const codec of avcCandidates(width, height, fps)) {
      const c = { codec, width, height, bitrate, framerate: fps, hardwareAcceleration: hw, avc: { format: 'avc' }, latencyMode: 'quality' };
      const r = await VideoEncoder.isConfigSupported(c).catch(() => null);
      if (r && r.supported) {
        encCfg = c;
        break outer;
      }
    }
  }
  if (!encCfg) throw heError(HE.encoderUnsupported, 'unsupported');

  // ── muxer ──
  let mod;
  try {
    mod = await import(/* @vite-ignore */ MP4_MUXER_URL);
  } catch (e) {
    throw heError(HE.libLoad, 'cdn', e);
  }
  const { Muxer, ArrayBufferTarget } = mod;
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width, height, frameRate: fps },
    audio: audio ? { codec: audioCfg.codec === 'opus' ? 'opus' : 'aac', numberOfChannels: audioCfg.numberOfChannels, sampleRate: audioCfg.sampleRate } : undefined,
    fastStart: 'in-memory',
    firstTimestampBehavior: 'cross-track-offset',
  });

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      try {
        muxer.addVideoChunk(chunk, meta);
      } catch (e) {
        fail(e);
      }
      sig.notify();
    },
    error: fail,
  });
  encoder.configure(encCfg);

  // ── אודיו: מקודד המערכת (AudioEncoder), או AAC ב־WASM כשאין. נבחר בדף ──
  // מקודדי AAC מוסיפים השהיית קידוד (priming). משאירים אותה בזרם ומוסיפים בסוף edit list שחותך אותה בנגן
  // (השמטת פריימים הייתה פוגעת בקול בתחילת הקובץ). ל־Opus הנגנים מטפלים בזה לבד.
  const AUDIO_BLOCK = 4096;
  const isAac = !!audio && audioCfg.codec !== 'opus';
  const primingSamples = audio && audioCfg.kind === 'wasm' ? AAC_PRIMING.wasm : AAC_PRIMING.native;
  const keepUntilUs = audio ? Math.round(((audio.frames + primingSamples + 1024) / audioCfg.sampleRate) * 1e6) : 0; // אחרי זה זה ריפוד של המקודד
  let muxedAudioFirst = false;
  const aacMeta = (given) => ({
    decoderConfig: {
      codec: 'mp4a.40.2',
      sampleRate: audioCfg.sampleRate,
      numberOfChannels: audioCfg.numberOfChannels,
      description: aacDescriptionFor(given && given.decoderConfig && given.decoderConfig.description, audioCfg.sampleRate, audioCfg.numberOfChannels),
    },
  });

  async function makeNativeSink() {
    const cfg = { codec: audioCfg.codec, sampleRate: audioCfg.sampleRate, numberOfChannels: audioCfg.numberOfChannels, bitrate: audioCfg.bitrate };
    const as = await AudioEncoder.isConfigSupported(cfg).catch(() => null);
    if (!as || !as.supported) throw heError(HE.audioEncoder, 'audio');
    let firstMeta = null;
    const enc = new AudioEncoder({
      output: (chunk, meta) => {
        try {
          if (meta && meta.decoderConfig && !firstMeta) {
            firstMeta = meta;
            // בדיקה: מדמה את הבאג של Safari 26 (תוכן esds במקום AudioSpecificConfig)
            if (debug.badDescription) firstMeta = { decoderConfig: { ...meta.decoderConfig, description: new Uint8Array([0, 0, 0, 0, 3, 0x80, 0x80, 0x80, 0x22, 0, 0]) } };
          }
          if (isAac) {
            if (chunk.timestamp >= keepUntilUs) return;
            const raw = new Uint8Array(chunk.byteLength);
            chunk.copyTo(raw);
            const data = stripAdts(raw); // הגנה: חלק מהמימושים עוטפים ב־ADTS
            const out = data === raw ? chunk : new EncodedAudioChunk({ type: chunk.type, timestamp: chunk.timestamp, duration: chunk.duration, data });
            // ה־description נבדק ונבנה מחדש אם הוא שגוי (באג ב־Safari 26)
            muxer.addAudioChunk(out, muxedAudioFirst ? undefined : aacMeta(firstMeta || meta));
          } else {
            muxer.addAudioChunk(chunk, muxedAudioFirst ? undefined : firstMeta || meta);
          }
          muxedAudioFirst = true;
        } catch (e) {
          fail(e);
        }
        sig.notify();
      },
      error: fail,
    });
    enc.configure(cfg);
    return {
      async ready() {
        while (enc.encodeQueueSize > 24) {
          await sig.wait(10);
          check();
        }
      },
      write(planes, N, pos) {
        const C = planes.length;
        const data = new Float32Array(N * C);
        for (let c = 0; c < C; c++) data.set(planes[c], c * N);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: audioCfg.sampleRate, numberOfFrames: N, numberOfChannels: C, timestamp: Math.round((pos / audioCfg.sampleRate) * 1e6), data });
        enc.encode(ad);
        ad.close();
      },
      async flush() {
        await enc.flush();
        enc.close();
      },
    };
  }

  async function makeWasmSink() {
    if (debug.breakWasm) throw heError(HE.libLoad, 'audio'); // בדיקה: כשל בטעינת הרכיב
    const C = audioCfg.numberOfChannels;
    const sr = audioCfg.sampleRate;
    const enc = await createWasmAacEncoder({ sampleRate: sr, channels: C, bitrate: audioCfg.bitrate });
    const FS = enc.frameSize;
    const acc = new Float32Array(FS * C);
    let fill = 0;
    let pts = 0; // בדגימות: החבילה הראשונה (priming) בזמן 0
    const emit = (packets) => {
      for (const p of packets) {
        const ts = Math.round((pts / sr) * 1e6);
        pts += p.duration;
        if (ts >= keepUntilUs) continue;
        muxer.addAudioChunkRaw(p.data, 'key', ts, Math.round((p.duration / sr) * 1e6), muxedAudioFirst ? undefined : aacMeta({ decoderConfig: { description: enc.description } }));
        muxedAudioFirst = true;
      }
    };
    return {
      async ready() {},
      write(planes, N) {
        const C2 = planes.length;
        for (let s = 0; s < N; s++) {
          for (let c = 0; c < C2; c++) acc[fill * C2 + c] = planes[c][s];
          if (++fill === FS) {
            emit(enc.encode(acc));
            fill = 0;
          }
        }
      },
      async flush() {
        if (fill > 0) {
          acc.fill(0, fill * C);
          emit(enc.encode(acc));
          fill = 0;
        }
        emit(enc.flush());
        enc.close();
      },
    };
  }

  let sink = null;
  let aPos = 0;
  if (audio) sink = audioCfg.kind === 'wasm' ? await makeWasmSink() : await makeNativeSink();
  async function pumpAudio(untilSec) {
    if (!sink) return;
    const sr = audio.sampleRate;
    const goal = Math.min(audio.frames, Math.ceil(untilSec * sr));
    while (aPos < goal) {
      check();
      await sink.ready();
      const N = Math.min(AUDIO_BLOCK, audio.frames - aPos);
      sink.write(audio.channels.map((ch) => ch.subarray(aPos, aPos + N)), N, aPos);
      aPos += N;
    }
  }

  // ── מפענח וזרם פריימים (הזנה רצה במקביל לצרכן) ──
  const shift = table.shift;
  const srcFrameDur = 1 / Math.max(1, V.fps);
  const tol = srcFrameDur * 0.5;
  const suf = suffixMinCts(table);
  const reader = createSampleReader(file, table);
  const queue = [];
  const stats = { waitFrameMs: 0, drawMs: 0, overlayWaitMs: 0, encWaitMs: 0, feedWaitMs: 0, readMs: 0 };
  let runSegs = [];
  let feedDone = false;
  const QMAX = 5;

  // ריצות פענוח: קטעים סמוכים שחולקים GOP מפוענחים ברצף אחד, אחרת קופצים ל־keyframe
  const runs = [];
  for (let k = 0; k < ranges.length; k++) {
    const R = ranges[k];
    if (R.frames <= 0) continue;
    const tFirst = frameSourceTime(R, R.firstFrame, fps) + shift;
    const tLast = frameSourceTime(R, R.endFrame - 1, fps) + shift;
    const lo = tFirst - tol;
    const hi = R.srcEnd + shift;
    const m1 = Math.min(hi, tLast + tol + 1e-6);
    const kf = keyframeBefore(table, lo);
    // המדגם האחרון שצריך להזין: הקטן ביותר j ש־suf[j] >= m1, פחות אחד
    let a = kf;
    let b = table.count;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (suf[mid] >= m1) b = mid;
      else a = mid + 1;
    }
    const endIdx = Math.max(kf, a - 1);
    const seg = { seg: k, lo, hi };
    const last = runs[runs.length - 1];
    if (last && lo >= last.hi - 1e-6 && kf >= last.startIdx && kf <= last.endIdx + 1) {
      last.segs.push(seg);
      last.endIdx = Math.max(last.endIdx, endIdx);
      last.hi = hi;
    } else {
      runs.push({ startIdx: kf, endIdx, segs: [seg], hi });
    }
  }

  const decoder = new VideoDecoder({
    output: (frame) => {
      const ts = frame.timestamp / 1e6;
      let seg = -1;
      for (const r of runSegs) {
        if (ts >= r.lo && ts < r.hi) {
          seg = r.seg;
          break;
        }
      }
      if (seg < 0) {
        frame.close();
        return;
      }
      queue.push({ frame, ts, seg });
      sig.notify();
    },
    error: fail,
  });
  decoder.configure(decCfg);

  async function feeder() {
    for (let r = 0; r < runs.length; r++) {
      const rn = runs[r];
      runSegs = rn.segs;
      for (let j = rn.startIdx; j <= rn.endIdx && j < table.count; j++) {
        check();
        if (decoder.decodeQueueSize > 10 || queue.length >= QMAX) {
          const w0 = performance.now();
          while (decoder.decodeQueueSize > 10 || queue.length >= QMAX) {
            await sig.wait(20);
            check();
          }
          stats.feedWaitMs += performance.now() - w0;
        }
        const r0 = performance.now();
        const data = await reader.get(j);
        stats.readMs += performance.now() - r0;
        decoder.decode(new EncodedVideoChunk({ type: table.sync[j] ? 'key' : 'delta', timestamp: Math.round(table.cts[j] * 1e6), data }));
      }
      await decoder.flush();
    }
    feedDone = true;
    sig.notify();
  }
  const feederDone = feeder().catch(fail);

  async function pull() {
    for (;;) {
      if (queue.length) {
        const it = queue.shift();
        sig.notify();
        return it;
      }
      check();
      if (feedDone) return null;
      const w0 = performance.now();
      await sig.wait(20);
      stats.waitFrameMs += performance.now() - w0;
    }
  }

  // ── קנבסי ההרכבה: טבעת של 3 כשהדף צריך לראות את הפריים (overlayFrame), אחרת קנבס אחד ──
  const comp = createCompositor({ makeCanvas: (w, h) => new OffscreenCanvas(w, h), outW: width, outH: height });
  const RING = ovf ? 3 : 1;
  const slots = Array.from({ length: RING }, () => {
    const c = new OffscreenCanvas(width, height);
    return { canvas: c, ctx: c.getContext('2d', { alpha: false }) };
  });
  let snapCanvas = null;
  let snapCtx = null;
  if (ovf) {
    snapCanvas = new OffscreenCanvas(ovf.w, ovf.h);
    snapCtx = snapCanvas.getContext('2d');
  }
  const inflight = [];
  const gop = gopFrames(fps);
  const rot = V.rotation;

  let cur = null;
  let nxt = null;
  const close = (o) => {
    if (o) o.frame.close();
  };

  // בחירת פריים המקור הקרוב ביותר בזמן (תומך ב־VFR ובשינוי קצב), בלי לחצות לקטע אחר
  async function choose(r, T) {
    if (!cur) cur = await pull();
    while (cur && cur.seg < r) {
      close(cur);
      cur = nxt;
      nxt = null;
      if (!cur) cur = await pull();
    }
    if (!cur) return null;
    for (;;) {
      if (!nxt) nxt = await pull();
      if (!nxt || nxt.seg !== r) break;
      // מתקדמים רק אם הפריים הבא קרוב יותר באופן ברור. בשוויון נשארים בפריים המוקדם (החזקת פריים)
      if (cur.seg !== r || Math.abs(nxt.ts - T) < Math.abs(cur.ts - T) - 2e-5) {
        close(cur);
        cur = nxt;
        nxt = null;
        continue;
      }
      break;
    }
    return cur;
  }

  let done = 0;
  // סיום פריים: שכבת העל מהדף, קידוד ושליחת התקדמות. תמיד לפי הסדר
  async function finish(e) {
    const { i, slot } = e;
    if (hasOverlay) {
      const o0 = performance.now();
      while (!overlays.has(i)) {
        check();
        await sig.wait(30);
      }
      stats.overlayWaitMs += performance.now() - o0;
      const bm = overlays.get(i);
      overlays.delete(i);
      if (bm) {
        slot.ctx.drawImage(bm, 0, 0, width, height);
        bm.close();
      }
    }
    const ts = Math.round((i * 1e6) / fps);
    const vf = new VideoFrame(slot.canvas, { timestamp: ts, duration: Math.round(((i + 1) * 1e6) / fps) - ts });
    if (encoder.encodeQueueSize > 8) {
      const e0 = performance.now();
      while (encoder.encodeQueueSize > 8) {
        await sig.wait(10);
        check();
      }
      stats.encWaitMs += performance.now() - e0;
    }
    encoder.encode(vf, { keyFrame: i % gop === 0 });
    vf.close();
    if (i % 8 === 0) await pumpAudio((i + 1) / fps + 0.4);
    done++;
    self.postMessage({ type: 'frame', i, done, total });
  }

  for (let r = 0; r < ranges.length; r++) {
    const R = ranges[r];
    for (let i = R.firstFrame; i < R.endFrame; i++) {
      check();
      const T = frameSourceTime(R, i, fps) + shift;
      const item = await choose(R.index, T);
      const slot = slots[i % RING];
      const d0 = performance.now();
      if (item) {
        const f = item.frame;
        const ds2 = rotatedSize(f.displayWidth, f.displayHeight, rot);
        const geom = { codedW: f.displayWidth, codedH: f.displayHeight, rotation: rot, dispW: ds2.w, dispH: ds2.h, outW: width, outH: height };
        comp.draw(slot.ctx, f, geom, opsForFrame(cam, i, geom));
      } else {
        slot.ctx.fillStyle = '#000';
        slot.ctx.fillRect(0, 0, width, height);
      }
      stats.drawMs += performance.now() - d0;
      if (ovf) {
        // הדף מקבל את הפריים אחרי ה־crop (אולי מוקטן), מצייר עליו, ומחזיר שכבה
        snapCtx.imageSmoothingQuality = 'high';
        snapCtx.drawImage(slot.canvas, 0, 0, ovf.w, ovf.h);
        const bm = snapCanvas.transferToImageBitmap();
        self.postMessage({ type: 'snap', i, bitmap: bm }, [bm]);
      }
      inflight.push({ i, slot });
      while (inflight.length >= RING) await finish(inflight.shift());
    }
  }
  while (inflight.length) await finish(inflight.shift());
  close(cur);
  close(nxt);
  cur = nxt = null;
  await feederDone;
  check();

  await pumpAudio(Infinity);
  await encoder.flush();
  if (sink) await sink.flush();
  check();
  try {
    decoder.close();
    encoder.close();
  } catch (_) {
    /* כבר סגורים */
  }
  for (const f of queue) f.frame.close();
  queue.length = 0;
  muxer.finalize();
  const buffer = target.buffer;
  let patch = null;
  if (isAac) {
    try {
      patch = patchAudioEditList(new Uint8Array(buffer), { primingSamples, audioFrames: audio.frames, sampleRate: audioCfg.sampleRate });
    } catch (e) {
      patch = null; // בלי edit list הקובץ תקין, והקול מאחר ב־priming
    }
  }
  self.postMessage(
    {
      type: 'done',
      buffer,
      patch,
      info: { videoCodec: encCfg.codec, hardware: encCfg.hardwareAcceleration, audioCodec: audio ? audioCfg.codec : null, audioEncoder: audio ? audioCfg.kind || 'native' : null, editList: !!patch, overlayFrame: !!ovf, frames: total, ms: Math.round(performance.now() - t0), runs: runs.length, rotation: rot, sourceCodec: V.codec, stats: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, Math.round(v)])) },
    },
    [buffer],
  );
}
