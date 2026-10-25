import { api } from './api.js';
import { askForm } from './dialogs.js';
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
    text: 'Our payments team reads every report and replies to your email.',
    submitLabel: 'Send report',
    fields: [
      { name: 'category', label: 'What is wrong?', type: 'select', options: CATEGORIES[subjectType] },
      { name: 'message', label: 'Details', type: 'textarea', required: true, minLength: 10, maxLength: 2000 },
    ],
    submit: v => api.post('/api/payments/issues', { subjectType, reference, category: v.category, message: v.message }),
  });
  if (done) toast.success('Report sent. Our team will reply by email.');
}
