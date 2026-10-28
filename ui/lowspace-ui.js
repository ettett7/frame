// "המקום במכשיר נגמר": הספרייה (ובתור) רק מציעה מחיקה של קליפים ישנים, והמשתמש בוחר. שום דבר לא נמחק בלי אישור מפורש.
// הפונקציה מתאימה ל־onLowSpace(suggestion) של library.save ו־batch.run, ומחזירה הבטחה למזהים שאושרו (ריק = לא למחוק).
import { h, icon } from './dom.js';
import { openModal } from './overlay.js';
import { T, sizeText } from './texts.js';
import { lowSpacePlan, selectOldest, libraryTitle } from './model.js';

const dateText = (ts) => { try { return new Date(ts).toLocaleDateString('he-IL', { day: 'numeric', month: 'short' }); } catch { return ''; } };

export function lowSpaceDialog(suggestion) {
  return new Promise((resolve) => {
    const plan0 = lowSpacePlan(suggestion);
    const chosen = new Set();
    let settled = false;
    const finish = (ids) => { if (settled) return; settled = true; resolve(ids); };

    const total = h('p', { class: 'hint', role: 'status', 'aria-live': 'polite' });
    const confirm = h('button', { type: 'button', class: 'cta cta-sm danger-btn', disabled: true, onClick: () => { finish([...chosen]); m.close(); } }, icon('close', 18), h('span', {}, T.library.lowConfirm));
    const rows = plan0.candidates.map((c) => {
      const box = h('input', { type: 'checkbox', class: 'low-check', 'aria-label': libraryTitle(c), onChange: () => { if (box.checked) chosen.add(c.id); else chosen.delete(c.id); paint(); } });
      return { id: c.id, box, el: h('label', { class: 'low-row' }, box, h('span', { class: 'low-name', dir: 'auto' }, libraryTitle(c)), h('small', {}, [dateText(c.createdAt), sizeText(c.bytes)].filter(Boolean).join(' · '))) };
    });
    function paint() {
      const p = lowSpacePlan(suggestion, [...chosen]);
      total.textContent = T.library.lowTotal(sizeText(p.got), sizeText(p.need));
      confirm.disabled = !p.enough;
      rows.forEach((r) => { r.box.checked = chosen.has(r.id); });
    }
    const selectAll = h('button', { type: 'button', class: 'link-btn', onClick: () => { chosen.clear(); selectOldest(suggestion).forEach((id) => chosen.add(id)); paint(); } }, T.library.lowOldest);
    const skip = h('button', { type: 'button', class: 'ghost-btn', onClick: () => { finish([]); m.close(); } }, T.library.lowSkip);

    const content = [h('h2', {}, T.library.lowTitle), h('p', { class: 'lede' }, T.library.lowText(sizeText(plan0.need)))];
    if (plan0.possible) content.push(selectAll, h('div', { class: 'low-list' }, ...rows.map((r) => r.el)), total, confirm);
    else content.push(h('p', { class: 'notice' }, T.library.lowCannot));
    content.push(skip);
    const m = openModal({ label: T.library.lowTitle, content, onClose: () => finish([]) });
    paint();
  });
}
