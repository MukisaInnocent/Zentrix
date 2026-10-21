import { api } from '../core/api.js';
import { $ } from '../core/dom.js';

export async function init() {
  try {
    const data = await api.get('/api/tasks/leaderboard');
    const tbody = $('#leaderboard-body');
    if (tbody && data.leaderboard) {
      tbody.innerHTML = data.leaderboard
        .map(row => {
          const rankClass = row.rank <= 3 ? `zx-rank--${row.rank}` : 'zx-rank--n';
          return `
            <tr>
              <td class="zx-rank ${rankClass}">#${row.rank}</td>
              <td class="zx-td-strong">@${row.username}</td>
              <td class="zx-td-strong zx-text-brand">${Number(row.score).toLocaleString()} pts</td>
            </tr>
          `;
        })
        .join('');
    }
  } catch (err) {
    console.error('Failed to load leaderboard', err);
  }
}
