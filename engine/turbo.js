// Turbo mode: the phone app hands the whole job to FRAME on the Mac (lan.py) and gets finished clips back.
// Works only when the app was opened FROM the Mac (http://<mac>.local:18775/...): a page from GitHub Pages (https) cannot call a local http address,
// and localStorage (where the pairing token lives) belongs to the origin it was paired on.
//
//   available() -> Promise<boolean>        paired, and the Mac answers a ping with that token
//   pairFromUrl(location) -> Promise<boolean>   reads #pair=<code>, trades it for a token, stores it. false = no code in the URL. Throws a Hebrew Error on failure
//   makeClips(file, options, {onProgress, signal}) -> Promise<Clip[]>   upload, start, poll, download. Same Clip shape as engine/pipeline.js
//   (aborting makeClips while the Mac works also tells the Mac to stop that job: POST /api/m/cancel/<id>)
//   forget()                               drops the stored token (the Mac side is cut with lan.revoke)
//   configure({base})                      for tests and demo pages only: prefix for every request ('' = same origin)
//
// Every failure is an Error whose message is Hebrew; an aborted signal throws an Error named "AbortError".

const KEY = 'frame.turbo';
const OFFLINE = 'אין חיבור למק. ודאו שהטלפון והמק מחוברים לאותה רשת Wi-Fi ושהאפשרות ״חיבור הטלפון״ פועלת ב־FRAME';
const config = { base: '' };
let memory = null;

export function configure({ base } = {}) {
  if (typeof base === 'string') config.base = base.replace(/\/+$/, '');
}

function readStore() {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if (v && typeof v.token === 'string' && v.token) return v;
    }
  } catch { /* storage can be blocked (private mode): fall back to memory */ }
  return memory;
}

function writeStore(value) {
  memory = value;
  try {
    if (value) globalThis.localStorage?.setItem(KEY, JSON.stringify(value));
    else globalThis.localStorage?.removeItem(KEY);
  } catch { /* the in-memory copy still works for this session */ }
}

export function forget() {
  writeStore(null);
}

