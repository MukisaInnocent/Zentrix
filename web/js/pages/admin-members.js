import { api } from '../core/api.js';
import { $, h, on } from '../core/dom.js';
import { act, ago, askForm, debounce, emptyRow, kv, money, pager, panel, queryParam, sheet, statusBadge, when } from '../admin/kit.js';

// Member search and detail: profile, balances, recent payments and statement, and freeze or unfreeze.
const state = { q: '', page: 1 };
let me = null;

async function load() {
  const params = new URLSearchParams({ page: String(state.page) });
  if (state.q) params.set('q', state.q);
  const data = await api.get(`/api/admin/members?${params}`);
  const body = $('#rows');
  if (!data.members.length) body.replaceChildren(emptyRow(6, 'No members match.'));
  else body.replaceChildren(...data.members.map(m => h('tr', { tabindex: '0', dataset: { open: m.id } },
    h('td', { class: 'zx-td-strong' }, `@${m.username}`, m.roles.some(r => r !== 'member') ? h('span', { class: 'zx-badge zx-badge--brand' }, ` ${m.roles.filter(r => r !== 'member').join(', ')}`) : null),
    h('td', { class: 'zx-td-mono' }, m.phone),
    h('td', {}, m.country),
    h('td', { class: 'zx-td-muted' }, ago(m.createdAt)),
    h('td', {}, m.phoneVerified ? 'Phone' : 'Not yet', m.emailVerified ? ', email' : ''),
    h('td', {}, h('span', { class: `zx-badge${m.status === 'active' ? ' zx-badge--success' : ' zx-badge--danger'}` }, m.status), m.openFlags ? h('span', { class: 'zx-badge zx-badge--warning' }, ` ${m.openFlags} flag(s)`) : null))));
  pager($('#pager'), data, page => {
    state.page = page;
    void load();
  });
}

