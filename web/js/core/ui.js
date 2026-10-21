import { h, icon } from './dom.js';
import { t } from './i18n.js';

// Loading, empty and error states (section 5: every page shows all three).
export function skeleton(lines = 3) {
  return h('div', { 'aria-hidden': 'true' }, h('span', { class: 'zx-skeleton zx-skeleton--title' }),
    Array.from({ length: lines }, () => h('span', { class: 'zx-skeleton zx-skeleton--text' })));
}

export function stateBlock({ glyph = 'inbox', title, text, action, error = false }) {
  return h('div', { class: `zx-state${error ? ' zx-state--error' : ''}`, role: error ? 'alert' : undefined },
    icon(glyph), title ? h('h3', {}, title) : null, text ? h('p', {}, text) : null, action ?? null);
}

export function errorState(err, retry) {
  const action = retry ? h('button', { type: 'button', class: 'zx-btn zx-btn--secondary', onclick: retry }, t('common.retry')) : null;
  const ref = err?.requestId ? ` (${t('common.reference')}: ${err.requestId.slice(0, 8)})` : '';
  return stateBlock({ glyph: 'alert', title: t('common.loadFailed'), text: `${err?.message ?? t('errors.unexpected')}${ref}`, action, error: true });
}

export function replaceWith(container, ...nodes) {
  container.replaceChildren(...nodes);
}
