import { api, ApiError } from '../core/api.js';
import { $ } from '../core/dom.js';
import { formatMoney } from '../core/format.js';
import { toast } from '../core/toast.js';

export async function init() {
  async function refresh() {
    try {
      const summary = await api.get('/api/wallet/summary');
      if ($('#trivia-earnings')) $('#trivia-earnings').textContent = formatMoney(summary.taskBalancesMinor.trivia, summary.currency);

      const tasksData = await api.get('/api/tasks?module=trivia');
      const tasks = tasksData.tasks || [];

      const subsData = await api.get('/api/tasks/submissions?module=trivia');
      const submissions = subsData.submissions || [];

      if ($('#trivia-completed-count')) $('#trivia-completed-count').textContent = String(submissions.length);

      const container = $('#trivia-container');
      if (container) {
        if (tasks.length === 0) {
          container.innerHTML = `<p class="zx-empty">No trivia questions available right now.</p>`;
        } else {
          container.innerHTML = tasks
            .map((t, idx) => {
              const options = (t.details && t.details.options) ? t.details.options : ['Option A', 'Option B', 'Option C', 'Option D'];

              const statusBadge = t.completed
                ? `<span class="zx-badge zx-badge--success">Completed (+UGX ${Number(t.rewardMinor).toLocaleString()})</span>`
                : `<span class="zx-badge zx-badge--brand">Reward: +UGX ${Number(t.rewardMinor).toLocaleString()}</span>`;

              const optionsHtml = options
                .map(
                  opt => `
                    <button class="zx-btn zx-btn--secondary opt-btn zx-btn--option" data-id="${t.id}" data-answer="${opt}" ${t.completed ? 'disabled' : ''}>
                      ${opt}
                    </button>
                  `,
                )
                .join('');

              return `
                <div class="zx-quiz">
                  <div class="zx-tile__head">
                    <span class="zx-quiz__count">Question ${idx + 1} of ${tasks.length}</span>
                    ${statusBadge}
                  </div>
                  <h3>${t.description}</h3>
                  <div class="zx-quiz__options">
                    ${optionsHtml}
                  </div>
                </div>
              `;
            })
            .join('');

          // Wire up trivia option clicks
          container.querySelectorAll('.opt-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
              const taskId = btn.getAttribute('data-id');
              const answer = btn.getAttribute('data-answer');
              btn.setAttribute('aria-busy', 'true');
              try {
                await api.post(`/api/tasks/${taskId}/complete`, { answer });
                toast.success('Correct answer! UGX 500 added to your wallet.');
                await refresh();
              } catch (err) {
                btn.removeAttribute('aria-busy');
                toast.error(err instanceof ApiError ? err.message : 'Incorrect answer. Try the next question!');
              }
            });
          });
        }
      }
    } catch (err) {
      console.error('Failed to load trivia challenges', err);
    }
  }

  await refresh();
}
