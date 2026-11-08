import { api } from '../core/api.js';
import { $, $$, h } from '../core/dom.js';
import { act, ago, askForm, debounce, emptyRow, kv, panel, sheet, when } from '../admin/kit.js';

// Aviator: the owner's Aviator project admin dashboard (2026-11-06, later), in the staff console. Tabs: overview, live round,
// rounds, players, credit transactions, review flags, game settings and the Aviator audit trail. The project's own
// users, passwords, roles and 2FA are left out: the site's staff accounts and Members page cover those. Admins change
// settings and credits; finance and support look. The server audits every change.
let me = null;
const isAdmin = () => Boolean(me?.roles.includes('admin'));
const credits = n => Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = n => (n === null || n === undefined ? '-' : `${(n * 100).toFixed(2)}%`);
const x = n => (n === null || n === undefined ? '-' : `${Number(n).toFixed(2)}x`);
const signed = n => `${n > 0 ? '+' : ''}${credits(n)}`;
const tone = n => (n > 0 ? 'zx-text-success' : n < 0 ? 'zx-text-danger' : '');
const TX = { deposit: 'Credits added', withdrawal: 'Credits removed', adjustment: 'Staff change' };
const BADGE = { pending: 'zx-badge--warning', approved: 'zx-badge--success', completed: 'zx-badge--success', rejected: 'zx-badge--danger', win: 'zx-badge--success', loss: 'zx-badge--danger', waiting: 'zx-badge--brand', active: 'zx-badge--warning', crashed: '' };
const badge = s => h('span', { class: `zx-badge ${BADGE[s] ?? ''}` }, s);
const kpi = (label, value, note, kind = '') => h('div', { class: `zx-kpi${kind ? ` zx-kpi--${kind}` : ''}` },
  h('span', { class: 'zx-kpi__label' }, label), h('span', { class: 'zx-kpi__value' }, String(value)), note ? h('span', { class: 'zx-kpi__note' }, note) : null);
const td = (text, cls) => h('td', cls ? { class: cls } : {}, text);
const fill = (id, list, cols, empty) => $(id).replaceChildren(...(list.length ? list : [emptyRow(cols, empty)]));

function button(label, onClick, kind = 'secondary') {
  const b = h('button', { type: 'button', class: `zx-btn zx-btn--${kind} zx-btn--sm` }, label);
  b.addEventListener('click', onClick);
  return b;
}
const memberLink = (userId, username) => h('a', { href: `/admin/members?id=${encodeURIComponent(userId)}` }, username);
const playerButton = (userId, username) => button(username, () => void openPlayer(userId), 'ghost');

// ----- Overview -----
async function loadOverview() {
  const r = await api.get(`/api/admin/aviator/reports?days=${$('#ov-days').value}`);
  const t = r.totals;
  const rtpGap = t.rtp === null ? '' : t.rtp > t.target_rtp ? 'attention' : 'good';
  $('#ov-kpis').replaceChildren(
    kpi('Staked', credits(t.staked), `${t.bets} bets by ${t.players} players`),
    kpi('Paid out', credits(t.paid), `${t.wins} winning bets`),
    kpi('House profit', credits(t.house_profit), 'Staked less paid out', t.house_profit < 0 ? 'danger' : ''),
    kpi('Return to players', pct(t.rtp), `Target ${pct(t.target_rtp)}`, rtpGap),
    kpi('Rounds', t.rounds, 'Finished in the period'),
    kpi('Credits added', credits(t.deposits), `Removed ${credits(t.withdrawals)}`),
  );
  fill('#ov-daily', r.daily.map(d => h('tr', {}, td(d.date), td(d.bets), td(d.players), td(credits(d.staked), 'zx-td-mono'), td(credits(d.paid), 'zx-td-mono'),
    td(credits(d.house_profit), `zx-td-mono ${tone(d.house_profit)}`), td(pct(d.rtp)))), 7, 'No bets in this period.');
  fill('#ov-wins', r.biggest_wins.map(b => h('tr', {}, td(b.username, 'zx-td-strong'), td(credits(b.amount), 'zx-td-mono'), td(x(b.multiplier)),
    td(signed(b.profit), 'zx-td-mono zx-text-success'), td(ago(b.date), 'zx-td-muted'))), 5, 'No wins in this period.');
  const row = (p, label) => h('tr', {}, h('td', {}, playerButton(p.userId, p.username), ' ', h('span', { class: 'zx-hint' }, label)), td(p.bets), td(signed(p.net), `zx-td-mono ${tone(p.net)}`));
  const winners = r.top_winners.filter(p => p.net > 0);
  const losers = r.top_losers.filter(p => p.net < 0);
  fill('#ov-players', [...winners.map(p => row(p, 'winner')), ...losers.map(p => row(p, 'loser'))], 3, 'No settled bets in this period.');
}

