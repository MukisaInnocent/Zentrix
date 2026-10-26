import { api } from '../core/api.js';
import { $, h } from '../core/dom.js';
import { act, debounce, emptyRow, money, segmented, when } from '../admin/kit.js';

// Every voucher, its buyer and the account it activated. Member links open the member's record.
const state = { status: 'all', q: '' };
const BADGE = { active: ['zx-badge--success', 'Unused'], used: ['zx-badge--brand', 'Used'], cancelled: ['', 'Cancelled'] };
const memberLink = username => h('a', { href: `/admin/members.html?q=${encodeURIComponent(username)}` }, `@${username}`);

async function load() {
  const params = new URLSearchParams({ status: state.status === 'used' ? 'redeemed' : state.status });
  if (state.q) params.set('q', state.q);
  const { vouchers } = await api.get(`/api/admin/vouchers?${params}`);
  $('#rows').replaceChildren(...(vouchers.length ? vouchers.map(v => {
    const [tone, label] = BADGE[v.status] ?? ['', v.status];
    return h('tr', {},
      h('td', { class: 'zx-td-mono zx-td-strong' }, v.code),
      h('td', {}, money(v.amountMinor, v.currency)),
      h('td', {}, memberLink(v.creator)),
      h('td', { class: 'zx-td-muted' }, when(v.createdAt)),
      h('td', {}, h('span', { class: `zx-badge ${tone}` }, label)),
      h('td', {}, v.usedBy ? memberLink(v.usedBy) : '-'),
      h('td', { class: 'zx-td-muted' }, v.usedAt ? when(v.usedAt) : '-'));
  }) : [emptyRow(7, 'No vouchers here.')]));
}

export async function init() {
  segmented($('#status-filter'), [{ value: 'all', label: 'All' }, { value: 'active', label: 'Unused' }, { value: 'used', label: 'Used' }, { value: 'cancelled', label: 'Cancelled' }], state.status, value => {
    state.status = value;
    void act(load);
  });
  $('#search').addEventListener('input', debounce(e => {
    state.q = e.target.value.trim();
    void act(load);
  }));
  await act(load);
}
