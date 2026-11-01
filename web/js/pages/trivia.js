import { api, ApiError, newIdempotencyKey } from '../core/api.js';
import { $, h } from '../core/dom.js';
import { formatMoney } from '../core/format.js';
import { toast } from '../core/toast.js';

// Trivia questions come from the server with their real reward (owner, 2026-11-01: no fixed amounts on the page).
// The page is built with DOM nodes, never HTML strings, so question text cannot inject markup. A question without
// answer options is shown as unavailable rather than with made-up options.

function question(task, index, total, onAnswer) {
  const reward = formatMoney(task.rewardMinor, task.currency);
  const options = Array.isArray(task.details?.options) ? task.details.options.map(String) : [];
  const badge = task.completed
    ? h('span', { class: 'zx-badge zx-badge--success' }, `Completed (+${reward})`)
    : h('span', { class: 'zx-badge zx-badge--brand' }, `Reward: +${reward}`);
  const buttons = options.map(option => {
    const btn = h('button', { type: 'button', class: 'zx-btn zx-btn--secondary zx-btn--option', disabled: task.completed }, option);
    btn.addEventListener('click', () => onAnswer(task, option, btn));
    return btn;
  });
  return h('div', { class: 'zx-quiz' },
    h('div', { class: 'zx-tile__head' }, h('span', { class: 'zx-quiz__count' }, `Question ${index + 1} of ${total}`), badge),
    h('h3', {}, task.description),
    options.length ? h('div', { class: 'zx-quiz__options' }, ...buttons) : h('p', { class: 'zx-hint' }, 'This question is not available right now.'));
}

export async function init() {
  async function answer(task, option, btn) {
    btn.setAttribute('aria-busy', 'true');
    try {
      const res = await api.post(`/api/tasks/${task.id}/complete`, { answer: option }, { idempotencyKey: newIdempotencyKey() });
      toast.success(`Correct answer! ${formatMoney(res.rewardMinor ?? task.rewardMinor, task.currency)} added to your trivia earnings.`);
      await refresh();
    } catch (err) {
      btn.removeAttribute('aria-busy');
      toast.error(err instanceof ApiError ? err.message : 'Incorrect answer. Try the next question!');
    }
  }

  async function refresh() {
    try {
      const [summary, tasksData, subsData] = await Promise.all([
        api.get('/api/wallet/summary'), api.get('/api/tasks?module=trivia'), api.get('/api/tasks/submissions?module=trivia'),
      ]);
      $('#trivia-earnings').textContent = formatMoney(summary.taskBalancesMinor.trivia, summary.currency);
      $('#trivia-completed-count').textContent = String((subsData.submissions ?? []).length);
      const tasks = tasksData.tasks ?? [];
      $('#trivia-container').replaceChildren(...(tasks.length
        ? tasks.map((t, i) => question(t, i, tasks.length, answer))
        : [h('p', { class: 'zx-empty' }, 'No trivia questions available right now.')]));
    } catch (err) {
      console.error('Failed to load trivia challenges', err);
    }
  }

  await refresh();
}
