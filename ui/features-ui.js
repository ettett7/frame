// מסכי הכניסה ליכולות החכמות: טלפרומפטר, תגובה ועריכה בקול.
// המודולים (features/*) בונים בעצמם ממשק הקלטה מלא על המסך, ולכן כאן יש מסך הכנה, ואחריו שכבה במסך מלא שבה המודול רץ.
// אם מודול לא קיים, מוצגת הודעה ברורה במקום קריסה.
import { h, icon, clear } from './dom.js';
import { T, clockText } from './texts.js';
import { busyLayer } from './overlay.js';

const back = (ctx) => h('button', { type: 'button', class: 'back-link', onClick: () => ctx.dispatch({ type: 'go', screen: 'smart' }) }, icon('back', 18), T.smart.back);
const hebrew = (e) => (e && typeof e.message === 'string' && /[֐-׿]/.test(e.message) ? e.message : T.errors.generic);
const extOf = (type) => (/mp4|quicktime/.test(type) ? 'mp4' : 'webm');

// שכבה במסך מלא שהמודול מצייר בתוכה. כפתור הסגירה תמיד מעליו
function openStage(onClose) {
  const stage = h('div', { class: 'stage-full', role: 'dialog', 'aria-modal': 'true' });
  const close = h('button', { type: 'button', class: 'round-btn stage-close', 'aria-label': T.smart.close, onClick: () => end() }, icon('close', 22));
  const inner = h('div', { class: 'stage-inner' });
  stage.append(inner, close);
  let ended = false;
  function end() { if (ended) return; ended = true; stage.remove(); document.body.classList.remove('has-stage'); if (onClose) onClose(); }
  document.body.append(stage); document.body.classList.add('has-stage');
  return { el: inner, stage, end };
}

// ------------------------------------------------------------------ טלפרומפטר

export function teleprompterScreen(ctx) {
  const t = T.smart.teleprompter;
  const text = h('textarea', { class: 'field area', rows: '7', placeholder: t.placeholder, dir: 'auto', 'aria-label': t.script });
  const speed = h('input', { type: 'range', min: '1', max: '10', step: '1', value: '4', class: 'range', 'aria-label': t.speed });
  const mirror = h('input', { type: 'checkbox', role: 'switch', class: 'switch' });
  const msg = h('p', { class: 'error', role: 'alert', hidden: true });
  const say = (m) => { msg.textContent = m; msg.hidden = !m; };
  let session = null, handle = null;
  const teardown = () => { try { if (handle && typeof handle.destroy === 'function') handle.destroy(); } catch { /* נסגר */ } handle = null; };

  const open = h('button', { type: 'button', class: 'cta', onClick: async () => {
    say('');
    if (!text.value.trim()) { say(t.needText); return; }
    const mod = await ctx.loadFeature('teleprompter');
    if (!mod || typeof mod.mountTeleprompter !== 'function') { say(T.smart.soon); return; }
    session = openStage(teardown);
    try {
      handle = mod.mountTeleprompter(session.el, { text: text.value, speed: Number(speed.value), mirror: mirror.checked });
      handle.onRecorded((blob) => {
        if (!(blob instanceof Blob)) return;
        const type = blob.type || 'video/webm';
        session.end(); teardown();
        ctx.toast(t.done);
        ctx.pickFile(new File([blob], `FRAME-teleprompter.${extOf(type)}`, { type }));
      });
    } catch (e) { session.end(); teardown(); say(hebrew(e)); }
  } }, icon('camera', 22), h('span', {}, t.start));

  const el = h('section', { class: 'screen-feature' }, back(ctx),
    h('div', { class: 'hero rise' }, h('h1', {}, T.smart.list[0].name), h('p', { class: 'lede' }, T.smart.list[0].desc)),
    h('label', { class: 'field-label' }, t.script, text), h('p', { class: 'hint' }, t.scriptHint),
    h('label', { class: 'field-label' }, t.speed, speed),
    h('label', { class: 'switch-row' }, h('span', {}, h('b', {}, t.mirror), h('small', {}, t.mirrorHint)), mirror),
    msg, h('div', { class: 'sticky-cta' }, open));
  return { el, destroy: () => { teardown(); if (session) session.end(); } };
}

