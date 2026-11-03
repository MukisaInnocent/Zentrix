import { initTaskPage } from '../core/task-page.js';

export function init() {
  return initTaskPage({
    module: 'youtube', verb: 'Open video', proof: 'watched_video', defaultSeconds: 30,
    empty: 'No YouTube tasks right now. Check back soon.',
    ids: { earnings: '#yt-earnings', count: '#yt-completed-count', list: '#tasks-container', submissions: '#yt-submissions-body' },
  });
}
