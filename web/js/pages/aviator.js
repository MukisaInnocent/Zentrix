import { api, ApiError } from '../core/api.js';
import { $, h } from '../core/dom.js';
import { formatDate } from '../core/format.js';
import { toast } from '../core/toast.js';

// Aviator (owner, 2026-11-06), played with free game points. The server picks the crash point and decides every
// cash-out from its own clock; the browser only animates the climbing multiplier and asks the server whether the
// plane is still flying. The crash point is never known here until the round ends.
const POLL_MS = 400;
let rules = { minStake: 10, maxStake: 1000, growthPerSecond: 0.07 };
let round = null; // { id, startedLocal }
let frame = 0;
let poller = 0;

const x = x100 => `${(x100 / 100).toFixed(2)}x`;
const points = n => Number(n).toLocaleString();

function setPoints(n) {
  $('#points').textContent = points(n);
}

function setFlying(on) {
  $('#bet-btn').hidden = on;
  $('#cash-btn').hidden = !on;
  $('#stake').disabled = on;
  $('#sky').classList.toggle('zx-aviator__sky--flying', on);
}

function draw() {
  if (!round) return;
  const seconds = (performance.now() - round.startedLocal) / 1000;
  const m = Math.exp(rules.growthPerSecond * seconds);
  $('#multiplier').textContent = `${m.toFixed(2)}x`;
  const stake = Number(round.stake);
  $('#cash-btn').textContent = `Cash out ${points(Math.floor(stake * m))}`;
  // The plane climbs along a curve as the multiplier grows (CSS variables, 0 to 1).
  const progress = Math.min(1, seconds / 30);
  const sky = $('#sky');
  sky.style.setProperty('--zx-av-x', String(progress));
  sky.style.setProperty('--zx-av-y', String(Math.min(1, Math.log(m) / Math.log(10))));
  frame = requestAnimationFrame(draw);
}

function stop() {
  cancelAnimationFrame(frame);
  clearInterval(poller);
  round = null;
  setFlying(false);
}

function finish(r, pts) {
  stop();
  setPoints(pts);
  const sky = $('#sky');
  if (r.status === 'cashed') {
    $('#multiplier').textContent = x(r.cashoutX100);
    $('#sky-note').textContent = `You cashed out at ${x(r.cashoutX100)} and won ${points(r.payout)} points. The plane flew away at ${x(r.crashX100)}.`;
    sky.classList.add('zx-aviator__sky--won');
  } else {
    $('#multiplier').textContent = x(r.crashX100);
    $('#sky-note').textContent = `Flew away at ${x(r.crashX100)}. You lost ${points(r.stake)} points.`;
    sky.classList.add('zx-aviator__sky--crashed');
  }
  void loadHistory();
}

function fly(r) {
  const sky = $('#sky');
  sky.classList.remove('zx-aviator__sky--won', 'zx-aviator__sky--crashed');
  round = { id: r.id, stake: r.stake, startedLocal: performance.now() - (r.elapsedMs ?? 0) };
  $('#sky-note').textContent = 'Flying...';
  setFlying(true);
  frame = requestAnimationFrame(draw);
  poller = setInterval(async () => {
    if (!round) return;
    try {
      const { round: now } = await api.get(`/api/aviator/rounds/${round.id}`);
      if (now.status !== 'flying') {
        const state = await api.get('/api/aviator');
        finish(now, state.points);
      }
    } catch {
      // Try again on the next tick.
    }
  }, POLL_MS);
}

async function loadHistory() {
  const state = await api.get('/api/aviator');
  setPoints(state.points);
  $('#history').replaceChildren(...(state.history.length ? state.history.map(r => h('tr', {},
    h('td', { class: 'zx-td-muted' }, formatDate(r.startedAt, { withTime: true })),
    h('td', { class: 'zx-td-mono' }, points(r.stake)),
    h('td', { class: 'zx-td-mono' }, x(r.crashX100)),
    h('td', { class: 'zx-td-mono' }, r.cashoutX100 ? x(r.cashoutX100) : '-'),
    h('td', { class: `zx-amount ${r.status === 'cashed' ? 'zx-amount--in' : 'zx-amount--out'}` }, r.status === 'cashed' ? `+${points(r.payout)}` : `-${points(r.stake)}`)))
    : [h('tr', {}, h('td', { colspan: '5', class: 'zx-td-empty' }, 'No rounds yet.'))]));
  return state;
}

export async function init() {
  const state = await loadHistory();
  rules = state.rules;
  $('#daily-points').textContent = points(rules.dailyPoints);
  if (state.current) fly(state.current);

  const stakeInput = $('#stake');
  document.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => {
    const next = Math.min(rules.maxStake, Math.max(rules.minStake, (Number(stakeInput.value) || 0) + Number(b.dataset.step)));
    stakeInput.value = String(next);
  }));

  $('#stake-form').addEventListener('submit', async e => {
    e.preventDefault();
    $('#stake-error').textContent = '';
    const btn = $('#bet-btn');
    btn.disabled = true;
    try {
      const res = await api.post('/api/aviator/rounds', { stake: Number(stakeInput.value) });
      setPoints(res.points);
      fly(res.round);
    } catch (err) {
      $('#stake-error').textContent = err instanceof ApiError ? err.message : 'Could not start. Try again.';
    } finally {
      btn.disabled = false;
    }
  });

  $('#cash-btn').addEventListener('click', async () => {
    if (!round) return;
    const id = round.id;
    $('#cash-btn').disabled = true;
    try {
      const res = await api.post(`/api/aviator/rounds/${id}/cashout`, {});
      finish(res.round, res.points);
      if (res.round.status === 'cashed') toast.success(`Cashed out at ${x(res.round.cashoutX100)}: +${points(res.round.payout)} points.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not cash out.');
    } finally {
      $('#cash-btn').disabled = false;
    }
  });
}
