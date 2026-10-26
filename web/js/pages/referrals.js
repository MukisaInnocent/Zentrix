import { api } from '../core/api.js';
import { $, h } from '../core/dom.js';
import { formatDate, formatMoney } from '../core/format.js';

// Referrals by level, shown as tables. Every level has an overview (that level's figures only) and lists of its
// active and inactive usernames. A username is Active once its activation fee is confirmed.
const VIEWS = {
  overview: { status: null, title: 'Overview' },
  active: { status: 'active', title: 'Active Usernames', empty: 'No active usernames at this level yet.' },
  inactive: { status: 'inactive', title: 'Inactive Usernames', empty: 'No inactive usernames at this level.' },
};
const LEADS = {
  1: 'Usernames that joined with your username.',
  2: 'Usernames invited by your level 1 usernames.',
  3: 'Usernames invited by your level 2 usernames.',
};

export async function init() {
  const params = new URLSearchParams(location.search);
  const level = [1, 2, 3].includes(Number(params.get('level'))) ? Number(params.get('level')) : 1;
  const view = VIEWS[params.get('view')] ? params.get('view') : 'overview';
  const query = `?level=${level}&view=${view}`;
  if (`?${params}` !== query) history.replaceState(null, '', `${location.pathname}${query}`);

  const config = VIEWS[view];
  $('#ref-title').textContent = `Level ${level} · ${config.title}`;
  $('#ref-lead').textContent = LEADS[level];
  $('#stats-card').hidden = view !== 'overview';
  $('#list-card').hidden = view === 'overview';

  if (view === 'overview') {
    const overview = await api.get('/api/referrals');
    const c = overview.levels[level];
    $('#stats-title').textContent = `Level ${level} overview`;
    $('#stats-body').replaceChildren(h('tr', {},
      h('td', { class: 'zx-td-strong' }, `Level ${level}`),
      h('td', {}, String(c.total)),
      h('td', {}, String(c.active)),
      h('td', {}, String(c.inactive)),
      h('td', { class: 'zx-amount' }, formatMoney(c.rewardsMinor, overview.currency))));
    return;
  }

  $('#table-title').textContent = `Level ${level} ${config.title.toLowerCase()}`;
  const data = await api.get(`/api/referrals/members?level=${level}&status=${config.status}`);
  const body = $('#ref-body');
  if (!data.members.length) {
    body.replaceChildren(h('tr', {}, h('td', { colspan: '6', class: 'zx-td-empty' }, config.empty)));
    return;
  }
  body.replaceChildren(...data.members.map(m => h('tr', {},
    h('td', { class: 'zx-td-strong' }, `@${m.username}`),
    h('td', { class: 'zx-td-mono' }, m.phone ?? '-'),
    h('td', {}, m.country),
    h('td', { class: 'zx-td-muted' }, formatDate(m.joinedAt)),
    h('td', {}, h('span', { class: `zx-badge ${m.status === 'Active' ? 'zx-badge--success' : 'zx-badge--warning'}` }, m.status)),
    h('td', { class: 'zx-amount' }, m.rewardMinor === '0' ? '' : formatMoney(m.rewardMinor, m.currency)))));
}
