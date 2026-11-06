import { api, ApiError } from '../core/api.js';

// Aviator: the owner's Aviator project (app/templates/dashboard.html and app/static/main.js) brought over as it is
// (owner, 2026-11-06). The game script below is the project's, with three changes the site needs: it runs as this
// page's module (no inline scripts or onclick handlers under the site's CSP), requests go to /api/aviator with the
// site's session and CSRF token, and the demo-credit wallet (the project's wallet page) sits on the same page.

const API_BASE = '/api/aviator';

// The project's fetchAPI, on the site's API client (session cookie, CSRF token, error messages).
async function fetchAPI(endpoint, method = 'GET', body = null) {
    try {
        return method === 'GET' ? await api.get(`${API_BASE}${endpoint}`) : await api.post(`${API_BASE}${endpoint}`, body ?? {});
    } catch (err) {
        throw new Error(err instanceof ApiError ? err.message : 'API Request Failed', { cause: err });
    }
}

// Jet silhouette in a 100x40 box, nose pointing right (from the project's main.js).
const JET_BODY_PATH = 'M4 20C4 16 10 15 20 15L72 15C84 15 94 17 98 20C94 23 84 25 72 25L20 25C10 25 4 24 4 20Z M46 18L34 3L42 3L64 17Z M44 22L30 38L39 38L64 23Z M9 17L3 4L10 4L22 16Z M10 23L4 31L11 31L23 24Z';
const JET_WINDOW_PATH = 'M78 17.2C84 17.2 90 18 93.5 19.6L79 19.6Z';

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let toastTimer = null;
function showMessage(msg, type = 'error') {
    const el = document.getElementById('message-box');
    el.textContent = msg;
    el.className = `avx-alert ${type}`;
    void el.offsetWidth; // restart the entrance animation
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}

function formatCredits(value) {
    return Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Smoothly count an element's number from its current value to `target`.
function animateNumber(el, target, { suffix = '', duration = 700 } = {}) {
    if (!el) return;
    const from = Number(el.dataset.value ?? target);
    el.dataset.value = target;
    if (prefersReducedMotion || from === target) {
        el.textContent = `${formatCredits(target)}${suffix}`;
        return;
    }
    el.classList.remove('bump-up', 'bump-down');
    void el.offsetWidth;
    el.classList.add(target > from ? 'bump-up' : 'bump-down');
    const start = performance.now();
    const step = (now) => {
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        el.textContent = `${formatCredits(from + (target - from) * eased)}${suffix}`;
        if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

function relativeTime(iso) {
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return iso;
    const secs = Math.round((Date.now() - then) / 1000);
    if (secs < 60) return 'just now';
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return new Date(then).toLocaleDateString();
}

// The project's wallet page: ask for demo credits or to remove them (staff approve), and the request list.
function initWallet(refreshBalance) {
    const list = document.getElementById('trans-list');
    async function loadTransactions() {
        try {
            const trans = await fetchAPI('/wallet/transactions');
            list.replaceChildren();
            if (!trans.length) {
                const li = document.createElement('li');
                li.className = 'history-empty';
                li.textContent = 'No requests yet.';
                list.appendChild(li);
                return;
            }
            for (const t of trans) {
                const li = document.createElement('li');
                li.className = `tx-item ${t.type}`;
                const what = document.createElement('span');
                what.textContent = `${t.type === 'deposit' ? 'Credit request' : 'Removal request'} · ${relativeTime(t.date)}`;
                const amount = document.createElement('strong');
                amount.textContent = `${t.type === 'deposit' ? '+' : '-'}${formatCredits(t.amount)}`;
                const status = document.createElement('em');
                status.className = `tx-status ${t.status}`;
                status.textContent = t.status;
                li.append(what, amount, status);
                list.appendChild(li);
            }
        } catch (e) {
            console.error(e);
        }
    }
    for (const [formId, inputId, endpoint, done] of [
        ['dep-form', 'dep-amount', '/wallet/deposit', 'Credit request sent. Staff will approve it soon.'],
        ['with-form', 'with-amount', '/wallet/withdraw', 'Removal request sent.'],
    ]) {
        document.getElementById(formId).addEventListener('submit', async (e) => {
            e.preventDefault();
            const input = document.getElementById(inputId);
            try {
                await fetchAPI(endpoint, 'POST', { amount: input.value });
                input.value = '';
                showMessage(done, 'success');
                await loadTransactions();
                await refreshBalance();
            } catch (error) {
                showMessage(error.message);
            }
        });
    }
    document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
        document.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
        document.getElementById('dep-form').hidden = b.dataset.tab !== 'deposit';
        document.getElementById('with-form').hidden = b.dataset.tab !== 'withdraw';
    }));
    void loadTransactions();
    setInterval(() => { if (document.visibilityState === 'visible') void loadTransactions(); }, 15000);
}

