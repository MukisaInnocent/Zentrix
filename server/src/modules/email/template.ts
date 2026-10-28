// Branded emails (owner, 2026-10-28): one layout for every email, as HTML with a plain-text version. Email clients
// ignore stylesheets, so the HTML uses tables and inline styles; every text value is escaped. Colours follow the
// site's tokens (web/css/tokens.css).

export interface EmailContent {
  heading: string;
  // Paragraphs of plain text; a line break inside one is kept.
  paragraphs: string[];
  button?: { label: string; url: string };
  // Shown small under the button (for example "This link works for 30 minutes.").
  note?: string;
  // Why the member gets this email and where to change it; shown in the footer.
  footer?: string;
}

export interface RenderedEmail {
  html: string;
  text: string;
}

const BRAND = '#5b2bd6';
const INK = '#1c1530';
const MUTED = '#6b6480';
const PAGE = '#f4f2fa';

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const para = (text: string, style: string) => `<p style="${style}">${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;

export function renderEmail(content: EmailContent, opts: { origin: string; testMode: boolean }): RenderedEmail {
  const body = 'margin:0 0 16px;font-size:16px;line-height:24px;color:' + INK;
  const small = 'margin:0 0 8px;font-size:13px;line-height:20px;color:' + MUTED;
  const button = content.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px"><tr><td style="border-radius:8px;background:${BRAND}">` +
      `<a href="${escapeHtml(content.button.url)}" style="display:inline-block;padding:12px 24px;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px">${escapeHtml(content.button.label)}</a>` +
      `</td></tr></table>` +
      para(`If the button does not work, copy this link into your browser:\n${content.button.url}`, small)
    : '';
  const banner = opts.testMode
    ? `<tr><td style="padding:8px 24px;background:#fff4d6;color:#7a5600;font-size:13px;font-weight:bold;text-align:center">TEST MODE: no real money</td></tr>`
    : '';
  const footer = [content.footer, `Pexerearn · ${opts.origin.replace(/^https?:\/\//, '')} · info@pexerearn.com`].filter(Boolean) as string[];
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(content.heading)}</title></head>
<body style="margin:0;padding:0;background:${PAGE};font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="padding:20px 24px;background:${BRAND};color:#ffffff;font-size:22px;font-weight:bold;letter-spacing:0.5px">Pexerearn</td></tr>
${banner}
<tr><td style="padding:28px 24px 12px">
<h1 style="margin:0 0 16px;font-size:22px;line-height:28px;color:${INK}">${escapeHtml(content.heading)}</h1>
${content.paragraphs.map(p => para(p, body)).join('\n')}
${button}
${content.note ? para(content.note, small) : ''}
</td></tr>
<tr><td style="padding:16px 24px 24px;border-top:1px solid #e8e4f3">${footer.map(f => para(f, small)).join('')}</td></tr>
</table></td></tr></table>
</body></html>`;

  const text = [
    content.heading,
    '',
    ...content.paragraphs.flatMap(p => [p, '']),
    ...(content.button ? [`${content.button.label}: ${content.button.url}`, ''] : []),
    ...(content.note ? [content.note, ''] : []),
    ...(opts.testMode ? ['TEST MODE: no real money.', ''] : []),
    '--',
    ...footer,
  ].join('\n');
  return { html, text };
}