function abortError() {
  const e = new Error('הפעולה בוטלה');
  e.name = 'AbortError';
  return e;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(abortError()); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function transient(message) {
  const e = new Error(message);
  e.transient = true;
  return e;
}

async function serverMessage(res) {
  try {
    const j = await res.json();
    if (j && typeof j.error === 'string') return j.error;
  } catch { /* not JSON */ }
  return '';
}

// One authenticated request. Returns the Response (ok only).
async function call(path, { method = 'GET', body, headers = {}, signal } = {}) {
  throwIfAborted(signal);
  const store = readStore();
  const h = { ...headers };
  if (store) h.Authorization = 'Bearer ' + store.token;
  let res;
  try {
    res = await fetch(config.base + path, { method, headers: h, body, signal });
  } catch (e) {
    if (signal?.aborted || e?.name === 'AbortError') throw abortError();
    throw transient(OFFLINE);
  }
  if (res.ok) return res;
  const message = await serverMessage(res);
  if (res.status === 401) {
    forget();
    throw new Error('החיבור למק נותק. יש לבצע צימוד מחדש: בחרו ״חיבור הטלפון״ ב־FRAME במק וסרקו את הקוד');
  }
  const e = new Error(message || `המק החזיר שגיאה (${res.status})`);
  if (res.status >= 500) e.transient = true;
  throw e;
}

async function getJson(path, options) {
  const res = await call(path, options);
  try {
    return await res.json();
  } catch {
    throw new Error('המק החזיר תשובה שאי אפשר להבין');
  }
}

export async function available() {
  const store = readStore();
  if (!store) return false;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), 3000) : null;
  try {
    const res = await fetch(config.base + '/api/m/ping', { headers: { Authorization: 'Bearer ' + store.token }, signal: ctl?.signal });
    if (res.status === 401) { forget(); return false; }
    if (!res.ok) return false;
    const j = await res.json();
    return !!(j && j.ok === true && j.app === 'FRAME');
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function deviceName() {
  const ua = String(globalThis.navigator?.userAgent || '');
  if (/iPad/i.test(ua)) return 'אייפד';
  if (/iPhone|iPod/i.test(ua)) return 'אייפון';
  if (/Android/i.test(ua)) return 'אנדרואיד';
  return 'טלפון';
}

export async function pairFromUrl(loc = globalThis.location) {
  const hash = String(loc?.hash || '').replace(/^#/, '');
  const code = new URLSearchParams(hash).get('pair');
  if (!code) return false;
  if (loc.protocol === 'https:') {
    throw new Error('אפשר להתחבר למק רק כשהאפליקציה נפתחת מהמק, בכתובת שמתחילה ב־http. פתחו את הקישור או את קוד ה־QR שמוצגים ב־FRAME במק');
  }
  const base = loc.origin && loc.origin !== 'null' ? loc.origin : config.base;
  let res;
  try {
    res = await fetch(base + '/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: deviceName() }) });
  } catch {
    throw new Error(OFFLINE);
  }
  let j = {};
  try { j = await res.json(); } catch { /* handled below */ }
  if (!res.ok || typeof j.token !== 'string') {
    throw new Error((typeof j.error === 'string' && j.error) || 'הצימוד למק נכשל. אפשר ליצור קוד חדש ב־FRAME במק');
  }
  writeStore({ token: j.token, id: j.id, name: j.name });
  try {                                                  // the one-time code does not stay in the address bar or the history
    globalThis.history?.replaceState(null, '', (loc.pathname || '/') + (loc.search || ''));
  } catch { /* not a browser */ }
  return true;
}

// ---- the job ------------------------------------------------------------------------------------------------------------------------------
function upload(file, signal, onFraction) {
  const store = readStore();
  const name = encodeURIComponent(file.name || 'video');
  if (typeof XMLHttpRequest === 'function') {            // fetch cannot report upload progress, XHR can
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const onAbort = () => xhr.abort();
      const done = () => signal?.removeEventListener?.('abort', onAbort);
      xhr.open('POST', config.base + '/api/m/upload');
      xhr.setRequestHeader('Authorization', 'Bearer ' + store.token);
      xhr.setRequestHeader('X-Frame-Name', name);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total) onFraction(e.loaded / e.total); };
      xhr.onload = () => {
        done();
        let j = {};
        try { j = JSON.parse(xhr.responseText); } catch { /* handled below */ }
        if (xhr.status === 401) { forget(); return reject(new Error('החיבור למק נותק. יש לבצע צימוד מחדש')); }
        if (xhr.status >= 200 && xhr.status < 300 && typeof j.upload === 'string') return resolve(j);
        reject(new Error(j.error || `ההעלאה למק נכשלה (${xhr.status})`));
      };
      xhr.onerror = () => { done(); reject(new Error(OFFLINE)); };
      xhr.onabort = () => { done(); reject(abortError()); };
      if (signal?.aborted) return reject(abortError());
      signal?.addEventListener?.('abort', onAbort, { once: true });
      xhr.send(file);
    });
  }
  return (async () => {
    const j = await getJson('/api/m/upload', { method: 'POST', body: file, headers: { 'X-Frame-Name': name }, signal });
    onFraction(1);
    if (typeof j.upload !== 'string') throw new Error('ההעלאה למק נכשלה');
    return j;
  })();
}

async function waitForJob(id, signal, onProgress) {
  let failures = 0;
  let delay = 1000;
  for (;;) {
    throwIfAborted(signal);
    try {
      const j = await getJson(`/api/m/job/${id}`, { signal });
      failures = 0;
      onProgress(Number(j.progress) || 0, typeof j.status === 'string' ? j.status : '');
      if (j.state === 'done') return j;
      if (j.state === 'error' || j.state === 'cancelled') throw new Error(j.error || 'העיבוד במק נעצר');
    } catch (e) {
      if (e?.name === 'AbortError' || !e?.transient || ++failures >= 5) throw e;
    }
    await sleep(delay, signal);
    delay = Math.min(Math.round(delay * 1.25), 3000);
  }
}

