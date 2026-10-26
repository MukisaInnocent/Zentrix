import { api, newIdempotencyKey } from '../core/api.js';
import { $, h } from '../core/dom.js';
import { formatDate, formatMoney } from '../core/format.js';
import { bindForm } from '../core/forms.js';
import { toast } from '../core/toast.js';

// Pay For Client: activate a member of your own country by paying their fee, or send money to an active member.
// The server checks everything and moves the money; the page only shows what it says.
const TYPE = {
  out: ['Sent', 'zx-amount--out', '- '],
  in: ['Received', 'zx-amount--in', '+ '],
  activation: ['Activation paid', 'zx-amount--out', '- '],
};

async function refresh() {
  const [summary, data, info] = await Promise.all([api.get('/api/wallet/summary'), api.get('/api/client-payments'), api.get('/api/payments/channels')]);
  $('#pfc-balance').textContent = formatMoney(summary.spendableMinor, summary.currency);
  $('#pfc-count').textContent = String(data.payments.length);
  $('#pfc-amount-label').textContent = `Amount (${summary.currency})`;
  if (info.activation.feeMinor) {
    $('#pfc-activate-hint').textContent = `Pay the ${formatMoney(info.activation.feeMinor, info.currency)} activation fee for a member of your own country who has not activated yet.`;
  }
  const body = $('#pfc-history-body');
  if (!data.payments.length) {
    body.replaceChildren(h('tr', {}, h('td', { colspan: '6', class: 'zx-td-empty' }, 'No payments yet.')));
    return;
  }
  body.replaceChildren(...data.payments.map(p => {
    const [label, tone, sign] = TYPE[p.direction] ?? TYPE.out;
    return h('tr', {},
      h('td', { class: 'zx-td-muted' }, formatDate(p.createdAt)),
      h('td', { class: 'zx-td-strong' }, `@${p.counterparty}`),
      h('td', {}, label),
      h('td', { class: `zx-amount ${tone}` }, `${sign}${formatMoney(p.amountMinor, p.currency)}`),
      h('td', { class: 'zx-td-mono' }, p.reference),
      h('td', {}, h('span', { class: 'zx-badge zx-badge--success' }, 'Completed')));
  }));
}

export async function init() {
  bindForm($('#pfc-activate-form'), async (data, form) => {
    const res = await api.post('/api/client-payments/activate', { username: String(data.username).trim().replace(/^@/, '') }, { idempotencyKey: newIdempotencyKey() });
    toast.success(`@${res.username} is now activated. Receipt ${res.receiptNo}.`);
    form.reset();
    await refresh();
  });

  bindForm($('#pfc-form'), async (data, form) => {
    const res = await api.post('/api/client-payments', { recipient: String(data.recipient).trim().replace(/^@/, ''), amount: data.amount }, { idempotencyKey: newIdempotencyKey() });
    toast.success(`Sent to @${res.payee}. Reference ${res.reference}.`);
    form.reset();
    await refresh();
  });

  await refresh();
}
