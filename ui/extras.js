// מסכים משניים: תבניות, יכולות חכמות, הגדרות והדרכת התקנה.
import { h, icon } from './dom.js';
import { T } from './texts.js';
import { LANGUAGES, QUALITIES, THEMES, LIMITS, turboContext } from './model.js';

// ------------------------------------------------------------------ תבניות

export function templatesScreen(ctx) {
  const s = ctx.state;
  const cards = T.templates.list.map((t) => {
    const on = s.template === t.id;
    return h('button', { type: 'button', class: `tpl-card${on ? ' is-on' : ''}`, 'aria-pressed': String(on), onClick: () => ctx.dispatch({ type: 'selectTemplate', id: on ? null : t.id }) },
      h('span', { class: 'tpl-art', 'aria-hidden': 'true', dataset: { tpl: t.id } }, t.icon),
      h('span', { class: 'tpl-text' }, h('b', {}, t.name), h('small', {}, t.desc)),
      h('span', { class: 'tpl-state' }, on ? [icon('check', 16), T.templates.selected] : T.templates.use));
  });
  const el = h('section', { class: 'screen-templates' },
    h('div', { class: 'hero rise' }, h('h1', {}, T.templates.title), h('p', { class: 'lede' }, T.templates.lede)),
    h('div', { class: 'tpl-list' }, ...cards),
    s.template && h('div', { class: 'sticky-cta' },
      h('button', { type: 'button', class: 'cta', onClick: () => ctx.dispatch({ type: 'go', screen: s.file ? 'options' : 'home' }) }, icon('upload', 22), h('span', {}, s.file ? T.options.cta : T.templates.nowPick))),
    s.template && h('button', { type: 'button', class: 'link-btn center', onClick: () => ctx.dispatch({ type: 'selectTemplate', id: null }) }, T.templates.none));
  return { el };
}

// ------------------------------------------------------------------ יכולות חכמות

export function smartScreen(ctx) {
  const cards = T.smart.list.map((f) => h('button', { type: 'button', class: 'smart-card rise', onClick: () => ctx.dispatch({ type: 'go', screen: f.id }) },
    h('span', { class: 'smart-icon', 'aria-hidden': 'true' }, f.icon),
    h('span', { class: 'tpl-text' }, h('b', {}, f.name), h('small', {}, f.desc)),
    icon('back', 20)));
  return { el: h('section', { class: 'screen-smart' }, h('div', { class: 'hero rise' }, h('h1', {}, T.smart.title), h('p', { class: 'lede' }, T.smart.lede)), h('div', { class: 'tpl-list' }, ...cards)) };
}

// ------------------------------------------------------------------ התקנה

export function installScreen(ctx) {
  const mode = ctx.install.mode;
  let body;
  if (mode === 'installed') body = h('p', { class: 'notice' }, T.settings.installed);
  else if (mode === 'ios') {
    body = [
      ctx.install.iosSafari ? null : h('p', { class: 'error' }, T.install.iosSafari),
      h('ol', { class: 'guide' }, ...T.install.iosSteps.map((st, i) => h('li', { class: 'guide-step rise', style: { '--d': `${i * 80}ms` } },
        h('span', { class: 'guide-n', 'aria-hidden': 'true' }, st.icon),
        h('span', {}, h('b', {}, `${i + 1}. ${st.title}`), h('small', {}, st.text))))),
    ];
  } else if (mode === 'android') {
    body = [h('h2', { class: 'sect' }, T.install.androidTitle), h('p', { class: 'lede' }, T.install.androidText),
      ctx.install.canPrompt && h('button', { type: 'button', class: 'cta', onClick: () => ctx.install.prompt() }, icon('plus', 22), h('span', {}, T.settings.installNow)),
      h('p', { class: 'hint' }, T.install.androidManual)];
  } else body = h('p', { class: 'lede' }, T.install.other);
  const el = h('section', { class: 'screen-install' },
    h('div', { class: 'hero rise' }, h('h1', {}, T.install.title), h('p', { class: 'lede' }, T.install.lede)),
    body,
    h('button', { type: 'button', class: 'ghost-btn center-btn', onClick: () => ctx.dispatch({ type: 'go', screen: 'home' }) }, T.install.done));
  return { el };
}

// ------------------------------------------------------------------ הגדרות

function chipGroup(label, items, current, onPick) {
  const wrap = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': label });
  const buttons = items.map(([value, text]) => h('button', { type: 'button', role: 'radio', class: 'choice choice-chip', 'aria-checked': String(value === current), dataset: { value }, onClick: () => { onPick(value); paint(value); } }, text));
  function paint(cur) { buttons.forEach((b) => { const on = b.dataset.value === cur; b.setAttribute('aria-checked', String(on)); b.classList.toggle('is-on', on); }); }
  wrap.append(...buttons); paint(current);
  return wrap;
}

