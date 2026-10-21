import { api, ApiError, loginUrl, setUnauthorizedHandler } from './core/api.js';
import { $ } from './core/dom.js';
import { loadCurrencies } from './core/format.js';
import { applyI18n, initI18n } from './core/i18n.js';
import { initMotion } from './core/motion.js';
import { initTableLabels } from './core/tables.js';
import { renderPublicChrome, renderShell } from './core/shell.js';
import { initTheme } from './core/theme.js';
import { errorState } from './core/ui.js';

// Every page loads this module: <body data-page="dashboard" data-shell="app|admin|auto|auth|public|plain">.
// app/admin need a session; auto shows the member shell when signed in and public chrome otherwise.
const page = document.body.dataset.page;
const shell = document.body.dataset.shell ?? 'public';

async function loadMe(redirect) {
  try {
    const res = await api.get('/api/me', { noRedirect: !redirect });
    return { ...res.user, session: res.session };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      if (redirect) location.assign(loginUrl());
      return null;
    }
    throw err;
  }
}

async function boot() {
  initTheme();
  await initI18n();
  const meta = await api.get('/api/meta').catch(() => null);

  let me = null;
  try {
    if (shell === 'app' || shell === 'admin') {
      setUnauthorizedHandler(() => location.assign(loginUrl()));
      me = await loadMe(true);
      if (!me) return;
      if (shell === 'admin' && !me.isStaff) return void location.replace('/dashboard.html');
    } else if (shell === 'auto') {
      me = await loadMe(false);
    }
  } catch (err) {
    $('main')?.replaceChildren(errorState(err, () => location.reload()));
    return;
  }
  await loadCurrencies().catch(() => undefined);
  if (me && shell !== 'auth') renderShell({ me, meta, page, admin: shell === 'admin' });
  else if (shell === 'public' || shell === 'auto') renderPublicChrome();

  applyI18n(document);
  try {
    initMotion();
    initTableLabels();
  } catch (err) {
    console.error(err);
  }
  try {
    const mod = await import(`./pages/${page}.js`);
    await mod.init?.({ me, meta });
  } catch (err) {
    console.error(err);
    $('main')?.prepend(errorState(err instanceof ApiError ? err : null, () => location.reload()));
  }
  document.body.classList.add('zx-ready');
}

void boot();