// ----- Live round -----
async function loadLive() {
  const r = await api.get('/api/admin/aviator/live');
  if (!r.round) {
    $('#live-kpis').replaceChildren(kpi('Round', '-', r.paused ? 'The game is paused' : 'No round yet'));
    fill('#live-bets', [], 5, 'No bets yet.');
    return;
  }
  const g = r.round;
  const now = g.status === 'waiting' ? `Starts in ${g.starts_in}s` : g.status === 'active' ? `In flight at ${x(g.multiplier)}` : `Flew away at ${x(g.crash_point)}`;
  $('#live-kpis').replaceChildren(
    kpi('Round', `#${g.id}`, r.paused ? 'Game paused: no new round after this one' : now, r.paused ? 'attention' : ''),
    kpi('Status', g.status, now),
    kpi('Bets', g.bets, `${r.players_in_flight} still in flight`),
    kpi('Staked', credits(g.staked), `Paid out ${credits(g.paid)}`),
  );
  fill('#live-bets', r.bets.map(b => h('tr', {}, td(b.username, 'zx-td-strong'), td(credits(b.amount), 'zx-td-mono'), h('td', {}, badge(b.result)), td(x(b.multiplier)), td(credits(b.payout), 'zx-td-mono'))),
    5, 'No bets in this round yet.');
}

// ----- Rounds -----
async function openRound(id) {
  const s = sheet(`Round #${id}`);
  await act(async () => {
    const r = await api.get(`/api/admin/aviator/rounds/${id}`);
    const f = r.fairness;
    const check = (ok) => h('span', { class: `zx-badge ${ok ? 'zx-badge--success' : 'zx-badge--danger'}` }, ok ? 'matches' : 'does not match');
    s.body.replaceChildren(
      panel('Round', kv([
        ['Status', r.round.status], ['Started', when(r.round.start_time)], ['Crash point', x(r.round.crash_point)],
        ['Bets', `${r.round.bets} (${r.round.wins} won)`], ['Staked', credits(r.round.staked)], ['Paid out', credits(r.round.paid)],
        ['House profit', r.round.house_profit === null ? '-' : credits(r.round.house_profit)], ['House edge', r.round.house_edge_percent === null ? '-' : `${r.round.house_edge_percent}%`],
      ])),
      panel('Fairness check', f.verifiable
        ? kv([['Published hash', h('span', { class: 'zx-mono' }, f.hash)], ['Hash check', check(f.hash_matches)], ['Server seed', h('span', { class: 'zx-mono' }, f.server_seed)],
          ['Crash point from the seed', x(f.computed_crash_point)], ['Crash point check', check(f.crash_matches)], ['Formula', h('span', { class: 'zx-hint' }, f.formula)]])
        : h('p', { class: 'zx-hint' }, f.reason)),
      panel('Bets', r.bets.length
        ? h('div', { class: 'zx-table-wrap' }, h('table', { class: 'zx-table' },
          h('thead', {}, h('tr', {}, ...['Member', 'Bet', 'Result', 'Cashed out at', 'Payout'].map(c => h('th', { scope: 'col' }, c)))),
          h('tbody', {}, ...r.bets.map(b => h('tr', {}, td(b.username, 'zx-td-strong'), td(credits(b.amount), 'zx-td-mono'), h('td', {}, badge(b.result)), td(x(b.multiplier)), td(credits(b.payout), 'zx-td-mono'))))))
        : h('p', { class: 'zx-hint' }, 'No bets in this round.')),
    );
  });
}

async function loadRounds() {
  const { rounds } = await api.get('/api/admin/aviator/rounds?limit=100');
  fill('#rounds-rows', rounds.map(r => h('tr', {}, td(`#${r.id}`, 'zx-td-strong'), td(when(r.start_time), 'zx-td-muted'), h('td', {}, badge(r.status)), td(x(r.crash_point)),
    td(r.bets), td(credits(r.staked), 'zx-td-mono'), td(credits(r.paid), 'zx-td-mono'),
    td(r.house_profit === null ? '-' : credits(r.house_profit), `zx-td-mono ${tone(r.house_profit ?? 0)}`), h('td', {}, button('Details', () => void openRound(r.id))))),
  9, 'No rounds yet.');
}

