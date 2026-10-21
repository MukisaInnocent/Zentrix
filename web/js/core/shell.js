import { api } from './api.js';
import { $, h, icon, initials } from './dom.js';
import { t } from './i18n.js';
import { currentTheme, toggleTheme } from './theme.js';
import { toast } from './toast.js';

// Navigation config. Modules not built yet show as "Soon" instead of linking to fake pages. Items with
// children render as expandable groups (as in the demo). `bottom: true` puts an item in the phone bar.
const MEMBER_NAV = [
  { group: 'nav.group.main', items: [{ id: 'dashboard', href: '/dashboard.html', icon: 'home', label: 'nav.dashboard', bottom: true }] },
  {
    group: 'nav.group.wallet',
    items: [
      { id: 'wallet', href: '/accounts.html', icon: 'wallet', label: 'nav.wallet' },
      { id: 'deposit', href: '/deposit.html', icon: 'deposit', label: 'nav.deposit' },
      { id: 'withdraw', href: '/withdraw.html', icon: 'withdraw', label: 'nav.withdraw' },
      { id: 'vouchers', href: '/voucher.html', icon: 'ticket', label: 'nav.vouchers' },
      { id: 'payforclient', href: '/payforclient.html', icon: 'transfer', label: 'nav.payForClient' },
      { id: 'membership', href: '/membership.html', icon: 'badge', label: 'nav.membership', bottom: true },
    ],
  },
  {
    group: 'nav.group.earn',
    items: [
      { id: 'youtube', href: '/youtube.html', icon: 'play', label: 'nav.youtube' },
      { id: 'tiktok', href: '/tiktok.html', icon: 'music', label: 'nav.tiktok' },
      { id: 'ads', href: '/adsearn.html', icon: 'pointer', label: 'nav.ads' },
      { id: 'trivia', href: '/trivia.html', icon: 'help', label: 'nav.trivia' },
      { id: 'leaderboard', href: '/leaderboard.html', icon: 'trophy', label: 'nav.leaderboard' },
    ],
  },
  {
    group: 'nav.group.learn',
    items: [
      { id: 'ebooks', href: '/ebooks.html', icon: 'book', label: 'nav.ebooks' },
      { id: 'forex', href: '/forex.html', icon: 'chart', label: 'nav.forex' },
    ],
  },
  {
    group: 'nav.group.network',
    items: [
      { id: 'team', href: '/team.html', icon: 'users', label: 'nav.team', bottom: true },
      { id: 'contact', href: '/contact.html', icon: 'mail', label: 'nav.contact' },
    ],
  },
  {
    group: 'nav.group.advertise',
    items: [
      { id: 'metaads', icon: 'megaphone', label: 'nav.metaAds', soon: true },
      { id: 'social', icon: 'share', label: 'nav.socialPromotions', soon: true },
    ],
  },
  {
    group: 'nav.group.account',
    items: [
      { id: 'profile', href: '/profile.html', icon: 'user', label: 'nav.profile', bottom: true },
      { id: 'contact', href: '/contact.html', icon: 'mail', label: 'nav.contact' },
      {
        id: 'policies', icon: 'file', label: 'nav.policies',
        children: [
          { id: 'terms', href: '/terms.html', label: 'nav.terms' },
          { id: 'privacy', href: '/privacy.html', label: 'nav.privacy' },
          { id: 'risk', href: '/risk.html', label: 'nav.risk' },
          { id: 'refund', href: '/refund.html', label: 'nav.refund' },
        ],
      },
      { id: 'logout', action: 'logout', icon: 'logout', label: 'nav.logout' },
    ],
  },
];

const ADMIN_NAV = [
  { group: 'admin.nav.group.overview', items: [{ id: 'admin-home', href: '/admin/index.html', icon: 'grid', label: 'admin.nav.overview', bottom: true }] },
  {
    group: 'admin.nav.group.people',
    items: [
      { id: 'admin-members', href: '/admin/members.html', icon: 'users', label: 'admin.nav.members', bottom: true },
      { id: 'admin-fraud', href: '/admin/fraud.html', icon: 'flag', label: 'admin.nav.fraud' },
    ],
  },
  {
    group: 'admin.nav.group.config',
    items: [
      { id: 'admin-countries', href: '/admin/countries.html', icon: 'globe', label: 'admin.nav.countries' },
      { id: 'admin-settings', href: '/admin/settings.html', icon: 'settings', label: 'admin.nav.settings' },
    ],
  },
  {
    group: 'admin.nav.group.records',
    items: [
      { id: 'admin-audit', href: '/admin/audit.html', icon: 'history', label: 'admin.nav.audit' },
      { id: 'admin-outbox', href: '/admin/outbox.html', icon: 'inbox', label: 'admin.nav.outbox', testOnly: true },
    ],
  },
  { group: 'admin.nav.group.exit', items: [{ id: 'back', href: '/dashboard.html', icon: 'home', label: 'admin.nav.back' }] },
];

