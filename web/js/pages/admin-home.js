import { api } from '../core/api.js';
import { $, h, icon } from '../core/dom.js';
import { act, ago, askForm, live, money, severityBadge, statusBadge } from '../admin/kit.js';

// Live overview: queues that need people, today's money in and out, the balance check per currency,
// system alerts and pause banners. Refreshes every 5 seconds while the tab is visible.
const seen = new Set();
let firstLoad = true;

function kpi({ label, value, note, href, tone }) {
  const tag = href ? 'a' : 'div';
  return h(tag, { class: `zx-kpi${tone ? ` zx-kpi--${tone}` : ''}`, href },
    h('span', { class: 'zx-kpi__label' }, label), h('span', { class: 'zx-kpi__value' }, value), note ? h('span', { class: 'zx-kpi__note' }, note) : null);
}

function renderKpis(c) {
  const n = key => Number(c[key] ?? 0);
  $('#kpis').replaceChildren(
    kpi({ label: 'Deposits to check', value: String(n('deposits_pending')), note: `${money(c.deposits_pending_ugx, 'UGX')} claimed`, href: '/admin/deposits.html', tone: n('deposits_pending') ? 'attention' : 'good' }),
    kpi({ label: 'Withdrawals to approve', value: String(n('withdrawals_requested')), note: n('withdrawals_need_admin') ? `${n('withdrawals_need_admin')} need an admin` : 'None need an admin', href: '/admin/withdrawals.html?status=requested', tone: n('withdrawals_requested') ? 'attention' : 'good' }),
    kpi({ label: 'Payouts to send', value: String(n('withdrawals_approved') + n('withdrawals_processing')), note: `${n('withdrawals_processing')} being sent · ${money(c.withdrawals_open_ugx, 'UGX')} open`, href: '/admin/withdrawals.html?status=open', tone: n('withdrawals_approved') + n('withdrawals_processing') ? 'attention' : 'good' }),
    kpi({ label: 'Member issues', value: String(n('issues_open')), note: 'Open or in progress', href: '/admin/issues.html', tone: n('issues_open') ? 'attention' : 'good' }),
    kpi({ label: 'Chat reports', value: String(n('chat_reports_open')), note: 'Reported chats to review', href: '/admin/chats.html', tone: n('chat_reports_open') ? 'attention' : 'good' }),
    kpi({ label: 'Confirmed today', value: money(c.deposits_confirmed_today_ugx, 'UGX'), note: `${n('deposits_confirmed_today')} deposits · ${n('deposits_rejected_today')} rejected` }),
    kpi({ label: 'Paid out today', value: money(c.withdrawals_paid_today_ugx, 'UGX'), note: `${n('withdrawals_paid_today')} withdrawals · ${n('memberships_today')} new activations` }),
  );
}

function renderBanners(data) {
  const banners = [];
  for (const f of data.flags) {
    banners.push(h('div', { class: 'zx-banner zx-banner--danger', role: 'alert' }, icon('alert'),
      h('span', { class: 'zx-banner__text' }, `${f.key === 'withdrawals_paused' ? 'Withdrawals' : 'Deposits'} are paused for ${f.currency_code}. ${f.reason ?? ''}`),
      h('a', { class: 'zx-btn zx-btn--sm zx-btn--secondary', href: '/admin/balances.html' }, 'Review')));
  }
  if (Number(data.counts.treasury_pending)) {
    banners.push(h('div', { class: 'zx-banner zx-banner--warning' }, icon('clock'),
      h('span', { class: 'zx-banner__text' }, `${data.counts.treasury_pending} treasury request(s) wait for a second admin.`),
      h('a', { class: 'zx-btn zx-btn--sm zx-btn--secondary', href: '/admin/balances.html#treasury' }, 'Open')));
  }
  if (!data.lastReconciliation) {
    banners.push(h('div', { class: 'zx-banner zx-banner--warning' }, icon('info'), h('span', { class: 'zx-banner__text' }, 'No balance check has run yet. The worker runs one every 5 minutes.')));
  }
  $('#banners').replaceChildren(...banners);
}

const VERB = {
  'deposit:pending': 'claimed a deposit', 'deposit:confirmed': 'deposit confirmed', 'deposit:rejected': 'deposit rejected', 'deposit:cancelled': 'deposit cancelled',
  'withdrawal:requested': 'requested a withdrawal', 'withdrawal:approved': 'withdrawal approved', 'withdrawal:processing': 'payout started',
  'withdrawal:paid': 'withdrawal paid', 'withdrawal:failed': 'payout failed', 'withdrawal:cancelled': 'withdrawal cancelled',
};

