import { api, ApiError } from '../core/api.js';
import { $, h } from '../core/dom.js';
import { act, emptyRow, when } from '../admin/kit.js';

// Test-mode outbox: messages the site would have emailed or texted when no delivery service is configured.
async function load() {
  try {
    const { messages } = await api.get('/api/admin/outbox');
    $('#rows').replaceChildren(...(messages.length ? messages.map(m => h('tr', {},
      h('td', { class: 'zx-td-muted' }, when(m.created_at)),
      h('td', {}, m.channel),
      h('td', {}, m.recipient),
      h('td', { class: 'zx-td-strong' }, m.subject ?? ''),
      h('td', {}, h('details', {}, h('summary', {}, 'Show'), h('pre', { class: 'zx-outbox-body' }, m.body)))))
      : [emptyRow(5, 'Nothing sent yet.')]));
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return $('#rows').replaceChildren(emptyRow(5, 'The outbox exists only in test mode.'));
    throw err;
  }
}

export async function init() {
  await act(load);
}
