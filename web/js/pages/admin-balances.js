import { api } from '../core/api.js';
import { $, h, icon, setBusy } from '../core/dom.js';
import { toast } from '../core/toast.js';
import { act, ago, askForm, emptyRow, money, moneyPost, panel, severityBadge, statusBadge, when } from '../admin/kit.js';

// The balance check: does the ledger balance, does every cached balance match its entries, and is what members
// are owed covered by the money actually held on each channel? Also channel statements, pause switches,
// treasury requests (a second admin approves) and the recent check runs.
const KIND = { capital_in: 'Owner capital in', owner_withdrawal: 'Owner withdrawal', fund_budget: 'Fund a budget', channel_transfer: 'Move float between channels' };
const ACCOUNT = {
  platform_revenue: 'Platform revenue (activation fees)', fees: 'Withdrawal fees', referral_budget: 'Referral budget', promotions_budget: 'Task reward budget',
  owner_capital: 'Owner capital', voucher_liability: 'Unredeemed vouchers', suspense: 'Suspense',
};
let me = null;

function equationRow(label, value, strong = false) {
  return h('div', { class: 'zx-equation__row' }, h('span', {}, strong ? h('strong', {}, label) : label), h('span', {}, value));
}

function renderSummary(report) {
  const blocks = [];
  blocks.push(report.ok
    ? h('div', { class: 'zx-banner zx-banner--success' }, icon('check-circle'), h('span', { class: 'zx-banner__text' }, 'Every check passes: the ledger balances, no drift, and member balances are covered.'))
    : h('div', { class: 'zx-banner zx-banner--danger', role: 'alert' }, icon('alert'), h('span', { class: 'zx-banner__text' }, 'A check is failing. Withdrawals pause automatically in the affected currency until an admin resumes them after a clean check.')));
  if (report.drift.length || report.ledgerUnbalanced.length) {
    blocks.push(panel('Ledger integrity',
      ...report.ledgerUnbalanced.map(u => h('p', { class: 'zx-error' }, `${u.currency}: debits ${u.debitsMinor} and credits ${u.creditsMinor} do not match.`)),
      ...report.drift.map(d => h('p', { class: 'zx-error' }, `Account ${d.accountId} (${d.kind}, ${d.currency}) shows ${d.cachedMinor} but its entries add up to ${d.entriesMinor}.`))));
  }
  const s = report.stuck;
  if (s.deposits || s.withdrawalsWaiting || s.withdrawalsProcessing) {
    blocks.push(h('div', { class: 'zx-banner zx-banner--warning' }, icon('clock'), h('span', { class: 'zx-banner__text' },
      `Waiting too long: ${s.deposits} deposit(s), ${s.withdrawalsWaiting} withdrawal(s) to approve or send, ${s.withdrawalsProcessing} payout(s) started but not finished.`)));
  }
  if (!report.currencies.length) blocks.push(h('p', { class: 'zx-hint' }, 'No money has moved yet.'));
  blocks.push(h('div', { class: 'zx-check-grid' }, report.currencies.map(c => h('section', { class: 'zx-panel' },
    h('h3', {}, `${c.currency} `, c.ok ? h('span', { class: 'zx-badge zx-badge--success' }, 'Covered') : h('span', { class: 'zx-badge zx-badge--danger' }, 'Check failing')),
    h('div', { class: 'zx-equation' },
      equationRow('Main balances', money(c.memberMainMinor, c.currency)),
      equationRow('Deposit balances', money(c.memberDepositMinor, c.currency)),
      equationRow('Task earnings', money(c.memberTaskMinor, c.currency)),
      equationRow('Withdrawals on hold', money(c.memberHeldMinor, c.currency)),
      equationRow('Members are owed', money(c.liabilitiesMinor, c.currency), true)),
    h('div', { class: 'zx-equation' },
      equationRow('Ledger says held', money(c.ledgerHeldMinor, c.currency)),
      equationRow(`Held per statements${c.unverifiedChannels ? ` (${c.unverifiedChannels} channel(s) unverified)` : ''}`, money(c.fundsHeldMinor, c.currency), true),
      equationRow('Cover after paying everyone', money(c.coverageMinor, c.currency), true)),
    h('div', { class: 'zx-equation' }, Object.entries(c.system).map(([k, v]) => equationRow(ACCOUNT[k] ?? k, money(v, c.currency)))),
    c.findings.length ? h('ul', { class: 'zx-warnlist' }, c.findings.map(f => h('li', {}, severityBadge(f.severity), ' ', f.message))) : null))));
  $('#summary').replaceChildren(...blocks);
}

