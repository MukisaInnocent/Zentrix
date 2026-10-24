import { api } from './api.js';
import { askForm } from './dialogs.js';
import { formatDate } from './format.js';
import { h } from './dom.js';
import { toast } from './toast.js';

// Member-side pieces shared by the deposit and withdraw pages.
const STATUS = {
  pending: ['warning', 'Waiting review'], confirmed: ['success', 'Credited'], rejected: ['danger', 'Not found'], cancelled: ['', 'Cancelled'],
  requested: ['warning', 'Requested'], approved: ['brand', 'Approved'], processing: ['brand', 'Being sent'], paid: ['success', 'Paid'], failed: ['danger', 'Failed'],
};

export function paymentBadge(status) {
  const [tone, label] = STATUS[status] ?? ['', status];
  return h('span', { class: `zx-badge${tone ? ` zx-badge--${tone}` : ''}` }, label);
}

const CATEGORIES = {
  deposit: [{ value: 'not_credited', label: 'I paid but it is not credited' }, { value: 'wrong_amount', label: 'The amount credited is wrong' }, { value: 'delayed', label: 'It is taking too long' }, { value: 'other', label: 'Something else' }],
  withdrawal: [{ value: 'not_received', label: 'Marked paid but I did not receive it' }, { value: 'wrong_amount', label: 'I received the wrong amount' }, { value: 'delayed', label: 'It is taking too long' }, { value: 'other', label: 'Something else' }],
};

export async function reportProblem(subjectType, reference) {
  const done = await askForm({
    title: `Report a problem with ${reference}`,
    text: 'Our payments team reads every report. Follow the answer under Payment reports on this page.',
    submitLabel: 'Send report',
    fields: [
      { name: 'category', label: 'What is wrong?', type: 'select', options: CATEGORIES[subjectType] },
      { name: 'message', label: 'Details', type: 'textarea', required: true, minLength: 10, maxLength: 2000 },
    ],
    submit: v => api.post('/api/payments/issues', { subjectType, reference, category: v.category, message: v.message }),
  });
  if (done) {
    toast.success('Report sent. Our team will reply soon.');
    document.dispatchEvent(new CustomEvent('zx:reports-changed'));
  }
}

const ISSUE_STATUS = { open: ['warning', 'Sent'], in_progress: ['brand', 'Being handled'], resolved: ['success', 'Resolved'] };

async function openThread(id, rerender) {
  const { issue, messages } = await api.get(`/api/payments/issues/${id}`);
  const thread = h('div', { class: 'zx-thread' }, messages.map(m =>
    h('div', { class: `zx-msg${m.fromStaff ? ' zx-msg--staff' : ''}` }, h('span', { class: 'zx-msg__meta' }, `${m.author} · ${formatDate(m.createdAt, { withTime: true })}`), m.body)));
  const reply = await askForm({
    title: issue.subject ? `Report on ${issue.subject.reference}` : 'Report',
    text: issue.status === 'resolved' ? 'This report is resolved. Writing again reopens it.' : undefined,
    submitLabel: 'Send message',
    fields: [{ name: 'body', label: 'Your message', type: 'textarea', required: true, maxLength: 2000 }],
    before: thread,
    submit: v => api.post(`/api/payments/issues/${id}/messages`, { body: v.body }),
  });
  if (reply) {
    toast.success('Message sent');
    await rerender();
  }
}

// Lists the member's payment reports with their status; each opens the conversation.
export function mountReports(container) {
  const render = async () => {
    const { issues } = await api.get('/api/payments/issues');
    if (!issues.length) return container.replaceChildren(h('p', { class: 'zx-hint' }, 'No reports. If something is wrong with a payment, use Report a problem next to it.'));
    container.replaceChildren(h('ul', { class: 'zx-feed' }, issues.map(i => {
      const [tone, label] = ISSUE_STATUS[i.status] ?? ['', i.status];
      const open = h('button', { type: 'button', class: 'zx-btn zx-btn--ghost zx-btn--sm' }, 'View');
      open.addEventListener('click', () => void openThread(i.id, render).catch(err => toast.error(err.message)));
      return h('li', {},
        h('div', { class: 'zx-feed__body' }, h('span', { class: 'zx-feed__title' }, i.subject ? i.subject.reference : 'General'),
          h('span', { class: 'zx-feed__meta' }, `${i.summary ?? ''} · ${formatDate(i.updatedAt, { withTime: true })}`)),
        h('span', { class: `zx-badge${tone ? ` zx-badge--${tone}` : ''}` }, label), open);
    })));
  };
  document.addEventListener('zx:reports-changed', () => void render());
  return render();
}
