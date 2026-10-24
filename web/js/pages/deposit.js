import { api, newIdempotencyKey } from '../core/api.js';
import { $, h, icon } from '../core/dom.js';
import { formatDate, formatMoney } from '../core/format.js';
import { bindForm } from '../core/forms.js';
import { mountReports, paymentBadge, reportProblem } from '../core/payments.js';
import { toast } from '../core/toast.js';

// Manual deposit: the member sends money to a business channel, then submits the transaction ID. Staff check
// the channel statement and credit the main balance. The page never adds anything to a balance itself.
let channels = [];
let selected = null;

function renderPaybox() {
  const c = channels.find(x => x.code === selected);
  const box = $('#paybox');
  if (!c) return box.replaceChildren(h('p', { class: 'zx-hint' }, 'No payment method is available for your country yet. Contact support.'));
  const copy = h('button', { type: 'button', class: 'zx-btn zx-btn--secondary zx-btn--sm zx-btn--fit' }, icon('copy'), 'Copy number');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(c.accountNumber.replace(/\s+/g, ''));
      toast.success('Number copied');
    } catch {
      toast.error('Copy is blocked in this browser.');
    }
  });
  box.replaceChildren(
    h('span', { class: 'zx-hint' }, `Send ${c.currency} by ${c.name} to`),
    h('span', { class: 'zx-paybox__number' }, c.accountNumber),
    h('span', {}, 'Name shown: ', h('strong', {}, c.accountName)),
    c.instructions ? h('span', { class: 'zx-hint' }, c.instructions) : null,
    copy);
}

function renderChannels() {
  const usable = channels.filter(c => c.depositsEnabled);
  if (!usable.find(c => c.code === selected)) selected = usable[0]?.code ?? null;
  $('#channel-pick').replaceChildren(...usable.map(c => {
    const input = h('input', { type: 'radio', name: 'channel-choice', value: c.code, checked: c.code === selected });
    input.addEventListener('change', () => {
      selected = c.code;
      renderPaybox();
    });
    return h('label', {}, input, c.name);
  }));
  renderPaybox();
}

async function refresh() {
  const [summary, list] = await Promise.all([api.get('/api/wallet/summary'), api.get('/api/payments/deposits')]);
  $('#stat-balance').textContent = formatMoney(summary.availableBalanceMinor, summary.currency);
  $('#stat-pending').textContent = formatMoney(summary.pendingDepositsMinor, summary.currency);
  $('#stat-total-deposited').textContent = formatMoney(summary.totalDepositedMinor, summary.currency);
  const body = $('#deposit-history-body');
  if (!list.deposits.length) {
    body.replaceChildren(h('tr', {}, h('td', { colspan: '6', class: 'zx-td-empty' }, 'No deposits yet.')));
    return;
  }
  body.replaceChildren(...list.deposits.map(d => {
    const actions = [];
    if (d.status === 'pending') {
      const cancel = h('button', { type: 'button', class: 'zx-btn zx-btn--ghost zx-btn--sm' }, 'Cancel');
      cancel.addEventListener('click', async () => {
        try {
          await api.post(`/api/payments/deposits/${d.id}/cancel`, {});
          toast.success('Deposit claim cancelled');
          await refresh();
        } catch (err) {
          toast.error(err.message);
        }
      });
      actions.push(cancel);
    }
    if (d.status !== 'cancelled') {
      const report = h('button', { type: 'button', class: 'zx-btn zx-btn--ghost zx-btn--sm' }, 'Report a problem');
      report.addEventListener('click', () => void reportProblem('deposit', d.reference));
      actions.push(report);
    }
    return h('tr', {},
      h('td', { class: 'zx-td-muted' }, formatDate(d.createdAt, { withTime: true })),
      h('td', {}, d.channel.name),
      h('td', { class: 'zx-td-mono' }, d.providerTxnId),
      h('td', { class: 'zx-amount zx-amount--in' }, formatMoney(d.creditedAmountMinor ?? d.claimedAmountMinor, d.currency)),
      h('td', {}, paymentBadge(d.status), d.reviewNote ? h('div', { class: 'zx-hint' }, d.reviewNote) : null),
      h('td', {}, h('span', { class: 'zx-row-actions' }, actions)));
  }));
}

export async function init({ me }) {
  const info = await api.get('/api/payments/channels');
  channels = info.channels;
  $('#paused').hidden = !info.depositsPaused;
  $('#deposit-submit').disabled = info.depositsPaused || !channels.some(c => c.depositsEnabled);
  if (me?.phone) $('#deposit-phone').value = me.phone;
  renderChannels();

  bindForm($('#deposit-form'), async (data, form) => {
    if (!selected) throw new Error('No payment method');
    const res = await api.post('/api/payments/deposits', { channel: selected, ...data }, { idempotencyKey: newIdempotencyKey() });
    toast.success(`Submitted. Reference ${res.deposit.reference}. We will credit it once we find the payment.`);
    form.reset();
    if (me?.phone) $('#deposit-phone').value = me.phone;
    await refresh();
  });

  await Promise.all([refresh(), mountReports($('#reports'))]);
}