function renderChannels(channels, positions, refresh) {
  const body = $('#channels');
  if (!channels.length) return body.replaceChildren(emptyRow(6, 'No payment channels yet. Add the business mobile-money number members should pay.'));
  body.replaceChildren(...channels.map(c => {
    const p = positions.find(x => x.code === c.code);
    const record = h('button', { type: 'button', class: 'zx-btn zx-btn--secondary zx-btn--sm' }, 'Record statement');
    record.addEventListener('click', async () => {
      if (await askForm({
        title: `Statement balance: ${c.name}`, text: 'Read the current balance from the channel statement or app, exactly.', submitLabel: 'Save',
        fields: [{ name: 'balance', label: `Balance (${c.currency})`, required: true, inputmode: 'decimal' }, { name: 'note', label: 'Note', type: 'textarea' }],
        submit: v => api.post('/api/admin/payments/float-snapshots', { channel: c.code, balance: v.balance, ...(v.note ? { note: v.note } : {}) }),
      })) await refresh();
    });
    const edit = me?.roles.includes('admin') ? h('button', { type: 'button', class: 'zx-btn zx-btn--ghost zx-btn--sm' }, 'Edit') : null;
    edit?.addEventListener('click', () => void editChannel(c, refresh));
    const diff = p?.differenceMinor;
    return h('tr', {},
      h('td', { class: 'zx-td-strong' }, c.name, ' ', !c.depositsEnabled ? h('span', { class: 'zx-badge' }, 'No deposits') : null, !c.payoutsEnabled ? h('span', { class: 'zx-badge' }, 'No payouts') : null),
      h('td', { class: 'zx-td-mono' }, `${c.accountNumber} · ${c.accountName}`),
      h('td', { class: 'zx-amount' }, money(p?.ledgerHeldMinor ?? '0', c.currency)),
      h('td', {}, p?.statementMinor ? `${money(p.statementMinor, c.currency)} · ${ago(p.statementAt)}` : h('span', { class: 'zx-badge zx-badge--warning' }, 'Never recorded')),
      h('td', { class: diff && diff.startsWith('-') ? 'zx-text-danger' : '' }, diff === null || diff === undefined ? '' : money(diff, c.currency)),
      h('td', {}, h('span', { class: 'zx-row-actions' }, record, edit)));
  }));
}

async function editChannel(c, refresh) {
  await askForm({
    title: `Edit ${c.name}`, submitLabel: 'Save',
    fields: [
      { name: 'name', label: 'Name members see', value: c.name, required: true },
      { name: 'accountName', label: 'Account name', value: c.accountName, required: true },
      { name: 'ussdCode', label: 'USSD code members dial (optional)', value: c.ussdCode ?? '' },
      { name: 'merchantCode', label: 'Merchant code (optional)', value: c.merchantCode ?? '' },
      { name: 'accountNumber', label: 'Account or number', value: c.accountNumber, required: true },
      { name: 'instructions', label: 'Instructions for members', type: 'textarea', value: c.instructions ?? '' },
      { name: 'depositsEnabled', label: 'Accept deposits', type: 'select', value: String(c.depositsEnabled), options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] },
      { name: 'payoutsEnabled', label: 'Use for payouts', type: 'select', value: String(c.payoutsEnabled), options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] },
    ],
    submit: v => api.patch(`/api/admin/payments/channels/${c.code}`, {
      name: v.name, accountName: v.accountName, accountNumber: v.accountNumber, ...(v.instructions ? { instructions: v.instructions } : {}),
      ...(v.ussdCode ? { ussdCode: v.ussdCode } : {}), ...(v.merchantCode ? { merchantCode: v.merchantCode } : {}),
      depositsEnabled: v.depositsEnabled === 'true', payoutsEnabled: v.payoutsEnabled === 'true',
    }),
  }) && (await refresh());
}

