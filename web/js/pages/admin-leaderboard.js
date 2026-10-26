import { api } from '../core/api.js';
import { $, h } from '../core/dom.js';
import { act, emptyRow, money, segmented } from '../admin/kit.js';

// Staff-only referral report: members ranked by activated direct invites. Usernames open the member's record.
const state = { period: 'all' };

async function load() {
  const { leaders } = await api.get(`/api/admin/leaderboard/referrals?period=${state.period}`);
  $('#rows').replaceChildren(...(leaders.length ? leaders.map(l => h('tr', {},
    h('td', { class: 'zx-td-strong' }, String(l.rank)),
    h('td', {}, h('a', { href: `/admin/members.html?q=${encodeURIComponent(l.username)}` }, `@${l.username}`)),
    h('td', { class: 'zx-td-mono' }, l.phone ?? '-'),
    h('td', {}, l.country),
    h('td', { class: 'zx-td-strong' }, String(l.activated)),
    h('td', {}, String(l.invited)),
    h('td', {}, money(l.rewardsMinor, l.currency))))
    : [emptyRow(7, 'Nobody has invited anyone in this period.')]));
}

export async function init() {
  segmented($('#period-filter'), [{ value: 'all', label: 'All time' }, { value: '30d', label: 'Last 30 days' }, { value: '7d', label: 'Last 7 days' }], state.period, value => {
    state.period = value;
    void act(load);
  });
  await act(load);
}
