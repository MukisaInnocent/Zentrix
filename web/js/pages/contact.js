import { api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { toast } from '../core/toast.js';

// The support details come from the server (Settings > Support contact, edited by admins), so a change there shows
// here and on the home page without editing any page.
async function showContact() {
  const { support } = await api.get('/api/meta', { noRedirect: true });
  if (!support) return;
  const email = $('#contact-email');
  email.textContent = support.email;
  email.href = `mailto:${support.email}`;
  const phone = $('#contact-phone');
  phone.textContent = support.phone;
  phone.href = `tel:${support.phone.replace(/[^+\d]/g, '')}`;
  $('#contact-hours').textContent = support.hours;
  $('#contact-whatsapp-row').hidden = !support.whatsapp;
  if (support.whatsapp) {
    const wa = $('#contact-whatsapp');
    wa.textContent = support.whatsapp;
    wa.href = `https://wa.me/${support.whatsapp.replace(/\D/g, '')}`;
  }
}

export async function init() {
  // The page reads fine without the details if the server cannot be reached.
  await showContact().catch(() => undefined);
  const form = $('#contact-form');
  form?.addEventListener('submit', e => {
    e.preventDefault();
    toast.success('Your message has been sent to our support team!');
    form.reset();
  });
}
