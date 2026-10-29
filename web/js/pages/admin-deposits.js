import { api } from '../core/api.js';
import { $, h, on } from '../core/dom.js';
import { minorToDecimal, loadCurrencies } from '../core/format.js';
import { act, ago, askForm, checkProvider, copyable, debounce, emptyRow, kv, live, money, moneyPost, pager, panel, providerPanel, queryParam, segmented, sheet, statusBadge, timeline, when } from '../admin/kit.js';

// Deposit queue. Staff open a claim, find the payment on the channel statement (same transaction ID, sender
// and amount), then confirm the amount actually received or reject it with a reason the member will see.
const state = { status: 'pending', q: '', page: 1 };
let poll;

async function loadList() {
  const params = new URLSearchParams({ page: String(state.page) });
  if (state.status) params.set('status', state.status);
  if (state.q) params.set('q', state.q);
  const data = await api.get(`/api/admin/payments/deposits?${params}`);
  const body = $('#rows');
  if (!data.deposits.length) body.replaceChildren(emptyRow(7, state.status === 'pending' ? 'No deposits waiting. New claims appear here automatically.' : 'No deposits match.'));
  else body.replaceChildren(...data.deposits.map(row));
  pager($('#pager'), data, page => {
    state.page = page;
    void poll.refresh();
  });
}

function checks(d) {
  const flags = [];
  if (d.warnings.sameTxnOtherClaims) flags.push(h('span', { class: 'zx-badge zx-badge--danger' }, 'Txn ID reused'));
  if (d.warnings.sameSenderOtherMembers) flags.push(h('span', { class: 'zx-badge zx-badge--warning' }, `Sender used by ${d.warnings.sameSenderOtherMembers} other`));
  if (d.creditedAmountMinor && d.creditedAmountMinor !== d.claimedAmountMinor) flags.push(h('span', { class: 'zx-badge zx-badge--warning' }, 'Amount differs'));
  return flags.length ? h('span', { class: 'zx-flags' }, flags) : h('span', { class: 'zx-badge zx-badge--success' }, 'No warnings');
}

function row(d) {
  return h('tr', { tabindex: '0', dataset: { open: d.id } },
    h('td', { class: 'zx-td-muted' }, ago(d.createdAt)),
    h('td', { class: 'zx-td-strong' }, `@${d.member}`, ' ', h('span', { class: `zx-badge ${d.purpose === 'wallet' ? 'zx-badge--brand' : 'zx-badge--warning'}` }, d.purpose === 'wallet' ? 'Deposit' : 'Activation')),
    h('td', {}, d.channel.name),
    h('td', { class: 'zx-td-mono' }, d.providerTxnId),
    h('td', { class: 'zx-amount' }, money(d.creditedAmountMinor ?? d.claimedAmountMinor, d.currency)),
    h('td', {}, checks(d)),
    h('td', {}, statusBadge(d.status)));
}

