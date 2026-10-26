import { api, ApiError } from '../core/api.js';
import { $, h } from '../core/dom.js';
import { segmented } from '../admin/kit.js';

// Members ranked by activated direct invites (owner, 2026-10-26). Usernames and countries only; no prize.
const state = { period: 'all' };

async function load() {
  const body = $('#leaderboard-body');
  try {
    const { leaders, me } = await api.get(`/api/referrals/leaderboard?period=${state.period}`);
    $('#my-rank').textContent = me
      ? `Your place: #${me.rank} with ${me.activated} activated invite(s) out of ${me.invited}.`
      : 'You are not on the leaderboard for this period yet. Share your invite link to get started.';
    body.replaceChildren(...(leaders.length ? leaders.map(l => h('tr', {},
      h('td', { class: `zx-rank ${l.rank <= 3 ? `zx-rank--${l.rank}` : 'zx-rank--n'}` }, `#${l.rank}`),
      h('td', { class: 'zx-td-strong' }, `@${l.username}`),
      h('td', {}, l.country),
      h('td', { class: 'zx-td-strong zx-text-brand' }, String(l.activated)),
      h('td', {}, String(l.invited))))
      : [h('tr', {}, h('td', { colspan: '5', class: 'zx-td-empty' }, 'Nobody has invited anyone in this period yet.'))]));
  } catch (err) {
    body.replaceChildren(h('tr', {}, h('td', { colspan: '5', class: 'zx-td-empty' }, err instanceof ApiError ? err.message : 'Could not load the leaderboard.')));
  }
}

export async function init() {
  segmented($('#period-filter'), [{ value: 'all', label: 'All time' }, { value: '30d', label: 'Last 30 days' }, { value: '7d', label: 'Last 7 days' }], state.period, value => {
    state.period = value;
    void load();
  });
  await load();
}
