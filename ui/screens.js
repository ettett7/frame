// מסכי הזרימה הראשית: פתיחה, אפשרויות, התקדמות ותוצאות.
// כל מסך הוא פונקציה שמקבלת את ה־ctx ומחזירה {el, update(state), destroy()}.
import { h, icon, clear } from './dom.js';
import { T, lengthLabel, clockText, sizeText } from './texts.js';
import {
  TYPES, LENGTHS, COUNTS, MUSIC, FORMATS, FORMAT_NAMES, BG_SCENES, stepStates, etaText, optionsSummary, canStart, pageLabel, backgroundReady,
} from './model.js';
import { postCard } from './post-ui.js';

// ------------------------------------------------------------------ פתיחה

export function homeScreen(ctx) {
  const s = ctx.state;
  const input = (capture) => h('input', {
    type: 'file', accept: 'video/*', class: 'sr-only', ...(capture ? { capture: 'environment' } : { multiple: true }),
    onChange: (e) => { const list = [...(e.target.files || [])]; e.target.value = ''; if (list.length > 1) ctx.pickFiles(list); else if (list[0]) ctx.pickFile(list[0]); },
  });
  const tpl = s.template && T.templates.list.find((x) => x.id === s.template);
  const el = h('section', { class: 'screen-home' },
    h('div', { class: 'hero rise' },
      h('p', { class: 'eyebrow' }, T.tagline),
      h('h1', {}, T.home.title),
      h('p', { class: 'lede' }, T.home.lede)),
    ctx.pendingBanner(),
    ctx.installBanner(),
    tpl && h('div', { class: 'chip-tpl rise' },
      h('span', {}, `${T.home.template}: ${tpl.icon} ${tpl.name}`),
      h('button', { type: 'button', class: 'chip-x', 'aria-label': T.home.removeTemplate, onClick: () => ctx.dispatch({ type: 'selectTemplate', id: null }) }, icon('close', 16))),
    h('label', { class: 'pick-card rise', style: { '--d': '60ms' } },
      input(false),
      h('span', { class: 'pick-icon' }, icon('upload', 34)),
      h('b', {}, T.home.pick),
      h('small', {}, T.home.pickHint)),
    h('label', { class: 'pick-alt rise', style: { '--d': '120ms' } },
      input(true),
      h('span', { class: 'pick-alt-icon' }, icon('camera', 24)),
      h('span', { class: 'pick-alt-text' }, h('b', {}, T.home.camera), h('small', {}, T.home.cameraHint))),
    s.error && h('p', { class: 'error', role: 'alert' }, s.error),
    s.notice && h('p', { class: 'notice', role: 'status' }, s.notice),
    h('p', { class: 'privacy' }, icon('lock', 16), T.home.privacy));
  return { el };
}

// ------------------------------------------------------------------ אפשרויות

