import { api } from '../core/api.js';
import { $, h, icon } from '../core/dom.js';
import { act, emptyRow, money, when } from '../admin/kit.js';

// Overall balance (owner, 2026-11-10): the server adds every figure up and converts it; this page only shows them.
const ROWS = [
  ['received', 'Received', 'Activation fees and deposits members paid in.'],
  ['ownerIn', 'Owner sent in', 'Money the owner put on a payment method to cover losses.'],
  ['withdrawn', 'Withdrawn', 'Withdrawals paid out to members.'],
  ['withdrawalFees', 'Withdrawal charges kept', 'Charges and tax members paid on withdrawals (part of what is held).'],
  ['providerCharges', 'LivePay charges', 'What LivePay kept from payments, when the platform pays it.'],
  ['ownerOut', 'Owner took out', 'Money the owner took out of the business.'],
  ['referralRewards', 'Referral rewards', 'Rewards credited to members (owed until they withdraw).'],
  ['other', 'Other', 'Any other money movement on the payment methods.'],
  ['ledgerHeld', 'Should hold', 'What the payment methods should hold by the books.'],
  ['actualHeld', 'Really held', 'LivePay\'s balance plus the other methods\' statements.'],
  ['owedToMembers', 'Owed to members', 'Member balances, deposits and withdrawals waiting.'],
  ['position', 'Position', 'Really held less owed to members: a surplus when positive, a deficit when negative.'],
];

const signed = (minor, currency) => {
  const text = money(minor, currency);
  return BigInt(minor) < 0n ? h('span', { class: 'zx-text-danger' }, text) : text;
};

function stat(tone, iconName, label, value, note) {
  return h('div', { class: `zx-stat${tone ? ` zx-stat--${tone}` : ''}` },
    h('span', { class: 'zx-stat__badge' }, icon(iconName)),
    h('span', { class: 'zx-stat__value' }, value),
    h('span', { class: 'zx-stat__label' }, label),
    note ? h('span', { class: 'zx-stat__note' }, note) : null);
}

async function load() {
  const r = await api.get('/api/admin/overall-balance');
  const t = r.totalUgx;
  const ugx = r.currencies.find(c => c.currency === 'UGX');
  const lp = ugx?.livepay;

  const notes = [];
  if (!r.livepayAvailable) notes.push('LivePay\'s balance is not available yet, so its methods count at what the books say.');
  if (r.notInTotal.length) notes.push(`Left out of the UGX total (no exchange rate yet): ${r.notInTotal.join(', ')}.`);
  $('#livepay-note').replaceChildren(
    r.livepayReadAt ? h('p', { class: 'zx-hint' }, `LivePay balance read ${when(r.livepayReadAt)}.`) : '',
    ...notes.map(n => h('div', { class: 'zx-banner zx-banner--warning' }, icon('info'), h('span', { class: 'zx-banner__text' }, n))));

  const deficit = BigInt(t.position) < 0n;
  const lpShort = lp?.differenceMinor && BigInt(lp.differenceMinor) < 0n;
  $('#stats').replaceChildren(
    stat('mint', 'deposit', 'Received', money(t.received, 'UGX'), `Owner sent in ${money(t.ownerIn, 'UGX')}`),
    stat('sand', 'withdraw', 'Withdrawn', money(t.withdrawn, 'UGX'), `LivePay charges ${money(t.providerCharges, 'UGX')}`),
    stat(lpShort ? 'rose' : 'lilac', 'card', 'LivePay balance', lp?.balanceMinor ? money(lp.balanceMinor, 'UGX') : '-',
      lp?.differenceMinor ? `${BigInt(lp.differenceMinor) < 0n ? 'Short by' : 'Above the books by'} ${money(lp.differenceMinor.replace('-', ''), 'UGX')}` : 'Should hold ' + money(lp?.ledgerMinor ?? '0', 'UGX')),
    stat(deficit ? 'rose' : 'mint', 'shield', deficit ? 'Deficit' : 'Surplus', money(t.position.replace('-', ''), 'UGX'), `Held ${money(t.actualHeld, 'UGX')}, owed ${money(t.owedToMembers, 'UGX')}`),
  );

  $('#totals').replaceChildren(...ROWS.map(([k, label, means]) => h('tr', {},
    h('td', { class: 'zx-td-strong' }, label), h('td', { class: 'zx-td-muted' }, means), h('td', {}, signed(t[k], 'UGX')))));

  $('#currencies').replaceChildren(...(r.currencies.length ? r.currencies.map(c => h('tr', {},
    h('td', { class: 'zx-td-strong' }, c.currency),
    ...['received', 'ownerIn', 'withdrawn', 'providerCharges', 'ownerOut', 'referralRewards', 'ledgerHeld', 'actualHeld', 'owedToMembers', 'position']
      .map(k => h('td', {}, signed(c.figures[k], c.currency))))) : [emptyRow(11, 'No money has moved yet.')]));

  const channels = r.currencies.flatMap(c => c.channels.map(ch => ({ ...ch, currency: c.currency, livepay: c.livepay })));
  const source = ch => (ch.actualSource === 'livepay' ? 'LivePay' : ch.actualSource === 'statement' ? `Statement ${when(ch.actualAt)}` : 'Not checked');
  $('#channels').replaceChildren(...(channels.length ? channels.map(ch => h('tr', {},
    h('td', { class: 'zx-td-strong' }, `${ch.name} (${ch.currency})`),
    h('td', {}, money(ch.ledgerMinor, ch.currency)),
    h('td', {}, ch.actualSource === 'livepay' ? 'All LivePay methods together: see above' : money(ch.actualMinor, ch.currency)),
    h('td', { class: 'zx-td-muted' }, source(ch)),
    h('td', {}, ch.actualSource === 'livepay' ? signed(ch.livepay?.differenceMinor ?? '0', ch.currency) : signed(ch.differenceMinor, ch.currency)))) : [emptyRow(5, 'No payment methods yet.')]));
}

export async function init() {
  $('#refresh').addEventListener('click', () => void act(load));
  await act(load);
}
