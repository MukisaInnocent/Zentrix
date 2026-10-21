import { $ } from '../core/dom.js';
import { toast } from '../core/toast.js';

export function init() {
  const form = $('#contact-form');
  form?.addEventListener('submit', e => {
    e.preventDefault();
    toast.success('Your message has been sent to our support team!');
    form.reset();
  });
}
