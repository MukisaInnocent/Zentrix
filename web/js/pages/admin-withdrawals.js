import { api } from '../core/api.js';
import { $, h, on } from '../core/dom.js';
import { act, ago, askForm, checkProvider, copyable, debounce, emptyRow, kv, live, money, moneyPost, pager, panel, providerPanel, queryParam, segmented, sheet, statusBadge, timeline, when } from '../admin/kit.js';

// Withdrawal queue. Approve (an admin for large amounts or new accounts), Start payout (claims it so two
// people never pay the same request), send the money from the business channel to the member's verified
// phone, then Mark paid with the payout transaction ID. Failed or cancelled requests return the funds. Where LivePay
// is set up, Send with LivePay replaces the manual steps: LivePay sends the money and the result is recorded by itself.
const state = { status: 'open', q: '', page: 1 };
let poll;

const SOURCE = { main: 'Balance (referrals)', youtube: 'YouTube earnings', tiktok: 'TikTok earnings', ads: 'Ads earnings', trivia: 'Trivia earnings', fixtap: 'Fix Tap earnings', music: 'Music earnings' };

async function loadList() {
  const params = new URLSearchParams({ page: String(state.page) });
  if (state.status) params.set('status', state.status);
  if (state.q) params.set('q', state.q);
  const data = await api.get(`/api/admin/payments/withdrawals?${params}`);
  const body = $('#rows');
  if (!data.withdrawals.length) body.replaceChildren(emptyRow(7, state.status === 'open' ? 'Nothing waiting. New requests appear here automatically.' : 'No withdrawals match.'));
  else body.replaceChildren(...data.withdrawals.map(w => h('tr', { tabindex: '0', dataset: { open: w.id } },
    h('td', { class: 'zx-td-muted' }, ago(w.createdAt)),
    h('td', { class: 'zx-td-strong' }, `@${w.member}`),
    h('td', { class: 'zx-td-mono' }, `${w.payoutPhone} · ${w.channel.name}`),
    h('td', { class: 'zx-amount' }, money(w.amountMinor, w.currency)),
    h('td', {}, SOURCE[w.source] ?? w.source),
    h('td', {}, w.needsAdminApproval ? h('span', { class: 'zx-badge zx-badge--warning' }, 'Admin + second person') : h('span', { class: 'zx-badge' }, 'Standard')),
    h('td', {}, statusBadge(w.status), w.processingBy ? h('span', { class: 'zx-hint' }, ` @${w.processingBy}`) : null))));
  pager($('#pager'), data, page => {
    state.page = page;
    void poll.refresh();
  });
}

