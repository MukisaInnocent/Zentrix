import { api, ApiError } from '../core/api.js';
import { $, h, on, setBusy } from '../core/dom.js';
import { loadCurrencies, minorToDecimal } from '../core/format.js';
import { act, debounce, emptyRow, kv, money, panel, queryParam, segmented, sheet, when } from '../admin/kit.js';
import { toast } from '../core/toast.js';

// Countries and fees: the activation fee, withdrawal limits, tax, approval threshold and charge table per
// country. Amounts are typed as decimal strings and converted on the server; the page never calculates money.
const state = { filter: 'members', q: '' };
let countries = [];
let exponents = {};

const pct = bp => (bp === null || bp === undefined ? '' : `${bp / 100}%`);
const status = c => (c.blocked ? h('span', { class: 'zx-badge zx-badge--danger' }, 'Blocked')
  : !c.config_version ? h('span', { class: 'zx-badge' }, 'Not set')
    : c.is_placeholder ? h('span', { class: 'zx-badge zx-badge--warning' }, 'Placeholder')
      : h('span', { class: 'zx-badge zx-badge--success' }, 'Confirmed'));

function render() {
  const q = state.q.toLowerCase();
  const list = countries.filter(c => (state.filter === 'all' || (state.filter === 'members' ? c.members > 0 : c.blocked))
    && (!q || `${c.name} ${c.code} ${c.currency_code}`.toLowerCase().includes(q)));
  $('#rows').replaceChildren(...(list.length ? list.map(c => h('tr', { tabindex: '0', dataset: { open: c.code } },
    h('td', { class: 'zx-td-strong' }, `${c.name} (${c.code})`),
    h('td', {}, c.currency_code),
    h('td', {}, money(c.membership_fee_minor, c.currency_code)),
    h('td', {}, money(c.withdrawal_min_minor, c.currency_code)),
    h('td', {}, money(c.withdrawal_max_minor, c.currency_code)),
    h('td', {}, money(c.withdrawal_daily_max_minor, c.currency_code)),
    h('td', {}, pct(c.withdrawal_fee_bp)),
    h('td', {}, money(c.withdrawal_approval_threshold_minor, c.currency_code)),
    h('td', {}, String(c.members)),
    h('td', {}, status(c)))) : [emptyRow(10, 'No countries match.')]));
}

async function load() {
  [{ countries }, exponents] = await Promise.all([api.get('/api/admin/countries'), loadCurrencies()]);
  render();
}

// A labelled input for the config form.
function field(name, label, value, { type = 'text', hint, inputmode } = {}) {
  const id = `cfg-${name}`;
  const input = type === 'checkbox'
    ? h('input', { id, name, type: 'checkbox', checked: Boolean(value) })
    : h('input', { id, name, class: 'zx-input', type, value: value ?? '', inputmode, autocomplete: 'off' });
  return type === 'checkbox'
    ? h('div', { class: 'zx-check' }, input, h('label', { for: id }, label))
    : h('div', { class: 'zx-field' }, h('label', { for: id }, label), input, hint ? h('span', { class: 'zx-hint' }, hint) : null);
}

const showError = (slot, err) => {
  slot.textContent = err instanceof ApiError ? err.message : 'Connection error. Please try again.';
  slot.hidden = false;
};

