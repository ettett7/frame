// מחליפי דמה לספרייה ולתור, עד שהמודולים האמיתיים (features/library.js ו־features/batch.js) מגיעים.
// הספרייה כאן שומרת בזיכרון בלבד, ולכן הממשק מציג הודעה ברורה על כך.

export function createLibraryStub() {
  const items = new Map();
  let seq = 0;
  const meta = (c) => ({ id: c.id, title: c.title, hook: c.hook, thumbnail: c.thumbnail || null, createdAt: c.createdAt, duration: c.duration || 0, size: c.blob ? c.blob.size : 0 });
  return {
    kind: 'stub',
    async save(clip) {
      const id = `m${Date.now().toString(36)}${(seq++).toString(36)}`;
      items.set(id, { ...clip, id, createdAt: Date.now() });
      return id;
    },
    async list() { return [...items.values()].map(meta); },
    async get(id) { return items.get(id) || null; },
    async remove(id) { return items.delete(id); },
    async status() { return { backend: 'memory', persistent: false }; },
    async rename(id, name) { const c = items.get(id); if (!c) return false; c.title = name; c.hook = name; return true; },
    async usage() {
      let used = 0, quota = 0;
      for (const c of items.values()) used += c.blob ? c.blob.size : 0;
      try { const e = await navigator.storage.estimate(); quota = e.quota || 0; } catch { quota = 0; }
      return { used, quota };
    },
  };
}

// תור פשוט: סרטון אחרי סרטון, עם אותה עריכה. makeClips מגיע מהמנוע.
export function createBatchStub(makeClips) {
  return {
    kind: 'stub',
    async run(files, options, { onItem = () => {}, onProgress = () => {}, signal } = {}) {
      const all = [];
      for (let i = 0; i < files.length; i++) {
        if (signal && signal.aborted) throw Object.assign(new Error('בוטל'), { name: 'AbortError' });
        onItem({ index: i, status: 'working' });
        try {
          const clips = await makeClips(files[i], options, { signal, onProgress: (f, text) => onProgress({ index: i, itemFraction: f, overall: (i + f) / files.length, text }) });
          all.push(...clips);
          onItem({ index: i, status: 'done', clips });
        } catch (e) {
          if (e && e.name === 'AbortError') throw e;
          onItem({ index: i, status: 'error', error: e });
        }
      }
      return all;
    },
  };
}
