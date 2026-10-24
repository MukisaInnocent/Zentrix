import { api } from '../core/api.js';
import { $, h, on } from '../core/dom.js';
import { ago, debounce, emptyRow, kv, panel, sheet, when } from '../admin/kit.js';

// The append-only audit log: who did what, before and after, from which IP and when.
const state = { action: '', before: null, history: [] };
let entries = [];

async function load() {
  const params = new URLSearchParams();
  if (state.action) params.set('action', state.action);
  if (state.before) params.set('before', String(state.before));
  const data = await api.get(`/api/admin/audit-log?${params}`);
  entries = data.entries;
  const body = $('#rows');
  if (!entries.length) body.replaceChildren(emptyRow(5, 'No entries.'));
  else body.replaceChildren(...entries.map(e => h('tr', { tabindex: '0', dataset: { open: e.id } },
    h('td', { class: 'zx-td-muted', title: when(e.created_at) }, ago(e.created_at)),
    h('td', { class: 'zx-td-strong' }, e.actor ? `@${e.actor}` : 'system'),
    h('td', { class: 'zx-td-mono' }, e.action),
    h('td', { class: 'zx-td-mono' }, [e.target_type, e.target_id].filter(Boolean).join(' ')),
    h('td', {}, e.reason ?? ''))));
  const prev = h('button', { type: 'button', class: 'zx-btn zx-btn--secondary zx-btn--sm', disabled: state.history.length === 0 }, 'Newer');
  const next = h('button', { type: 'button', class: 'zx-btn zx-btn--secondary zx-btn--sm', disabled: entries.length < 50 }, 'Older');
  prev.addEventListener('click', () => {
    state.before = state.history.pop() ?? null;
    void load();
  });
  next.addEventListener('click', () => {
    state.history.push(state.before);
    state.before = Number(entries.at(-1).id);
    void load();
  });
  $('#pager').replaceChildren(prev, next);
}

const json = value => h('pre', { class: 'zx-mono zx-hint' }, value === null || value === undefined ? 'none' : JSON.stringify(value, null, 2));

function openEntry(id) {
  const e = entries.find(x => String(x.id) === String(id));
  if (!e) return;
  const view = sheet(e.action);
  view.body.replaceChildren(
    panel('Entry', kv([['When', when(e.created_at)], ['Staff', e.actor ? `@${e.actor}` : 'system'], ['Roles', (e.actor_roles ?? []).join(', ')], ['Target', [e.target_type, e.target_id].filter(Boolean).join(' ')], ['Reason', e.reason ?? ''], ['IP', e.ip ?? ''], ['Request', e.request_id ?? '']])),
    panel('Before', json(e.before)),
    panel('After', json(e.after)),
  );
}

export async function init() {
  $('#search').addEventListener('input', debounce(e => {
    state.action = e.target.value.trim();
    state.before = null;
    state.history = [];
    void load();
  }));
  on($('#rows'), 'click', 'tr[data-open]', (_e, tr) => openEntry(tr.dataset.open));
  on($('#rows'), 'keydown', 'tr[data-open]', (e, tr) => {
    if (e.key === 'Enter') openEntry(tr.dataset.open);
  });
  await load();
}
