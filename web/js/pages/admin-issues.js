import { api } from '../core/api.js';
import { $, h, on, setBusy } from '../core/dom.js';
import { act, ago, askForm, debounce, emptyRow, kv, live, pager, panel, queryParam, segmented, sheet, statusBadge, when } from '../admin/kit.js';

// Member-reported payment problems. Staff read the thread, check the linked deposit or withdrawal, reply, and
// resolve with a note of what was done. A member writing again reopens a resolved report.
const state = { status: 'unresolved', q: '', page: 1 };
let poll;

const CATEGORY = { not_credited: 'Paid, not credited', wrong_amount: 'Wrong amount', not_received: 'Payout not received', delayed: 'Taking too long', other: 'Other' };

async function loadList() {
  const params = new URLSearchParams({ page: String(state.page) });
  if (state.status) params.set('status', state.status);
  if (state.q) params.set('q', state.q);
  const data = await api.get(`/api/admin/payments/issues?${params}`);
  const body = $('#rows');
  if (!data.issues.length) body.replaceChildren(emptyRow(6, 'No reports here.'));
  else body.replaceChildren(...data.issues.map(i => h('tr', { tabindex: '0', dataset: { open: i.id } },
    h('td', { class: 'zx-td-muted' }, ago(i.updatedAt)),
    h('td', { class: 'zx-td-strong' }, `@${i.member}`),
    h('td', { class: 'zx-td-mono' }, i.subject?.reference ?? 'General'),
    h('td', {}, CATEGORY[i.category] ?? i.category, i.awaitingStaff ? h('span', { class: 'zx-badge zx-badge--warning' }, ' Needs reply') : null),
    h('td', {}, i.assignedTo ? `@${i.assignedTo}` : 'Nobody yet'),
    h('td', {}, statusBadge(i.status)))));
  pager($('#pager'), data, page => {
    state.page = page;
    void poll.refresh();
  });
}

async function openIssue(id) {
  const view = sheet('Payment issue', { onClose: () => history.replaceState(null, '', location.pathname) });
  history.replaceState(null, '', `?id=${id}`);
  const render = async () => {
    const { issue: i, messages, member: m } = await api.get(`/api/admin/payments/issues/${id}`);
    view.setTitle(CATEGORY[i.category] ?? 'Payment issue');
    const page = i.subject?.type === 'deposit' ? 'deposits' : 'withdrawals';
    const reply = h('textarea', { class: 'zx-textarea', id: 'issue-reply', maxlength: '2000', 'aria-label': 'Reply to the member' });
    const send = h('button', { type: 'button', class: 'zx-btn' }, 'Send reply');
    send.addEventListener('click', async () => {
      if (!reply.value.trim()) return reply.focus();
      setBusy(send, true);
      if (await act(() => api.post(`/api/admin/payments/issues/${id}/messages`, { body: reply.value.trim() }), 'Reply sent')) await render();
      setBusy(send, false);
    });
    view.body.replaceChildren(
      panel('Report', h('div', {}, statusBadge(i.status)), kv([
        ['Member', `@${m.username} (${m.status})`],
        ['Phone', m.phone ?? ''],
        ['Payment', i.subject ? h('a', { href: `/admin/${page}.html?id=${i.subject.id}` }, `${i.subject.type} ${i.subject.reference}`) : 'Not linked to a payment'],
        ['Opened', when(i.createdAt)],
        ['Handled by', i.assignedTo ? `@${i.assignedTo}` : 'Nobody yet'],
        i.resolution ? ['Resolution', i.resolution] : null,
      ])),
      panel('Conversation', h('div', { class: 'zx-thread' }, messages.map(msg =>
        h('div', { class: `zx-msg${msg.fromStaff ? ' zx-msg--staff' : ''}` }, h('span', { class: 'zx-msg__meta' }, `${msg.fromStaff ? `@${msg.author} (staff)` : `@${msg.author}`} · ${when(msg.createdAt)}`), msg.body)))),
      panel('Reply', reply, h('span', { class: 'zx-hint' }, 'The member sees replies as "Zentrix support".'), send),
    );
    const resolve = h('button', { type: 'button', class: 'zx-btn zx-btn--success' }, i.status === 'resolved' ? 'Reopen' : 'Resolve');
    resolve.addEventListener('click', async () => {
      if (i.status === 'resolved') {
        if (await act(() => api.post(`/api/admin/payments/issues/${id}/status`, { status: 'open' }), 'Reopened')) await render();
        return;
      }
      if (await askForm({
        title: 'Resolve report', text: 'Say what was done. The member sees this.', submitLabel: 'Resolve', tone: 'success',
        fields: [{ name: 'resolution', label: 'Resolution', type: 'textarea', required: true, minLength: 5 }],
        submit: v => api.post(`/api/admin/payments/issues/${id}/status`, { status: 'resolved', resolution: v.resolution }),
      })) await render();
    });
    const take = i.status === 'open' ? h('button', { type: 'button', class: 'zx-btn zx-btn--secondary' }, 'I am handling this') : null;
    take?.addEventListener('click', async () => {
      if (await act(() => api.post(`/api/admin/payments/issues/${id}/status`, { status: 'in_progress' }), 'Assigned to you')) await render();
    });
    view.setActions(take, resolve);
    void poll.refresh();
  };
  try {
    await render();
  } catch (err) {
    view.body.replaceChildren(h('p', { class: 'zx-error' }, err.message));
  }
}

export async function init() {
  segmented($('#status-filter'), [
    { value: 'unresolved', label: 'Not resolved' }, { value: 'open', label: 'New' }, { value: 'in_progress', label: 'In progress' },
    { value: 'resolved', label: 'Resolved' }, { value: '', label: 'All' },
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
  on($('#rows'), 'click', 'tr[data-open]', (_e, tr) => void openIssue(tr.dataset.open));
  on($('#rows'), 'keydown', 'tr[data-open]', (e, tr) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void openIssue(tr.dataset.open);
    }
  });
  poll = live(loadList, { ms: 10000, indicator: $('#live') });
  const id = queryParam('id');
  if (id) await act(() => openIssue(id));
}
