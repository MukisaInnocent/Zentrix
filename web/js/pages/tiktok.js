import { initTaskPage } from '../core/task-page.js';

export function init() {
  return initTaskPage({
    module: 'tiktok', verb: 'Open video', proof: 'watched_video', defaultSeconds: 30,
    empty: 'No TikTok tasks right now. Check back soon.',
    ids: { earnings: '#tt-earnings', count: '#tt-completed-count', list: '#tt-tasks-container', submissions: '#tt-submissions-body' },
  });
}
