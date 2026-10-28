// העורך המהיר: מעטפת סביב features/quick-editor.js. העורך עצמו מצייר תצוגה חיה על קנבס, והייצוא קורה רק בסוף.
import { h, icon } from './dom.js';
import { T } from './texts.js';

export function editorScreen(ctx) {
  const idx = ctx.state.editing, clip = ctx.clips[idx];
  const host = h('div', { class: 'editor-host' });
  const msg = h('p', { class: 'notice', role: 'status', hidden: true });
  const busyText = h('p', { class: 'p-text' }, T.editor.exporting);
  const busyBar = h('span', { class: 'bar-fill' });
  const busy = h('div', { class: 'busy', hidden: true, role: 'status' }, h('div', { class: 'busy-box' }, h('div', { class: 'bar' }, busyBar), busyText));
  const say = (m) => { msg.textContent = m; msg.hidden = !m; };
  let handle = null, alive = true;

  const onExport = async (arg, opts = {}) => {
    busy.hidden = false; busyBar.style.width = '4%'; busyText.textContent = T.editor.exporting;
    try {
      await ctx.exportEdit(idx, arg, (f, text) => {
        busyBar.style.width = `${Math.round(Math.max(0.04, Math.min(1, f)) * 100)}%`; if (text) busyText.textContent = text;
        if (typeof opts.onProgress === 'function') opts.onProgress(f, text);
      }, opts.signal);
      ctx.toast(T.editor.exported);
    } catch (e) {
      if (alive) { busy.hidden = true; say(e && /[֐-׿]/.test(e.message) ? e.message : T.errors.generic); }
    }
  };

  (async () => {
    if (!clip || !clip.state) { say(T.editor.cannot); return; }
    const mod = await ctx.loadFeature('quick-editor');
    if (!alive) return;
    if (!mod || typeof mod.mountQuickEditor !== 'function') { say(T.editor.soon); return; }
    try { handle = mod.mountQuickEditor(host, { clipState: clip.state, onExport, brand: await ctx.brand() }); if (handle && typeof handle.then === 'function') handle = await handle; } catch { say(T.errors.generic); }
  })();

  const el = h('section', { class: 'screen-editor' },
    h('button', { type: 'button', class: 'back-link', onClick: () => ctx.dispatch({ type: 'closeEditor' }) }, icon('back', 18), T.editor.back),
    h('h1', { class: 'sr-only' }, T.editor.title),
    msg, host, busy);
  return {
    el,
    destroy: () => {
      alive = false;
      try { if (typeof handle === 'function') handle(); else if (handle && typeof handle.destroy === 'function') handle.destroy(); else if (handle && typeof handle.unmount === 'function') handle.unmount(); } catch { /* נסגר */ }
    },
  };
}