// ----- Players -----
async function adjust(userId, username, balance, s) {
  const values = await askForm({
    title: `Change ${username}'s demo credits`,
    text: `They have ${credits(balance)} credits now. Demo credits have no cash value.`,
    fields: [
      { name: 'mode', label: 'Change', type: 'select', options: [{ value: 'add', label: 'Add' }, { value: 'subtract', label: 'Subtract' }, { value: 'set', label: 'Set to' }] },
      { name: 'amount', label: 'Credits', inputmode: 'decimal', required: true },
      { name: 'reason', label: 'Reason (kept in the audit log)', required: true, minLength: 3, maxLength: 200 },
    ],
    submitLabel: 'Save',
    submit: v => api.post(`/api/admin/aviator/players/${userId}/balance`, v),
  });
  if (values) {
    s.close();
    await openPlayer(userId);
    void loadPlayers();
  }
}

async function openPlayer(userId) {
  const s = sheet('Player');
  await act(async () => {
    const d = await api.get(`/api/admin/aviator/players/${userId}`);
    s.setTitle(d.user.username);
    const st = d.stats;
    s.body.replaceChildren(
      panel('Player', kv([
        ['Member', memberLink(d.user.id, d.user.username)], ['Account', d.user.status], ['Demo credits', credits(d.user.balance)],
        ['Bets', `${st.bets} (${st.wins} won)`], ['Staked', credits(st.staked)], ['Paid out', credits(st.paid)],
        ['Net', h('span', { class: tone(st.net) }, signed(st.net))], ['Return', pct(st.rtp)], ['Best cash-out', x(st.best_multiplier)],
      ])),
      panel('Recent bets', d.bets.length
        ? h('div', { class: 'zx-table-wrap' }, h('table', { class: 'zx-table' },
          h('thead', {}, h('tr', {}, ...['Round', 'Bet', 'Result', 'At', 'Payout', 'When'].map(c => h('th', { scope: 'col' }, c)))),
          h('tbody', {}, ...d.bets.map(b => h('tr', {}, td(`#${b.round_id}`), td(credits(b.amount), 'zx-td-mono'), h('td', {}, badge(b.result)),
            td(b.result === 'win' ? x(b.multiplier) : '-'), td(credits(b.payout), 'zx-td-mono'), td(ago(b.date), 'zx-td-muted'))))))
        : h('p', { class: 'zx-hint' }, 'No bets yet.')),
      panel('Credit activity', d.transactions.length
        ? h('div', { class: 'zx-table-wrap' }, h('table', { class: 'zx-table' },
          h('thead', {}, h('tr', {}, ...['Type', 'Credits', 'Before', 'After', 'Reason', 'Status', 'When'].map(c => h('th', { scope: 'col' }, c)))),
          h('tbody', {}, ...d.transactions.map(t => h('tr', {}, td(TX[t.type] ?? t.type), td(credits(t.amount), 'zx-td-mono'),
            td(t.before === null ? '-' : credits(t.before), 'zx-td-mono'), td(t.after === null ? '-' : credits(t.after), 'zx-td-mono'),
            td([t.reason, t.staff && `by ${t.staff}`].filter(Boolean).join(' ') || '-'), h('td', {}, badge(t.status)), td(ago(t.date), 'zx-td-muted'))))))
        : h('p', { class: 'zx-hint' }, 'No credit activity yet.')),
    );
    if (isAdmin()) s.setActions(button('Change credits', () => void adjust(userId, d.user.username, d.user.balance, s), 'secondary'));
  });
}