async function openMember(id) {
  const view = sheet('Member', { onClose: () => history.replaceState(null, '', location.pathname) });
  history.replaceState(null, '', `?id=${id}`);
  const render = async () => {
    const [detail, money_] = await Promise.all([api.get(`/api/admin/members/${id}`), api.get(`/api/admin/payments/members/${id}`)]);
    const m = detail.member;
    const b = money_.balances;
    view.setTitle(`@${m.username}`);
    view.body.replaceChildren(
      panel('Account', kv([
        ['Status', `${m.status}${m.statusReason ? `: ${m.statusReason}` : ''}`],
        ['Phone', `${m.phone}${m.phoneVerified ? ' (verified)' : ' (not verified)'}`],
        ['Email', m.email],
        ['Country', `${m.country.name} · ${m.currency}`],
        ['Joined', when(m.createdAt)],
        ['Referred by', m.referrer ? `@${m.referrer.username}` : 'Nobody'],
        ['Account', b.membershipActive ? `Activated ${when(b.membershipActivatedAt)}` : 'Not activated'],
        m.withdrawalsLockedUntil ? ['Withdrawals locked until', when(m.withdrawalsLockedUntil)] : null,
      ])),
      panel('Balances', kv([
        ['Main balance', money(b.availableBalanceMinor, b.currency)],
        ...Object.entries(b.taskBalancesMinor).map(([k, v]) => [`${k} earnings`, money(v, b.currency)]),
        ['On hold for withdrawals', money(b.reservedBalanceMinor, b.currency)],
        ['Deposits waiting review', money(b.pendingDepositsMinor, b.currency)],
        ['Deposited, all time', money(b.totalDepositedMinor, b.currency)],
        ['Withdrawn, all time', money(b.totalWithdrawnMinor, b.currency)],
      ])),
      panel('Deposits', money_.deposits.length ? h('ul', { class: 'zx-feed' }, money_.deposits.map(d => h('li', {},
        h('div', { class: 'zx-feed__body' }, h('a', { class: 'zx-feed__title', href: `/admin/deposits.html?id=${d.id}` }, d.reference), h('span', { class: 'zx-feed__meta' }, `${d.channel.name} · ${d.providerTxnId} · ${ago(d.createdAt)}`)),
        h('span', { class: 'zx-feed__amount' }, money(d.creditedAmountMinor ?? d.claimedAmountMinor, d.currency)), statusBadge(d.status)))) : h('p', { class: 'zx-hint' }, 'No deposits.')),
      panel('Withdrawals', money_.withdrawals.length ? h('ul', { class: 'zx-feed' }, money_.withdrawals.map(w => h('li', {},
        h('div', { class: 'zx-feed__body' }, h('a', { class: 'zx-feed__title', href: `/admin/withdrawals.html?id=${w.id}` }, w.reference), h('span', { class: 'zx-feed__meta' }, `${w.channel.name} · ${ago(w.createdAt)}`)),
        h('span', { class: 'zx-feed__amount' }, money(w.amountMinor, w.currency)), statusBadge(w.status)))) : h('p', { class: 'zx-hint' }, 'No withdrawals.')),
      panel('Statement', money_.statement.length ? h('ul', { class: 'zx-feed' }, money_.statement.map(t => h('li', {},
        h('div', { class: 'zx-feed__body' }, h('span', { class: 'zx-feed__title' }, t.description), h('span', { class: 'zx-feed__meta' }, `${t.balance} · ${when(t.createdAt)}${t.reference ? ` · ${t.reference}` : ''}`)),
        h('span', { class: `zx-feed__amount ${t.amountMinor.startsWith('-') ? 'zx-amount--out' : 'zx-amount--in'}` }, money(t.amountMinor, t.currency))))) : h('p', { class: 'zx-hint' }, 'No ledger entries.')),
      detail.fraudFlags.length ? panel('Fraud flags', h('ul', { class: 'zx-warnlist' }, detail.fraudFlags.map(f => h('li', {}, `${f.kind} (${f.severity}, ${f.status})`)))) : null,
      detail.auditTrail.length ? panel('Staff actions', h('ul', { class: 'zx-feed' }, detail.auditTrail.map(a => h('li', {}, h('div', { class: 'zx-feed__body' }, h('span', { class: 'zx-feed__title' }, a.action), h('span', { class: 'zx-feed__meta' }, `${when(a.created_at)}${a.reason ? ` · ${a.reason}` : ''}`)))))) : null,
    );
    const canFreeze = me.roles.some(r => r === 'admin' || r === 'compliance') && me.id !== m.id;
    const frozen = m.status === 'frozen';
    const btn = h('button', { type: 'button', class: `zx-btn ${frozen ? 'zx-btn--success' : 'zx-btn--danger'}` }, frozen ? 'Unfreeze account' : 'Freeze account');
    btn.addEventListener('click', async () => {
      if (await askForm({
        title: frozen ? 'Unfreeze account' : 'Freeze account', text: frozen ? 'The member can deposit and withdraw again.' : 'The member cannot claim deposits or withdraw while frozen.',
        submitLabel: frozen ? 'Unfreeze' : 'Freeze', tone: frozen ? 'success' : 'danger',
        fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true, minLength: 5 }],
        submit: v => api.post(`/api/admin/members/${id}/${frozen ? 'unfreeze' : 'freeze'}`, { reason: v.reason }),
      })) await render();
    });
    const unlockButtons = me.roles.includes('admin') && me.id !== m.id
      ? ['password', 'email', 'phone'].map(kind => {
        const open = detail.unlocked?.[kind];
        const b = h('button', { type: 'button', class: 'zx-btn zx-btn--secondary' }, open ? `${kind} unlocked until ${when(open)}` : `Unlock ${kind} change`);
        b.addEventListener('click', async () => {
          if (await askForm({
            title: `Unlock ${kind} change`,
            text: 'Only after you have checked this is the real member. They can then make the change once in the next 24 hours.',
            submitLabel: 'Unlock for 24 hours',
            fields: [{ name: 'verification', label: 'How did you verify them?', type: 'textarea', required: true, minLength: 10 }],
            submit: v => api.post(`/api/admin/members/${id}/unlock`, { kind, verification: v.verification }),
          })) await render();
        });
        return b;
      })
      : [];
    view.setActions(canFreeze ? btn : null, ...unlockButtons);
  };
  try {
    await render();
  } catch (err) {
    view.body.replaceChildren(h('p', { class: 'zx-error' }, err.message));
  }
}

export async function init({ me: current }) {
  me = current;
  $('#search').addEventListener('input', debounce(e => {
    state.q = e.target.value.trim();
    state.page = 1;
    void load();
  }));
  on($('#rows'), 'click', 'tr[data-open]', (_e, tr) => void openMember(tr.dataset.open));
  on($('#rows'), 'keydown', 'tr[data-open]', (e, tr) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void openMember(tr.dataset.open);
    }
  });
  await load();
  const id = queryParam('id');
  if (id) await act(() => openMember(id));
}
