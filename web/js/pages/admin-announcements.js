import { ApiError, api } from '../core/api.js';
import { $, h, on } from '../core/dom.js';
import { clearErrors, showErrors } from '../core/forms.js';
import { toast } from '../core/toast.js';
import { act, ago, askForm, debounce, emptyRow, when } from '../admin/kit.js';

// Announcements: an admin writes an email and sends it to members. The server fixes the recipients, sends what fits
// in today's email allowance and the daily job sends the rest. The preview is drawn here; the test email is real.
const AUDIENCE = { all: 'All members', activated: 'Activated members', not_activated: 'Not activated' };
const STATUS = { sending: ['warning', 'Sending'], done: ['success', 'Done'], cancelled: ['', 'Cancelled'] };
let countries = [];
let isAdmin = false;
let me = null;

const form = () => $('#compose');

function message() {
  const f = form().elements;
  const v = name => f.namedItem(name).value.trim();
  return {
    subject: v('subject'), heading: v('heading'), body: v('body'),
    ...(v('buttonLabel') ? { buttonLabel: v('buttonLabel') } : {}),
    ...(v('buttonUrl') ? { buttonUrl: v('buttonUrl') } : {}),
    audience: v('audience'), country: v('country') || null,
  };
}

// The same layout as the real email: brand bar, heading, paragraphs (a blank line starts one), button.
export function mailPreview({ subject, heading, paragraphs, buttonLabel, note }) {
  return h('div', { class: 'zx-mail-preview' },
    h('div', { class: 'zx-mail-preview__bar' }, 'Pexerearn'),
    h('div', { class: 'zx-mail-preview__subject' }, 'Subject: ', subject || '(no subject yet)'),
    h('div', { class: 'zx-mail-preview__body' },
      h('h3', {}, heading || '(no heading yet)'),
      ...(paragraphs.length ? paragraphs.map(p => h('p', {}, p)) : [h('p', { class: 'zx-hint' }, '(no message yet)')]),
      buttonLabel ? h('span', { class: 'zx-mail-preview__button' }, buttonLabel) : null,
      note ? h('p', { class: 'zx-mail-preview__note' }, note) : null));
}

function drawPreview() {
  const m = message();
  $('#preview').replaceChildren(mailPreview({
    subject: m.subject, heading: m.heading, paragraphs: m.body.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean),
    buttonLabel: m.buttonUrl ? m.buttonLabel : null,
  }));
}

let reach = 0;
async function updateReach() {
  const m = message();
  const params = new URLSearchParams({ audience: m.audience, ...(m.country ? { country: m.country } : {}) });
  ({ members: reach } = await api.get(`/api/admin/announcements/audience?${params}`));
  $('#reach').textContent = `${reach.toLocaleString()} member${reach === 1 ? '' : 's'} match. Members who turned announcements off are skipped when it is sent.`;
  $('#send').textContent = `Send to ${reach.toLocaleString()} member${reach === 1 ? '' : 's'}`;
  $('#send').disabled = reach === 0;
}

function kpi(label, value, tone) {
  return h('div', { class: `zx-kpi${tone ? ` zx-kpi--${tone}` : ''}` }, h('span', { class: 'zx-kpi__label' }, label), h('span', { class: 'zx-kpi__value' }, String(value)));
}

