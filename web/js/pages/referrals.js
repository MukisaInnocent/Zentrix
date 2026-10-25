import { api } from '../core/api.js';
import { $, h } from '../core/dom.js';
import { formatDate, formatMoney } from '../core/format.js';

// Referrals by level, shown as tables. Level 1 has an overview plus active and inactive lists; levels 2 and 3 list
// everyone. A member is Active once their activation fee is confirmed.
const VIEWS = {
  overview: { status: 'all', title: 'Overview', empty: 'Nobody has joined through your link yet.' },
  active: { status: 'active', title: 'Active Members', empty: 'No active members yet.' },
  inactive: { status: 'inactive', title: 'Inactive Members', empty: 'No inactive members. Everyone who joined has activated.' },
};

export async function init() {
  const params = new URLSearchParams(location.search);
  const level = [1, 2, 3].includes(Number(params.get('level'))) ? Number(params.get('level')) : 1;
  const view = level === 1 && VIEWS[params.get('view')] ? params.get('view') : 'overview';
  const query = level === 1 ? `?level=1&view=${view}` : `?level=${level}`;
  if (`?${params}` !== query) history.replaceState(null, '', `${location.pathname}${query}`);

  const config = VIEWS[view];
  $('#ref-title').textContent = level === 1 ? `Level 1 · ${config.title}` : `Level ${level}`;
  $('#ref-lead').textContent = level === 1 ? 'People who joined with your username.' : `People ${level === 2 ? 'invited by your level 1 members' : 'invited by your level 2 members'}.`;
  $('#table-title').textContent = level === 1 ? config.title : `Level ${level} members`;
  $('#ref-stats').hidden = !(level === 1 && view === 'overview');

  const [data, overview] = await Promise.all([
    api.get(`/api/referrals/members?level=${level}&status=${level === 1 ? config.status : 'all'}`),
    api.get('/api/referrals'),
  ]);
  $('#stat-total').textContent = String(data.counts.total);
  $('#stat-active').textContent = String(data.counts.active);
  $('#stat-inactive').textContent = String(data.counts.inactive);
  $('#stat-rewards').textContent = formatMoney(overview.totalRewardsMinor, overview.currency);

  const body = $('#ref-body');
  if (!data.members.length) {
    body.replaceChildren(h('tr', {}, h('td', { colspan: '5', class: 'zx-td-empty' }, level === 1 ? config.empty : `Nobody at level ${level} yet.`)));
    return;
  }
  body.replaceChildren(...data.members.map(m => h('tr', {},
    h('td', { class: 'zx-td-strong' }, `@${m.username}`),
    h('td', {}, m.country),
    h('td', { class: 'zx-td-muted' }, formatDate(m.joinedAt)),
    h('td', {}, h('span', { class: `zx-badge ${m.status === 'Active' ? 'zx-badge--success' : 'zx-badge--warning'}` }, m.status)),
    h('td', { class: 'zx-amount' }, m.rewardMinor === '0' ? '' : formatMoney(m.rewardMinor, m.currency)))));
}