function configForm(code, cfg, exp, onSaved) {
  const dec = minor => (minor === undefined || minor === null ? '' : minorToDecimal(minor, exp));
  const alert = h('div', { class: 'zx-error', hidden: true, role: 'alert' });
  const form = h('form', { class: 'zx-form' }, alert,
    h('div', { class: 'zx-form-row zx-form-row--2' },
      field('membershipFee', 'Activation fee', dec(cfg?.membershipFeeMinor), { inputmode: 'decimal' }),
      field('withdrawalApprovalThreshold', 'Admin approval from', dec(cfg?.withdrawalApprovalThresholdMinor), { inputmode: 'decimal', hint: 'Withdrawals from this amount need an admin.' })),
    h('div', { class: 'zx-form-row zx-form-row--2' },
      field('withdrawalMin', 'Minimum withdrawal', dec(cfg?.withdrawalMinMinor), { inputmode: 'decimal' }),
      field('withdrawalMax', 'Maximum per withdrawal', dec(cfg?.withdrawalMaxMinor), { inputmode: 'decimal' })),
    h('div', { class: 'zx-form-row zx-form-row--2' },
      field('withdrawalDailyMax', 'Daily maximum', dec(cfg?.withdrawalDailyMaxMinor), { inputmode: 'decimal' }),
      field('withdrawalFeeBp', 'Withdrawal tax (basis points)', cfg?.withdrawalFeeBp ?? 50, { type: 'number', hint: '50 = 0.5% of the amount, added to the charge.' })),
    h('div', { class: 'zx-form-row zx-form-row--2' },
      field('withdrawalFeeMin', 'Charge when there is no charge table', dec(cfg?.withdrawalFeeMinMinor ?? '0'), { inputmode: 'decimal' }),
      field('newAccountReviewDays', 'New-account review days', cfg?.newAccountReviewDays ?? 14, { type: 'number', hint: 'Withdrawals from newer accounts need an admin.' })),
    h('div', { class: 'zx-form-row zx-form-row--2' },
      field('vatBp', 'VAT (basis points)', cfg?.vatBp ?? 0, { type: 'number' }),
      field('kycLevelForWithdrawal', 'KYC level for withdrawals (0 to 3)', cfg?.kycLevelForWithdrawal ?? 0, { type: 'number' })),
    h('div', { class: 'zx-form-row zx-form-row--2' },
      field('termsVersion', 'Terms version', cfg?.termsVersion ?? '2026-10-v1'),
      field('privacyVersion', 'Privacy version', cfg?.privacyVersion ?? '2026-10-v1')),
    field('engagementTasksEnabled', 'Engagement tasks enabled', cfg?.engagementTasksEnabled ?? true, { type: 'checkbox' }),
    field('isPlaceholder', 'Still a placeholder (not confirmed by the owner)', cfg?.isPlaceholder ?? true, { type: 'checkbox' }),
    field('note', 'Why are these changing?', ''),
    h('button', { type: 'submit', class: 'zx-btn zx-btn--fit' }, 'Save fees and limits'));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    alert.hidden = true;
    const v = name => form.elements.namedItem(name);
    const body = {
      membershipFee: v('membershipFee').value.trim(), withdrawalMin: v('withdrawalMin').value.trim(), withdrawalMax: v('withdrawalMax').value.trim(),
      withdrawalDailyMax: v('withdrawalDailyMax').value.trim(), withdrawalFeeBp: Number(v('withdrawalFeeBp').value), withdrawalFeeMin: v('withdrawalFeeMin').value.trim() || '0',
      withdrawalApprovalThreshold: v('withdrawalApprovalThreshold').value.trim(), newAccountReviewDays: Number(v('newAccountReviewDays').value),
      vatBp: Number(v('vatBp').value), kycLevelForWithdrawal: Number(v('kycLevelForWithdrawal').value), engagementTasksEnabled: v('engagementTasksEnabled').checked,
      termsVersion: v('termsVersion').value.trim(), privacyVersion: v('privacyVersion').value.trim(), isPlaceholder: v('isPlaceholder').checked,
      ...(v('note').value.trim() ? { note: v('note').value.trim() } : {}),
    };
    const btn = form.querySelector('button[type=submit]');
    setBusy(btn, true);
    try {
      const saved = await api.post(`/api/admin/countries/${code}/config`, body);
      toast.success(`Saved as version ${saved.version}.`);
      await onSaved();
    } catch (err) {
      showError(alert, err);
    } finally {
      setBusy(btn, false);
    }
  });
  return form;
}

function flagsForm(country, onSaved) {
  const alert = h('div', { class: 'zx-error', hidden: true, role: 'alert' });
  const form = h('form', { class: 'zx-form' }, alert,
    field('liveEnabled', 'Open in live mode', country.liveEnabled, { type: 'checkbox' }),
    field('blocked', 'Blocked (nobody from this country can register)', country.blocked, { type: 'checkbox' }),
    field('blockReason', 'Reason for blocking', country.blockReason ?? ''),
    h('button', { type: 'submit', class: 'zx-btn zx-btn--secondary zx-btn--fit' }, 'Save switches'));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    alert.hidden = true;
    const v = name => form.elements.namedItem(name);
    const blocked = v('blocked').checked;
    const btn = form.querySelector('button[type=submit]');
    setBusy(btn, true);
    try {
      await api.post(`/api/admin/countries/${country.code}/flags`, { liveEnabled: v('liveEnabled').checked, blocked, blockReason: blocked ? v('blockReason').value.trim() || null : null });
      toast.success('Switches saved.');
      await onSaved();
    } catch (err) {
      showError(alert, err);
    } finally {
      setBusy(btn, false);
    }
  });
  return form;
}

