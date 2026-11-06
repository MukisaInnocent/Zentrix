import { api } from '../core/api.js';
import { $, h } from '../core/dom.js';
import { formatDate } from '../core/format.js';
import { act, emptyRow } from '../admin/kit.js';

// Aviator demo-credit requests (the owner's Aviator project admin deposits and withdrawals, 2026-11-06). Finance
// and admins approve or reject; support can look. The server audits every decision.
const KIND = { deposit: 'Credits', withdrawal: 'Removal' };
const TONE = { pending: 'zx-badge--warning', approved: 'zx-badge--success', rejected: 'zx-badge--danger' };
const credits = n => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function button(label, onClick, tone = 'secondary') {
  const b = h('button', { type: 'button', class: `zx-btn zx-btn--${tone} zx-btn--sm` }, label);
  b.addEventListener('click', onClick);
  return b;
}

async function decide(r, action) {
  await act(async () => {
    await api.post(`/api/admin/aviator/requests/${r.id}/process`, { action });
    await load();
  }, `Request ${action === 'approve' ? 'approved' : 'rejected'}.`);
}

async function load() {
  const { requests } = await api.get('/api/admin/aviator/requests');
  $('#rows').replaceChildren(...(requests.length ? requests.map(r => h('tr', {},
    h('td', { class: 'zx-td-muted' }, formatDate(r.createdAt, { withTime: true })),
    h('td', { class: 'zx-td-strong' }, r.username),
    h('td', {}, KIND[r.kind]),
    h('td', { class: 'zx-td-mono' }, credits(r.amount)),
    h('td', { class: 'zx-td-mono' }, credits(r.balance)),
    h('td', {}, h('span', { class: `zx-badge ${TONE[r.status]}` }, r.status)),
    h('td', {}, r.status === 'pending'
      ? h('span', { class: 'zx-row-actions' }, button('Approve', () => void decide(r, 'approve')), button('Reject', () => void decide(r, 'reject'), 'ghost'))
      : '-')))
    : [emptyRow(7, 'No requests yet.')]));
}

export async function init() {
  await act(load);
}
