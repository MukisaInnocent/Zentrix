// Launch countdown for pexerearn.com: 2 November 2026, 00:00 East Africa Time (21:00 UTC on 1 November).
// The time left is measured against the server's clock (the Date header), so a wrong phone clock does not
// change it.
const LAUNCH = Date.parse('2026-11-01T21:00:00Z');
let offset = 0; // server time minus this device's time, in milliseconds

const pad = n => String(n).padStart(2, '0');
const $ = id => document.getElementById(id);

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

let lastSpoken = '';
function tick() {
  const left = Math.max(0, LAUNCH - (Date.now() + offset));
  if (left === 0) {
    $('counting').hidden = true;
    $('live').hidden = false;
    document.title = 'Pexerearn is live';
    return false;
  }
  const s = Math.floor(left / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  $('days').textContent = String(days);
  $('hours').textContent = pad(hours);
  $('minutes').textContent = pad(minutes);
  $('seconds').textContent = pad(s % 60);
  // Screen readers hear the time left once a minute, not every second.
  const spoken = `${days} days, ${hours} hours and ${minutes} minutes until launch.`;
  if (spoken !== lastSpoken) $('spoken').textContent = lastSpoken = spoken;
  return true;
}

function showLocalTime() {
  const local = new Date(LAUNCH).toLocaleString([], { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  if (Intl.DateTimeFormat().resolvedOptions().timeZone !== 'Africa/Kampala') $('local-time').textContent = `(${local} where you are)`;
}

function run() {
  if (!tick()) return;
  // Wake on each new second; the timer is corrected every time, so it never drifts.
  setTimeout(run, 1000 - ((Date.now() + offset) % 1000) + 5);
}

showLocalTime();
tick();
await syncClock();
run();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void syncClock().then(tick);
});
