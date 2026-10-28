import { api } from '../core/api.js';
import { $, h, on } from '../core/dom.js';
import { toast } from '../core/toast.js';
import { act, ago, askForm, debounce, emptyRow, when } from '../admin/kit.js';

// The email log: every email the site sent, and what Resend reported (delivered, bounced, marked as spam).
// Blocked addresses get no email until an admin removes them.
const LABEL = {
  queued: ['', 'Waiting'],
  sent: ['brand', 'Sent'],
  delayed: ['warning', 'Delayed'],
  delivered: ['success', 'Delivered'],
  bounced: ['danger', 'Bounced'],
  complained: ['danger', 'Marked as spam'],
  failed: ['danger', 'Failed'],
  suppressed: ['warning', 'Blocked address'],
  skipped: ['', 'Test address'],
};
const badge = status => {
  const [tone, label] = LABEL[status] ?? ['', status];
  return h('span', { class: `zx-badge${tone ? ` zx-badge--${tone}` : ''}` }, label);
};
const state = { q: '', status: '' };
let isAdmin = false;

function kpi(label, value, tone) {
  return h('div', { class: `zx-kpi${tone ? ` zx-kpi--${tone}` : ''}` }, h('span', { class: 'zx-kpi__label' }, label), h('span', { class: 'zx-kpi__value' }, String(value)));
}

async function loadMessages() {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.status) params.set('status', state.status);
  const { messages, last7Days: s } = await api.get(`/api/admin/emails?${params}`);
  const problems = (s.bounced ?? 0) + (s.complained ?? 0) + (s.failed ?? 0);
  $('#summary').replaceChildren(
    kpi('Sent, 7 days', Object.entries(s).filter(([k]) => k !== 'skipped').reduce((n, [, v]) => n + v, 0)),
    kpi('Delivered', s.delivered ?? 0),
    kpi('Waiting', (s.queued ?? 0) + (s.sent ?? 0) + (s.delayed ?? 0)),
    kpi('Bounced or spam', problems, problems ? 'attention' : ''),
    kpi('Blocked address', s.suppressed ?? 0),
    kpi('Test addresses', s.skipped ?? 0),
  );
  $('#rows').replaceChildren(...(messages.length ? messages.map(m => h('tr', {},
    h('td', { class: 'zx-td-muted', title: when(m.created_at) }, ago(m.created_at)),
    h('td', {}, h('div', {}, m.recipient), m.username ? h('div', { class: 'zx-hint' }, `@${m.username}`) : null),
    h('td', { class: 'zx-td-strong' }, m.subject),
    h('td', { class: 'zx-td-mono' }, m.kind),
    h('td', {}, badge(m.status), m.detail ? h('div', { class: 'zx-hint' }, m.detail) : null)))
    : [emptyRow(5, 'No emails match.')]));
}

async function loadBlocked() {
  const { suppressions } = await api.get('/api/admin/emails/suppressions');
  $('#blocked').replaceChildren(...(suppressions.length ? suppressions.map(s => h('tr', {},
    h('td', { class: 'zx-td-strong' }, s.email),
    h('td', {}, s.reason === 'complained' ? 'Marked an email as spam' : 'Bounced', s.detail ? h('div', { class: 'zx-hint' }, s.detail) : null),
    h('td', { class: 'zx-td-muted' }, when(s.created_at)),
    h('td', {}, isAdmin ? h('button', { type: 'button', class: 'zx-btn zx-btn--secondary zx-btn--sm', dataset: { unblock: s.email } }, 'Remove') : null)))
    : [emptyRow(4, 'No blocked addresses.')]));
}

export async function init({ me }) {
  isAdmin = me.roles.includes('admin');
  if (!isAdmin) $('#send-test').remove();
  else {
    $('#send-test').addEventListener('click', async () => {
      const result = await askForm({
        title: 'Send a test email', text: 'Sends a short branded email from info@pexerearn.com, to check that delivery works.',
        submitLabel: 'Send', fields: [{ name: 'to', label: 'Send to', type: 'email', required: true }],
        submit: v => api.post('/api/admin/emails/test', { to: v.to }),
      });
      if (result) {
        toast.success(result.outcome === 'queued' || result.outcome === 'sent' ? 'Test email sent. Its status appears below.' : `Not sent: ${LABEL[result.outcome]?.[1] ?? result.outcome}.`);
        await loadMessages();
      }
    });
  }
  $('#search').addEventListener('input', debounce(e => {
    state.q = e.target.value.trim();
    void act(loadMessages);
  }));
  $('#status').addEventListener('change', e => {
    state.status = e.target.value;
    void act(loadMessages);
  });
  on($('#blocked'), 'click', 'button[data-unblock]', async (_e, button) => {
    const email = button.dataset.unblock;
    if (await askForm({
      title: 'Remove from blocked list', text: `${email} will get email again. Do this only after the member fixed the address or asked for email again.`,
      submitLabel: 'Remove', fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true, minLength: 3 }],
      submit: v => api.post('/api/admin/emails/suppressions/remove', { email, reason: v.reason }),
    })) {
      toast.success('Removed. The address gets email again.');
      await loadBlocked();
    }
  });
  await act(() => Promise.all([loadMessages(), loadBlocked()]));
}
