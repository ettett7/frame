// שכבות על המסך: חלון קופץ נגיש, ושכבת המתנה עם פס התקדמות. משותף לספרייה, לפוסט, ליכולות החכמות ולמקום מלא.
import { h } from './dom.js';

// סוגרים ב־Escape, בלחיצה על הרקע או בכפתור, והמיקוד חוזר למקום שממנו נפתח
export function openModal({ label, content, onClose }) {
  const opener = document.activeElement;
  const back = h('div', { class: 'modal-back' });
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': label, tabindex: '-1' }, content);
  back.append(box);
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    document.removeEventListener('keydown', onKey);
    back.classList.add('is-out');
    setTimeout(() => back.remove(), 160);
    if (onClose) onClose();
    if (opener && opener.focus) try { opener.focus(); } catch { /* נעלם */ }
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(back);
  box.focus();
  return { close, box };
}

// חלון המתנה בזמן הרכבה, רינדור או ייצוא
export function busyLayer(text) {
  const bar = h('span', { class: 'bar-fill' }), label = h('p', { class: 'p-text' }, text);
  const el = h('div', { class: 'busy', role: 'status' }, h('div', { class: 'busy-box' }, h('div', { class: 'bar' }, bar), label));
  document.body.append(el);
  return {
    set(f, t) { bar.style.width = `${Math.round(Math.max(0.04, Math.min(1, f || 0)) * 100)}%`; if (t) label.textContent = t; },
    done() { el.remove(); },
  };
}
