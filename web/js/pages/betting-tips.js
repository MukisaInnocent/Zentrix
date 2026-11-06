import { api, ApiError } from '../core/api.js';
import { $, h } from '../core/dom.js';
import { formatDate } from '../core/format.js';

// Betting tips (owner, 2026-11-06): the tips an admin posts in the staff console, upcoming first, then results.
// Tips only: nothing is staked on the site. All text goes in as DOM text.
const RESULT = { won: ['Won', 'zx-badge--success'], lost: ['Lost', 'zx-badge--danger'], void: ['Void', 'zx-badge--warning'] };

const match = t => h('td', { class: 'zx-td-strong' }, `${t.homeTeam} v ${t.awayTeam}`, t.league ? h('div', { class: 'zx-hint' }, t.league) : null);
const tipCell = t => h('td', {}, t.tip, t.note ? h('div', { class: 'zx-hint' }, t.note) : null);
const empty = (cols, text) => h('tr', {}, h('td', { colspan: String(cols), class: 'zx-td-empty' }, text));

export async function init() {
  try {
    const { tips } = await api.get('/api/tips');
    const upcoming = tips.filter(t => t.result === 'pending');
    const done = tips.filter(t => t.result !== 'pending');
    $('#upcoming').replaceChildren(...(upcoming.length ? upcoming.map(t => h('tr', {},
      h('td', { class: 'zx-td-muted' }, formatDate(t.kickoffAt, { withTime: true })), match(t), tipCell(t), h('td', { class: 'zx-td-mono' }, t.odds ?? '-')))
      : [empty(4, 'No tips right now. Check back soon.')]));
    $('#results').replaceChildren(...(done.length ? done.map(t => h('tr', {},
      h('td', { class: 'zx-td-muted' }, formatDate(t.kickoffAt)), match(t), tipCell(t), h('td', { class: 'zx-td-mono' }, t.score || '-'),
      h('td', {}, h('span', { class: `zx-badge ${RESULT[t.result][1]}` }, RESULT[t.result][0]))))
      : [empty(5, 'No results yet.')]));
  } catch (err) {
    $('#upcoming').replaceChildren(empty(4, err instanceof ApiError ? err.message : 'Could not load the tips. Reload the page.'));
  }
}