function navItem(item, page) {
  const label = t(item.label);
  if (item.children) {
    const listId = `zx-nav-${item.id}`;
    const active = item.children.some(c => c.id === page);
    const toggle = h(
      'button',
      { type: 'button', class: `zx-nav__toggle${active ? ' zx-is-active' : ''}`, 'aria-expanded': String(active), 'aria-controls': listId },
      icon(item.icon), h('span', {}, label), icon('chevron-right', 'zx-nav__chev'),
    );
    const sub = h('ul', { class: 'zx-nav__sub', id: listId, hidden: !active }, item.children.map(c => h('li', {}, navItem(c, page))));
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(open));
      sub.hidden = !open;
    });
    return h('div', {}, toggle, sub);
  }
  if (item.soon) {
    return h('span', { class: 'zx-nav__item', 'aria-disabled': 'true' }, item.icon ? icon(item.icon) : null, h('span', {}, label), h('span', { class: 'zx-soon' }, t('nav.soon')));
  }
  if (item.action === 'logout') {
    return h('button', { type: 'button', class: 'zx-nav__item', dataset: { action: 'logout' } }, icon(item.icon), h('span', {}, label));
  }
  return h('a', { class: 'zx-nav__item', href: item.href, 'aria-current': item.id === page ? 'page' : undefined }, item.icon ? icon(item.icon) : null, h('span', {}, label));
}

function buildNav(config, page) {
  return config.map(section =>
    h('div', {}, h('h2', { class: 'zx-nav__heading' }, t(section.group)), h('ul', { class: 'zx-nav__list' }, section.items.map(item => h('li', {}, navItem(item, page))))),
  );
}

export async function logout() {
  try {
    await api.post('/api/auth/logout');
  } finally {
    location.assign('/login.html');
  }
}

function setupDrawer(drawer, menuBtn) {
  const open = () => {
    document.body.classList.add('zx-drawer-open');
    menuBtn.setAttribute('aria-expanded', 'true');
    drawer.querySelector('a, button')?.focus();
  };
  const close = () => {
    if (!document.body.classList.contains('zx-drawer-open')) return;
    document.body.classList.remove('zx-drawer-open');
    menuBtn.setAttribute('aria-expanded', 'false');
    menuBtn.focus();
  };
  menuBtn.addEventListener('click', () => (document.body.classList.contains('zx-drawer-open') ? close() : open()));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') close();
  });
  return { open, close };
}

function setupBackToTop() {
  const btn = h('button', { type: 'button', class: 'zx-totop', 'aria-label': t('common.backToTop') }, icon('chevron-up'));
  btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
  addEventListener('scroll', () => btn.classList.toggle('zx-is-visible', window.scrollY > 400), { passive: true });
  document.body.append(btn);
}

