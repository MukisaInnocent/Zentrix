import { toast } from '../core/toast.js';

export function init() {
  document.querySelectorAll('.lesson-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const title = btn.getAttribute('data-title') || 'Forex Lesson';
      toast.info(`Opening lesson: "${title}"...`);
    });
  });
}