function renderFlags(flags, currencies, refresh) {
  const list = [...new Set(['UGX', ...currencies])];
  const isOn = (key, cur) => flags.find(f => f.key === key && f.currency_code === cur && f.active);
  $('#flags').replaceChildren(h('ul', { class: 'zx-feed' }, list.flatMap(cur => ['deposits_paused', 'withdrawals_paused'].map(key => {
    const flag = isOn(key, cur);
    const what = key === 'deposits_paused' ? 'Deposits' : 'Withdrawals';
    const btn = h('button', { type: 'button', class: `zx-btn zx-btn--sm ${flag ? 'zx-btn--success' : 'zx-btn--danger'}` }, flag ? 'Resume' : 'Pause');
    btn.addEventListener('click', async () => {
      if (await askForm({
        title: `${flag ? 'Resume' : 'Pause'} ${what.toLowerCase()} (${cur})`,
        text: flag ? 'Only an admin can resume, and withdrawals resume only after a clean balance check.' : 'Members see that this is paused for a short check.',
        submitLabel: flag ? 'Resume' : 'Pause', tone: flag ? 'success' : 'danger',
        fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true, minLength: 5 }],
        submit: v => api.post('/api/admin/payments/flags', { key, currency: cur, active: !flag, reason: v.reason }),
      })) await refresh();
    });
    return h('li', {},
      h('div', { class: 'zx-feed__body' }, h('span', { class: 'zx-feed__title' }, `${what} in ${cur}`),
        h('span', { class: 'zx-feed__meta' }, flag ? `Paused${flag.automatic ? ' automatically' : ''} ${ago(flag.changed_at)}: ${flag.reason ?? ''}` : 'Running')),
      flag ? h('span', { class: 'zx-badge zx-badge--danger' }, 'Paused') : h('span', { class: 'zx-badge zx-badge--success' }, 'Running'), btn);
  }))));
}

function renderTreasury(requests, refresh) {
  const body = $('#treasury');
  if (!requests.length) return body.replaceChildren(emptyRow(6, 'No treasury requests yet.'));
  body.replaceChildren(...requests.map(r => {
    const cells = [
      h('td', { class: 'zx-td-muted' }, `${ago(r.createdAt)} by @${r.requestedBy}`),
      h('td', {}, KIND[r.kind] ?? r.kind),
      h('td', { class: 'zx-amount' }, money(r.amountMinor, r.currency)),
      h('td', {}, `${ACCOUNT[r.from] ?? r.from} to ${ACCOUNT[r.to] ?? r.to}`),
      h('td', {}, r.note, r.externalRef ? h('span', { class: 'zx-hint' }, ` · ${r.externalRef}`) : null),
    ];
    let status = statusBadge(r.status === 'pending' ? 'pending' : r.status === 'approved' ? 'confirmed' : 'rejected');
    if (r.status === 'pending' && me?.roles.includes('admin') && r.requestedBy !== me.username) {
      const decide = approve => async () => {
        if (await askForm({
          title: approve ? 'Approve treasury request' : 'Reject treasury request', text: `${KIND[r.kind]}: ${money(r.amountMinor, r.currency)}. ${r.note}`,
          submitLabel: approve ? 'Approve and move money' : 'Reject', tone: approve ? 'success' : 'danger',
          fields: [{ name: 'note', label: 'Note', type: 'textarea', required: !approve }],
          submit: v => moneyPost(`/api/admin/payments/treasury/${r.id}/decide`, { approve, ...(v.note ? { note: v.note } : {}) }),
        })) await refresh();
      };
      const yes = h('button', { type: 'button', class: 'zx-btn zx-btn--success zx-btn--sm' }, 'Approve');
      const no = h('button', { type: 'button', class: 'zx-btn zx-btn--secondary zx-btn--sm' }, 'Reject');
      yes.addEventListener('click', decide(true));
      no.addEventListener('click', decide(false));
      status = h('span', { class: 'zx-row-actions' }, no, yes);
    } else if (r.status === 'pending') {
      status = h('span', {}, statusBadge('pending'), h('span', { class: 'zx-hint' }, ' Needs another admin'));
    } else if (r.decidedBy) {
      status = h('span', {}, status, h('span', { class: 'zx-hint' }, ` @${r.decidedBy}`));
    }
    return h('tr', {}, ...cells, h('td', {}, status));
  }));
}