async function load() {
  const { announcements, budget } = await api.get('/api/admin/announcements');
  const a = budget.allowance;
  $('#budget').replaceChildren(
    kpi('Emails sent today', `${budget.usedToday} of ${a.daily}`),
    kpi('Kept for members', a.reserved),
    kpi('Announcements left today', budget.budget, budget.budget === 0 ? 'attention' : ''),
    kpi('This month', `${budget.usedThisMonth} of ${a.monthly}`),
  );
  $('#rows').replaceChildren(...(announcements.length ? announcements.map(x => {
    const [tone, label] = STATUS[x.status] ?? ['', x.status];
    const country = countries.find(c => c.code === x.country)?.name;
    return h('tr', {},
      h('td', { class: 'zx-td-muted', title: when(x.createdAt) }, ago(x.createdAt), h('div', { class: 'zx-hint' }, `by @${x.createdBy}`)),
      h('td', { class: 'zx-td-strong' }, x.subject),
      h('td', {}, AUDIENCE[x.audience] ?? x.audience, country ? h('div', { class: 'zx-hint' }, country) : null),
      h('td', {}, `${x.sent} of ${x.recipients} sent`,
        h('div', { class: 'zx-hint' }, [x.delivered ? `${x.delivered} delivered` : null, x.waiting ? `${x.waiting} waiting for the next days` : null, x.skipped ? `${x.skipped} skipped` : null, x.bounced ? `${x.bounced} bounced` : null].filter(Boolean).join(' · '))),
      h('td', {}, h('span', { class: `zx-badge${tone ? ` zx-badge--${tone}` : ''}` }, label)),
      h('td', {}, isAdmin && x.status === 'sending' ? h('button', { type: 'button', class: 'zx-btn zx-btn--secondary zx-btn--sm', dataset: { cancel: x.id } }, 'Stop') : null));
  }) : [emptyRow(6, 'No announcements yet.')]));
}

function showServerErrors(err) {
  if (err instanceof ApiError && err.fields) showErrors(form(), err.fields);
  toast.error(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
}

async function sendTest() {
  clearErrors(form());
  const result = await askForm({
    title: 'Send me a test', text: 'Sends this announcement to one address only, exactly as members will see it.',
    submitLabel: 'Send test', fields: [{ name: 'to', label: 'Send to', type: 'email', required: true, value: me?.email ?? '' }],
    submit: v => api.post('/api/admin/announcements/test', { to: v.to, message: message() }),
  });
  if (result) toast.success(result.outcome === 'sent' || result.outcome === 'queued' ? 'Test sent. Check the inbox (and spam).' : `Not sent: ${result.outcome}.`);
}

async function send(e) {
  e.preventDefault();
  clearErrors(form());
  const m = message();
  const ok = await askForm({
    title: 'Send this announcement?', submitLabel: `Send to ${reach.toLocaleString()}`,
    text: `"${m.subject}" goes to ${reach.toLocaleString()} member${reach === 1 ? '' : 's'} (${AUDIENCE[m.audience]}${m.country ? `, ${countries.find(c => c.code === m.country)?.name ?? m.country}` : ''}). What does not fit in today's email allowance goes out on the next days. This cannot be undone, but you can stop the rest later.`,
    submit: () => api.post('/api/admin/announcements', m),
  }).catch(err => {
    showServerErrors(err);
    return null;
  });
  if (!ok) return;
  const later = ok.recipients - ok.sentNow;
  toast.success(later > 0 ? `${ok.sentNow} sent now; the rest go out over the next days within the email allowance.` : `Sent to ${ok.sentNow} members.`);
  form().reset();
  drawPreview();
  await act(() => Promise.all([load(), updateReach()]));
}

export async function init(ctx) {
  me = ctx.me;
  isAdmin = me.roles.includes('admin');
  ({ countries } = await api.get('/api/reference/countries'));
  $('#country').append(...countries.map(c => h('option', { value: c.code }, c.name)));
  if (!isAdmin) form().hidden = true;
  form().addEventListener('input', drawPreview);
  const reachSoon = debounce(() => void act(updateReach));
  $('#audience').addEventListener('change', reachSoon);
  $('#country').addEventListener('change', reachSoon);
  $('#test').addEventListener('click', () => void sendTest().catch(showServerErrors));
  form().addEventListener('submit', e => void send(e));
  on($('#rows'), 'click', 'button[data-cancel]', async (_e, button) => {
    if (await askForm({
      title: 'Stop this announcement?', text: 'Members who have not received it yet will not get it. Emails already sent stay sent.', submitLabel: 'Stop sending', tone: 'danger',
      submit: () => api.post(`/api/admin/announcements/${button.dataset.cancel}/cancel`, {}),
    })) {
      toast.success('Stopped.');
      await act(load);
    }
  });
  drawPreview();
  await act(() => Promise.all([load(), isAdmin ? updateReach() : null]));
}