export function optionsScreen(ctx) {
  const s = ctx.state, file = s.file;
  const video = h('video', { class: 'preview', muted: true, playsinline: true, preload: 'metadata', 'aria-hidden': 'true' });
  video.muted = true;
  if (ctx.fileUrl) video.src = ctx.fileUrl + '#t=0.4';
  video.addEventListener('loadedmetadata', () => { if (Number.isFinite(video.duration)) ctx.dispatch({ type: 'setDuration', duration: video.duration }); });

  const meta = h('div', { class: 'file-meta' });
  const paintMeta = (st) => {
    clear(meta);
    meta.append(h('b', { dir: 'auto' }, st.file ? st.file.name : ''),
      h('small', {}, [st.file && st.file.duration ? clockText(st.file.duration) : '', st.file ? sizeText(st.file.size) : ''].filter(Boolean).join(' · ')));
  };

  const radio = (key, value, content, extra = '') => h('button', {
    type: 'button', role: 'radio', class: `choice ${extra}`, dataset: { key, value: String(value) }, 'aria-checked': 'false',
    onClick: () => ctx.dispatch({ type: 'setOption', key, value }),
  }, content);

  const typeGrid = h('div', { class: 'type-grid', role: 'radiogroup', 'aria-label': T.options.type },
    ...TYPES.map((t) => radio('type', t.id, [h('span', { class: 'type-icon', 'aria-hidden': 'true' }, t.icon), h('b', {}, t.name)], 'choice-card')));
  const lengthRow = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': T.options.length },
    ...LENGTHS.map((v) => radio('length', v, lengthLabel(v), 'choice-chip')));
  const countRow = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': T.options.count },
    ...COUNTS.map((v) => radio('count', v, v === 1 ? 'אחד' : String(v), 'choice-chip')));
  const musicRow = h('div', { class: 'chips wrap', role: 'radiogroup', 'aria-label': T.options.music },
    ...MUSIC.map((m) => radio('music', m.id, m.name, 'choice-chip')));
  const formatRow = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': T.options.format },
    ...FORMATS.map((f) => radio('format', f, [h('b', { dir: 'ltr' }, f), h('small', {}, FORMAT_NAMES[f])], 'choice-chip tall')));
  const captions = h('label', { class: 'switch-row' },
    h('span', {}, h('b', {}, T.options.captions), h('small', {}, T.options.captionsOn)),
    h('input', { type: 'checkbox', role: 'switch', class: 'switch', dataset: { key: 'captions' }, onChange: (e) => ctx.dispatch({ type: 'setOption', key: 'captions', value: e.target.checked }) }));

  const summary = h('p', { class: 'cta-summary' });
  const ctaLabel = h('span', {}, T.options.cta);
  const cta = h('button', { type: 'button', class: 'cta', onClick: () => ctx.start() }, icon('sparkle', 24), ctaLabel);
  const messages = h('div', { class: 'messages' });

  const batchCard = s.batch && h('div', { class: 'file-card batch-card rise' },
    h('div', { class: 'file-meta' }, h('b', {}, T.batch.count(s.batch.files.length)), h('small', {}, T.batch.pickHint)),
    h('ul', { class: 'batch-list' }, ...s.batch.files.map((f) => h('li', {}, h('span', { dir: 'auto' }, f.name), h('small', {}, sizeText(f.size))))),
    h('button', { type: 'button', class: 'link-btn', onClick: () => ctx.dispatch({ type: 'clearFile' }) }, T.options.change));
  const fileCard = h('div', { class: 'file-card rise' },
    h('div', { class: 'preview-wrap' }, video),
    meta,
    h('button', { type: 'button', class: 'link-btn', onClick: () => ctx.dispatch({ type: 'clearFile' }) }, T.options.change));

  // רקע, אפקטים ומותג
  const bgRow = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': T.bg.title },
    ...[['none', T.bg.none], ['blur', T.bg.blur], ['replace', 'החלפה']].map(([v, label]) => radio('background', v, label, 'choice-chip')));
  const galleryInput = h('input', { type: 'file', accept: 'image/*', class: 'sr-only', onChange: (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (f) ctx.setBgGallery(f);
  } });
  const sceneRow = h('div', { class: 'chips scenes wrap', role: 'radiogroup', 'aria-label': T.bg.title },
    ...BG_SCENES.map((sc) => h('button', { type: 'button', role: 'radio', class: 'choice choice-chip scene', dataset: { key: 'bgScene', value: sc.id }, 'aria-checked': 'false', onClick: () => ctx.dispatch({ type: 'setOption', key: 'bgScene', value: sc.id }) },
      h('span', { class: 'scene-swatch', style: { background: `linear-gradient(160deg, ${sc.from}, ${sc.to})` }, 'aria-hidden': 'true' }), sc.name)),
    h('button', { type: 'button', role: 'radio', class: 'choice choice-chip scene', dataset: { key: 'bgScene', value: 'gallery' }, 'aria-checked': 'false', onClick: () => galleryInput.click() },
      icon('upload', 18), h('span', { class: 'gallery-label' }, T.bg.gallery)));
  const densityRow = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': T.effects.title },
    ...[['low', T.effects.few], ['normal', T.effects.regular], ['high', T.effects.many]].map(([v, label]) => radio('density', v, label, 'choice-chip')));
  const brandRow = h('label', { class: 'switch-row' },
    h('span', {}, h('b', {}, T.brand.use), h('small', {}, ctx.hasBrand() ? T.brand.useHint : T.brand.none)),
    h('input', { type: 'checkbox', role: 'switch', class: 'switch', dataset: { key: 'brand' }, disabled: !ctx.hasBrand(), onChange: (e) => ctx.dispatch({ type: 'setOption', key: 'brand', value: e.target.checked }) }));

  const el = h('section', { class: 'screen-options' },
    batchCard || fileCard,
    messages,
    h('h2', { class: 'sect' }, T.options.type), typeGrid,
    h('h2', { class: 'sect' }, T.options.length), lengthRow,
    h('h2', { class: 'sect' }, T.options.count), countRow,
    h('h2', { class: 'sect' }, T.options.music), musicRow,
    h('details', { class: 'more' },
      h('summary', {}, T.options.more),
      h('h3', { class: 'sect small' }, T.bg.title), bgRow, sceneRow, galleryInput,
      h('h3', { class: 'sect small' }, T.effects.title), densityRow, h('p', { class: 'hint' }, T.effects.hint),
      h('h3', { class: 'sect small' }, T.options.format), formatRow, captions, brandRow),
    h('div', { class: 'cta-bar' }, summary, cta));

  function update(st) {
    paintMeta(st);
    el.querySelectorAll('.choice').forEach((b) => {
      const on = String(st[b.dataset.key]) === b.dataset.value;
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('is-on', on);
    });
    el.querySelectorAll('input.switch').forEach((i) => { i.checked = !!st[i.dataset.key] && !i.disabled; });
    sceneRow.hidden = st.background !== 'replace';
    el.querySelector('.gallery-label').textContent = st.bgGallery ? st.bgGallery.name : T.bg.gallery;
    ctaLabel.textContent = st.batch ? T.batch.cta : T.options.cta;
    summary.textContent = optionsSummary(st) + (st.template ? ` · ${(T.templates.list.find((x) => x.id === st.template) || {}).name || ''}` : '');
    cta.disabled = !canStart(st);
    clear(messages);
    if (st.error) messages.append(h('p', { class: 'error', role: 'alert' }, st.error));
    if (st.notice) messages.append(h('p', { class: 'notice', role: 'status' }, st.notice));
    if (!backgroundReady(st)) messages.append(h('p', { class: 'notice', role: 'status' }, T.bg.need));
  }
  update(s);
  return { el, update };
}

