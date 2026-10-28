// חיבור הממשק למנוע. הממשק קורא רק ל־engine/pipeline.js, ל־features/* ול־engine/turbo.js.
// כל עוד המודולים לא קיימים (או שנכשלו בטעינה), נכנס מנוע הדמה מ־stub.js.
import { turboContext } from './model.js';
import { createLibraryStub, createBatchStub } from './stubs.js';

let cached = null;

export async function loadEngine() {
  if (cached) return cached;
  let real = null;
  // ‏?engine=stub: מנוע הדמה, לבדיקת הממשק בלי עריכה אמיתית
  const forceStub = typeof location !== 'undefined' && new URLSearchParams(location.search).get('engine') === 'stub';
  if (!forceStub) { try { real = await import('../engine/pipeline.js'); } catch { real = null; } }
  if (real && typeof real.makeClips === 'function') {
    cached = {
      kind: 'real', makeClips: real.makeClips,
      rehook: real.rehook || real.applyHook || null,
      renderReaction: real.renderReaction || real.renderPrepared || null,
      renderState: real.renderState || null, // עריכה מחדש מתוך clip.state (סוכן 8)
    };
  } else {
    const stub = await import('./stub.js');
    cached = { kind: 'stub', makeClips: stub.makeClips, rehook: stub.rehook, renderReaction: null, renderState: null };
  }
  return cached;
}

export async function loadTurbo() {
  try { return await import('../engine/turbo.js'); } catch { return null; }
}

// הטלפון מחובר למק? רק כשהאפליקציה נפתחה מהמק או מרשת מקומית. מגרסת GitHub אי אפשר.
export async function turboStatus(loc = location) {
  const where = turboContext(loc);
  if (where === 'github') return { where, connected: false, turbo: null };
  const turbo = await loadTurbo();
  if (!turbo) return { where, connected: false, turbo: null };
  try { if (typeof turbo.pairFromUrl === 'function') await turbo.pairFromUrl(loc); } catch { /* קישור בלי קוד צימוד */ }
  let connected = false;
  try { connected = !!(await turbo.available()); } catch { connected = false; }
  return { where, connected, turbo: connected ? turbo : null };
}

export async function loadFeature(name) {
  try { return await import(`../features/${name}.js`); } catch { return null; }
}

// ספרייה ותור: המודול האמיתי כשהוא קיים, ואחרת דמה בזיכרון
const asApi = (mod) => (mod && (mod.library || mod.batch || mod.default || mod)) || null;
let libraryCache = null, batchCache = null; // batchCache: null = עוד לא נבדק, false = אין מודול

export async function loadLibrary() {
  if (libraryCache) return libraryCache;
  const api = asApi(await loadFeature('library'));
  const fn = (name) => (typeof api[name] === 'function' ? (...a) => api[name](...a) : null);
  libraryCache = api && ['save', 'list', 'get', 'remove'].every((k) => typeof api[k] === 'function')
    ? {
      kind: 'real',
      save: (c, o) => api.save(c, o), list: () => api.list(), get: (id) => api.get(id), remove: (id) => api.remove(id),
      rename: async (id, name) => {
        if (typeof api.rename === 'function') return api.rename(id, name);
        const c = await api.get(id); if (!c) return false; // בלי rename במודול: שומרים עותק בשם החדש ומוחקים את הישן
        await api.save({ ...c, title: name, hook: name }); await api.remove(id); return true;
      },
      usage: typeof api.usage === 'function' ? () => api.usage() : async () => ({}),
      release: fn('release'), thumbUrl: fn('thumbUrl'), status: fn('status'), exportAll: fn('exportAll'), share: fn('share'),
      persist: fn('persist'), // חייב להיקרא מתוך לחיצה
    }
    : createLibraryStub();
  return libraryCache;
}
// הספרייה אם כבר נטענה (בלי המתנה), כדי לשחרר כתובות
export const peekLibrary = () => libraryCache;

// התור האמיתי (או null). בלי מודל, makeClips עובר לתור הדמה
export async function loadBatchModule() {
  if (batchCache !== null) return batchCache || null;
  const api = asApi(await loadFeature('batch'));
  const fn = (name) => (api && typeof api[name] === 'function' ? (...a) => api[name](...a) : null);
  batchCache = api && typeof api.run === 'function'
    ? { kind: 'real', run: (f, o, cb) => api.run(f, o, cb), enableNotifications: fn('enableNotifications'), pending: fn('pending'), resume: fn('resume'), discard: fn('discard') }
    : false;
  return batchCache || null;
}
export async function loadBatch(makeClips) {
  return (await loadBatchModule()) || createBatchStub(makeClips);
}
