import { initTaskPage } from '../core/task-page.js';

export function init() {
  return initTaskPage({
    module: 'ads', verb: 'View ad', proof: 'viewed_ad', defaultSeconds: 30,
    empty: 'No ads right now. Check back soon.',
    ids: { earnings: '#ads-earnings', count: '#ads-completed-count', list: '#ads-container', submissions: '#ads-submissions-body' },
  });
}