async function newTreasury(channels, refresh) {
  const channelOptions = channels.map(c => ({ value: c.code, label: `${c.name} (${c.currency})` }));
  const kind = await askForm({
    title: 'New treasury request', submitLabel: 'Next',
    fields: [{ name: 'kind', label: 'What do you want to do?', type: 'select', options: Object.entries(KIND).map(([value, label]) => ({ value, label })) }],
  });
  if (!kind) return;
  const fields = [{ name: 'amount', label: 'Amount', required: true, inputmode: 'decimal' }];
  if (kind.kind === 'capital_in') fields.push({ name: 'channel', label: 'Channel the money arrived on', type: 'select', options: channelOptions }, { name: 'externalRef', label: 'Transaction ID', required: true });
  if (kind.kind === 'owner_withdrawal') fields.push({ name: 'source', label: 'Take from', type: 'select', options: ['platform_revenue', 'fees', 'owner_capital'].map(v => ({ value: v, label: ACCOUNT[v] })) }, { name: 'channel', label: 'Channel the money leaves from', type: 'select', options: channelOptions }, { name: 'externalRef', label: 'Transaction ID' });
  if (kind.kind === 'fund_budget') fields.push({ name: 'source', label: 'Take from', type: 'select', options: ['platform_revenue', 'fees', 'owner_capital'].map(v => ({ value: v, label: ACCOUNT[v] })) }, { name: 'budget', label: 'Budget', type: 'select', options: ['promotions_budget', 'referral_budget'].map(v => ({ value: v, label: ACCOUNT[v] })) });
  if (kind.kind === 'channel_transfer') fields.push({ name: 'channel', label: 'From channel', type: 'select', options: channelOptions }, { name: 'toChannel', label: 'To channel', type: 'select', options: channelOptions }, { name: 'externalRef', label: 'Transaction ID' });
  fields.push({ name: 'note', label: 'What is this for?', type: 'textarea', required: true, minLength: 5 });
  const currency = kind.kind === 'fund_budget' ? 'UGX' : null;
  const done = await askForm({
    title: KIND[kind.kind], text: 'Another admin must approve this before any money moves.', submitLabel: 'Send for approval', fields,
    submit: v => {
      const channel = channels.find(c => c.code === v.channel);
      const body = { kind: kind.kind, currency: channel?.currency ?? currency ?? 'UGX', amount: v.amount, note: v.note };
      for (const k of ['channel', 'toChannel', 'source', 'budget', 'externalRef']) if (v[k]) body[k] = v[k];
      return api.post('/api/admin/payments/treasury', body);
    },
  });
  if (done) await refresh();
}

async function addChannel(refresh) {
  if (await askForm({
    title: 'Add payment channel', text: 'A way members in one country pay the activation fee, and where staff pay out from.', submitLabel: 'Add channel',
    fields: [
      { name: 'code', label: 'Short code (letters, digits, underscores)', required: true, value: 'mtn_ug' },
      { name: 'name', label: 'Name members see', required: true, value: 'MTN Mobile Money' },
      { name: 'country', label: 'Country code', required: true, value: 'UG', maxLength: 2 },
      { name: 'accountName', label: 'Registered account name', required: true },
      { name: 'ussdCode', label: 'USSD code members dial, for example *165*3# (optional)' },
      { name: 'merchantCode', label: 'Merchant code (optional)' },
      { name: 'accountNumber', label: 'Account or number', required: true },
      { name: 'instructions', label: 'Instructions for members', type: 'textarea' },
    ],
    submit: v => api.post('/api/admin/payments/channels', { ...v, country: v.country.toUpperCase(), ussdCode: v.ussdCode || undefined, merchantCode: v.merchantCode || undefined, instructions: v.instructions || undefined }),
  })) await refresh();
}

export async function init({ me: current }) {
  me = current;
  let channels = [];
  const refresh = async () => {
    const [balances, list, treasury] = await Promise.all([
      api.get('/api/admin/payments/balances'),
      api.get('/api/admin/payments/channels'),
      api.get('/api/admin/payments/treasury'),
    ]);
    channels = list.channels;
    renderSummary(balances.report);
    renderChannels(channels, balances.report.currencies.flatMap(c => c.channels), refresh);
    renderFlags(balances.flags, balances.report.currencies.map(c => c.currency), refresh);
    renderTreasury(treasury.requests, refresh);
    $('#runs').replaceChildren(...(balances.runs.length ? balances.runs.map(r => h('li', {},
      h('div', { class: 'zx-feed__body' }, h('span', { class: 'zx-feed__title' }, r.ok ? 'All checks passed' : 'Check failed'),
        h('span', { class: 'zx-feed__meta' }, `${when(r.created_at)} · ${r.triggered_by ? 'run by staff' : 'automatic'}`)),
      r.ok ? h('span', { class: 'zx-badge zx-badge--success' }, 'OK') : h('span', { class: 'zx-badge zx-badge--danger' }, 'Failed'))) : [h('li', {}, h('span', { class: 'zx-hint' }, 'No checks have run yet.'))]));
  };
  const addBtn = $('#add-channel');
  if (!me.roles.includes('admin')) addBtn.hidden = true;
  addBtn.addEventListener('click', () => void addChannel(refresh));
  $('#new-treasury').addEventListener('click', () => void newTreasury(channels, refresh));
  $('#run-check').addEventListener('click', async e => {
    const btn = e.currentTarget;
    setBusy(btn, true);
    let report = null;
    await act(async () => {
      ({ report } = await api.post('/api/admin/payments/reconciliation/run', {}));
      await refresh();
    });
    if (report) (report.ok ? toast.success : toast.error)(report.ok ? 'Check finished: everything passes.' : 'A check failed. See the findings above.');
    setBusy(btn, false);
  });
  await refresh();
  if (location.hash === '#treasury') $('#treasury')?.scrollIntoView();
}
