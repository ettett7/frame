// כרטיס "פוסט ותמונת שער" בתוצאות: כותרת, תיאור, האשטגים וקריאה לפעולה עם כפתורי העתקה, ותמונת שער לשמירה ולשיתוף.
// הכרטיס מופיע רק כשיש פוסט או כשאפשר ליצור תמונת שער (features/post-kit.js ו־features/cover.js).
import { h, icon, clear } from './dom.js';
import { T } from './texts.js';
import { postText, hashtagsText } from './model.js';
import { openModal } from './overlay.js';

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* ננסה בדרך הישנה */ }
  const ta = h('textarea', { 'aria-hidden': 'true', style: { position: 'fixed', top: '0', insetInlineStart: '0', opacity: '0' } });
  ta.value = text; document.body.append(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

export function postCard(ctx, index) {
  const host = h('div', { class: 'post-card-host' });
  const body = h('div', { class: 'post-body' });
  host.hidden = true;

  const field = (label, text) => h('div', { class: 'post-field' },
    h('div', { class: 'post-field-head' }, h('b', {}, label),
      h('button', { type: 'button', class: 'link-btn', onClick: async () => ctx.toast((await copyText(text)) ? T.post.copied : T.post.copyFailed) }, T.post.copy)),
    h('p', { dir: 'auto', class: 'post-text' }, text));

  let coverUrl = '';
  function paintCover(info) {
    const wrap = h('div', { class: 'cover-box' });
    if (info.cover) {
      coverUrl = URL.createObjectURL(info.cover);
      wrap.append(h('img', { class: 'cover-img', src: coverUrl, alt: T.post.cover }),
        h('div', { class: 'sheet-row' },
          h('button', { type: 'button', class: 'ghost-btn', onClick: () => ctx.saveCover(index) }, icon('download', 20), h('span', {}, T.post.coverSave)),
          h('button', { type: 'button', class: 'ghost-btn', onClick: () => ctx.shareCover(index) }, icon('share', 20), h('span', {}, T.post.coverShare))));
    } else if (info.canCover) {
      const btn = h('button', { type: 'button', class: 'ghost-btn', onClick: async () => {
        btn.disabled = true; btn.textContent = T.post.coverMaking;
        const made = await ctx.makeCoverFor(index);
        if (made) fill(); else { btn.disabled = false; btn.textContent = T.post.coverMake; ctx.toast(T.post.coverFailed); }
      } }, T.post.coverMake);
      wrap.append(btn);
    } else return null;
    return h('div', { class: 'post-field' }, h('div', { class: 'post-field-head' }, h('b', {}, T.post.cover)), wrap);
  }

  async function fill() {
    const info = await ctx.postInfo(index);
    if (coverUrl) { URL.revokeObjectURL(coverUrl); coverUrl = ''; }
    clear(body);
    if (!info || (!info.post && !info.cover && !info.canCover)) { host.hidden = true; return; }
    const post = info.post;
    if (post) {
      if (post.title) body.append(field(T.post.heading, post.title));
      if (post.description) body.append(field(T.post.description, post.description));
      if (post.hashtags.length) body.append(field(T.post.hashtags, hashtagsText(post)));
      if (post.cta) body.append(field(T.post.cta, post.cta));
      body.append(h('button', { type: 'button', class: 'cta cta-sm', onClick: async () => ctx.toast((await copyText(postText(post))) ? T.post.copied : T.post.copyFailed) }, icon('check', 20), h('span', {}, T.post.copyAll)));
    }
    const cover = paintCover(info);
    if (cover) body.append(cover);
    host.hidden = false;
  }

  // הכרטיס נפתח בחלון משלו, כדי שהנגן לא יצטמצם
  const open = () => {
    const m = openModal({ label: T.post.title, content: [
      h('button', { type: 'button', class: 'round-btn modal-x', 'aria-label': T.library.cancel, onClick: () => m.close() }, icon('close', 22)),
      h('h2', {}, T.post.title), body] });
  };
  host.append(h('button', { type: 'button', class: 'ghost-btn post-open', onClick: open }, icon('sparkle', 20), h('span', {}, T.post.title)));
  fill();
  host.destroy = () => { if (coverUrl) URL.revokeObjectURL(coverUrl); };
  return host;
}
