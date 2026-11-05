import { api } from '../core/api.js';
import { $, h, icon } from '../core/dom.js';
import { formatDate } from '../core/format.js';
import { act, emptyRow, when } from '../admin/kit.js';

// Events (owner, 2026-11-05): visitors, registrations and activations per East Africa Time day and by country. The
// server does every count; this page only shows them. Visitor counts exist only on AWS (CloudFront logs, hourly).
const count = n => (n === null || n === undefined ? '-' : Number(n).toLocaleString());

function stat(tone, iconName, label, value, note) {
  return h('div', { class: `zx-stat${tone ? ` zx-stat--${tone}` : ''}` },
    h('span', { class: 'zx-stat__badge' }, icon(iconName)),
    h('span', { class: 'zx-stat__value' }, value),
    h('span', { class: 'zx-stat__label' }, label),
    note ? h('span', { class: 'zx-stat__note' }, note) : null);
}

async function load() {
  const days = $('#days').value;
  const e = await api.get(`/api/admin/events?days=${days}`);
  const today = e.daily[0];
  const period = $('#days').selectedOptions[0].textContent.toLowerCase();

  $('#visits-note').replaceChildren(e.visits.available
    ? h('p', { class: 'zx-hint' }, `Visitor counts since ${formatDate(e.visits.since)}, last updated ${when(e.visits.updatedAt)}.`)
    : h('div', { class: 'zx-banner zx-banner--warning' }, icon('info'),
      h('span', { class: 'zx-banner__text' }, 'No visitor counts yet. They start once the visitor log is switched on for the live site, and appear here within an hour.')));

  $('#stats').replaceChildren(
    stat('', 'eye', 'Visitors today', count(today.visitors), `${count(today.pageViews)} pages viewed`),
    stat('mint', 'user-plus', 'Registered today', count(today.registrations), `${count(today.activations)} activated today`),
    stat('lilac', 'chart', `Visitors, ${period}`, e.visits.available ? count(e.period.visitors) : '-', `${count(e.period.registrations)} registered, ${count(e.period.activations)} activated`),
    stat('sand', 'users', 'Members overall', count(e.totals.registrations), `${count(e.totals.activations)} activated overall`),
  );

  $('#daily').replaceChildren(...e.daily.map(d => h('tr', {},
    h('td', { class: 'zx-td-strong' }, d.day === e.today ? `${formatDate(d.day)} (today)` : formatDate(d.day)),
    h('td', {}, count(d.visitors)),
    h('td', {}, count(d.pageViews)),
    h('td', {}, count(d.registrations)),
    h('td', {}, count(d.activations)))));

  $('#countries').replaceChildren(...(e.countries.length ? e.countries.map(c => h('tr', {},
    h('td', { class: 'zx-td-strong' }, c.name),
    h('td', {}, e.visits.available ? count(c.visitors) : '-'),
    h('td', {}, e.visits.available ? count(c.pageViews) : '-'),
    h('td', {}, count(c.registrations)),
    h('td', {}, count(c.activations)))) : [emptyRow(5, 'Nothing in this period yet.')]));
}

export async function init() {
  $('#days').addEventListener('change', () => void act(load));
  await act(load);
}
