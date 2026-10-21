import { h, icon } from './dom.js';

let region;
function ensureRegion() {
  if (!region) {
    region = h('div', { class: 'zx-toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(region);
  }
  return region;
}

function show(message, kind = 'info', ms = 4500) {
  const glyph = kind === 'error' ? 'alert' : kind === 'success' ? 'check-circle' : 'info';
  const el = h('div', { class: `zx-toast zx-toast--${kind}` }, icon(glyph), h('span', {}, message));
  ensureRegion().append(el);
  setTimeout(() => el.remove(), ms);
}

export const toast = {
  info: message => show(message, 'info'),
  success: message => show(message, 'success'),
  error: message => show(message, 'error', 7000),
};
