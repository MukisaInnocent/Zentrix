// Launch countdown for pexerearn.com: 2 November 2026, 00:00 East Africa Time (21:00 UTC on 1 November).
// The time left is measured against the server's clock (the Date header), so a wrong phone clock does not
// change it. Each number slides in when it changes; the bar under it shows how much of that unit is left.
const LAUNCH = Date.parse('2026-11-01T21:00:00Z');
// When the countdown went up, for the days bar.
const PUBLISHED = Date.parse('2026-10-29T00:00:00+03:00');
const TOTAL_DAYS = Math.ceil((LAUNCH - PUBLISHED) / 86_400_000);
let offset = 0; // server time minus this device's time, in milliseconds

const pad = n => String(n).padStart(2, '0');
const $ = selector => document.querySelector(selector);
const now = () => Date.now() + offset;

async function syncClock() {
  try {
    const sent = Date.now();
    const res = await fetch('/', { method: 'HEAD', cache: 'no-store' });
    const server = Date.parse(res.headers.get('date') ?? '');
    if (!Number.isNaN(server)) offset = server + (Date.now() - sent) / 2 - Date.now();
  } catch {
    // Offline or blocked: the device clock is the best we have.
  }
}

function show(unit, text, fill) {
  const el = $(`[data-unit="${unit}"]`);
  if (el.textContent !== text) {
    el.textContent = text;
    el.classList.remove('is-changing');
    void el.offsetWidth; // restart the slide-in
    el.classList.add('is-changing');
  }
  $(`[data-fill="${unit}"]`).style.setProperty('--fill', String(Math.min(1, Math.max(0, fill))));
}

let lastSpoken = '';
function tick() {
  const left = Math.max(0, LAUNCH - now());
  if (left === 0) {
    $('#counting').hidden = true;
    $('#live').hidden = false;
    document.title = 'Pexerearn is live';
    return false;
  }
  const s = Math.floor(left / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  show('days', String(days), days / Math.max(1, TOTAL_DAYS));
  show('hours', pad(hours), hours / 24);
  show('minutes', pad(minutes), minutes / 60);
  show('seconds', pad(seconds), seconds / 60);
  // Screen readers hear the time left once a minute, not every second.
  const spoken = `${days} days, ${hours} hours and ${minutes} minutes until Pexerearn opens.`;
  if (spoken !== lastSpoken) $('#spoken').textContent = lastSpoken = spoken;
  return true;
}

function showLocalTime() {
  // Same clock time as East Africa (UTC+3): nothing to add.
  if (new Date(LAUNCH).getTimezoneOffset() === -180) return;
  const local = new Date(LAUNCH).toLocaleString([], { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  $('#local-time').textContent = `That is ${local} where you are.`;
}

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

async function share() {
  const data = { title: 'Pexerearn', text: 'Pexerearn opens on 2 November 2026 at 00:00 East Africa Time.', url: 'https://pexerearn.com/' };
  try {
    if (navigator.share) return await navigator.share(data);
    await navigator.clipboard.writeText(data.url);
    toast('Link copied. Paste it anywhere to share.');
  } catch (err) {
    if (err?.name !== 'AbortError') toast('Copy this link to share: pexerearn.com');
  }
}

function run() {
  if (!tick()) return;
  // Wake on each new second; the timer is corrected every time, so it never drifts.
  setTimeout(run, 1000 - (now() % 1000) + 5);
}

showLocalTime();
$('#share').addEventListener('click', () => void share());
tick();
await syncClock();
run();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void syncClock().then(tick);
});
