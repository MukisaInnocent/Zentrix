import { api } from '../core/api.js';
import { $, h, on } from '../core/dom.js';
import { act, ago, askForm, emptyRow, kv, live, panel, queryParam, segmented, sheet, when } from '../admin/kit.js';

// Reported member chats. Opening a report shows the conversation (the server audits each read); closing it
// records what was done.
const state = { status: 'open' };
let poll;

const KIND = { invite: 'Invite chat', foreign: 'Chat with foreigners' };
const badge = status => h('span', { class: `zx-badge ${status === 'open' ? 'zx-badge--warning' : 'zx-badge--success'}` }, status === 'open' ? 'Open' : 'Closed');

async function loadList() {
  const { reports } = await api.get(`/api/admin/chats/reports?status=${state.status}`);
  const body = $('#rows');
  if (!reports.length) body.replaceChildren(emptyRow(6, 'No reports here.'));
  else body.replaceChildren(...reports.map(r => h('tr', { tabindex: '0', dataset: { open: r.id } },
    h('td', { class: 'zx-td-muted' }, ago(r.createdAt)),
    h('td', { class: 'zx-td-strong' }, `@${r.reporter}`),
    h('td', {}, r.members.map(m => `@${m.username} (${m.country})`).join(' and ')),
    h('td', {}, KIND[r.kind] ?? r.kind),
    h('td', {}, r.reason),
    h('td', {}, badge(r.status)))));
}

async function openReport(id) {
  const view = sheet('Chat report', { onClose: () => history.replaceState(null, '', location.pathname) });
  history.replaceState(null, '', `?id=${id}`);
  const render = async () => {
    const { report: r, messages } = await api.get(`/api/admin/chats/reports/${id}`);
    view.body.replaceChildren(
      panel('Report', h('div', {}, badge(r.status)), kv([
        ['Reported by', `@${r.reporter}`],
        ['Chat between', r.members.map(m => `@${m.username} (${m.country})`).join(' and ')],
        ['Kind', KIND[r.kind] ?? r.kind],
        ['Reason', r.reason],
        ['Reported', when(r.createdAt)],
        r.closedAt ? ['Closed', `${when(r.closedAt)} by @${r.closedBy}`] : null,
        r.closingNote ? ['What was done', r.closingNote] : null,
      ])),
      panel('Conversation', messages.length
        ? h('div', { class: 'zx-thread' }, messages.map(m =>
          h('div', { class: `zx-msg${m.username === r.reporter ? ' zx-msg--staff' : ''}` }, h('span', { class: 'zx-msg__meta' }, `@${m.username} · ${when(m.createdAt)}`), m.body)))
        : h('p', { class: 'zx-hint' }, 'No messages in this chat.')),
    );
    const close = r.status === 'open' ? h('button', { type: 'button', class: 'zx-btn zx-btn--success' }, 'Close report') : null;
    close?.addEventListener('click', async () => {
      if (await askForm({
        title: 'Close report', text: 'Say what was done, for example a warning or a freeze.', submitLabel: 'Close report', tone: 'success',
        fields: [{ name: 'note', label: 'What was done', type: 'textarea', required: true, minLength: 3 }],
        submit: v => api.post(`/api/admin/chats/reports/${id}/close`, { note: v.note }),
      })) {
        await render();
        void poll.refresh();
      }
    });
    view.setActions(close);
  };
  try {
    await render();
  } catch (err) {
    view.body.replaceChildren(h('p', { class: 'zx-error' }, err.message));
  }
}

export async function init() {
  segmented($('#status-filter'), [{ value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }, { value: 'all', label: 'All' }], state.status, value => {
    state.status = value;
    void poll.refresh();
  });
  on($('#rows'), 'click', 'tr[data-open]', (_e, tr) => void openReport(tr.dataset.open));
  on($('#rows'), 'keydown', 'tr[data-open]', (e, tr) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void openReport(tr.dataset.open);
    }
  });
  poll = live(loadList, { ms: 15000, indicator: $('#live') });
  const id = queryParam('id');
  if (id) await act(() => openReport(id));
}