async function loadPlayers() {
  const q = $('#players-q').value.trim();
  const { players } = await api.get(`/api/admin/aviator/players${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  fill('#players-rows', players.map(p => h('tr', {}, td(p.username, 'zx-td-strong'), td(p.status), td(credits(p.balance), 'zx-td-mono'), td(p.bets),
    td(credits(p.staked), 'zx-td-mono'), td(credits(p.paid), 'zx-td-mono'), td(signed(p.net), `zx-td-mono ${tone(p.net)}`),
    td(p.lastBet ? ago(p.lastBet) : '-', 'zx-td-muted'), h('td', {}, button('Open', () => void openPlayer(p.userId))))),
  9, q ? 'No players match.' : 'No players yet.');
}

// ----- Transactions -----
async function decide(r, action) {
  await act(async () => {
    await api.post(`/api/admin/aviator/requests/${r.id}/process`, { action });
    await loadTransactions();
  }, `Request ${action === 'approve' ? 'approved' : 'rejected'}.`);
}

async function loadTransactions() {
  const { requests } = await api.get('/api/admin/aviator/transactions');
  const canDecide = me?.roles.some(role => role === 'admin' || role === 'finance');
  fill('#tx-rows', requests.map(r => h('tr', {}, td(when(r.createdAt), 'zx-td-muted'), h('td', {}, playerButton(r.userId, r.username)), td(TX[r.kind] ?? r.kind),
    td(credits(r.amount), 'zx-td-mono'), td(r.reason || '-'), td(credits(r.balance), 'zx-td-mono'), h('td', {}, badge(r.status)),
    h('td', {}, r.status === 'pending' && canDecide
      ? h('span', { class: 'zx-row-actions' }, button('Approve', () => void decide(r, 'approve')), button('Reject', () => void decide(r, 'reject'), 'ghost'))
      : '-'))),
  8, 'No credit activity yet.');
}

// ----- Flags -----
async function loadFlags() {
  const f = await api.get('/api/admin/aviator/flags');
  $('#flags-rule').textContent = `High returns: ${f.rules.high_rtp}`;
  fill('#flags-rows', f.high_rtp.map(p => h('tr', {}, td(p.username, 'zx-td-strong'), td(p.bets), td(credits(p.staked), 'zx-td-mono'), td(credits(p.paid), 'zx-td-mono'),
    td(`${p.rtp.toFixed(2)}x`), h('td', {}, button('Open', () => void openPlayer(p.userId))))), 6, 'Nothing to review.');
}

// ----- Settings -----
async function loadSettings() {
  const s = await api.get('/api/admin/aviator/settings');
  const form = $('#settings-form');
  for (const [name, value] of Object.entries(s)) {
    const input = form.elements.namedItem(name);
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = typeof value === 'number' && ['min_bet', 'max_bet', 'max_win'].includes(name) ? value.toFixed(2) : value;
  }
  $('#s-updated').textContent = `Last changed ${when(s.updated_at)}.`;
  for (const el of form.elements) el.disabled = !isAdmin();
}

function bindSettings() {
  const form = $('#settings-form');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const v = name => form.elements.namedItem(name).value.trim();
    const body = {
      betting_seconds: Number(v('betting_seconds')), crash_display_seconds: Number(v('crash_display_seconds')), growth_rate: Number(v('growth_rate')),
      house_edge_percent: Number(v('house_edge_percent')), min_bet: v('min_bet'), max_bet: v('max_bet'), max_win: v('max_win'),
      paused: form.elements.namedItem('paused').checked, pause_message: v('pause_message'),
    };
    const error = form.querySelector('[data-form-error]');
    error.hidden = true;
    const ok = await act(async () => {
      try {
        const r = await api.put('/api/admin/aviator/settings', body);
        await loadSettings();
        return r;
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        throw err;
      }
    }, 'Settings saved.');
    if (ok) void loadLive();
  });
}

// ----- Audit -----
const ACTIONS = { 'aviator.balance_adjust': 'Credits changed', 'aviator.settings_update': 'Settings changed', 'aviator.export': 'Exported', 'aviator.request_approved': 'Request approved', 'aviator.request_rejected': 'Request rejected' };
function details(a) {
  if (!a.details || typeof a.details !== 'object') return '-';
  return Object.entries(a.details).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ');
}
async function loadAudit() {
  const { entries } = await api.get('/api/admin/aviator/audit');
  fill('#audit-rows', entries.map(a => h('tr', {}, td(when(a.date), 'zx-td-muted'), td(a.staff || '-'), td(ACTIONS[a.action] ?? a.action), td(details(a)), td(a.reason || '-'), td(a.ip || '-', 'zx-td-mono'))),
    6, 'No Aviator changes yet.');
}

const LOADERS = { overview: loadOverview, live: loadLive, rounds: loadRounds, players: loadPlayers, transactions: loadTransactions, flags: loadFlags, settings: loadSettings, audit: loadAudit };
let current = 'overview';

function show(tab) {
  current = tab;
  for (const b of $$('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const p of $$('[data-panel]')) p.hidden = p.dataset.panel !== tab;
  void act(LOADERS[tab]);
}

export async function init({ me: staff }) {
  me = staff;
  if (!isAdmin()) for (const el of $$('[data-admin-only]')) el.hidden = true;
  for (const b of $$('[data-tab]')) b.addEventListener('click', () => show(b.dataset.tab));
  $('#ov-days').addEventListener('change', () => void act(loadOverview));
  $('#players-q').addEventListener('input', debounce(() => void act(loadPlayers), 300));
  bindSettings();
  // The live round refreshes every second while its tab is open and the page is visible (as in the project).
  setInterval(() => {
    if (current === 'live' && document.visibilityState === 'visible') void loadLive().catch(() => {});
  }, 1000);
  show('overview');
}
