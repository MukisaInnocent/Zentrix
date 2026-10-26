import { api, ApiError, newIdempotencyKey } from '../core/api.js';
import { $, h } from '../core/dom.js';
import { formatDate, formatMoney } from '../core/format.js';
import { toast } from '../core/toast.js';

// Vouchers are bought from the main balance and used to activate another member's account. The value options
// (never below the activation fee) come from the server; nothing here calculates money.
const BADGES = { active: 'zx-badge--success', used: 'zx-badge--brand', cancelled: '' };

function voucherRow(v) {
  return h('tr', {},
    h('td', { class: 'zx-td-mono zx-td-strong' }, v.code),
    h('td', { class: 'zx-td-strong' }, formatMoney(v.amountMinor, v.currency)),
    h('td', { class: 'zx-td-muted' }, formatDate(v.createdAt)),
    h('td', {}, h('span', { class: `zx-badge zx-badge--cap ${BADGES[v.status] ?? ''}` }, v.status === 'active' ? 'unused' : v.status)),
    h('td', {}, v.usedBy ? `@${v.usedBy}` : '-'),
    h('td', { class: 'zx-td-muted' }, v.usedAt ? formatDate(v.usedAt, { withTime: true }) : '-'));
}

function fillSelect(select, options, empty) {
  const keep = select.value;
  select.replaceChildren(...(options.length ? options : [h('option', { value: '' }, empty)]));
  if ([...select.options].some(o => o.value === keep)) select.value = keep;
}

async function refresh() {
  const [summary, data] = await Promise.all([api.get('/api/wallet/summary'), api.get('/api/vouchers')]);
  $('#voucher-wallet-balance').textContent = formatMoney(summary.availableBalanceMinor, summary.currency);
  const unused = data.vouchers.filter(v => v.status === 'active');
  $('#active-vouchers-count').textContent = String(unused.length);

  $('#voucher-value-label').textContent = `Voucher Value (${data.currency})`;
  $('#buy-hint').textContent = `Each voucher is worth at least the activation fee of ${formatMoney(data.activationFeeMinor, data.currency)}.`;
  fillSelect($('#voucher-value'), data.valueOptions.map(o => h('option', { value: o.amount }, formatMoney(o.amountMinor, data.currency))), 'Not available');
  fillSelect($('#activate-code'), unused.map(v => h('option', { value: v.code }, `${v.code} (${formatMoney(v.amountMinor, v.currency)})`)), 'No unused vouchers. Buy one first.');
  $('#activate-submit').disabled = unused.length === 0;

  $('#vouchers-body').replaceChildren(...(data.vouchers.length
    ? data.vouchers.map(voucherRow)
    : [h('tr', {}, h('td', { colspan: '6', class: 'zx-td-empty' }, 'No vouchers created yet. Use the form above to buy your first voucher.'))]));
}

// Submits a money-moving form once, showing the server's message in the form's alert slot on failure.
function bindMoneyForm(form, alert, button, send) {
  form.addEventListener('submit', async e => {
    e.preventDefault();
    alert.textContent = '';
    button.setAttribute('aria-busy', 'true');
    button.disabled = true;
    let sent = false;
    try {
      await send(new FormData(form));
      sent = true;
    } catch (err) {
      alert.textContent = err instanceof ApiError ? err.message : 'Connection error. Please try again.';
    }
    button.removeAttribute('aria-busy');
    button.disabled = false;
    if (sent) await refresh().catch(() => undefined);
  });
}

export async function init() {
  bindMoneyForm($('#buy-voucher-form'), $('#buy-alert'), $('#buy-submit'), async data => {
    const quantity = Number(data.get('quantity') || 1);
    await api.post('/api/vouchers/buy', { amount: String(data.get('amount') || ''), quantity }, { idempotencyKey: newIdempotencyKey() });
    toast.success(`Bought ${quantity} voucher(s).`);
  });

  bindMoneyForm($('#activate-user-form'), $('#activate-alert'), $('#activate-submit'), async data => {
    const res = await api.post('/api/vouchers/activate', {
      username: String(data.get('username') || '').trim().replace(/^@/, '').toLowerCase(),
      code: String(data.get('code') || ''),
    }, { idempotencyKey: newIdempotencyKey() });
    toast.success(`@${res.username} is now activated.`);
    $('#activate-username').value = '';
  });

  try {
    await refresh();
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : 'Could not load your vouchers.');
  }
}
