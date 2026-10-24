import { ApiError, api, newIdempotencyKey } from '../core/api.js';
import { askForm } from '../core/dialogs.js';
import { h, icon } from '../core/dom.js';
import { formatDate, formatMoney } from '../core/format.js';
import { toast } from '../core/toast.js';

export { askForm };

// Shared pieces of the staff console: money and status display, live polling, the detail sheet, action
// dialogs, timelines and paging. All text goes in through textContent (h()), never innerHTML.

export const money = (amountMinor, currency) => (amountMinor === null || amountMinor === undefined ? '' : formatMoney(amountMinor, currency));
export const when = value => formatDate(value, { withTime: true });

export function ago(value) {
  if (!value) return '';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const STATUS = {
  pending: ['warning', 'Waiting review'],
  confirmed: ['success', 'Confirmed'],
  rejected: ['danger', 'Rejected'],
  cancelled: ['', 'Cancelled'],
  requested: ['warning', 'Requested'],
  approved: ['brand', 'Approved'],
  processing: ['brand', 'Sending'],
  paid: ['success', 'Paid'],
  failed: ['danger', 'Failed'],
  open: ['warning', 'Open'],
  in_progress: ['brand', 'In progress'],
  resolved: ['success', 'Resolved'],
  acknowledged: ['brand', 'Acknowledged'],
};

export function statusBadge(status) {
  const [tone, label] = STATUS[status] ?? ['', status];
  return h('span', { class: `zx-badge${tone ? ` zx-badge--${tone}` : ''}` }, label);
}

export const severityBadge = severity =>
  h('span', { class: `zx-badge zx-badge--${severity === 'critical' ? 'danger' : severity === 'warning' ? 'warning' : 'brand'}` }, severity);

// Polls `load` every `ms` while the tab is visible, and right away when it becomes visible again. The
// indicator element shows Live / Paused / Offline with the time of the last good refresh.
export function live(load, { ms = 8000, indicator } = {}) {
  let timer = null;
  let running = false;
  const label = indicator ? h('span', {}, 'Connecting') : null;
  if (indicator) indicator.replaceChildren(h('span', { class: 'zx-live__dot', 'aria-hidden': 'true' }), label);
  const set = (state, text) => {
    if (!indicator) return;
    indicator.className = `zx-live${state ? ` zx-live--${state}` : ''}`;
    label.textContent = text;
  };
  async function tick() {
    if (running) return;
    running = true;
    try {
      await load();
      set('', `Live · updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
    } catch (err) {
      set('error', err instanceof ApiError && err.status === 0 ? 'Offline, retrying' : 'Refresh failed, retrying');
    } finally {
      running = false;
    }
  }
  const schedule = () => {
    clearInterval(timer);
    timer = setInterval(() => {
      if (document.visibilityState === 'visible') void tick();
    }, ms);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void tick();
    else set('paused', 'Paused while this tab is hidden');
  });
  schedule();
  void tick();
  return { refresh: tick };
}

// Right-hand detail sheet (full screen on phones). Returns { body, actions, close, setTitle }.
export function sheet(title, { onClose } = {}) {
  const heading = h('h2', { id: 'zx-sheet-title' }, title);
  const closeBtn = h('button', { type: 'button', class: 'zx-icon-btn zx-icon-btn--square', 'aria-label': 'Close' }, icon('close'));
  const body = h('div', { class: 'zx-sheet__body' });
  const actions = h('div', { class: 'zx-sheet__actions', hidden: true });
  const dialog = h('dialog', { class: 'zx-sheet', 'aria-labelledby': 'zx-sheet-title' },
    h('div', { class: 'zx-sheet__inner' }, h('div', { class: 'zx-sheet__head' }, heading, closeBtn), body, actions));
  const close = () => dialog.close();
  closeBtn.addEventListener('click', close);
  dialog.addEventListener('click', e => {
    if (e.target === dialog) close();
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    onClose?.();
  });
  document.body.append(dialog);
  dialog.showModal();
  return {
    body,
    close,
    setTitle: text => (heading.textContent = text),
    setActions: (...buttons) => {
      actions.replaceChildren(...buttons.filter(Boolean));
      actions.hidden = actions.children.length === 0;
    },
  };
}

// Money-moving staff call: a fresh Idempotency-Key per click.
export const moneyPost = (path, body) => api.post(path, body, { idempotencyKey: newIdempotencyKey() });

export function timeline(events) {
  if (!events.length) return h('p', { class: 'zx-hint' }, 'No history yet.');
  return h('ol', { class: 'zx-timeline' }, events.map(e =>
    h('li', {},
      h('div', { class: 'zx-timeline__what' }, e.from ? `${label(e.from)} to ${label(e.to)}` : label(e.to)),
      h('div', { class: 'zx-timeline__meta' }, [when(e.at), e.actor ? `by @${e.actor}` : null, e.note].filter(Boolean).join(' · ')))));
}

const label = status => STATUS[status]?.[1] ?? status;

export function kv(pairs) {
  return h('dl', { class: 'zx-kv zx-kv--tight' }, pairs.filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v ?? '')]));
}

export function copyable(text) {
  const btn = h('button', { type: 'button', 'aria-label': `Copy ${text}` }, icon('copy'));
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied');
    } catch {
      toast.error('Copy is blocked in this browser.');
    }
  });
  return h('span', { class: 'zx-copyable' }, h('span', { class: 'zx-mono' }, text), btn);
}

export function panel(title, ...children) {
  return h('section', { class: 'zx-panel' }, h('h3', {}, title), ...children);
}

// Segmented status filter. options: [{ value, label }]. Calls onChange(value).
export function segmented(container, options, value, onChange) {
  const render = current => container.replaceChildren(...options.map(o => {
    const b = h('button', { type: 'button', 'aria-pressed': String(o.value === current) }, o.label, o.count ? h('span', { class: 'zx-count' }, String(o.count)) : null);
    b.addEventListener('click', () => {
      render(o.value);
      onChange(o.value);
    });
    return b;
  }));
  render(value);
  return { render };
}

export function pager(container, { page, hasMore }, go) {
  const prev = h('button', { type: 'button', class: 'zx-btn zx-btn--secondary zx-btn--sm', disabled: page <= 1 }, 'Previous');
  const next = h('button', { type: 'button', class: 'zx-btn zx-btn--secondary zx-btn--sm', disabled: !hasMore }, 'Next');
  prev.addEventListener('click', () => go(page - 1));
  next.addEventListener('click', () => go(page + 1));
  container.replaceChildren(prev, h('span', { class: 'zx-hint' }, `Page ${page}`), next);
}

// Runs a staff action with toasts; returns true on success.
export async function act(fn, success) {
  try {
    await fn();
    if (success) toast.success(success);
    return true;
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    if (!(err instanceof ApiError)) console.error(err);
    return false;
  }
}

export function emptyRow(colspan, text) {
  return h('tr', {}, h('td', { colspan: String(colspan), class: 'zx-td-empty' }, text));
}

// Reads ?id= so a link from the overview opens the right record.
export const queryParam = name => new URLSearchParams(location.search).get(name);

export function debounce(fn, ms = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