// Renders the member or staff shell around the page's <main>.
export function renderShell({ me, meta, page, admin = false }) {
  const config = (admin ? ADMIN_NAV : MEMBER_NAV).map(section => ({
    ...section,
    items: section.items.filter(item => !(item.testOnly && !meta?.testMode)),
  }));
  if (!admin && me.isStaff) config.push({ group: 'nav.group.staff', items: [{ id: 'admin', href: '/admin/index.html', icon: 'shield', label: 'nav.adminConsole' }] });

  document.body.classList.add('zx-shell-app');
  const main = $('main');
  main.id = 'main';
  main.classList.add('zx-main');
  main.tabIndex = -1;

  const drawerId = 'zx-drawer';
  const closeBtn = h('button', { type: 'button', class: 'zx-icon-btn zx-icon-btn--square zx-drawer__close', 'aria-label': t('common.closeMenu') }, icon('close'));
  const drawer = h(
    'nav', { class: 'zx-drawer', id: drawerId, 'aria-label': t('common.mainMenu') },
    h('div', { class: 'zx-drawer__head' }, h('a', { class: 'zx-brand', href: admin ? '/admin/index.html' : '/dashboard.html' }, h('img', { src: '/img/mark.svg', alt: '' }), h('span', {}, admin ? 'Zentrix Staff' : 'Zentrix')), closeBtn),
    h('div', { class: 'zx-drawer__body' }, buildNav(config, page)),
  );
  const scrim = h('div', { class: 'zx-scrim', 'aria-hidden': 'true' });
  const menuBtn = h('button', { type: 'button', class: 'zx-icon-btn zx-icon-btn--square zx-topbar__menu', 'aria-label': t('common.openMenu'), 'aria-expanded': 'false', 'aria-controls': drawerId }, icon('grid'));
  const themeBtn = h('button', { type: 'button', class: 'zx-icon-btn', 'aria-label': t('common.toggleTheme') }, icon(currentTheme() === 'dark' ? 'sun' : 'moon'));
  themeBtn.addEventListener('click', () => themeBtn.querySelector('use').setAttribute('href', `/img/icons.svg#${toggleTheme() === 'dark' ? 'sun' : 'moon'}`));
  const bell = h('button', { type: 'button', class: 'zx-icon-btn', 'aria-label': t('common.notifications') }, icon('bell'));
  bell.addEventListener('click', () => toast.info(t('common.notificationsSoon')));
  const title = document.title.split('·')[0]?.trim() ?? 'Zentrix';
  const topbar = h(
    'header', { class: 'zx-topbar' }, menuBtn, h('div', { class: 'zx-topbar__title' }, title),
    h('div', { class: 'zx-topbar__actions' },
      h('span', { class: 'zx-currency-pill', title: t('common.walletCurrency') }, `${me.country.code} · ${me.currency}`),
      themeBtn, bell,
      h('a', { class: 'zx-avatar', href: '/profile.html', 'aria-label': t('nav.profile') }, initials(me.username))),
  );
  document.body.prepend(h('a', { class: 'zx-skip-link', href: '#main' }, t('common.skipToContent')));
  main.before(topbar);
  document.body.append(scrim, drawer);

  const bottomItems = config.flatMap(s => s.items).filter(i => i.bottom && !i.soon);
  const bottom = h('nav', { class: 'zx-bottomnav', 'aria-label': t('common.quickMenu') },
    bottomItems.map(i => h('a', { href: i.href, 'aria-current': i.id === page ? 'page' : undefined }, icon(i.icon), h('span', {}, t(i.label)))),
    h('button', { type: 'button', 'aria-controls': drawerId, dataset: { openMenu: '' } }, icon('menu'), h('span', {}, t('common.menu'))));
  document.body.append(bottom);

  const drawerCtl = setupDrawer(drawer, menuBtn);
  closeBtn.addEventListener('click', drawerCtl.close);
  scrim.addEventListener('click', drawerCtl.close);
  bottom.querySelector('[data-open-menu]').addEventListener('click', drawerCtl.open);
  drawer.addEventListener('click', e => {
    if (e.target instanceof Element && e.target.closest('[data-action="logout"]')) void logout();
  });

  main.append(h('footer', { class: 'zx-app-footer' },
    `© ${new Date().getFullYear()} Zentrix · `, h('a', { href: '/terms.html' }, t('nav.terms')), ' · ',
    h('a', { href: '/privacy.html' }, t('nav.privacy')), ' · ', h('a', { href: '/risk.html' }, t('nav.risk'))));
  setupBackToTop();
}

// Header and footer for public pages (and "auto" pages when nobody is signed in).
export function renderPublicChrome() {
  const main = $('main');
  main.id = 'main';
  main.classList.add('zx-main');
  main.tabIndex = -1;
  const header = h('header', { class: 'zx-public-header' },
    h('div', { class: 'zx-public-header__inner' },
      h('a', { class: 'zx-brand', href: '/' }, h('img', { src: '/img/mark.svg', alt: '' }), h('span', {}, 'Zentrix')),
      h('nav', { class: 'zx-public-nav', 'aria-label': t('common.mainMenu') },
        h('a', { href: '/#how' }, t('nav.howItWorks')), h('a', { href: '/membership.html' }, t('nav.membership')), h('a', { href: '/contact.html' }, t('nav.contact'))),
      h('div', { class: 'zx-public-header__cta' },
        h('a', { class: 'zx-btn zx-btn--ghost zx-btn--sm', href: '/login.html' }, t('common.signIn')),
        h('a', { class: 'zx-btn zx-btn--sm', href: '/register.html' }, t('common.join')))));
  document.body.prepend(h('a', { class: 'zx-skip-link', href: '#main' }, t('common.skipToContent')), header);
  const year = new Date().getFullYear();
  document.body.append(
    h('footer', { class: 'zx-footer' },
      h('div', { class: 'zx-footer__inner' },
        h('span', {}, `© ${year} Zentrix`),
        h('nav', { 'aria-label': t('nav.policies') },
          ['terms', 'privacy', 'risk', 'refund', 'contact'].map(id =>
            h('a', { href: `/${id}.html` }, t(`nav.${id}`)),
          ),
        ),
      ),
    ),
  );
}