// ------------------------------------------------------------------ תגובה ודואט

export function reactionScreen(ctx) {
  const r = T.smart.reaction;
  let source = null, sourceUrl = '', layout = 'split', session = null, handle = null;
  const preview = h('video', { class: 'rx-source', playsinline: true, controls: true, hidden: true });
  const msg = h('p', { class: 'error', role: 'alert', hidden: true });
  const say = (m, ok) => { msg.textContent = m; msg.hidden = !m; msg.className = ok ? 'notice' : 'error'; };
  const chips = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': r.layout });
  const paintLayout = () => chips.querySelectorAll('.choice').forEach((b) => { const on = b.dataset.value === layout; b.setAttribute('aria-checked', String(on)); b.classList.toggle('is-on', on); });
  for (const [v, label] of [['split', r.split], ['pip', r.pip]]) chips.append(h('button', { type: 'button', role: 'radio', class: 'choice choice-chip', dataset: { value: v }, onClick: () => { layout = v; paintLayout(); } }, label));
  paintLayout();
  const pick = h('input', { type: 'file', accept: 'video/*', class: 'sr-only', onChange: (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (!f) return;
    source = f; if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    sourceUrl = URL.createObjectURL(f); preview.src = sourceUrl; preview.hidden = false; say(r.pickedSource, true);
  } });
  const teardown = () => { try { if (handle && typeof handle.destroy === 'function') handle.destroy(); } catch { /* נסגר */ } handle = null; };

  async function compose(mod, selfBlob, info) {
    const busy = busyLayer(r.composing);
    try {
      const out = await mod.makeReaction(source, selfBlob, { layout, offset: info && info.offset, selfDuration: info && info.duration, onProgress: (f, text) => busy.set(f, text) });
      busy.done();
      if (!out || !out.file) throw new Error(T.errors.generic);
      ctx.toast(r.ready);
      ctx.pickFile(out.file); // ההרכבה היא קובץ וידאו רגיל עם קול, והעריכה ממשיכה בצינור הרגיל
    } catch (e) { busy.done(); say(hebrew(e)); }
  }

  const open = h('button', { type: 'button', class: 'cta', onClick: async () => {
    say('');
    if (!source) { say(r.needSource); return; }
    const mod = await ctx.loadFeature('reaction');
    if (!mod || typeof mod.startReaction !== 'function' || typeof mod.makeReaction !== 'function') { say(T.smart.soon); return; }
    session = openStage(teardown);
    try {
      handle = mod.startReaction(session.el, source, { layout });
      handle.onRecorded((blob, info) => { session.end(); teardown(); compose(mod, blob, info); });
    } catch (e) { session.end(); teardown(); say(hebrew(e)); }
  } }, icon('camera', 22), h('span', {}, r.open));

  const el = h('section', { class: 'screen-feature' }, back(ctx),
    h('div', { class: 'hero rise' }, h('h1', {}, T.smart.list[1].name), h('p', { class: 'lede' }, T.smart.list[1].desc)),
    h('label', { class: 'pick-alt' }, pick, h('span', { class: 'pick-alt-icon' }, icon('upload', 24)), h('span', { class: 'pick-alt-text' }, h('b', {}, r.pickSource))),
    preview,
    h('h2', { class: 'sect' }, r.layout), chips, h('p', { class: 'hint' }, r.headphones), msg,
    h('div', { class: 'sticky-cta' }, open));
  return { el, destroy: () => { teardown(); if (session) session.end(); if (sourceUrl) URL.revokeObjectURL(sourceUrl); } };
}

// ------------------------------------------------------------------ עריכה בקול

