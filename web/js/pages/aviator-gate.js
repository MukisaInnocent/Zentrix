import { api, ApiError } from '../core/api.js';

// Aviator terms (owner, 2026-11-19): until the member accepts the current Aviator Terms and Conditions, the game and
// wallet stay hidden behind the "Before you play" card. The server refuses bets without an acceptance too.
export async function setupTermsGate() {
  const root = document.querySelector('.avx');
  const gate = document.getElementById('terms-gate');
  const form = document.getElementById('terms-form');
  const check = document.getElementById('terms-check');
  const button = document.getElementById('terms-accept');
  const error = document.getElementById('terms-error');
  if (!root || !gate || !form) return;

  const open = () => { root.dataset.terms = 'accepted'; gate.hidden = true; };
  let version;
  try {
    const status = await api.get('/api/aviator/terms');
    version = status.version;
    if (status.accepted) return void open();
  } catch {
    return; // the game's own requests show any error; bets stay refused by the server
  }
  root.dataset.terms = 'pending';
  gate.hidden = false;

  check.addEventListener('change', () => { button.disabled = !check.checked; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!check.checked) return;
    button.disabled = true;
    error.hidden = true;
    try {
      await api.post('/api/aviator/terms/accept', { version });
      open();
    } catch (err) {
      error.textContent = err instanceof ApiError ? err.message : 'Could not save your acceptance. Please try again.';
      error.hidden = false;
      button.disabled = false;
    }
  });
}
