import { api } from '../core/api.js';
import { $, h } from '../core/dom.js';
import { act, askForm, emptyRow, when } from '../admin/kit.js';

// System-wide settings. Each known setting gets a form with plain labels; the server validates every value and
// keeps each change as a new version.
const KNOWN = {
  'referral.tier_amounts_ugx': {
    title: 'Referral rewards (UGX)',
    fields: [
      { name: 'level1', label: 'Level 1 (direct inviter)', type: 'number' },
      { name: 'level2', label: 'Level 2', type: 'number' },
      { name: 'level3', label: 'Level 3', type: 'number' },
    ],
    hint: 'Paid when an invited member activates. Together at most UGX 19,000. Other countries get the same share of their own fee.',
    show: v => `Level 1: UGX ${v.level1.toLocaleString()} · Level 2: UGX ${v.level2.toLocaleString()} · Level 3: UGX ${v.level3.toLocaleString()}`,
    read: v => ({ level1: Number(v.level1), level2: Number(v.level2), level3: Number(v.level3) }),
  },
  'voucher.value_multiples': {
    title: 'Voucher values',
    fields: [{ name: 'list', label: 'Multiples of the activation fee, separated by commas', hint: 'For example 1, 2, 3, 5. 1 means exactly the fee; values are never below it.' }],
    toForm: v => ({ list: v.join(', ') }),
    show: v => v.map(m => (m === 1 ? 'the fee' : `${m} x the fee`)).join(', '),
    read: v => v.list.split(',').map(s => s.trim()).filter(Boolean).map(Number),
  },
  'support.contact': {
    title: 'Support contact',
    fields: [{ name: 'email', label: 'Email', type: 'email' }, { name: 'phone', label: 'Phone' }, { name: 'hours', label: 'Opening hours' }],
    hint: 'Shown on the Contact page.',
    show: v => `${v.email} · ${v.phone} · ${v.hours}`,
  },
  'community.url': {
    title: 'Community link',
    fields: [{ name: 'url', label: 'Link (https), or leave empty for none' }],
    toForm: v => ({ url: v ?? '' }),
    show: v => v ?? 'None',
    read: v => v.url || null,
  },
  'legal.terms_version': { title: 'Terms version', fields: [{ name: 'value', label: 'Version' }], toForm: v => ({ value: v }), read: v => v.value },
  'legal.privacy_version': { title: 'Privacy version', fields: [{ name: 'value', label: 'Version' }], toForm: v => ({ value: v }), read: v => v.value },
};

const display = s => {
  const known = KNOWN[s.key];
  if (known?.show) return known.show(s.value);
  return typeof s.value === 'string' ? s.value : JSON.stringify(s.value);
};

async function edit(s) {
  const known = KNOWN[s.key] ?? { title: s.key, fields: [{ name: 'json', label: 'Value (JSON)', type: 'textarea' }], toForm: v => ({ json: JSON.stringify(v) }), read: v => JSON.parse(v.json) };
  const current = known.toForm ? known.toForm(s.value) : s.value;
  const saved = await askForm({
    title: `Change ${known.title}`, text: [s.description, known.hint].filter(Boolean).join(' '), submitLabel: 'Save',
    fields: [
      ...known.fields.map(f => ({ ...f, value: current?.[f.name] ?? '' })),
      { name: 'note', label: 'Why is this changing?', required: true, minLength: 3 },
    ],
    submit: v => {
      const { note, ...rest } = v;
      return api.put(`/api/admin/settings/${encodeURIComponent(s.key)}`, { value: known.read ? known.read(rest) : rest, note });
    },
  });
  if (saved) await load();
}

let settings = [];

async function load() {
  ({ settings } = await api.get('/api/admin/settings'));
  $('#rows').replaceChildren(...(settings.length ? settings.map(s => {
    const btn = h('button', { type: 'button', class: 'zx-btn zx-btn--secondary zx-btn--sm' }, 'Change');
    btn.addEventListener('click', () => void edit(s));
    return h('tr', {},
      h('td', {}, h('div', { class: 'zx-td-strong' }, KNOWN[s.key]?.title ?? s.key), h('div', { class: 'zx-hint' }, s.description)),
      h('td', {}, display(s), s.isFallback ? h('div', { class: 'zx-hint' }, 'Default (never changed)') : null),
      h('td', {}, String(s.version)),
      h('td', { class: 'zx-td-muted' }, s.updatedAt ? when(s.updatedAt) : '-'),
      h('td', {}, btn));
  }) : [emptyRow(5, 'No settings.')]));
}

export async function init() {
  await act(load);
}