// ------------------------------------------------------------------ התקדמות

const RING = 2 * Math.PI * 54;

export function progressScreen(ctx) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 120 120'); svg.setAttribute('class', 'ring'); svg.setAttribute('aria-hidden', 'true');
  const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  for (const [k, v] of Object.entries({ cx: 60, cy: 60, r: 54, class: 'ring-track' })) track.setAttribute(k, v);
  const fill = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  for (const [k, v] of Object.entries({ cx: 60, cy: 60, r: 54, class: 'ring-fill', 'stroke-dasharray': RING, 'stroke-dashoffset': RING })) fill.setAttribute(k, v);
  svg.append(track, fill);

  const pct = h('b', { class: 'ring-pct' }, '0%');
  const text = h('p', { class: 'p-text', 'aria-live': 'polite' }, '');
  const eta = h('p', { class: 'p-eta' }, T.progress.etaSoon);
  const list = h('ol', { class: 'steps' });
  const batchList = h('ul', { class: 'batch-run' });
  const notifyHost = h('div', { class: 'notify-host' });
  const tip = h('p', { class: 'tip' }, T.progress.tips[0]);
  let tipIndex = 0;
  const tipTimer = setInterval(() => { tipIndex = (tipIndex + 1) % T.progress.tips.length; tip.textContent = T.progress.tips[tipIndex]; tip.classList.remove('rise'); void tip.offsetWidth; tip.classList.add('rise'); }, 6000);

  const el = h('section', { class: 'screen-progress' },
    h('div', { class: 'orb' }, h('div', { class: 'ring-wrap' }, svg, pct)),
    h('h1', {}, T.progress.title),
    text, eta, list, batchList, notifyHost,
    h('p', { class: 'keep' }, icon('lock', 16), T.progress.keepOpen),
    tip,
    h('button', { type: 'button', class: 'ghost-btn', onClick: () => ctx.cancel() }, T.progress.cancel));

  let lastEtaPaint = 0;
  function update(st) {
    const job = st.job;
    if (!job) return;
    const f = job.fraction;
    fill.setAttribute('stroke-dashoffset', String(RING * (1 - f)));
    pct.textContent = `${Math.round(f * 100)}%`;
    text.textContent = job.text || '';
    const now = Date.now();
    if (now - lastEtaPaint > 1500 || f >= 1) {
      lastEtaPaint = now;
      const remaining = job.eta === null || job.eta === undefined ? null : Math.max(0, job.eta - (now - job.etaAt) / 1000);
      eta.textContent = etaText(remaining);
    }
    clear(batchList); clear(notifyHost);
    if (st.batchRun) {
      const ns = ctx.notifyStatus();
      notifyHost.append(ns === 'ask'
        ? h('button', { type: 'button', class: 'ghost-btn', onClick: () => ctx.askNotify() }, icon('bell', 20), h('span', {}, T.batch.notify))
        : h('p', { class: 'hint' }, ns === 'on' ? T.batch.notifyOn : ns === 'denied' ? T.batch.notifyDenied : T.batch.notifyUnsupported));
      if (ns === 'ask') notifyHost.append(h('p', { class: 'hint' }, T.batch.notifyHint));
      list.hidden = true;
      batchList.append(h('li', { class: 'batch-sum' }, T.batch.summary(st.batchRun.doneCount, st.batchRun.items.length)),
        ...st.batchRun.items.map((it) => h('li', { class: `batch-item is-${it.status}` },
          h('span', { class: 'step-dot', 'aria-hidden': 'true' }, it.status === 'done' ? icon('check', 14) : ''),
          h('span', { dir: 'auto' }, it.name), h('small', {}, it.status === 'working' ? `${Math.round(it.fraction * 100)}%` : T.batch.states[it.status]))));
    }
    clear(list);
    if (st.batchRun) return;
    for (const stp of stepStates(f)) {
      list.append(h('li', { class: `step is-${stp.state}`, 'aria-current': stp.state === 'active' ? 'step' : null },
        h('span', { class: 'step-dot', 'aria-hidden': 'true' }, stp.state === 'done' ? icon('check', 14) : ''),
        h('span', {}, stp.label)));
    }
  }
  update(ctx.state);
  return { el, update, destroy: () => clearInterval(tipTimer) };
}

