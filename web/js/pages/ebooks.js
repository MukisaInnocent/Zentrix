import { toast } from '../core/toast.js';

export function init() {
  document.querySelectorAll('.download-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const title = btn.getAttribute('data-title') || 'E-book';
      toast.success(`Opening "${title}" e-book reader...`);
    });
  });
}