function renderFeed(events) {
  const list = $('#feed');
  if (!events.length) return list.replaceChildren(h('li', {}, h('span', { class: 'zx-hint' }, 'No payment activity yet.')));
  list.replaceChildren(...events.map(e => {
    const fresh = !firstLoad && !seen.has(e.id);
    seen.add(e.id);
    const page = e.type === 'deposit' ? 'deposits' : 'withdrawals';
    return h('li', { class: fresh ? 'zx-is-new' : undefined },
      h('span', { class: `zx-feed__icon${e.type === 'withdrawal' ? ' zx-feed__icon--out' : ''}`, 'aria-hidden': 'true' }, icon(e.type === 'deposit' ? 'deposit' : 'withdraw')),
      h('div', { class: 'zx-feed__body' },
        h('a', { class: 'zx-feed__title', href: `/admin/${page}.html?id=${e.subjectId}` }, `@${e.member} ${VERB[`${e.type}:${e.to}`] ?? e.to}`),
        h('span', { class: 'zx-feed__meta' }, [e.reference, e.actor && e.actor !== e.member ? `by @${e.actor}` : null, ago(e.at)].filter(Boolean).join(' · '))),
      h('span', { class: 'zx-feed__amount' }, money(e.amountMinor, e.currency)), statusBadge(e.to));
  }));
  firstLoad = false;
}

function renderBalances(rows) {
  if (!rows.length) return $('#balances').replaceChildren(h('p', { class: 'zx-hint' }, 'No money recorded yet.'));
  $('#balances').replaceChildren(...rows.map(b => {
    const pct = b.owedPercent;
    const step = Math.min(100, Math.round(pct / 5) * 5);
    return h('div', { class: 'zx-equation' },
      h('div', { class: 'zx-equation__row' }, h('span', {}, h('strong', {}, b.currency), ' ', b.ok ? h('span', { class: 'zx-badge zx-badge--success' }, 'Covered') : h('span', { class: 'zx-badge zx-badge--danger' }, 'Not covered')), h('span', {}, `${pct}% of funds owed`)),
      h('div', { class: `zx-meter${b.ok ? '' : ' zx-meter--danger'}`, role: 'img', 'aria-label': `Members are owed ${pct}% of funds held` }, h('span', { class: `zx-meter__fill zx-w-${step}` })),
      h('div', { class: 'zx-equation__row' }, h('span', {}, 'Members are owed'), h('span', {}, money(b.liabilitiesMinor, b.currency))),
      h('div', { class: 'zx-equation__row' }, h('span', {}, `Held on channels${b.unverifiedChannels ? ` (${b.unverifiedChannels} without a statement)` : ''}`), h('span', {}, money(b.fundsHeldMinor, b.currency))),
      h('div', { class: 'zx-equation__row' }, h('span', {}, 'Platform revenue and fees'), h('span', {}, money(b.revenueAndFeesMinor, b.currency))),
      h('div', { class: 'zx-equation__row' }, h('span', {}, 'Cover'), h('span', {}, money(b.coverageMinor, b.currency))));
  }));
}

function renderAlerts(alerts, refresh) {
  if (!alerts.length) return $('#alerts').replaceChildren(h('p', { class: 'zx-hint' }, 'No open alerts. Everything checks out.'));
  $('#alerts').replaceChildren(h('ul', { class: 'zx-feed' }, alerts.map(a => {
    const ack = a.status === 'open' ? h('button', { type: 'button', class: 'zx-btn zx-btn--ghost zx-btn--sm' }, 'Acknowledge') : null;
    ack?.addEventListener('click', async () => {
      if (await act(() => api.post(`/api/admin/payments/alerts/${a.id}/acknowledge`, {}), 'Alert acknowledged')) await refresh();
    });
    const resolve = h('button', { type: 'button', class: 'zx-btn zx-btn--ghost zx-btn--sm' }, 'Resolve');
    resolve.addEventListener('click', async () => {
      const done = await askForm({
        title: 'Resolve alert', text: a.message, submitLabel: 'Resolve',
        fields: [{ name: 'note', label: 'What was done', type: 'textarea', required: true, minLength: 5 }],
        submit: v => api.post(`/api/admin/payments/alerts/${a.id}/resolve`, { note: v.note }),
      });
      if (done) await refresh();
    });
    return h('li', {},
      h('span', { class: `zx-feed__icon${a.severity === 'critical' ? ' zx-feed__icon--out' : ''}`, 'aria-hidden': 'true' }, icon(a.severity === 'critical' ? 'alert' : 'info')),
      h('div', { class: 'zx-feed__body' }, h('span', { class: 'zx-feed__title' }, a.message),
        h('span', { class: 'zx-feed__meta' }, [a.currency_code, `${a.occurrences} time(s)`, `last ${ago(a.last_seen_at)}`].filter(Boolean).join(' · ')),
        h('span', { class: 'zx-row-actions' }, ack, resolve)),
      severityBadge(a.severity));
  })));
}

export async function init() {
  let poll = null;
  const load = async () => {
    const data = await api.get('/api/admin/payments/overview');
    renderKpis(data.counts);
    renderBanners(data);
    renderFeed(data.events);
    renderBalances(data.balances);
    renderAlerts(data.alerts, () => poll.refresh());
  };
  poll = live(load, { ms: 5000, indicator: $('#live') });
}
