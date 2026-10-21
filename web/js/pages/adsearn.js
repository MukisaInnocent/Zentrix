import { api, ApiError } from '../core/api.js';
import { $ } from '../core/dom.js';
import { formatMoney } from '../core/format.js';
import { toast } from '../core/toast.js';

export async function init() {
  async function refresh() {
    try {
      const summary = await api.get('/api/wallet/summary');
      if ($('#ads-earnings')) $('#ads-earnings').textContent = formatMoney(summary.taskBalancesMinor.ads, summary.currency);

      const tasksData = await api.get('/api/tasks?module=ads');
      const tasks = tasksData.tasks || [];

      const subsData = await api.get('/api/tasks/submissions?module=ads');
      const submissions = subsData.submissions || [];

      if ($('#ads-completed-count')) $('#ads-completed-count').textContent = String(submissions.length);

      const container = $('#ads-container');
      if (container) {
        if (tasks.length === 0) {
          container.innerHTML = `<p class="zx-empty">No ads available right now. Check back shortly!</p>`;
        } else {
          container.innerHTML = tasks
            .map(t => {
              const actionBtn = t.completed
                ? `<span class="zx-btn zx-btn--secondary zx-btn--sm zx-btn--done">Viewed</span>`
                : `<button class="zx-btn zx-btn--sm complete-btn" data-id="${t.id}" data-duration="${t.durationSec || 30}" data-reward="${t.rewardMinor}">View Ad (+UGX ${Number(t.rewardMinor).toLocaleString()})</button>`;

              return `
                <div class="zx-tile">
                  <div>
                    <div class="zx-tile__title">${t.title}</div>
                    <div class="zx-hint zx-tile__meta">${t.description} &bull; Duration: ${t.durationSec || 30}s</div>
                    <div class="zx-tile__reward">Reward: +UGX ${Number(t.rewardMinor).toLocaleString()}</div>
                  </div>
                  <div>${actionBtn}</div>
                </div>
              `;
            })
            .join('');

          container.querySelectorAll('.complete-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
              const taskId = btn.getAttribute('data-id');
              btn.setAttribute('aria-busy', 'true');
              btn.disabled = true;
              try {
                await api.post(`/api/tasks/${taskId}/complete`, { answer: 'viewed_ad' });
                toast.success('Ad view verified! Reward added to your wallet.');
                await refresh();
              } catch (err) {
                btn.removeAttribute('aria-busy');
                btn.disabled = false;
                toast.error(err instanceof ApiError ? err.message : 'Could not complete ad view.');
              }
            });
          });
        }
      }

      const tbody = $('#ads-submissions-body');
      if (tbody) {
        if (submissions.length === 0) {
          tbody.innerHTML = `<tr><td colspan="4" class="zx-td-empty">No ads viewed yet. View ads above to earn instant rewards!</td></tr>`;
        } else {
          tbody.innerHTML = submissions
            .map(s => {
              const dateStr = new Date(s.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
              return `
                <tr>
                  <td class="zx-td-muted">${dateStr}</td>
                  <td class="zx-td-strong">${s.taskTitle}</td>
                  <td class="zx-amount zx-amount--in">+ ${formatMoney(s.rewardMinor, s.currency)}</td>
                  <td>
                    <span class="zx-badge zx-badge--success">
                      Approved
                    </span>
                  </td>
                </tr>
              `;
            })
            .join('');
        }
      }
    } catch (err) {
      console.error('Failed to load ads', err);
    }
  }

  await refresh();
}