async function openDeposit(id) {
  const view = sheet('Deposit', { onClose: () => history.replaceState(null, '', location.pathname) });
  history.replaceState(null, '', `?id=${id}`);
  view.body.replaceChildren(h('p', { class: 'zx-hint' }, 'Loading...'));
  let data;
  try {
    data = await api.get(`/api/admin/payments/deposits/${id}`);
  } catch (err) {
    view.body.replaceChildren(h('p', { class: 'zx-error' }, err.message));
    return;
  }
  const { deposit: d, member: m, events, related, issues, provider } = data;
  view.setTitle(`${d.purpose === 'wallet' ? 'Deposit' : 'Activation payment'} ${d.reference}`);
  const warnings = [];
  if (related.some(r => r.providerTxnId === d.providerTxnId)) warnings.push('This transaction ID appears on another claim. Check it is not the same payment twice.');
  if (related.some(r => r.senderPhone === d.senderPhone && r.member !== m.username)) warnings.push('Other members have claimed payments from this sender phone.');
  if (m.status !== 'active') warnings.push(`The member account is ${m.status}.`);
  if (m.openFlags) warnings.push(`The member has ${m.openFlags} open fraud flag(s).`);
  if (d.senderPhone !== m.phone) warnings.push('The sender phone is not the member\'s registered phone. That can be normal (a relative paying), but check the name on the statement.');

  view.body.replaceChildren(
    panel('Claim',
      h('div', { class: 'zx-big-amount' }, money(d.claimedAmountMinor, d.currency)),
      h('div', {}, statusBadge(d.status), d.creditedAmountMinor ? h('span', { class: 'zx-hint' }, ` Credited ${money(d.creditedAmountMinor, d.currency)}`) : null),
      kv([
        ['Channel', d.channel.name],
        ['Transaction ID', copyable(d.providerTxnId)],
        ['Sent from', copyable(d.senderPhone)],
        ['Reference', copyable(d.reference)],
        ['Submitted', `${when(d.createdAt)} (${ago(d.createdAt)})`],
        d.memberNote ? ['Member note', d.memberNote] : null,
        d.reviewNote ? ['Review note', d.reviewNote] : null,
      ])),
    providerPanel(provider),
    warnings.length ? panel('Check before confirming', h('ul', { class: 'zx-warnlist' }, warnings.map(w => h('li', {}, w)))) : null,
    panel('Member',
      kv([
        ['Username', `@${m.username}`],
        ['Phone', `${m.phone ?? ''}${m.phoneVerified ? ' (verified)' : ' (not verified)'}`],
        ['Status', m.status],
        ['Account', m.membershipActive ? 'Activated' : 'Not activated'],
        ['Balance (referrals)', money(m.balances.availableBalanceMinor, m.balances.currency)],
        ['Deposit', money(m.balances.depositBalanceMinor, m.balances.currency)],
        ['Confirmed deposits', money(m.balances.totalDepositedMinor, m.balances.currency)],
        ['Joined', when(m.joinedAt)],
      ]),
      h('a', { class: 'zx-btn zx-btn--ghost zx-btn--sm zx-btn--fit', href: `/admin/members.html?id=${m.id}` }, 'Open member')),
    related.length ? panel('Related claims', h('ul', { class: 'zx-feed' }, related.map(r => h('li', {},
      h('div', { class: 'zx-feed__body' }, h('span', { class: 'zx-feed__title' }, `@${r.member} · ${r.reference}`),
        h('span', { class: 'zx-feed__meta' }, `${r.providerTxnId} · ${r.senderPhone} · ${ago(r.createdAt)}`)),
      h('span', { class: 'zx-feed__amount' }, money(r.claimedAmountMinor, r.currency)), statusBadge(r.status))))) : null,
    issues.length ? panel('Member reports', ...issues.map(i => h('a', { href: `/admin/issues.html?id=${i.id}` }, `${i.category.replace('_', ' ')}: ${i.summary ?? ''}`))) : null,
    panel('History', timeline(events)),
  );

  if (d.status !== 'pending') return view.setActions();
  // A LivePay payment settles by itself; staff step in only when it needs a check (review).
  if (provider && ['queued', 'sent', 'pending'].includes(provider.status)) {
    const check = h('button', { type: 'button', class: 'zx-btn' }, 'Check with LivePay');
    check.addEventListener('click', async () => {
      if (await act(() => checkProvider(provider.reference), 'Status checked.')) {
        view.close();
        await poll.refresh();
        await openDeposit(d.id);
      }
    });
    return view.setActions(h('span', { class: 'zx-hint' }, 'Waiting for the member to approve the prompt. It settles by itself.'), check);
  }
  const exponent = (await loadCurrencies())[d.currency] ?? 0;
  const confirm = h('button', { type: 'button', class: 'zx-btn zx-btn--success' }, 'Confirm received');
  const reject = h('button', { type: 'button', class: 'zx-btn zx-btn--danger' }, 'Reject');
  confirm.addEventListener('click', async () => {
    const result = await askForm({
      title: d.purpose === 'wallet' ? 'Confirm deposit' : 'Confirm activation payment',
      text: d.purpose === 'wallet'
        ? `Only confirm after you have found transaction ${d.providerTxnId} on the ${d.channel.name} statement. The amount you enter is credited to the member's balance; explain any difference in the note.`
        : `Only confirm after you have found transaction ${d.providerTxnId} on the ${d.channel.name} statement for exactly the activation fee. The member's account opens and referral rewards are paid.`,
      submitLabel: d.purpose === 'wallet' ? 'Confirm and credit' : 'Confirm and activate', tone: 'success',
      fields: [
        { name: 'amount', label: `Amount on the statement (${d.currency})`, value: minorToDecimal(d.claimedAmountMinor, exponent), required: true, inputmode: 'decimal' },
        { name: 'note', label: d.purpose === 'wallet' ? 'Note (required if the amount differs)' : 'Note (optional)', type: 'textarea' },
      ],
      submit: v => moneyPost(`/api/admin/payments/deposits/${d.id}/confirm`, { amount: v.amount, ...(v.note ? { note: v.note } : {}) }),
    });
    if (result) {
      view.close();
      await poll.refresh();
    }
  });
  reject.addEventListener('click', async () => {
    const result = await askForm({
      title: 'Reject deposit', text: 'The member sees this reason and can report a problem if they disagree.', submitLabel: 'Reject claim', tone: 'danger',
      fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true, minLength: 5, value: 'We could not find this payment on our statement.' }],
      submit: v => api.post(`/api/admin/payments/deposits/${d.id}/reject`, { reason: v.reason }),
    });
    if (result) {
      view.close();
      await poll.refresh();
    }
  });
  view.setActions(reject, confirm);
}

export async function init() {
  const initial = new URLSearchParams(location.search).get('status');
  if (initial !== null) state.status = initial;
  segmented($('#status-filter'), [
    { value: 'pending', label: 'Waiting review' }, { value: 'confirmed', label: 'Confirmed' }, { value: 'rejected', label: 'Rejected' },
    { value: 'cancelled', label: 'Cancelled' }, { value: '', label: 'All' },
  ], state.status, value => {
    state.status = value;
    state.page = 1;
    void poll.refresh();
  });
  $('#search').addEventListener('input', debounce(e => {
    state.q = e.target.value.trim();
    state.page = 1;
    void poll.refresh();
  }));
  const openRow = (_e, tr) => void openDeposit(tr.dataset.open);
  on($('#rows'), 'click', 'tr[data-open]', openRow);
  on($('#rows'), 'keydown', 'tr[data-open]', (e, tr) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openRow(e, tr);
    }
  });
  poll = live(loadList, { ms: 8000, indicator: $('#live') });
  const id = queryParam('id');
  if (id) await act(() => openDeposit(id));
}
