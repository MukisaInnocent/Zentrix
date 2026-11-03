import { api, ApiError } from '../core/api.js';
import { $, h } from '../core/dom.js';

// Videos (owner, 2026-11-03): the links an admin adds in the staff console. YouTube and TikTok play in their own
// players on the page (the server builds the player address); every other link opens on its own site. Videos pay
// nothing. All text goes in as DOM text, never HTML.
function card(v) {
  const player = v.embedUrl
    ? h('div', { class: `zx-video__frame${v.platform === 'tiktok' ? ' zx-video__frame--tall' : ''}` },
      h('iframe', {
        src: v.embedUrl, title: v.title, loading: 'lazy', allowfullscreen: true, referrerpolicy: 'strict-origin-when-cross-origin',
        allow: 'encrypted-media; picture-in-picture; fullscreen', sandbox: 'allow-scripts allow-same-origin allow-presentation allow-popups',
      }))
    : null;
  return h('article', { class: 'zx-card zx-video' },
    player,
    h('h2', { class: 'zx-video__title' }, v.title),
    v.description ? h('p', { class: 'zx-hint' }, v.description) : null,
    h('a', { class: `zx-btn ${player ? 'zx-btn--ghost' : ''} zx-btn--sm`, href: v.linkUrl, target: '_blank', rel: 'noopener noreferrer' },
      player ? 'Open on its site' : 'Watch video'));
}

export async function init() {
  const box = $('#videos');
  try {
    const { videos } = await api.get('/api/videos');
    box.replaceChildren(...(videos.length ? videos.map(card) : [h('p', { class: 'zx-empty' }, 'No videos yet. Check back soon.')]));
  } catch (err) {
    box.replaceChildren(h('p', { class: 'zx-empty' }, err instanceof ApiError ? err.message : 'Could not load the videos. Reload the page.'));
  }
}
