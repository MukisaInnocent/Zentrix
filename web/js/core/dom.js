// Tiny DOM helpers. Text always goes in through textContent, never innerHTML, so server data cannot
// inject markup (section 11: output encoding).
const SVG_NS = 'http://www.w3.org/2000/svg';

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// h('a', { href: '/x', class: 'zx-btn' }, 'Text', child)
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function icon(name, extraClass = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `zx-icon ${extraClass}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `/img/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

export function on(root, event, selector, handler) {
  root.addEventListener(event, e => {
    const target = e.target instanceof Element ? e.target.closest(selector) : null;
    if (target && root.contains(target)) handler(e, target);
  });
}

export function initials(name) {
  return (name || '?').replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
}

export function setBusy(el, busy) {
  if (!el) return;
  if (busy) {
    el.setAttribute('aria-busy', 'true');
    el.disabled = true;
  } else {
    el.removeAttribute('aria-busy');
    el.disabled = false;
  }
}

// Same-origin relative path only, to stop open redirects through ?next=.
export function safeNext(value, fallback = '/dashboard.html') {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;
  return value;
}
