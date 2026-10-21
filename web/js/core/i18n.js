// UI strings live in /locales/<lang>.json (section 5b). English ships first; add a file to add a language.
const SUPPORTED = ['en'];
const RTL = ['ar', 'he', 'fa', 'ur'];
let dict = {};

function lookup(key) {
  const value = key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), dict);
  return typeof value === 'string' ? value : undefined;
}

export async function initI18n() {
  let preferred = 'en';
  try {
    preferred = (localStorage.getItem('zx-lang') || navigator.language || 'en').slice(0, 2).toLowerCase();
  } catch {
    // Storage can be blocked; English it is.
  }
  const lang = SUPPORTED.includes(preferred) ? preferred : 'en';
  try {
    const res = await fetch(`/locales/${lang}.json`, { credentials: 'same-origin' });
    dict = await res.json();
  } catch {
    dict = {};
  }
  document.documentElement.lang = lang;
  document.documentElement.dir = RTL.includes(lang) ? 'rtl' : 'ltr';
}

// t('dashboard.welcome', { name }) with {name} placeholders. Missing keys fall back to `fallback` or the key.
export function t(key, vars = {}, fallback) {
  const template = lookup(key) ?? fallback ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name) => (vars[name] === undefined ? '' : String(vars[name])));
}

export const has = key => lookup(key) !== undefined;

// Static markup keeps English text as a fallback and names its key in data-i18n attributes.
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const value = lookup(el.dataset.i18n);
    if (value !== undefined) el.textContent = value;
  }
  const attrs = [['data-i18n-placeholder', 'placeholder'], ['data-i18n-aria-label', 'aria-label'], ['data-i18n-title', 'title']];
  for (const [source, target] of attrs) {
    for (const el of root.querySelectorAll(`[${source}]`)) {
      const value = lookup(el.getAttribute(source));
      if (value !== undefined) el.setAttribute(target, value);
    }
  }
}