// ------------------------------------------------------------------ תוצאות

export function resultsScreen(ctx) {
  const res = ctx.state.results;
  const sheetHooks = h('div', { class: 'hook-chips', role: 'radiogroup', 'aria-label': T.results.hook });
  const counter = h('span', { class: 'r-counter' });
  const pager = h('div', { class: 'pager', tabindex: '0', 'aria-label': T.results.title });
  const pages = [], videos = [];

  res.clips.forEach((rc, i) => {
    const clip = ctx.clips[i];
    const video = h('video', { class: 'r-video', playsinline: true, loop: true, preload: 'auto', poster: clip.thumbnail ? ctx.thumbUrl(i) : null });
    video.muted = true; video.src = clip.url;
    const mute = h('button', { type: 'button', class: 'round-btn mute', 'aria-label': 'הפעלת קול', onClick: (e) => { e.stopPropagation(); video.muted = !video.muted; mute.replaceChildren(icon(video.muted ? 'mute' : 'sound', 22)); mute.setAttribute('aria-label', video.muted ? 'הפעלת קול' : 'השתקה'); } }, icon('mute', 22));
    const page = h('article', { class: 'page', dataset: { index: i }, 'aria-label': pageLabel(i, res.clips.length) },
      video, h('div', { class: 'page-shade', 'aria-hidden': 'true' }), mute, clip.demo && h('p', { class: 'demo-note' }, T.results.stubNote));
    video.addEventListener('click', () => { if (video.paused) video.play().catch(() => {}); else video.pause(); });
    pages.push(page); videos.push(video); pager.append(page);
  });

  const hookButtons = [];
  function paintHooks(st) {
    const active = st.results.active, rc = st.results.clips[active];
    clear(sheetHooks); hookButtons.length = 0;
    rc.hooks.forEach((hook, j) => {
      const b = h('button', { type: 'button', role: 'radio', class: `hook-chip${j === rc.hookIndex ? ' is-on' : ''}`, 'aria-checked': String(j === rc.hookIndex), dir: 'auto', onClick: () => ctx.pickHook(active, j) }, hook);
      hookButtons.push(b); sheetHooks.append(b);
    });
    counter.textContent = pageLabel(active, st.results.clips.length);
  }

  const bar = (label, name, onClick, cls) => h('button', { type: 'button', class: cls, onClick }, icon(name, 22), h('span', {}, label));
  const editBtn = bar(T.editor.button, 'wand', () => ctx.openEditor(ctx.state.results.active), 'ghost-btn');
  const postHost = h('div', { class: 'post-host' });
  let postFor = -1;
  const sheet = h('div', { class: 'sheet' },
    h('p', { class: 'sheet-title' }, T.results.hook, h('small', {}, ` · ${T.results.hookHint}`)),
    sheetHooks,
    h('div', { class: 'sheet-row' },
      bar(T.results.save, 'share', () => ctx.shareClip(ctx.state.results.active), 'cta cta-sm'),
      bar(T.results.download, 'download', () => ctx.downloadClip(ctx.state.results.active), 'ghost-btn')),
    h('div', { class: 'sheet-row one' }, editBtn),
    postHost,
    h('div', { class: 'sheet-row small' },
      bar(T.results.editAgain, 'refresh', () => ctx.dispatch({ type: 'editAgain' }), 'link-btn'),
      bar(T.results.home, 'plus', () => ctx.dispatch({ type: 'newVideo' }), 'link-btn')));

  const top = h('div', { class: 'r-top' },
    h('button', { type: 'button', class: 'round-btn', 'aria-label': T.results.editAgain, onClick: () => ctx.dispatch({ type: 'editAgain' }) }, icon('back', 22)),
    counter,
    h('span', { class: 'r-hint' }, res.clips.length > 1 ? T.results.swipe : ''));

  const el = h('section', { class: 'screen-results' }, pager, top, sheet);

  // הקליפ שבמרכז מתנגן, והשאר עוצרים. לפי מיקום הגלילה (ולא IntersectionObserver, שלא תמיד מופעל בכרטיסיות ברקע)
  let shown = -1, timer = 0;
  function sync() {
    const h = pager.clientHeight || 1, i = Math.min(videos.length - 1, Math.max(0, Math.round(pager.scrollTop / h)));
    if (i === shown) return;
    shown = i;
    videos.forEach((v, j) => { if (j === i) v.play().catch(() => {}); else v.pause(); });
    if (ctx.state.results && ctx.state.results.active !== i) ctx.dispatch({ type: 'page', index: i });
  }
  pager.addEventListener('scroll', () => { clearTimeout(timer); timer = setTimeout(sync, 90); }, { passive: true });
  setTimeout(sync, 60);

  function update(st) {
    paintHooks(st);
    editBtn.hidden = !ctx.canEdit(st.results.active);
    if (postFor !== st.results.active) { postFor = st.results.active; if (postHost.firstChild && postHost.firstChild.destroy) postHost.firstChild.destroy(); clear(postHost); postHost.append(postCard(ctx, st.results.active)); }
    st.results.clips.forEach((rc, i) => {
      const clip = ctx.clips[i];
      if (videos[i].getAttribute('src') !== clip.url) { const t = videos[i].currentTime; videos[i].src = clip.url; videos[i].currentTime = t || 0; videos[i].play().catch(() => {}); }
    });
  }
  update(ctx.state);
  return { el, update, destroy: () => { clearTimeout(timer); if (postHost.firstChild && postHost.firstChild.destroy) postHost.firstChild.destroy(); videos.forEach((v) => { v.pause(); v.removeAttribute('src'); v.load(); }); } };
}
