import { api } from '../core/api.js';
import { $, h } from '../core/dom.js';
import { formatMoney } from '../core/format.js';

// Referrals by level, shown as tables. Every level has an overview (that level's figures only) and lists of its
// active and inactive usernames. A username is Active once its activation fee is confirmed.
const VIEWS = {
  overview: { status: null, title: 'Overview' },
  active: { status: 'active', title: 'Active Usernames', empty: 'No active usernames at this level yet.' },
  inactive: { status: 'inactive', title: 'Inactive Usernames', empty: 'No inactive usernames at this level.' },
};
const LEADS = {
  1: 'Usernames that joined with your username.',
  2: 'Usernames invited by your level 1 usernames.',
  3: 'Usernames invited by your level 2 usernames.',
};

export async function init() {
  const params = new URLSearchParams(location.search);
  const level = [1, 2, 3].includes(Number(params.get('level'))) ? Number(params.get('level')) : 1;
  const view = VIEWS[params.get('view')] ? params.get('view') : 'overview';
  const query = `?level=${level}&view=${view}`;
  if (`?${params}` !== query) history.replaceState(null, '', `${location.pathname}${query}`);

  const config = VIEWS[view];
  $('#ref-title').textContent = `Level ${level} · ${config.title}`;
  $('#ref-lead').textContent = LEADS[level];
  $('#stats-card').hidden = view !== 'overview';
  $('#list-card').hidden = view === 'overview';

  if (view === 'overview') {
    const overview = await api.get('/api/referrals');
    const c = overview.levels[level];
    $('#stats-title').textContent = `Level ${level} overview`;
    $('#stats-body').replaceChildren(h('tr', {},
      h('td', { class: 'zx-td-strong' }, `Level ${level}`),
      h('td', {}, String(c.total)),
      h('td', {}, String(c.active)),
      h('td', {}, String(c.inactive)),
      h('td', { class: 'zx-amount' }, formatMoney(c.rewardsMinor, overview.currency))));
    return;
  }

  $('#table-title').textContent = `Level ${level} ${config.title.toLowerCase()}`;
  // Active (paid the activation fee) and Inactive (not yet) are two separate lists, one tab each.
  for (const tab of ['active', 'inactive']) {
    const link = $(`#tab-${tab}`);
    link.href = `${location.pathname}?level=${level}&view=${tab}`;
    if (tab === view) link.setAttribute('aria-current', 'page');
  }
  const input = $('#ref-q');
  input.value = params.get('q') ?? '';
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => void loadList(level, config, input.value.trim()), 300);
  });
  $('#ref-search').addEventListener('submit', e => {
    e.preventDefault();
    clearTimeout(timer);
    void loadList(level, config, input.value.trim());
  });
  await loadList(level, config, input.value.trim());
}

// The server searches the whole level (not only the rows on screen). A reply that arrives after a newer search
// started is dropped.
let latest = 0;
async function loadList(level, config, q) {
  const call = ++latest;
  const search = q ? `&q=${encodeURIComponent(q)}` : '';
  const data = await api.get(`/api/referrals/members?level=${level}&status=${config.status}${search}`);
  if (call !== latest) return;
  $('#count-active').textContent = String(data.counts.active);
  $('#count-inactive').textContent = String(data.counts.inactive);
  const body = $('#ref-body');
  if (!data.members.length) {
    body.replaceChildren(h('tr', {}, h('td', { colspan: '2', class: 'zx-td-empty' }, q ? `No username at this level contains "${q}".` : config.empty)));
    return;
  }
  // Username and phone number only (owner, 2026-11-03).
  body.replaceChildren(...data.members.map(m => h('tr', {},
    h('td', { class: 'zx-td-strong' }, m.username),
    h('td', { class: 'zx-td-mono' }, m.phone ?? '-'))));
}
