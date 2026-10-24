import { api } from '../core/api.js';
import { $, h } from '../core/dom.js';
import { ago, debounce, emptyRow, money, pager, when } from '../admin/kit.js';

// Read-only ledger explorer: each transaction with its balanced debit and credit entries.
const state = { kind: '', q: '', page: 1 };

async function load() {
  const params = new URLSearchParams({ page: String(state.page) });
  if (state.kind) params.set('status', state.kind);
  if (state.q) params.set('q', state.q);
  const data = await api.get(`/api/admin/payments/ledger?${params}`);
  const body = $('#rows');
  if (!data.transactions.length) body.replaceChildren(emptyRow(5, 'No ledger transactions match.'));
  else body.replaceChildren(...data.transactions.map(t => h('tr', {},
    h('td', { class: 'zx-td-muted', title: when(t.createdAt) }, ago(t.createdAt)),
    h('td', {}, h('span', { class: 'zx-badge zx-badge--brand' }, t.kind.replaceAll('_', ' ')), h('div', { class: 'zx-hint' }, t.memo)),
    h('td', { class: 'zx-td-mono' }, t.refId ?? ''),
    h('td', {}, h('div', {}, t.entries.map(e => h('div', { class: 'zx-ledger-entry' },
      h('span', { class: 'zx-ledger-entry__side' }, e.side),
      h('span', {}, e.account),
      h('span', { class: 'zx-ledger-entry__amount' }, money(e.amountMinor, e.currency)))))),
    h('td', {}, t.actor ? `@${t.actor}` : 'system'))));
  pager($('#pager'), data, page => {
    state.page = page;
    void load();
  });
}

export async function init() {
  $('#kind').addEventListener('change', e => {
    state.kind = e.target.value;
    state.page = 1;
    void load();
  });
  $('#search').addEventListener('input', debounce(e => {
    state.q = e.target.value.trim();
    state.page = 1;
    void load();
  }));
  await load();
}
