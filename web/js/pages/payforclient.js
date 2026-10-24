import { api, newIdempotencyKey } from '../core/api.js';
import { $, h } from '../core/dom.js';
import { formatDate, formatMoney } from '../core/format.js';
import { bindForm } from '../core/forms.js';
import { toast } from '../core/toast.js';

// Pay For Client: a wallet-to-wallet payment to another verified member (server checks everything).
export async function init() {
  async function refresh() {
    const [summary, data] = await Promise.all([api.get('/api/wallet/summary'), api.get('/api/client-payments')]);
    $('#pfc-balance').textContent = formatMoney(summary.availableBalanceMinor, summary.currency);
    $('#pfc-count').textContent = String(data.payments.length);
    const body = $('#pfc-history-body');
    if (!data.payments.length) {
      body.replaceChildren(h('tr', {}, h('td', { colspan: '6', class: 'zx-td-empty' }, 'No payments yet.')));
      return;
    }
    body.replaceChildren(...data.payments.map(p => h('tr', {},
      h('td', { class: 'zx-td-muted' }, formatDate(p.createdAt)),
      h('td', { class: 'zx-td-strong' }, `@${p.counterparty}`),
      h('td', {}, p.direction === 'out' ? 'Sent' : 'Received'),
      h('td', { class: `zx-amount ${p.direction === 'out' ? 'zx-amount--out' : 'zx-amount--in'}` }, `${p.direction === 'out' ? '- ' : '+ '}${formatMoney(p.amountMinor, p.currency)}`),
      h('td', { class: 'zx-td-mono' }, p.reference),
      h('td', {}, h('span', { class: 'zx-badge zx-badge--success' }, 'Completed')))));
  }

  bindForm($('#pfc-form'), async (data, form) => {
    const res = await api.post('/api/client-payments', data, { idempotencyKey: newIdempotencyKey() });
    toast.success(`Sent to @${res.payee}. Reference ${res.reference}.`);
    form.reset();
    await refresh();
  });

  await refresh();
}
