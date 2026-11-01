import { api, ApiError } from '../core/api.js';
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
  // A signed-in member is answered at their account email; a visitor gives an address.
  const signedIn = await api.get('/api/me', { noRedirect: true }).then(() => true, () => false);
  $('#contact-reply-field').hidden = signedIn;
  $('#contact-reply').required = !signedIn;

  // The message is emailed to support (POST /api/support/messages); success shows only when it was sent.
  const form = $('#contact-form');
  const alert = $('#contact-form-error');
  const button = $('#contact-submit');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    alert.hidden = true;
    if (!form.reportValidity()) return;
    const value = name => form.elements.namedItem(name).value.trim();
    button.disabled = true;
    try {
      await api.post('/api/support/messages', { ...(signedIn ? {} : { email: value('email') }), subject: value('subject'), message: value('message') });
      toast.success('Your message has been sent to our support team. We will answer you by email.');
      form.reset();
    } catch (err) {
      alert.textContent = err instanceof ApiError ? err.message : 'Connection error. Please try again.';
      alert.hidden = false;
    } finally {
      button.disabled = false;
    }
  });
}
