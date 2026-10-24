import { api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { formatMoney } from '../core/format.js';
import { toast } from '../core/toast.js';

export async function init() {
  try {
    const data = await api.get('/api/referrals');
    const { stats, team, commissions, referralLink } = data;

    // Referral link
    const linkInput = $('#ref-link');
    const copyBtn = $('#copy-btn');
    if (linkInput && referralLink) {
      linkInput.value = referralLink;
    }
    copyBtn?.addEventListener('click', () => {
      if (linkInput && linkInput.value) {
        navigator.clipboard.writeText(linkInput.value).then(() => {
          toast.success('Referral link copied to clipboard!');
        });
      }
    });

    // Stats
    if ($('#stat-total-ref')) $('#stat-total-ref').textContent = String(stats.totalReferrals || 0);
    if ($('#stat-total-comm')) $('#stat-total-comm').textContent = formatMoney(stats.totalCommissionsMinor || '0', stats.currency || 'UGX');
    if ($('#stat-lvl1-count')) $('#stat-lvl1-count').textContent = String(stats.level1Count || 0);
    if ($('#stat-lvl2-count')) $('#stat-lvl2-count').textContent = String((stats.level2Count || 0) + (stats.level3Count || 0));

    // Team members table
    const teamBody = $('#team-body');
    if (teamBody) {
      if (!team || team.length === 0) {
        teamBody.innerHTML = `<tr><td colspan="5" class="zx-td-empty">No team members yet. Share your referral link above to earn Level 1 (UGX 10,000), Level 2 (UGX 5,000), and Level 3 (UGX 2,000)!</td></tr>`;
      } else {
        teamBody.innerHTML = team
          .map(m => {
            const dateStr = new Date(m.joinedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
            const badgeClass = m.level === 1 ? 'zx-badge--brand' : m.level === 2 ? 'zx-badge--success' : 'zx-badge--warning';
            return `
              <tr>
                <td class="zx-td-strong">@${m.username}</td>
                <td>
                  <span class="zx-badge ${badgeClass}">
                    Level ${m.level}
                  </span>
                </td>
                <td>${m.country}</td>
                <td class="zx-td-muted">${dateStr}</td>
                <td>
                  <span class="zx-badge zx-badge--success">
                    ${m.status}
                  </span>
                </td>
              </tr>
            `;
          })
          .join('');
      }
    }

    // Commissions table
    const commBody = $('#commissions-body');
    if (commBody) {
      if (!commissions || commissions.length === 0) {
        commBody.innerHTML = `<tr><td colspan="5" class="zx-td-empty">No referral rewards yet.</td></tr>`;
      } else {
        commBody.innerHTML = commissions
          .map(c => {
            const dateStr = new Date(c.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            return `
              <tr>
                <td class="zx-td-muted">${dateStr}</td>
                <td class="zx-td-strong">@${c.fromUsername}</td>
                <td class="zx-td-strong">Direct invite</td>
                <td class="zx-amount">${formatMoney(c.amountMinor, c.currency)}</td>
                <td>
                  <span class="zx-badge ${c.status === 'credited' ? 'zx-badge--success' : 'zx-badge--warning'}">
                    ${c.status === 'credited' ? 'Paid' : c.status === 'pending' ? 'Pending, not paid yet' : 'Cancelled'}
                  </span>
                </td>
              </tr>
            `;
          })
          .join('');
      }
    }
  } catch (err) {
    console.error('Failed to load referral data', err);
  }
}