const ACTIONS = { delete: 'מחיקה', keep: 'שמירה בלבד', trim: 'חיתוך' };

export function voiceScreen(ctx) {
  const v = T.smart.voice;
  const input = h('textarea', { class: 'field area', rows: '3', placeholder: v.placeholder, dir: 'auto', 'aria-label': v.title });
  const out = h('div', { class: 'vo-out', hidden: true, 'aria-live': 'polite' });
  const msg = h('p', { class: 'error', role: 'alert', hidden: true });
  const say = (m) => { msg.textContent = m; msg.hidden = !m; };
  const speakLabel = h('span', {}, v.speak);
  let controller = null, command = null;

  const speak = h('button', { type: 'button', class: 'ghost-btn', onClick: async () => {
    say('');
    if (controller) { controller.abort(); return; }
    const mod = await ctx.loadFeature('voice-edit');
    const listen = mod && typeof mod.listen === 'function' ? mod.listen : null;
    if (!listen) { say(v.noSpeech); return; }
    controller = new AbortController();
    speakLabel.textContent = v.listening;
    try {
      const heard = await listen({ lang: 'he-IL', signal: controller.signal, onInterim: (txt) => { input.value = txt; } });
      if (heard === null) say(v.noSpeech); else if (heard) input.value = heard;
    } catch (e) { if (!e || e.name !== 'AbortError') say(v.noSpeech); }
    controller = null; speakLabel.textContent = v.speak;
  } }, icon('mic', 22), speakLabel);

  const apply = h('button', { type: 'button', class: 'cta', hidden: true, onClick: async () => {
    const mod = await ctx.loadFeature('voice-edit');
    const active = ctx.state.results ? ctx.state.results.active : 0, clip = ctx.clips[active];
    if (!command || !mod || !clip || !clip.state || typeof mod.applyToPlan !== 'function') { say(v.cannotApply); return; }
    const busy = busyLayer(v.applying);
    try {
      await ctx.exportEdit(active, { ...clip.state, plan: mod.applyToPlan(clip.state.plan, command) }, (f, text) => busy.set(f, text));
      busy.done(); ctx.toast(v.applied);
    } catch (e) { busy.done(); say(hebrew(e)); }
  } }, icon('wand', 22), h('span', {}, v.apply));

  const run = h('button', { type: 'button', class: 'cta', onClick: async () => {
    say(''); out.hidden = true; apply.hidden = true; command = null;
    const text = input.value.trim();
    if (!text) { say(v.needCommand); return; }
    const transcript = ctx.lastTranscript();
    if (!transcript) { say(v.noTranscript); return; }
    const mod = await ctx.loadFeature('voice-edit');
    if (!mod || typeof mod.parseCommand !== 'function') { say(T.smart.soon); return; }
    try {
      const active = ctx.clips[ctx.state.results ? ctx.state.results.active : 0];
      const r = mod.parseCommand(text, transcript, { duration: active && active.duration });
      if (!r) { say(v.unknown); return; }
      command = r;
      clear(out); out.hidden = false;
      out.append(h('b', {}, `${v.result}: ${ACTIONS[r.action] || r.action}`), r.explanationHe ? h('p', {}, r.explanationHe) : null,
        h('ul', {}, ...(r.ranges || []).map((x) => h('li', { dir: 'ltr' }, `${clockText(x.start ?? x[0])} – ${clockText(x.end ?? x[1])}`))));
      apply.hidden = !(active && active.state);
    } catch (e) { say(hebrew(e)); }
  } }, icon('sparkle', 22), h('span', {}, v.run));

  const el = h('section', { class: 'screen-feature' }, back(ctx),
    h('div', { class: 'hero rise' }, h('h1', {}, T.smart.list[2].name), h('p', { class: 'lede' }, v.hint)),
    input, h('div', { class: 'row' }, speak), msg, out, h('div', { class: 'sticky-cta stack' }, apply, run));
  return { el, destroy: () => { if (controller) controller.abort(); } };
}