export function init() {
    // ------------------------------------------------------------------
    // Constants (must match app/routes/game.py)
    // ------------------------------------------------------------------
    const GROWTH = 1.1;
    const LN_GROWTH = Math.log(GROWTH);
    const BETTING_MS = 8000;
    const CRASH_DISPLAY_MS = 3000;

    // ------------------------------------------------------------------
    // DOM
    // ------------------------------------------------------------------
    const $ = (id) => document.getElementById(id);
    const stage = $('stage');
    const canvas = $('flight-canvas');
    const ctx = canvas.getContext('2d');
    const multiplierEl = $('multiplier');
    const statusEl = $('status-overlay');
    const captionEl = $('game-caption');
    const countdownEl = $('countdown');
    const countdownBar = $('countdown-bar');
    const roundNumberEl = $('round-number');
    const btnBet = $('btn-bet');
    const btnCashout = $('btn-cashout');
    const cashoutAmountEl = $('cashout-amount');
    const betInput = $('bet-amount');
    const myBetInfo = $('my-bet-info');

    // ------------------------------------------------------------------
    // Game state (driven by the server)
    // ------------------------------------------------------------------
    let gameState = 'connecting';
    let roundId = null;
    let startTime = null;          // ms, server clock
    let crashPoint = null;
    let crashT = null;             // seconds after start when the round crashed
    let serverClockOffset = 0;
    let currentBet = null;
    let requestInProgress = false;
    let balance = null;

    // ------------------------------------------------------------------
    // Bet amount controls
    // ------------------------------------------------------------------
    try {
        const saved = localStorage.getItem('aviator.bet');
        if (saved) betInput.value = saved;
    } catch { /* storage unavailable */ }

    function setBetAmount(value) {
        const v = Math.max(0.01, Math.round(value * 100) / 100);
        betInput.value = v.toFixed(2);
        try { localStorage.setItem('aviator.bet', betInput.value); } catch { /* ignore */ }
        syncButtons();
    }
    document.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
        setBetAmount((parseFloat(betInput.value) || 0) + Number(b.dataset.step));
    }));
    document.querySelectorAll('[data-chip]').forEach((b) => b.addEventListener('click', () => {
        const v = parseFloat(betInput.value) || 0;
        const chip = b.dataset.chip;
        if (chip === 'half') setBetAmount(v / 2);
        else if (chip === 'double') setBetAmount(v * 2);
        else setBetAmount(v + Number(chip));
    }));
    betInput.addEventListener('change', () => setBetAmount(parseFloat(betInput.value) || 0.01));
    betInput.addEventListener('input', syncButtons);

    document.addEventListener('keydown', (e) => {
        if (e.code !== 'Space' || e.target.matches('input, textarea, select, button')) return;
        e.preventDefault();
        if (!btnCashout.hidden) cashout();
        else if (!btnBet.disabled) placeBet();
    });

    // ------------------------------------------------------------------
    // HUD rendering
    // ------------------------------------------------------------------
    function setBetButton(title, sub) {
        btnBet.querySelector('.btn-title').textContent = title;
        btnBet.querySelector('.btn-sub').textContent = sub;
    }

    function syncButtons() {
        const canBet = gameState === 'waiting' && !currentBet;
        btnBet.disabled = !canBet || requestInProgress;
        betInput.disabled = !canBet || requestInProgress;
        document.querySelectorAll('[data-step], [data-chip]').forEach((b) => { b.disabled = !canBet; });

        if (gameState === 'waiting' && !currentBet) {
            setBetButton('Place bet', `${formatCredits(parseFloat(betInput.value) || 0)} credits`);
        } else if (gameState === 'waiting') {
            setBetButton('Bet placed', 'Waiting for takeoff…');
        } else if (gameState === 'active') {
            setBetButton('Betting closed', 'Wait for the next round');
        } else {
            setBetButton('Next round', 'Starting soon');
        }

        const canCashout = gameState === 'active' && currentBet?.result === 'pending';
        btnCashout.hidden = !canCashout;
        btnBet.hidden = canCashout;
        btnCashout.disabled = requestInProgress;
    }

    function renderBet(bet) {
        currentBet = bet || null;
        myBetInfo.classList.remove('win', 'loss');
        if (!currentBet) {
            myBetInfo.textContent = 'No bet in this round.';
        } else if (currentBet.result === 'pending') {
            myBetInfo.textContent = `Bet placed: ${formatCredits(currentBet.amount)} demo credits`;
        } else if (currentBet.result === 'win') {
            myBetInfo.classList.add('win');
            myBetInfo.textContent = `Cashed out at ${currentBet.multiplier.toFixed(2)}x · +${formatCredits(currentBet.payout)} demo credits`;
        } else {
            myBetInfo.classList.add('loss');
            myBetInfo.textContent = `Flew away at ${crashPoint ? crashPoint.toFixed(2) : '?'}x · ${formatCredits(currentBet.amount)} demo credits lost`;
        }
    }

    function renderState(data) {
        const prevState = gameState;
        const isNewRound = roundId !== data.round_id;
        roundId = data.round_id;
        roundNumberEl.textContent = `ROUND #${roundId}`;
        serverClockOffset = Date.parse(data.server_time) - Date.now();
        startTime = Date.parse(data.start_time);

        if (isNewRound) {
            renderBet(null);
            crashPoint = null;
            crashT = null;
        }
        if (data.status === 'crashed') {
            crashPoint = data.crash_point;
            crashT = Math.log(Math.max(1, crashPoint)) / LN_GROWTH;
        }
        if (data.my_bet) renderBet(data.my_bet);

        gameState = data.status;
        statusEl.dataset.status = gameState;

        if (gameState !== prevState || isNewRound) {
            scene.onStateChange(prevState, gameState, isNewRound);
        }

        if (gameState === 'waiting') {
            statusEl.textContent = 'BOARDING · BETS OPEN';
            multiplierEl.classList.remove('crashed', 'hot');
            countdownEl.hidden = false;
        } else if (gameState === 'active') {
            statusEl.textContent = 'IN FLIGHT';
            countdownEl.hidden = true;
            captionEl.textContent = currentBet?.result === 'pending'
                ? 'Cash out before it flies away!'
                : currentBet?.result === 'win' ? 'Safely landed your credits' : 'Betting is closed for this round';
        } else if (gameState === 'crashed') {
            statusEl.textContent = 'FLEW AWAY';
            countdownEl.hidden = true;
            multiplierEl.textContent = `${crashPoint.toFixed(2)}x`;
            multiplierEl.classList.remove('hot');
            multiplierEl.classList.add('crashed');
        }
        syncButtons();
    }

    // Per-frame HUD values that change smoothly between server polls.
    function tickHud(serverNow, multiplier) {
        if (gameState === 'waiting') {
            const remaining = Math.max(0, startTime - serverNow);
            multiplierEl.textContent = `${Math.ceil(remaining / 1000)}s`;
            captionEl.textContent = remaining > 0 ? 'Place your bet before takeoff' : 'Taking off…';
            countdownBar.style.transform = `scaleX(${Math.min(1, remaining / BETTING_MS)})`;
        } else if (gameState === 'active') {
            multiplierEl.textContent = `${multiplier.toFixed(2)}x`;
            multiplierEl.classList.toggle('hot', multiplier >= 2);
            if (currentBet?.result === 'pending') {
                cashoutAmountEl.textContent = formatCredits(currentBet.amount * multiplier);
            }
        } else if (gameState === 'crashed' && crashT !== null) {
            const next = Math.max(0, startTime + crashT * 1000 + CRASH_DISPLAY_MS - serverNow);
            captionEl.textContent = `Next flight boarding in ${Math.ceil(next / 1000)}s`;
        }
    }

    // ------------------------------------------------------------------
    // Canvas scene
    // ------------------------------------------------------------------
    const scene = (() => {
        const jetBody = new Path2D(JET_BODY_PATH);
        const jetWindow = new Path2D(JET_WINDOW_PATH);
        const JET_SCALE = 0.9;
        const PAD = { l: 48, r: 26, t: 26, b: 34 };
        const FX = prefersReducedMotion ? 0.3 : 1;

        let W = 0, H = 0;
        let stars = [], clouds = [];
        let particles = [], floaters = [];
        let view = { xMax: 10, yMax: 2 };
        let speed = 0.2;
        let plane = { x: 0, y: 0, angle: 0, visible: true };
        let wreck = null;
        let enterAt = performance.now();
        let flash = 0;
        let emitCarry = 0;

        function resize() {
            const rect = stage.getBoundingClientRect();
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            W = rect.width;
            H = rect.height;
            canvas.width = Math.round(W * dpr);
            canvas.height = Math.round(H * dpr);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            stars = Array.from({ length: Math.round((W * H) / 5200) }, () => ({
                x: Math.random() * W, y: Math.random() * H,
                z: 0.2 + Math.random() * 0.8, tw: Math.random() * Math.PI * 2,
            }));
            clouds = Array.from({ length: 6 }, () => ({
                x: Math.random() * W * 1.3, y: H * (0.1 + Math.random() * 0.75),
                r: 50 + Math.random() * 90, z: 0.3 + Math.random() * 0.6,
            }));
        }
        new ResizeObserver(resize).observe(stage);

        const plotW = () => W - PAD.l - PAD.r;
        const plotH = () => H - PAD.t - PAD.b;
        const toPx = (t, m) => ({
            x: PAD.l + (t / view.xMax) * plotW(),
            y: H - PAD.b - ((m - 1) / (view.yMax - 1)) * plotH(),
        });

        function niceStep(raw) {
            const p = Math.pow(10, Math.floor(Math.log10(raw)));
            const n = raw / p;
            return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
        }

        function spawn(p) { particles.push(p); }

        function explode(x, y) {
            const sparks = Math.round(70 * FX);
            for (let i = 0; i < sparks; i++) {
                const a = Math.random() * Math.PI * 2;
                const s = 80 + Math.random() * 340;
                spawn({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: 0.5 + Math.random() * 0.7,
                        size: 1.5 + Math.random() * 2.5, hue: 20 + Math.random() * 35, kind: 'spark', drag: 2.2, g: 160 });
            }
            for (let i = 0; i < Math.round(24 * FX); i++) {
                const a = Math.random() * Math.PI * 2;
                const s = 20 + Math.random() * 80;
                spawn({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 20, life: 0, max: 1.2 + Math.random() * 1.2,
                        size: 10 + Math.random() * 18, kind: 'smoke', drag: 1.5, g: -10 });
            }
            flash = 1;
            stage.classList.remove('shake');
            void stage.offsetWidth;
            stage.classList.add('shake');
        }

        function celebrate(text) {
            floaters.push({ x: plane.x, y: plane.y - 30, text, life: 0, max: 1.6 });
            for (let i = 0; i < Math.round(36 * FX); i++) {
                const a = Math.random() * Math.PI * 2;
                const s = 60 + Math.random() * 200;
                spawn({ x: plane.x, y: plane.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: 0.6 + Math.random() * 0.6,
                        size: 2 + Math.random() * 2, hue: 150, kind: 'spark', drag: 2.5, g: 60 });
            }
        }

        function onStateChange(prev, next, isNewRound) {
            if (next === 'crashed' && prev === 'active' && plane.visible) {
                explode(plane.x, plane.y);
                wreck = { x: plane.x, y: plane.y, vx: 60, vy: -120, angle: plane.angle, va: 2.8, alpha: 1 };
                plane.visible = false;
                setTimeout(refreshHistory, 400);
            } else if (next === 'crashed') {
                plane.visible = false;
            } else if (next === 'waiting' && (isNewRound || prev !== 'waiting')) {
                plane.visible = true;
                wreck = null;
                enterAt = performance.now();
            } else if (next === 'active') {
                plane.visible = true;
            }
        }

        function drawBackground(m, dt, now) {
            const g = ctx.createLinearGradient(0, 0, 0, H);
            g.addColorStop(0, '#0d1640');
            g.addColorStop(1, '#050816');
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, W, H);

            // Climbing into space: the sky darkens and turns violet with altitude.
            const altitude = Math.min(1, Math.log(m) / Math.log(20));
            if (altitude > 0) {
                ctx.fillStyle = `rgba(20, 6, 48, ${altitude * 0.65})`;
                ctx.fillRect(0, 0, W, H);
            }

            for (const s of stars) {
                s.x -= s.z * speed * 40 * dt;
                if (s.x < 0) { s.x += W; s.y = Math.random() * H; }
                const a = 0.35 + 0.45 * Math.sin(now / 600 + s.tw) * s.z;
                ctx.fillStyle = `rgba(220, 230, 255, ${Math.max(0.1, a)})`;
                const len = Math.min(18, speed * 3 * s.z);
                if (len > 2) ctx.fillRect(s.x, s.y, len, s.z * 1.4);
                else ctx.fillRect(s.x, s.y, s.z * 1.8, s.z * 1.8);
            }

            for (const c of clouds) {
                c.x -= c.z * speed * 90 * dt;
                if (c.x < -c.r * 2) { c.x = W + c.r * 2; c.y = H * (0.1 + Math.random() * 0.75); }
                const alpha = 0.07 * (1 - altitude * 0.8);
                for (let i = 0; i < 3; i++) {
                    const cx = c.x + (i - 1) * c.r * 0.7;
                    const cy = c.y + (i === 1 ? -c.r * 0.25 : 0);
                    const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, c.r);
                    rg.addColorStop(0, `rgba(180, 200, 255, ${alpha})`);
                    rg.addColorStop(1, 'rgba(180, 200, 255, 0)');
                    ctx.fillStyle = rg;
                    ctx.beginPath();
                    ctx.arc(cx, cy, c.r, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }

        function drawGrid() {
            ctx.save();
            ctx.font = '600 10px Inter, sans-serif';
            ctx.textBaseline = 'middle';
            ctx.lineWidth = 1;

            const yStep = niceStep((view.yMax - 1) / 4);
            for (let v = 1; v <= view.yMax + 1e-9; v += yStep) {
                const { y } = toPx(0, v);
                ctx.strokeStyle = 'rgba(160, 180, 255, 0.07)';
                ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();
                ctx.fillStyle = 'rgba(163, 172, 214, 0.55)';
                ctx.textAlign = 'right';
                ctx.fillText(`${v.toFixed(v < 10 ? 1 : 0)}x`, PAD.l - 8, y);
            }

            const xStep = niceStep(view.xMax / 5);
            ctx.textAlign = 'center';
            for (let t = 0; t <= view.xMax + 1e-9; t += xStep) {
                const { x } = toPx(t, 1);
                ctx.fillStyle = 'rgba(163, 172, 214, 0.45)';
                ctx.fillText(`${Math.round(t)}s`, x, H - PAD.b + 16);
                ctx.fillRect(x, H - PAD.b, 1, 4);
            }
            ctx.strokeStyle = 'rgba(160, 180, 255, 0.18)';
            ctx.beginPath(); ctx.moveTo(PAD.l, H - PAD.b); ctx.lineTo(W - PAD.r, H - PAD.b); ctx.stroke();
            ctx.restore();
        }

        function drawRunway(now) {
            const y = H - PAD.b - 4;
            const count = Math.floor(plotW() / 34);
            for (let i = 0; i < count; i++) {
                const on = Math.floor(now / 140) % count === i || Math.floor(now / 140 + count / 2) % count === i;
                ctx.fillStyle = on ? 'rgba(255, 181, 71, 0.95)' : 'rgba(255, 181, 71, 0.18)';
                ctx.beginPath();
                ctx.arc(PAD.l + 20 + i * 34, y, on ? 2.6 : 1.8, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        function drawCurve(t, crashed) {
            if (t <= 0.02) return;
            const n = 90;
            const pts = [];
            for (let i = 0; i <= n; i++) {
                const ti = (t * i) / n;
                pts.push(toPx(ti, Math.pow(GROWTH, ti)));
            }
            const end = pts[pts.length - 1];
            const base = H - PAD.b;

            ctx.save();
            const fill = ctx.createLinearGradient(0, end.y, 0, base);
            fill.addColorStop(0, crashed ? 'rgba(255, 77, 109, 0.28)' : 'rgba(139, 92, 255, 0.32)');
            fill.addColorStop(1, 'rgba(62, 232, 255, 0)');
            ctx.fillStyle = fill;
            ctx.beginPath();
            ctx.moveTo(pts[0].x, base);
            pts.forEach((p) => ctx.lineTo(p.x, p.y));
            ctx.lineTo(end.x, base);
            ctx.closePath();
            ctx.fill();

            const stroke = ctx.createLinearGradient(PAD.l, 0, end.x, 0);
            if (crashed) {
                stroke.addColorStop(0, '#ff8aa0');
                stroke.addColorStop(1, '#ff4d6d');
            } else {
                stroke.addColorStop(0, '#3ee8ff');
                stroke.addColorStop(0.6, '#8b5cff');
                stroke.addColorStop(1, '#ff7a3d');
            }
            ctx.strokeStyle = stroke;
            ctx.lineWidth = 4;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.shadowColor = crashed ? '#ff4d6d' : '#8b5cff';
            ctx.shadowBlur = 18;
            ctx.beginPath();
            pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
            ctx.stroke();
            ctx.restore();
        }

        function drawJet(x, y, angle, alpha = 1, glow = true) {
            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.translate(x, y);
            ctx.rotate(angle);
            ctx.scale(JET_SCALE, JET_SCALE);
            ctx.translate(-55, -20);
            if (glow) {
                ctx.shadowColor = 'rgba(62, 232, 255, 0.85)';
                ctx.shadowBlur = 22;
            }
            const body = ctx.createLinearGradient(0, 0, 0, 40);
            body.addColorStop(0, '#ffffff');
            body.addColorStop(1, '#b9c6ff');
            ctx.fillStyle = body;
            ctx.fill(jetBody);
            ctx.shadowBlur = 0;
            ctx.fillStyle = '#3ee8ff';
            ctx.fill(jetWindow);
            ctx.restore();
        }

        function tailPoint() {
            const dx = (2 - 55) * JET_SCALE;
            return {
                x: plane.x + Math.cos(plane.angle) * dx,
                y: plane.y + Math.sin(plane.angle) * dx,
            };
        }

        function emitExhaust(rate, dt, power) {
            emitCarry += rate * FX * dt;
            const tail = tailPoint();
            while (emitCarry >= 1) {
                emitCarry -= 1;
                const back = 60 + Math.random() * 80 * power;
                spawn({
                    x: tail.x, y: tail.y + (Math.random() - 0.5) * 4,
                    vx: -Math.cos(plane.angle) * back - speed * 30 + (Math.random() - 0.5) * 20,
                    vy: -Math.sin(plane.angle) * back + (Math.random() - 0.5) * 20,
                    life: 0, max: 0.35 + Math.random() * 0.35 * power,
                    size: 2 + Math.random() * 3 * power, hue: 25 + Math.random() * 25, kind: 'flame', drag: 1.2, g: 0,
                });
            }
        }

        function updateParticles(dt) {
            ctx.save();
            for (let i = particles.length - 1; i >= 0; i--) {
                const p = particles[i];
                p.life += dt;
                if (p.life >= p.max) { particles.splice(i, 1); continue; }
                const k = Math.exp(-p.drag * dt);
                p.vx *= k; p.vy = p.vy * k + p.g * dt;
                p.x += p.vx * dt; p.y += p.vy * dt;
                const f = 1 - p.life / p.max;
                if (p.kind === 'smoke') {
                    ctx.globalCompositeOperation = 'source-over';
                    ctx.fillStyle = `rgba(90, 96, 130, ${0.28 * f})`;
                    ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1.6 - f * 0.6), 0, Math.PI * 2); ctx.fill();
                } else {
                    ctx.globalCompositeOperation = 'lighter';
                    const light = p.kind === 'flame' ? 55 + 25 * f : 60;
                    ctx.fillStyle = `hsla(${p.hue}, 100%, ${light}%, ${f})`;
                    ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (p.kind === 'flame' ? 0.5 + f : 1), 0, Math.PI * 2); ctx.fill();
                }
            }
            ctx.restore();

            ctx.save();
            ctx.font = '800 22px Sora, Inter, sans-serif';
            ctx.textAlign = 'center';
            for (let i = floaters.length - 1; i >= 0; i--) {
                const f = floaters[i];
                f.life += dt;
                if (f.life >= f.max) { floaters.splice(i, 1); continue; }
                const t = f.life / f.max;
                ctx.globalAlpha = 1 - t * t;
                ctx.fillStyle = '#3dffa8';
                ctx.shadowColor = '#3dffa8';
                ctx.shadowBlur = 16;
                ctx.fillText(f.text, f.x, f.y - t * 60);
            }
            ctx.restore();
        }

        let last = performance.now();
        function frame(now) {
            const dt = Math.min(0.05, (now - last) / 1000);
            last = now;
            if (!W || !H) { requestAnimationFrame(frame); return; }

            const serverNow = Date.now() + serverClockOffset;
            let t = 0, m = 1;
            if (gameState === 'active' && startTime !== null) {
                t = Math.max(0, (serverNow - startTime) / 1000);
                m = Math.pow(GROWTH, t);
            } else if (gameState === 'crashed' && crashT !== null) {
                t = crashT;
                m = crashPoint;
            }
            tickHud(serverNow, m);

            // Camera: zoom out smoothly to keep the jet in view.
            const k = Math.min(1, dt * 3);
            view.xMax += (Math.max(10, t * 1.3) - view.xMax) * k;
            view.yMax += (Math.max(2, 1 + (m - 1) * 1.45) - view.yMax) * k;
            view.xMax = Math.max(view.xMax, t * 1.18);
            view.yMax = Math.max(view.yMax, 1 + (m - 1) * 1.25);

            const targetSpeed = gameState === 'active' ? Math.min(6, 1 + t * 0.25) : gameState === 'waiting' ? 0.25 : 0.08;
            speed += (targetSpeed - speed) * Math.min(1, dt * 2);

            ctx.clearRect(0, 0, W, H);
            drawBackground(m, dt, now);
            drawGrid();
            if (gameState === 'waiting') drawRunway(now);
            drawCurve(t, gameState === 'crashed');

            // Jet position and heading.
            if (gameState === 'active' || gameState === 'waiting' || gameState === 'connecting') {
                const p = toPx(t, m);
                let angle = -0.04;
                if (t > 0.05) {
                    const q = toPx(t - 0.05, Math.pow(GROWTH, t - 0.05));
                    angle = Math.max(-1.1, Math.min(0, Math.atan2(p.y - q.y, p.x - q.x)));
                }
                // The jet's tail sits on the tip of the curve, nose pointing along it.
                let x = p.x + Math.cos(angle) * 44;
                let y = p.y + Math.sin(angle) * 44 - 10;
                if (gameState === 'waiting') {
                    const e = Math.min(1, (now - enterAt) / 1300);
                    const ease = 1 - Math.pow(1 - e, 3);
                    x = -80 + (x + 80) * ease;
                    y += Math.sin(now / 320) * 2;
                    const remaining = startTime ? startTime - serverNow : BETTING_MS;
                    emitExhaust(remaining < 1500 ? 70 : 18, dt, remaining < 1500 ? 1.2 : 0.5);
                } else {
                    y += Math.sin(now / 140) * 1.5;
                    emitExhaust(90, dt, 1 + Math.min(1.5, t * 0.05));
                }
                plane.x = x; plane.y = y; plane.angle = angle;
                if (plane.visible) drawJet(x, y, angle);
            }

            // Wreck tumbling after a crash.
            if (wreck) {
                wreck.vy += 420 * dt;
                wreck.x += wreck.vx * dt;
                wreck.y += wreck.vy * dt;
                wreck.angle += wreck.va * dt;
                wreck.alpha = Math.max(0, wreck.alpha - dt * 0.55);
                if (Math.random() < 0.6 * FX) {
                    spawn({ x: wreck.x, y: wreck.y, vx: (Math.random() - 0.5) * 20, vy: -20, life: 0, max: 1,
                            size: 6 + Math.random() * 8, kind: 'smoke', drag: 1, g: -15 });
                }
                drawJet(wreck.x, wreck.y, wreck.angle, wreck.alpha, false);
                if (wreck.alpha <= 0 || wreck.y > H + 60) wreck = null;
            }

            updateParticles(dt);

            if (flash > 0) {
                ctx.fillStyle = `rgba(255, 140, 90, ${flash * 0.35})`;
                ctx.fillRect(0, 0, W, H);
                flash = Math.max(0, flash - dt * 2.5);
            }

            requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);

        return { onStateChange, celebrate };
    })();

    // ------------------------------------------------------------------
    // Server communication
    // ------------------------------------------------------------------
    async function updateState() {
        try {
            renderState(await fetchAPI('/game/state'));
        } catch (error) {
            statusEl.dataset.status = 'error';
            statusEl.textContent = 'RECONNECTING';
            captionEl.textContent = 'The game server could not be reached. Retrying…';
            console.error(error);
        }
    }

    function bucket(m) { return m >= 10 ? 'm-high' : m >= 2 ? 'm-mid' : 'm-low'; }

    let lastHistoryKey = '';
    async function refreshHistory() {
        try {
            const rounds = await fetchAPI('/game/history');
            const key = rounds.map((r) => r.round_id).join(',');
            if (key === lastHistoryKey) return;
            lastHistoryKey = key;

            const log = $('game-log');
            const ticker = $('ticker');
            log.replaceChildren();
            ticker.replaceChildren();
            if (rounds.length === 0) {
                const empty = document.createElement('li');
                empty.className = 'history-empty';
                empty.textContent = 'No completed rounds yet.';
                log.appendChild(empty);
                return;
            }

            const maxM = Math.max(...rounds.map((r) => r.crash_point));
            rounds.forEach((round, i) => {
                const cls = bucket(round.crash_point);

                const item = document.createElement('li');
                item.className = `history-item ${cls}`;
                item.style.animationDelay = `${i * 30}ms`;
                const label = document.createElement('span');
                label.textContent = `#${round.round_id}`;
                const result = document.createElement('strong');
                result.textContent = `${round.crash_point.toFixed(2)}x`;
                const bar = document.createElement('i');
                bar.className = 'history-bar';
                bar.style.width = `${Math.max(4, (Math.log(round.crash_point) / Math.log(Math.max(2, maxM))) * 100)}%`;
                item.append(label, result, bar);
                log.appendChild(item);

                const pill = document.createElement('span');
                pill.className = cls;
                pill.textContent = `${round.crash_point.toFixed(2)}x`;
                pill.style.animationDelay = `${i * 40}ms`;
                ticker.appendChild(pill);
            });

            const pts = rounds.map((r) => r.crash_point);
            $('stat-avg').textContent = `${(pts.reduce((a, b) => a + b, 0) / pts.length).toFixed(2)}x`;
            $('stat-max').textContent = `${maxM.toFixed(2)}x`;
            $('stat-2x').textContent = `${Math.round((pts.filter((p) => p >= 2).length / pts.length) * 100)}%`;
        } catch (error) {
            console.error(error);
        }
    }

    async function refreshBalance() {
        try {
            const data = await fetchAPI('/wallet/balance');
            balance = data.balance;
            animateNumber($('nav-balance'), balance, { suffix: ' cr' });
        } catch { /* shown on the next try */ }
    }

    async function placeBet() {
        if (requestInProgress || gameState !== 'waiting' || currentBet) return;
        requestInProgress = true;
        syncButtons();
        try {
            await fetchAPI('/game/bet', 'POST', { amount: betInput.value });
            showMessage(`Bet of ${formatCredits(betInput.value)} credits placed. Good flight!`, 'success');
            refreshBalance();
        } catch (error) {
            showMessage(error.message);
        } finally {
            requestInProgress = false;
            await updateState();
        }
    }

    async function cashout() {
        if (requestInProgress || !currentBet || currentBet.result !== 'pending') return;
        requestInProgress = true;
        syncButtons();
        try {
            const result = await fetchAPI('/game/cashout', 'POST', { bet_id: currentBet.id });
            scene.celebrate(`+${formatCredits(result.payout)}`);
            showMessage(`Cashed out at ${result.multiplier.toFixed(2)}x: +${formatCredits(result.payout)} credits`, 'success');
            refreshBalance();
        } catch (error) {
            showMessage(error.message);
        } finally {
            requestInProgress = false;
            await updateState();
        }
    }

    async function pollGame() {
        await updateState();
        window.setTimeout(pollGame, 400);
    }

    btnBet.addEventListener('click', () => void placeBet());
    btnCashout.addEventListener('click', () => void cashout());
    initWallet(refreshBalance);

    pollGame();
    refreshHistory();
    refreshBalance();
    window.setInterval(refreshHistory, 4000);
}
