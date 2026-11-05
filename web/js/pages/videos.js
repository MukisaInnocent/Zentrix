import { api, ApiError } from '../core/api.js';
import { $, h } from '../core/dom.js';

// Videos (owner, 2026-11-03): the videos an admin adds in the staff console. Every video plays on the page in the
// YouTube or TikTok player (the server builds the player address); none opens an outside link (owner, 2026-11-05).
// Videos pay nothing. All text goes in as DOM text, never HTML.
function card(v) {
  return h('article', { class: 'zx-card zx-video' },
    h('div', { class: `zx-video__frame${v.platform === 'tiktok' ? ' zx-video__frame--tall' : ''}` },
      h('iframe', {
        src: v.embedUrl, title: v.title, loading: 'lazy', allowfullscreen: true, referrerpolicy: 'strict-origin-when-cross-origin',
        allow: 'encrypted-media; picture-in-picture; fullscreen', sandbox: 'allow-scripts allow-same-origin allow-presentation',
      })),
    h('h2', { class: 'zx-video__title' }, v.title),
    v.description ? h('p', { class: 'zx-hint' }, v.description) : null);
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
