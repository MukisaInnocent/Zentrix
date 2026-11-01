import { api } from '../core/api.js';
import { $, h, icon } from '../core/dom.js';

// The E-books page lists the books an admin added in the staff console (owner, 2026-11-01), grouped by section.
// Each book opens its file in a new tab.
function card(book) {
  return h('article', { class: 'zx-card zx-card--lift zx-tile zx-tile--column' },
    h('div', {},
      h('div', { class: 'zx-tile__tag' }, icon('book'), h('span', {}, book.section)),
      h('h3', {}, book.title),
      h('p', { class: 'zx-hint' }, book.description)),
    h('div', { class: 'zx-tile__foot' },
      h('span', { class: 'zx-hint' }, book.pages ? `${book.pages} pages` : ''),
      h('a', { class: 'zx-btn zx-btn--secondary zx-btn--sm', href: book.linkUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Read / Download')));
}

export async function init() {
  const box = $('#ebooks');
  try {
    const { ebooks } = await api.get('/api/ebooks');
    if (!ebooks.length) return void box.replaceChildren(h('p', { class: 'zx-empty' }, 'No e-books yet. Check back soon.'));
    const sections = [...new Set(ebooks.map(b => b.section))];
    box.replaceChildren(...sections.map(section => h('section', { class: 'zx-stack-3' },
      h('h2', {}, section),
      h('div', { class: 'zx-auto-grid zx-auto-grid--lg' }, ...ebooks.filter(b => b.section === section).map(card)))));
  } catch {
    box.replaceChildren(h('p', { class: 'zx-empty' }, 'E-books could not be loaded. Please try again.'));
  }
}