export function settingsScreen(ctx) {
  const set = ctx.settings;
  const brand = h('input', { type: 'text', class: 'field', maxlength: LIMITS.brandMax, value: set.brandName, placeholder: T.settings.brandPlaceholder, dir: 'auto', 'aria-describedby': 'brand-hint', autocomplete: 'off', autocapitalize: 'off', onChange: (e) => ctx.saveSettings({ brandName: e.target.value }) });
  const logoImg = h('img', { class: 'logo-prev', alt: '', hidden: true });
  const logoMsg = h('p', { class: 'hint', role: 'status' });
  const logoInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml', class: 'sr-only', onChange: async (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (!/^image\//.test(f.type) || f.size > 5 * 1024 * 1024) { logoMsg.textContent = 'בחרו קובץ תמונה עד 5MB.'; return; }
    const ok = await ctx.saveLogo(f);
    logoMsg.textContent = ok ? T.settings.logoSaved : 'אי אפשר לשמור את הלוגו במכשיר הזה.';
    paintLogo();
  } });
  async function paintLogo() {
    const url = await ctx.logoUrl();
    logoImg.hidden = !url; if (url) logoImg.src = url;
    removeLogo.hidden = !url;
  }
  const removeLogo = h('button', { type: 'button', class: 'link-btn', hidden: true, onClick: async () => { await ctx.removeLogo(); logoMsg.textContent = ''; paintLogo(); } }, T.settings.logoRemove);

  const where = turboContext(ctx.location);
  const turboText = ctx.turbo.connected ? T.settings.turboOn : T.settings.turboOff;
  const turboNote = ctx.turbo.connected ? '' : where === 'github' ? T.settings.turboGithub : where === 'mac' ? T.settings.turboMac : T.settings.turboLocal;
  const inst = ctx.install.mode;
  const versionRow = h('p', { class: 'hint' }, `${T.settings.version}: ${ctx.version}`);
  const qHint = h('p', { class: 'hint' }, T.settings.qualityHint[set.quality]);

  const el = h('section', { class: 'screen-settings' },
    h('div', { class: 'hero rise' }, h('h1', {}, T.settings.title)),
    h('div', { class: 'group' },
      h('h2', { class: 'sect' }, T.settings.brand),
      h('label', { class: 'field-label' }, T.settings.brandName, brand),
      h('p', { class: 'hint', id: 'brand-hint' }, T.settings.brandNameHint),
      h('div', { class: 'logo-row' }, logoImg,
        h('label', { class: 'ghost-btn' }, logoInput, icon('upload', 20), h('span', {}, T.settings.logoPick)), removeLogo),
      logoMsg),
    h('div', { class: 'group' },
      h('h2', { class: 'sect' }, T.settings.language),
      chipGroup(T.settings.language, LANGUAGES.map((l) => [l, T.settings.languages[l]]), set.language, (v) => ctx.saveSettings({ language: v }))),
    h('div', { class: 'group' },
      h('h2', { class: 'sect' }, T.settings.quality),
      chipGroup(T.settings.quality, QUALITIES.map((q) => [q, T.settings.qualities[q]]), set.quality, (v) => { ctx.saveSettings({ quality: v }); qHint.textContent = T.settings.qualityHint[v]; }),
      qHint),
    h('div', { class: 'group' },
      h('h2', { class: 'sect' }, T.settings.theme),
      chipGroup(T.settings.theme, THEMES.map((t) => [t, T.settings.themes[t]]), set.theme, (v) => ctx.saveSettings({ theme: v }))),
    h('div', { class: 'group' },
      h('h2', { class: 'sect' }, T.settings.turbo),
      h('p', { class: `badge-line${ctx.turbo.connected ? ' on' : ''}` }, icon('mac', 18), turboText),
      turboNote && h('p', { class: 'hint' }, turboNote)),
    h('div', { class: 'group' },
      h('h2', { class: 'sect' }, T.settings.install),
      inst === 'installed' ? h('p', { class: 'badge-line on' }, icon('check', 18), T.settings.installed)
        : h('button', { type: 'button', class: 'ghost-btn', onClick: () => ctx.dispatch({ type: 'go', screen: 'install' }) }, T.settings.installHow)),
    h('div', { class: 'group' },
      h('h2', { class: 'sect' }, T.settings.cache),
      h('button', { type: 'button', class: 'ghost-btn', onClick: () => ctx.clearCache() }, T.settings.clearCache),
      versionRow),
    h('p', { class: 'about' }, T.settings.about));
  paintLogo();
  return { el };
}
