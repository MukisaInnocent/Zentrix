import { api } from '../core/api.js';
import { $, h, on } from '../core/dom.js';
import { act, debounce, emptyRow, money, pager } from '../admin/kit.js';

// Member balances (owner, 2026-11-03): members of one currency from the greatest balance to the lowest, with search.
// The server sorts and pages; the page only shows the amounts it gets.
const state = { q: '', currency: 'UGX', sort: 'balance', page: 1 };

async function load() {
  const params = new URLSearchParams({ currency: state.currency, sort: state.sort, page: String(state.page) });
  if (state.q) params.set('q', state.q);
  const data = await api.get(`/api/admin/members/balances?${params}`);
  const select = $('#currency');
  if (select.options.length !== data.currencies.length) {
    select.replaceChildren(...data.currencies.map(c => h('option', { value: c, selected: c === data.currency }, c)));
  }
  const first = (data.page - 1) * 25;
  $('#rows').replaceChildren(...(data.members.length ? data.members.map((m, i) => h('tr', { tabindex: '0', dataset: { open: m.id } },
    h('td', { class: 'zx-td-muted' }, String(first + i + 1)),
    h('td', { class: 'zx-td-strong' }, m.username),
    h('td', { class: 'zx-td-mono' }, m.phone ?? '-'),
    h('td', {}, m.country),
    h('td', { class: 'zx-amount' }, money(m.balanceMinor, data.currency)),
    h('td', { class: 'zx-amount' }, money(m.depositMinor, data.currency)),
    h('td', { class: 'zx-amount' }, money(m.tasksMinor, data.currency)),
    h('td', { class: 'zx-amount' }, money(m.heldMinor, data.currency)),
    h('td', { class: 'zx-amount zx-td-strong' }, money(m.totalMinor, data.currency))))
    : [emptyRow(9, 'No members match.')]));
  pager($('#pager'), data, page => {
    state.page = page;
    void act(load);
  });
}

export async function init() {
  const reload = () => {
    state.page = 1;
    void act(load);
  };
  $('#search').addEventListener('input', debounce(e => {
    state.q = e.target.value.trim();
    reload();
  }));
  $('#currency').addEventListener('change', e => {
    state.currency = e.target.value;
    reload();
  });
  $('#sort').addEventListener('change', e => {
    state.sort = e.target.value;
    reload();
  });
  const open = tr => location.assign(`/admin/members?id=${encodeURIComponent(tr.dataset.open)}`);
  on($('#rows'), 'click', 'tr[data-open]', (_e, tr) => open(tr));
  on($('#rows'), 'keydown', 'tr[data-open]', (e, tr) => {
    if (e.key === 'Enter') open(tr);
  });
  await act(load);
}
