import { api, ApiError, newIdempotencyKey } from '../core/api.js';
import { $, setBusy } from '../core/dom.js';
import { formatMoney } from '../core/format.js';
import { toast } from '../core/toast.js';

// Chat with foreigners (owner, 2026-11-08): a description, a button to the owner's outside live chat page, and a daily
// reward. Opening the link is recorded; the reward can be claimed once a day after that. The server decides everything.
const errorText = err => (err instanceof ApiError ? err.message : 'Connection error. Please try again.');
let reward = null;

function render() {
  const card = $('#reward-card');
  card.hidden = !reward;
  if (!reward) return;
  const amount = formatMoney(reward.amountMinor, reward.currency);
  const btn = $('#claim-btn');
  if (reward.claimed) {
    $('#reward-text').textContent = `You claimed today's ${amount}. Come back tomorrow for the next one.`;
    btn.disabled = true;
  } else {
    $('#reward-text').textContent = reward.opened
      ? `Claim your ${amount} for today.`
      : `Earn ${amount} every day: open the live chat first, then claim your reward.`;
    btn.disabled = false;
  }
}

export async function init() {
  try {
    reward = (await api.get('/api/chat/foreign/reward')).reward;
  } catch {
    reward = null;
  }
  render();

  // The link opens in a new tab as usual; the click is recorded so today's reward can be claimed.
  $('#live-chat-btn').addEventListener('click', () => {
    api.post('/api/chat/foreign/opened', {}).then(res => {
      reward = res.reward;
      render();
    }, () => {});
  });

  $('#claim-btn').addEventListener('click', async e => {
    if (reward && !reward.opened) {
      toast.error('Open the live chat link first, then claim your reward.');
      return;
    }
    const btn = e.currentTarget;
    setBusy(btn, true);
    try {
      const res = await api.post('/api/chat/foreign/claim', {}, { idempotencyKey: newIdempotencyKey() });
      reward = res.reward;
      toast.success(`${formatMoney(reward.amountMinor, reward.currency)} added to your chat rewards.`);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(btn, false);
      render();
    }
  });
}
