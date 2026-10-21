// Light/dark theme: follows the system unless the member picked one (stored per browser).
function stored() {
  try {
    return localStorage.getItem('zx-theme');
  } catch {
    return null;
  }
}

export function currentTheme() {
  const set = document.documentElement.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('zx-theme', next);
  } catch {
    // The choice just won't persist.
  }
  return next;
}

export function initTheme() {
  const saved = stored();
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
}