// Best effort: tells the Mac to stop a job the phone no longer wants (the clips that were already finished stay there).
async function cancelJob(id) {
  const store = readStore();
  if (!store) return;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), 3000) : null;
  try {
    await fetch(`${config.base}/api/m/cancel/${id}`, { method: 'POST', headers: { Authorization: 'Bearer ' + store.token }, signal: ctl?.signal });
  } catch { /* the Mac may be unreachable: nothing more to do */ } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchBlob(path, type, signal) {
  const res = await call(path, { signal });
  const blob = await res.blob();
  return blob.type === type ? blob : new Blob([blob], { type });
}

async function fetchText(path, signal) {
  return (await call(path, { signal })).text();
}

async function optional(task) {
  try { return await task(); } catch (e) { if (e?.name === 'AbortError') throw e; return null; }
}

export async function makeClips(file, options = {}, { onProgress, signal } = {}) {
  const report = (fraction, text) => {
    try { onProgress?.(Math.min(1, Math.max(0, fraction)), text); } catch { /* a faulty listener must not stop the job */ }
  };
  if (!readStore()) throw new Error('הטלפון עדיין לא מחובר למק. בחרו ״חיבור הטלפון״ ב־FRAME במק וסרקו את הקוד');
  if (!file || typeof file.size !== 'number' || file.size <= 0) throw new Error('בחרו סרטון לעריכה');
  throwIfAborted(signal);

  report(0, 'מעלים את הסרטון למק…');
  const up = await upload(file, signal, (f) => report(f * 0.25, `מעלים את הסרטון למק · ${Math.round(f * 100)}%`));

  report(0.25, 'המק מתחיל לערוך…');
  const started = await getJson('/api/m/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ upload: up.upload, options: options || {} }),
  });
  if (typeof started.id !== 'string') throw new Error('המק לא התחיל את העבודה');

  let job;
  try {
    job = await waitForJob(started.id, signal, (p, text) => report(0.25 + p * 0.65, text || 'המק עורך את הקליפים…'));
  } catch (e) {
    if (e?.name === 'AbortError') await cancelJob(started.id);       // the Mac stops working on a video nobody waits for
    throw e;
  }
  const items = Array.isArray(job.clips) ? job.clips : [];
  if (!items.length) throw new Error('המק לא יצר קליפים. כדאי לנסות סרטון אחר');

  const clips = [];
  for (let i = 0; i < items.length; i++) {
    const c = items[i];
    report(0.9 + (0.1 * i) / items.length, `מורידים קליפ ${i + 1} מתוך ${items.length}…`);
    const blob = await fetchBlob(c.video, 'video/mp4', signal);
    const thumbnail = c.thumbnail ? await optional(() => fetchBlob(c.thumbnail, 'image/jpeg', signal)) : null;
    const post = c.post ? await optional(() => fetchText(c.post, signal)) : null;
    const hooks = Array.isArray(c.hooks) && c.hooks.length ? c.hooks : (c.hook ? [c.hook] : []);
    clips.push({
      blob,
      url: typeof URL?.createObjectURL === 'function' ? URL.createObjectURL(blob) : '',
      duration: Number(c.duration) || 0,
      title: c.title || c.hook || '',
      hook: c.hook || hooks[0] || '',
      hooks,
      thumbnail,
      moment: { start: Number(c.start) || 0, end: Number(c.end) || 0, score: Number(c.score) || 0, hook: c.hook || '', hooks, reason: c.reason || '' },
      options: { ...(options || {}) },
      post,
      source: 'mac',
    });
  }
  report(1, 'הקליפים מוכנים');
  return clips;
}