// The withdrawal charge table for a currency: one row per band, by its upper limit.
function chargesEditor(currency, bands, exp, onSaved) {
  const body = h('tbody');
  const addRow = (upTo = '', charge = '') => {
    const remove = h('button', { type: 'button', class: 'zx-btn zx-btn--ghost zx-btn--sm' }, 'Remove');
    const row = h('tr', {},
      h('td', {}, h('input', { class: 'zx-input', name: 'upTo', inputmode: 'decimal', value: upTo, 'aria-label': 'Withdrawal limit' })),
      h('td', {}, h('input', { class: 'zx-input', name: 'charge', inputmode: 'decimal', value: charge, 'aria-label': 'Charge' })),
      h('td', {}, remove));
    remove.addEventListener('click', () => row.remove());
    body.append(row);
  };
  for (const b of bands) addRow(minorToDecimal(b.upToMinor, exp), minorToDecimal(b.chargeMinor, exp));
  const add = h('button', { type: 'button', class: 'zx-btn zx-btn--secondary zx-btn--sm zx-btn--fit' }, 'Add a row');
  add.addEventListener('click', () => addRow());
  const note = h('input', { class: 'zx-input', id: 'charges-note', autocomplete: 'off' });
  const alert = h('div', { class: 'zx-error', hidden: true, role: 'alert' });
  const save = h('button', { type: 'button', class: 'zx-btn zx-btn--fit' }, 'Save charge table');
  save.addEventListener('click', async () => {
    alert.hidden = true;
    const rows = [...body.querySelectorAll('tr')].map(tr => ({ upTo: tr.querySelector('[name=upTo]').value.trim(), charge: tr.querySelector('[name=charge]').value.trim() }))
      .filter(r => r.upTo || r.charge);
    setBusy(save, true);
    try {
      await api.put(`/api/admin/withdrawal-charges/${currency}`, { bands: rows, note: note.value.trim() });
      toast.success(`${currency} charge table saved.`);
      await onSaved();
    } catch (err) {
      showError(alert, err);
    } finally {
      setBusy(save, false);
    }
  });
  return h('div', { class: 'zx-stack-3' },
    h('p', { class: 'zx-hint' }, `Applies to every ${currency} withdrawal. A withdrawal pays the charge of the first row whose limit covers it, plus the tax. With no rows, it pays the country's "charge when there is no charge table".`),
    alert,
    h('div', { class: 'zx-table-wrap' }, h('table', { class: 'zx-table' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, `Withdrawal limit (${currency})`), h('th', { scope: 'col' }, `Charge (${currency})`), h('th', { scope: 'col' }, 'Action'))), body)),
    add,
    h('div', { class: 'zx-field' }, h('label', { for: 'charges-note' }, 'Why are the charges changing?'), note),
    save);
}

async function openCountry(code) {
  const view = sheet('Country', { onClose: () => history.replaceState(null, '', location.pathname) });
  history.replaceState(null, '', `?code=${code}`);
  const draw = async () => {
    const { country, configHistory } = await api.get(`/api/admin/countries/${code}`);
    const charges = await api.get(`/api/admin/withdrawal-charges/${country.currencyCode}`);
    const exp = exponents[country.currencyCode] ?? 0;
    const cfg = configHistory[0];
    view.setTitle(`${country.name} (${country.code}) · ${country.currencyCode}`);
    const reload = async () => {
      await draw();
      await load();
    };
    view.body.replaceChildren(
      panel('Fees and limits', cfg ? kv([['Version', `${cfg.version} (${when(cfg.createdAt)})`], ['Status', cfg.isPlaceholder ? 'Placeholder' : 'Confirmed']]) : h('p', { class: 'zx-hint' }, 'Not set yet. Members here cannot activate until it is saved.'),
        configForm(code, cfg, exp, reload)),
      panel('Withdrawal charge table', chargesEditor(country.currencyCode, charges.bands, exp, reload)),
      panel('Switches', flagsForm(country, reload)),
      panel('History', configHistory.length ? h('div', { class: 'zx-table-wrap' }, h('table', { class: 'zx-table' },
        h('thead', {}, h('tr', {}, ['Version', 'Saved', 'Activation fee', 'Minimum', 'Maximum', 'Daily maximum', 'Tax', 'Note'].map(t => h('th', { scope: 'col' }, t)))),
        h('tbody', {}, configHistory.map(c => h('tr', {},
          h('td', {}, String(c.version)), h('td', { class: 'zx-td-muted' }, when(c.createdAt)),
          h('td', {}, money(c.membershipFeeMinor, c.currencyCode)), h('td', {}, money(c.withdrawalMinMinor, c.currencyCode)),
          h('td', {}, money(c.withdrawalMaxMinor, c.currencyCode)), h('td', {}, money(c.withdrawalDailyMaxMinor, c.currencyCode)),
          h('td', {}, pct(c.withdrawalFeeBp)), h('td', { class: 'zx-td-muted' }, c.note ?? '')))))) : h('p', { class: 'zx-hint' }, 'No versions yet.')),
    );
  };
  try {
    await draw();
  } catch (err) {
    view.body.replaceChildren(h('p', { class: 'zx-error' }, err.message));
  }
}

export async function init() {
  segmented($('#status-filter'), [{ value: 'members', label: 'With members' }, { value: 'all', label: 'All' }, { value: 'blocked', label: 'Blocked' }], state.filter, value => {
    state.filter = value;
    render();
  });
  $('#search').addEventListener('input', debounce(e => {
    state.q = e.target.value.trim();
    render();
  }));
  on($('#rows'), 'click', 'tr[data-open]', (_e, tr) => void openCountry(tr.dataset.open));
  on($('#rows'), 'keydown', 'tr[data-open]', (e, tr) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void openCountry(tr.dataset.open);
    }
  });
  await act(load);
  const code = queryParam('code');
  if (code) await openCountry(code.toUpperCase());
}
