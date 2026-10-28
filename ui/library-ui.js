// "הקליפים שלי": רשת שערים של כל הקליפים שנשמרו במכשיר, עם פתיחה, שיתוף, שינוי שם ומחיקה באישור, ומד מקום.
import { h, icon, clear } from './dom.js';
import { openModal, busyLayer } from './overlay.js';
import { T, clockText, sizeText } from './texts.js';
import { normalizeUsage, sortLibrary, libraryTitle, validateName, clipFileName } from './model.js';

export { openModal };

const dateText = (ts) => { try { return new Date(ts).toLocaleDateString('he-IL', { day: 'numeric', month: 'short' }); } catch { return ''; } };

export function libraryScreen(ctx) {
  const grid = h('div', { class: 'lib-grid' });
  const meterFill = h('span', { class: 'meter-fill' });
  const meterText = h('small', {});
  const meter = h('div', { class: 'meter-box', hidden: true }, h('div', { class: 'meter', role: 'progressbar', 'aria-label': T.library.usage, 'aria-valuemin': '0', 'aria-valuemax': '100' }, meterFill), meterText);
  const status = h('p', { class: 'notice', role: 'status', hidden: true });
  const warn = h('div', { class: 'notice warn-box', role: 'status', hidden: true });
  const protect = h('div', { class: 'protect-box', hidden: true });
  const tools = h('div', { class: 'row lib-tools', hidden: true });
  protect.append(h('p', { class: 'hint' }, T.library.protectHint), h('button', { type: 'button', class: 'ghost-btn small', onClick: () => protectNow() }, icon('lock', 18), h('span', {}, T.library.protect)));
  const empty = h('div', { class: 'lib-empty', hidden: true }, h('p', {}, T.library.empty),
    h('button', { type: 'button', class: 'cta cta-sm', onClick: () => ctx.dispatch({ type: 'go', screen: 'home' }) }, icon('upload', 20), h('span', {}, T.library.emptyAction)));
  let urls = [], alive = true, lib = null, modalHandle = null;

  const say = (m) => { status.textContent = m || ''; status.hidden = !m; };
  const thumbUrl = (it) => {
    if (typeof it.thumbnail === 'string') return it.thumbnail;
    if (it.thumbnail instanceof Blob) {
      if (lib && lib.thumbUrl) return lib.thumbUrl(it); // הספרייה שומרת ומשחררת את הכתובות בעצמה
      const u = URL.createObjectURL(it.thumbnail); urls.push(u); return u;
    }
    return '';
  };

  async function paintUsage() {
    let u, raw = null;
    try { raw = await lib.usage(); u = normalizeUsage(raw); } catch { u = normalizeUsage(null); }
    u.persisted = raw && typeof raw.persisted === 'boolean' ? raw.persisted : null;
    if (!alive) return;
    meter.hidden = !(u.used || u.known);
    meterFill.style.width = `${Math.round(u.fraction * 100)}%`;
    meter.firstChild.classList.toggle('is-warn', u.level !== 'ok');
    meter.firstChild.setAttribute('aria-valuenow', String(Math.round(u.fraction * 100)));
    protect.hidden = !(lib.persist && u.known && u.persisted === false);
    meterText.textContent = `${T.library.usage}: ${sizeText(u.used)}${u.known ? ` מתוך ${sizeText(u.quota)}` : ''}${u.level === 'full' ? `. ${T.library.usageFull}` : ''}`;
  }

  // האחסון לא קבוע (גלישה פרטית, או IndexedDB חסום): הקליפים יעלמו בסגירה
  async function paintWarning() {
    let persistent = true;
    try { if (lib.status) persistent = (await lib.status()).persistent !== false; else persistent = lib.kind !== 'stub'; } catch { persistent = true; }
    if (!alive) return;
    clear(warn); warn.hidden = persistent;
    if (!persistent) {
      warn.append(h('span', {}, T.library.notPersistent));
      if (ctx.install.mode !== 'installed') warn.append(h('button', { type: 'button', class: 'link-btn', onClick: () => ctx.dispatch({ type: 'go', screen: 'install' }) }, T.library.notPersistentHow));
    }
  }
  // "הגנה על הקליפים": הבקשה מהדפדפן חייבת לבוא מלחיצה של המשתמש
  async function protectNow() {
    try { const res = await lib.persist(); ctx.toast((res && res.textHe) || T.library.protectDone); } catch { ctx.toast(T.errors.generic); }
    paintUsage();
  }
  async function exportEverything() {
    const busy = busyLayer(T.library.exporting);
    try {
      const out = await lib.exportAll({ onProgress: (f) => busy.set(f) });
      busy.done();
      const res = await lib.share(out, { title: T.library.title }); // אם השיתוף נחסם (פג תוקף הלחיצה) הספרייה יורדת להורדה רגילה
      ctx.toast(res && res.method === 'canceled' ? T.results.shareCancelled : res && res.method === 'download' ? T.results.downloadStarted : T.results.shared);
    } catch { busy.done(); ctx.toast(T.library.exportFailed); }
  }

  async function load() {
    lib = await ctx.library();
    if (!alive) return;
    say(lib.kind === 'stub' ? T.library.stub : '');
    paintWarning();
    let items = [];
    try { items = sortLibrary(await lib.list()); } catch { say(T.library.loadFailed); }
    if (!alive) return;
    urls.forEach((u) => URL.revokeObjectURL(u)); urls = [];
    clear(grid);
    empty.hidden = items.length > 0;
    clear(tools); tools.hidden = !(items.length && lib.exportAll && lib.share);
    if (!tools.hidden) tools.append(h('button', { type: 'button', class: 'ghost-btn small', onClick: exportEverything }, icon('download', 18), h('span', {}, T.library.exportAll)));
    for (const it of items) {
      const src = thumbUrl(it), title = libraryTitle(it);
      grid.append(h('button', { type: 'button', class: 'lib-card rise', onClick: () => openClip(it) },
        h('span', { class: 'lib-cover', style: src ? { backgroundImage: `url("${src}")` } : {} }, !src && icon('sparkle', 28),
          it.duration ? h('small', { class: 'lib-dur' }, clockText(it.duration)) : null),
        h('b', { dir: 'auto' }, title),
        h('small', {}, [dateText(it.createdAt ?? it.savedAt), (it.size ?? it.bytes) ? sizeText(it.size ?? it.bytes) : ''].filter(Boolean).join(' · '))));
    }
    paintUsage();
  }

  // ---- צפייה בקליפ
  async function openClip(item) {
    let clip = null;
    try { clip = await lib.get(item.id); } catch { clip = null; }
    if (!clip || !(clip.blob instanceof Blob)) { ctx.toast(T.library.loadFailed); return; }
    const own = !clip.url, url = clip.url || URL.createObjectURL(clip.blob);
    const title = h('h2', { dir: 'auto' }, libraryTitle(clip));
    const video = h('video', { class: 'lib-video', src: url, controls: true, playsinline: true, loop: true, autoplay: true });
    video.muted = true;
    const actions = h('div', { class: 'sheet-row' },
      h('button', { type: 'button', class: 'cta cta-sm', onClick: () => shareOne(clip) }, icon('share', 20), h('span', {}, T.library.share)),
      h('button', { type: 'button', class: 'ghost-btn', onClick: () => renameClip(item, clip, title) }, T.library.rename));
    const del = h('button', { type: 'button', class: 'link-btn danger', onClick: () => confirmDelete(item) }, icon('close', 18), h('span', {}, T.library.remove));
    modalHandle = openModal({ label: libraryTitle(clip), onClose: () => { video.pause(); if (!own && lib.release) lib.release(clip); else URL.revokeObjectURL(url); },
      content: [h('button', { type: 'button', class: 'round-btn modal-x', 'aria-label': T.library.cancel, onClick: () => modalHandle.close() }, icon('close', 22)), video, title, actions, del] });
  }

  async function shareOne(clip) {
    const name = clipFileName(clip, 0), title = libraryTitle(clip);
    if (!lib.share) { ctx.shareBlob(clip.blob, name, title); return; }
    try {
      const res = await lib.share(new File([clip.blob], name, { type: clip.blob.type || 'video/mp4' }), { title });
      ctx.toast(res && res.method === 'canceled' ? T.results.shareCancelled : res && res.method === 'download' ? T.results.downloadStarted : T.results.shared);
    } catch { ctx.toast(T.results.shareFailed); }
  }

  function renameClip(item, clip, titleEl) {
    const input = h('input', { type: 'text', class: 'field', value: libraryTitle(clip), maxlength: '60', dir: 'auto', 'aria-label': T.library.renameTitle });
    const err = h('p', { class: 'error', role: 'alert', hidden: true });
    const save = async () => {
      const v = validateName(input.value);
      if (!v.ok) { err.textContent = v.error; err.hidden = false; return; }
      m.close();
      try { const ok = await lib.rename(item.id, v.value); if (ok === false) throw new Error('x'); ctx.toast(T.library.renamed); titleEl.textContent = v.value; if (modalHandle) modalHandle.close(); await load(); } catch { ctx.toast(T.library.loadFailed); }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    const m = openModal({ label: T.library.renameTitle, content: [h('h2', {}, T.library.renameTitle), input, err,
      h('div', { class: 'sheet-row' }, h('button', { type: 'button', class: 'cta cta-sm', onClick: save }, T.library.renameSave), h('button', { type: 'button', class: 'ghost-btn', onClick: () => m.close() }, T.library.cancel))] });
    input.focus(); input.select();
  }

  function confirmDelete(item) {
    const m = openModal({ label: T.library.confirmTitle, content: [h('h2', {}, T.library.confirmTitle), h('p', { class: 'lede' }, T.library.confirmText),
      h('div', { class: 'sheet-row' },
        h('button', { type: 'button', class: 'cta cta-sm danger-btn', onClick: async () => { m.close(); if (modalHandle) modalHandle.close(); try { await lib.remove(item.id); ctx.toast(T.library.removed); } catch { ctx.toast(T.library.loadFailed); } await load(); } }, T.library.confirmOk),
        h('button', { type: 'button', class: 'ghost-btn', onClick: () => m.close() }, T.library.cancel))] });
  }

  const el = h('section', { class: 'screen-library' },
    h('div', { class: 'hero rise' }, h('h1', {}, T.library.title), h('p', { class: 'lede' }, T.library.lede)),
    status, warn, meter, protect, tools, grid, empty);
  load();
  return { el, destroy: () => { alive = false; urls.forEach((u) => URL.revokeObjectURL(u)); if (modalHandle) modalHandle.close(); } };
}