async function openWithdrawal(id) {
  const view = sheet('Withdrawal', { onClose: () => history.replaceState(null, '', location.pathname) });
  history.replaceState(null, '', `?id=${id}`);
  view.body.replaceChildren(h('p', { class: 'zx-hint' }, 'Loading...'));
  let data;
  try {
    data = await api.get(`/api/admin/payments/withdrawals/${id}`);
  } catch (err) {
    view.body.replaceChildren(h('p', { class: 'zx-error' }, err.message));
    return;
  }
  const { withdrawal: w, member: m, events, issues, you, provider } = data;
  const request = provider?.request ?? null;
  // A payout LivePay is still handling cannot be recorded by hand; one in review can.
  const inFlight = request && ['queued', 'sent', 'pending'].includes(request.status);
  view.setTitle(`Withdrawal ${w.reference}`);
  const warnings = [];
  if (m.status !== 'active') warnings.push(`The member account is ${m.status}. Do not pay; cancel instead.`);
  if (m.openFlags) warnings.push(`The member has ${m.openFlags} open fraud flag(s).`);
  if (m.lifetime.depositedMinor === '0') warnings.push('This member has never made a confirmed deposit. The balance comes only from earnings.');
  if (w.needsAdminApproval) warnings.push('Large amount or new account: an admin approves, and a different staff member sends and records the payout.');

  view.body.replaceChildren(
    panel('Payout',
      h('div', { class: 'zx-big-amount' }, money(w.amountMinor, w.currency)),
      h('div', {}, statusBadge(w.status)),
      kv([
        ['Send to', copyable(w.payoutPhone)],
        ['Assigned network', w.channel.name],
        ['Fee kept', money(w.feeMinor, w.currency)],
        ['Taken from', SOURCE[w.source] ?? w.source],
        ['Reference', copyable(w.reference)],
        ['Requested', `${when(w.createdAt)} (${ago(w.createdAt)})`],
        w.approvedBy ? ['Approved by', `@${w.approvedBy}`] : null,
        w.processingBy ? ['Being sent by', `@${w.processingBy}`] : null,
        w.payoutTxnId ? ['Payout transaction', copyable(w.payoutTxnId)] : null,
        w.closedReason ? ['Reason', w.closedReason] : null,
      ])),
    providerPanel(request),
    warnings.length ? panel('Check before paying', h('ul', { class: 'zx-warnlist' }, warnings.map(x => h('li', {}, x)))) : null,
    panel('Member',
      kv([
        ['Username', `@${m.username}`],
        ['Verified phone', m.phone ?? ''],
        ['Status', m.status],
        ['Balance now (referrals)', money(m.balances.availableBalanceMinor, m.balances.currency)],
        ['Deposit', money(m.balances.depositBalanceMinor, m.balances.currency)],
        ['On hold', money(m.balances.reservedBalanceMinor, m.balances.currency)],
        ['Deposited, all time', money(m.lifetime.depositedMinor, m.balances.currency)],
        ['Withdrawn, all time', money(m.lifetime.withdrawnMinor, m.balances.currency)],
        ['Joined', when(m.joinedAt)],
      ]),
      h('a', { class: 'zx-btn zx-btn--ghost zx-btn--sm zx-btn--fit', href: `/admin/members.html?id=${m.id}` }, 'Open member')),
    issues.length ? panel('Member reports', ...issues.map(i => h('a', { href: `/admin/issues.html?id=${i.id}` }, `${i.category.replace('_', ' ')}: ${i.summary ?? ''}`))) : null,
    panel('History', timeline(events)),
  );

  const done = async () => {
    view.close();
    await poll.refresh();
  };
  const button = (label, tone, handler) => {
    const b = h('button', { type: 'button', class: `zx-btn${tone ? ` zx-btn--${tone}` : ''}` }, label);
    b.addEventListener('click', handler);
    return b;
  };
  const cancel = button('Cancel and refund', 'danger', async () => {
    if (await askForm({
      title: 'Cancel withdrawal', text: 'The full amount and fee go back to the member\'s balance. The member sees the reason.', submitLabel: 'Cancel withdrawal', tone: 'danger',
      fields: [{ name: 'note', label: 'Reason', type: 'textarea', required: true, minLength: 5 }],
      submit: v => moneyPost(`/api/admin/payments/withdrawals/${w.id}/cancel`, { note: v.note }),
    })) await done();
  });

  const actions = [];
  if (w.status === 'requested') {
    actions.push(cancel);
    if (w.needsAdminApproval && !you.canApproveLarge) actions.push(h('span', { class: 'zx-hint' }, 'Waiting for an admin to approve.'));
    else actions.push(button('Approve', 'success', async () => {
      if (await act(() => moneyPost(`/api/admin/payments/withdrawals/${w.id}/approve`, {}), 'Approved. It is ready to be sent.')) await done();
    }));
  } else if (w.status === 'approved') {
    actions.push(cancel);
    if (w.needsAdminApproval && you.isApprover) actions.push(h('span', { class: 'zx-hint' }, 'You approved this, so another staff member must send it.'));
    else {
      actions.push(button(provider?.payoutChannel ? 'Pay by hand' : 'Start payout', '', async () => {
        if (await act(() => moneyPost(`/api/admin/payments/withdrawals/${w.id}/start`, {}), 'Marked as being sent by you. Send the money now.')) await openWithdrawalAgain();
      }));
      if (provider?.payoutChannel) actions.push(button('Send with LivePay', 'success', async () => {
        if (await askForm({
          title: 'Send with LivePay', text: `LivePay sends ${money(w.amountMinor, w.currency)} to ${w.payoutPhone} from ${provider.payoutChannel.name}. The result is recorded by itself. This moves real money in live mode.`,
          submitLabel: 'Send now', tone: 'success',
          fields: [{ name: 'note', label: 'Note (optional)', type: 'textarea' }],
          submit: v => moneyPost(`/api/admin/payments/withdrawals/${w.id}/send-provider`, v.note ? { note: v.note } : {}),
        })) await openWithdrawalAgain();
      }));
    }
  } else if (w.status === 'processing' && inFlight) {
    actions.push(h('span', { class: 'zx-hint' }, 'LivePay is sending this payout. It finishes by itself.'));
    actions.push(button('Check with LivePay', '', async () => {
      if (await act(() => checkProvider(request.reference), 'Status checked.')) await openWithdrawalAgain();
    }));
  } else if (w.status === 'processing') {
    actions.push(button('Payout failed', 'danger', async () => {
      if (await askForm({
        title: 'Payout failed', text: 'Use this only if no money left the business account. The full amount and fee go back to the member.', submitLabel: 'Mark failed and refund', tone: 'danger',
        fields: [{ name: 'note', label: 'What went wrong', type: 'textarea', required: true, minLength: 5 }],
        submit: v => moneyPost(`/api/admin/payments/withdrawals/${w.id}/fail`, { note: v.note }),
      })) await done();
    }));
    actions.push(button('Mark paid', 'success', async () => {
      if (await askForm({
        title: 'Record payout', text: `Send ${money(w.amountMinor, w.currency)} to ${w.payoutPhone}, then say which network you paid from and enter the transaction ID from the confirmation message.`, submitLabel: 'Mark paid', tone: 'success',
        fields: [
          { name: 'channel', label: 'Paid from', type: 'select', value: w.channel.code, options: data.channels.map(c => ({ value: c.code, label: c.name })) },
          { name: 'payoutTxnId', label: 'Payout transaction ID', required: true, minLength: 4 },
          { name: 'note', label: 'Note (optional)', type: 'textarea' },
        ],
        submit: v => moneyPost(`/api/admin/payments/withdrawals/${w.id}/paid`, { payoutTxnId: v.payoutTxnId, channel: v.channel, ...(v.note ? { note: v.note } : {}) }),
      })) await done();
    }));
  }
  view.setActions(...actions);

  async function openWithdrawalAgain() {
    view.close();
    await poll.refresh();
    await openWithdrawal(w.id);
  }
}

export async function init() {
  const initial = new URLSearchParams(location.search).get('status');
  if (initial !== null) state.status = initial;
  segmented($('#status-filter'), [
    { value: 'open', label: 'Open' }, { value: 'requested', label: 'To approve' }, { value: 'approved', label: 'To send' },
    { value: 'processing', label: 'Being sent' }, { value: 'paid', label: 'Paid' }, { value: 'failed', label: 'Failed' },
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
  on($('#rows'), 'click', 'tr[data-open]', (_e, tr) => void openWithdrawal(tr.dataset.open));
  on($('#rows'), 'keydown', 'tr[data-open]', (e, tr) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void openWithdrawal(tr.dataset.open);
    }
  });
  poll = live(loadList, { ms: 8000, indicator: $('#live') });
  const id = queryParam('id');
  if (id) await act(() => openWithdrawal(id));
}
