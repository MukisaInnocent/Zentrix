import { api } from '../core/api.js';
import { $, h } from '../core/dom.js';
import { formatDate } from '../core/format.js';
import { act, askForm, emptyRow } from '../admin/kit.js';
import { toast } from '../core/toast.js';

// Betting tips (owner, 2026-11-06): add, edit, settle, remove and restore the tips on the member Betting tips page.
// Support staff see the list; only admins change it. Every change is audited by the server.
const state = { removed: false };
const RESULTS = { pending: 'Not played yet', won: 'Won', lost: 'Lost', void: 'Void' };
const TONE = { pending: '', won: 'zx-badge--success', lost: 'zx-badge--danger', void: 'zx-badge--warning' };

// datetime-local wants "YYYY-MM-DDTHH:MM" in the browser's own time.
function localInput(value) {
  if (!value) return '';
  const d = new Date(value);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function tipFields(t = {}) {
  return [
    { name: 'homeTeam', label: 'Home team', required: true, maxLength: 80, value: t.homeTeam },
    { name: 'awayTeam', label: 'Away team', required: true, maxLength: 80, value: t.awayTeam },
    { name: 'league', label: 'League (optional)', maxLength: 80, value: t.league },
    { name: 'kickoffAt', label: 'Kick-off (your time)', type: 'datetime-local', required: true, value: localInput(t.kickoffAt) },
    { name: 'tip', label: 'Tip', required: true, maxLength: 80, value: t.tip, hint: 'For example Home win, Draw, Over 2.5 goals, Both teams to score.' },
    { name: 'odds', label: 'Odds (optional)', inputmode: 'decimal', maxLength: 8, value: t.odds ?? '', hint: 'For example 1.85.' },
    { name: 'note', label: 'Note (optional)', type: 'textarea', maxLength: 300, value: t.note },
    { name: 'result', label: 'Result', type: 'select', value: t.result ?? 'pending', options: Object.entries(RESULTS).map(([value, label]) => ({ value, label })) },
    { name: 'score', label: 'Final score (optional)', maxLength: 20, value: t.score, hint: 'For example 2-1.' },
    { name: 'published', label: 'Members see it', type: 'select', value: String(t.published ?? true), options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No, keep it hidden for now' }] },
  ];
}

const toBody = v => ({
  homeTeam: v.homeTeam, awayTeam: v.awayTeam, league: v.league ?? '', kickoffAt: new Date(v.kickoffAt).toISOString(), tip: v.tip,
  odds: v.odds ? v.odds : null, note: v.note ?? '', result: v.result, score: v.score ?? '', published: v.published === 'true',
});

async function addTip() {
  if (await askForm({ title: 'Add a tip', submitLabel: 'Add tip', fields: tipFields(), submit: v => api.post('/api/admin/tips', toBody(v)) })) {
    toast.success('Tip added.');
    await load();
  }
}

async function editTip(t) {
  if (await askForm({ title: `${t.homeTeam} v ${t.awayTeam}`, submitLabel: 'Save changes', fields: tipFields(t), submit: v => api.put(`/api/admin/tips/${t.id}`, toBody(v)) })) {
    toast.success('Tip saved.');
    await load();
  }
}

function button(label, onClick, tone = 'secondary') {
  const b = h('button', { type: 'button', class: `zx-btn zx-btn--${tone} zx-btn--sm` }, label);
  b.addEventListener('click', onClick);
  return b;
}

async function load() {
  const { tips } = await api.get(`/api/admin/tips${state.removed ? '?removed=1' : ''}`);
  $('#rows').replaceChildren(...(tips.length ? tips.map(t => h('tr', {},
    h('td', { class: 'zx-td-muted' }, formatDate(t.kickoffAt, { withTime: true })),
    h('td', { class: 'zx-td-strong' }, `${t.homeTeam} v ${t.awayTeam}`, t.league ? h('div', { class: 'zx-hint' }, t.league) : null, t.removedAt ? h('div', { class: 'zx-hint' }, 'Removed') : null),
    h('td', {}, t.tip),
    h('td', { class: 'zx-td-mono' }, t.odds ?? '-'),
    h('td', {}, h('span', { class: `zx-badge ${TONE[t.result]}` }, RESULTS[t.result]), t.score ? h('div', { class: 'zx-hint' }, t.score) : null),
    h('td', {}, t.published ? 'Yes' : 'Hidden'),
    h('td', {}, h('span', { class: 'zx-row-actions' }, t.removedAt
      ? [button('Restore', () => void act(async () => { await api.post(`/api/admin/tips/${t.id}/restore`, {}); await load(); }, 'Tip restored.'))]
      : [button('Edit', () => void editTip(t)), button('Remove', () => void act(async () => { await api.post(`/api/admin/tips/${t.id}/remove`, {}); await load(); }, 'Tip removed.'), 'ghost')]))))
    : [emptyRow(7, 'No tips yet. Members see an empty Betting tips page until you add one.')]));
}

export async function init() {
  $('#show-removed').addEventListener('change', e => {
    state.removed = e.target.checked;
    void act(load);
  });
  $('#add-btn').addEventListener('click', () => void addTip());
  await act(load);
}
