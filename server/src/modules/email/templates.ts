import { z } from 'zod';
import type { Db } from '../../db/sql.js';
import { maybeOne, one } from '../../db/sql.js';
import { parse } from '../../http/validate.js';
import { badRequest } from '../../lib/errors.js';
import type { Services } from '../../services.js';
import { sendEmail, type EmailCategory, type SendOutcome } from './send.js';

// The wording of every automatic email (owner, 2026-10-29: admins edit it in the staff console). Each kind has
// built-in wording; an admin's version, stored in email_templates, replaces it. Fill-ins such as {username} are
// replaced when the email is sent. The body is plain text: a blank line starts a new paragraph, and a paragraph
// is left out when one of its fill-ins has no value (for example "Reason: {reason}" without a reason). Links,
// codes and the security notes stay in code, so an edit can never break a sign-in or a reset.

export interface TemplateContent {
  subject: string;
  heading: string;
  body: string;
  buttonLabel?: string;
}

interface TemplateDef {
  title: string;
  group: 'Sign-up and security' | 'Activation and referrals' | 'Payments' | 'Support';
  when: string;
  category: EmailCategory;
  /** Fill-in name -> what it holds, with a sample value for previews. */
  vars: Record<string, { about: string; sample: string }>;
  /** Fill-ins the wording must keep (a sign-in code email without the code is useless). */
  required?: string[];
  /** Whether the email has a button; its link is set by the site. */
  button: boolean;
  /** A fixed line under the button (security notes), not editable. */
  note?: string;
  defaults: TemplateContent;
}

const USER = { username: { about: "The member's username", sample: 'jane' } };
const MONEY = { amount: { about: 'The amount with its currency', sample: 'UGX 19,000' }, reference: { about: 'The payment reference', sample: 'DP-7K2M9Q4X' } };
const REASON = { reason: { about: 'The reason staff gave (paragraph left out without one)', sample: 'The transaction ID was not found on our statement.' } };
const NEXT_STEPS = 'Here is what you can do now:\n- Invite people with your username as the referral code; see Referrals for your link.\n- Use Pay For Client or vouchers to help someone else activate.\n- See your balance and history on the dashboard.';

export const TEMPLATES = {
  email_verification: {
    title: 'Confirm email address', group: 'Sign-up and security', when: 'Right after sign-up, and when a member asks for a new link.', category: 'security',
    vars: { ...USER }, button: true, note: 'The link works for 48 hours. If you did not create a Pexerearn account, ignore this email.',
    defaults: { subject: 'Confirm your Pexerearn email address', heading: 'Confirm your email address', body: 'Welcome to Pexerearn. Confirm this is your email address so we can reach you about your account.', buttonLabel: 'Confirm email address' },
  },
  sign_in_code: {
    title: 'Sign-in code', group: 'Sign-up and security', when: 'When a member with a second sign-in step signs in.', category: 'security',
    vars: { ...USER, code: { about: 'The 6-digit code', sample: '482913' } }, required: ['code'], button: false,
    defaults: { subject: 'Your Pexerearn sign-in code', heading: 'Your sign-in code', body: 'Your Pexerearn sign-in code is {code}.\n\nIt expires in 5 minutes and works once. If you did not just sign in, change your password now.' },
  },
  password_reset: {
    title: 'Password reset link', group: 'Sign-up and security', when: 'When someone asks to reset the password on the Forgot password page.', category: 'security',
    vars: { ...USER }, button: true, note: 'The link works for 30 minutes. If you did not ask for this, ignore this email; your password stays the same.',
    defaults: { subject: 'Reset your Pexerearn password', heading: 'Reset your password', body: 'Someone asked to reset the password for this Pexerearn account. To choose a new password, use the button below.', buttonLabel: 'Choose a new password' },
  },
  password_changed: {
    title: 'Password changed', group: 'Sign-up and security', when: 'After a password is reset or changed.', category: 'security',
    vars: { ...USER }, button: true,
    defaults: { subject: 'Your Pexerearn password was changed', heading: 'Your password was changed', body: 'The password for your Pexerearn account was just changed and other devices were signed out.\n\nIf this was not you, reset your password now and contact support.', buttonLabel: 'Reset your password' },
  },
  email_changed: {
    title: 'Email address changed (old address)', group: 'Sign-up and security', when: 'To the old address, after a member changes their email.', category: 'security',
    vars: { ...USER, newEmail: { about: 'The new email address', sample: 'jane.new@example.com' } }, button: false,
    defaults: { subject: 'Your Pexerearn email address was changed', heading: 'Your email address was changed', body: 'The email address on your Pexerearn account (@{username}) was changed to {newEmail}. If this was not you, contact support now.' },
  },
  email_updated: {
    title: 'Email address changed (new address)', group: 'Sign-up and security', when: 'To the new address, after a member changes their email.', category: 'security',
    vars: { ...USER }, button: false,
    defaults: { subject: 'Your Pexerearn email address was updated', heading: 'Your email address was updated', body: 'This address is now the email for the Pexerearn account @{username}.' },
  },
  phone_changed: {
    title: 'Phone number changed', group: 'Sign-up and security', when: 'After a member or an admin changes the phone number.', category: 'security',
    vars: { ...USER }, button: false,
    defaults: { subject: 'Your Pexerearn phone number was changed', heading: 'Your phone number was changed', body: 'The phone number on your Pexerearn account (@{username}) was changed. Withdrawals are locked for 48 hours. If this was not you, contact support now.' },
  },
  sign_in_alert: {
    title: 'New sign-in alert', group: 'Sign-up and security', when: 'When an account is signed in from a new device or network. Members can turn it off.', category: 'sign_in',
    vars: { ...USER, time: { about: 'When it happened (UTC)', sample: '2026-10-29 08:15' }, device: { about: 'The browser or app', sample: 'Mozilla/5.0 (Linux; Android 14)' } }, button: true,
    defaults: { subject: 'Pexerearn: new sign-in to your account', heading: 'New sign-in to your account', body: 'Hello @{username},\n\nYour account was just signed in from a device or network we have not seen recently.\nTime: {time} UTC\nDevice: {device}\n\nIf this was you, there is nothing to do. If it was not, change your password now (ask the admin to unlock it) and contact support.', buttonLabel: 'Open your profile' },
  },
  payment_deposit_submitted: {
    title: 'Activation payment received', group: 'Activation and referrals', when: 'When a member submits their activation payment.', category: 'payment',
    vars: { ...USER, ...MONEY }, button: false,
    defaults: { subject: 'Pexerearn: Activation payment {reference} received', heading: 'We received your activation payment', body: 'Hello @{username},\n\nWe received your activation payment of {amount} (reference {reference}). Our team is checking it against our statement and will activate your account as soon as it is found.' },
  },
  payment_deposit_confirmed: {
    title: 'Welcome: account activated', group: 'Activation and referrals', when: 'When the activation payment is confirmed.', category: 'payment',
    vars: { ...USER, ...MONEY }, button: true,
    defaults: { subject: 'Pexerearn: Welcome! Your account is active', heading: 'Welcome to Pexerearn', body: `Hello @{username},\n\nYour activation payment of {amount} (reference {reference}) is confirmed and your account is now active.\n\n${NEXT_STEPS}`, buttonLabel: 'Open your dashboard' },
  },
  payment_deposit_rejected: {
    title: 'Activation payment not confirmed', group: 'Activation and referrals', when: 'When staff reject an activation payment.', category: 'payment',
    vars: { ...USER, ...MONEY, ...REASON }, button: true,
    defaults: { subject: 'Pexerearn: Activation payment {reference} not confirmed', heading: 'We could not confirm your payment', body: 'Hello @{username},\n\nWe could not confirm your activation payment {reference}.\n\nReason: {reason}\n\nOpen the Activate page to submit it again, or contact support if you think this is a mistake.', buttonLabel: 'Open the Activate page' },
  },
  activated_by: {
    title: 'Welcome: activated by someone else', group: 'Activation and referrals', when: 'When another member activates this account with a voucher or Pay For Client.', category: 'account',
    vars: { ...USER, how: { about: 'How it was activated', sample: 'a payment from @john' } }, button: true,
    defaults: { subject: 'Pexerearn: Welcome! Your account is active', heading: 'Welcome to Pexerearn', body: `Hello @{username},\n\nYour account was activated with {how}. You can now use every part of Pexerearn.\n\n${NEXT_STEPS}`, buttonLabel: 'Open your dashboard' },
  },
  referral_signup: {
    title: 'Someone joined with your link', group: 'Activation and referrals', when: 'To the inviter, right when someone signs up with their username. Members can turn it off.', category: 'referral',
    vars: { ...USER, member: { about: 'Username of the new member', sample: 'peter' }, country: { about: "The new member's country", sample: 'Uganda' } }, button: true,
    defaults: { subject: 'Pexerearn: @{member} joined with your link', heading: 'Someone joined with your link', body: 'Hello @{username},\n\n@{member} ({country}) just created a Pexerearn account with your username as the referral code.\n\nYour referral reward is paid when they activate their account, and we will email you then.', buttonLabel: 'See your referrals' },
  },
  referral_reward: {
    title: 'Referral reward earned', group: 'Activation and referrals', when: 'To each inviter (levels 1 to 3) when an invited member activates. Members can turn it off.', category: 'referral',
    vars: {
      ...USER, member: { about: 'Username of the member who activated', sample: 'peter' }, amount: { about: 'The reward with its currency', sample: 'UGX 10,000' },
      level: { about: 'The referral level (1 to 3)', sample: '1' },
      conversion: { about: 'A sentence about the currency conversion, only for members in another country', sample: '@peter paid in KES, so the reward of KES 348.83 was converted into your currency at the latest exchange rate.' },
    },
    button: true,
    defaults: { subject: 'Pexerearn: you earned {amount}', heading: 'You earned a referral reward', body: 'Hello @{username},\n\n@{member} activated their account, and {amount} (level {level}) was added to your balance.\n\n{conversion}', buttonLabel: 'See your referrals' },
  },
  payment_wallet_deposit_submitted: {
    title: 'Deposit received', group: 'Payments', when: 'When an activated member submits a deposit.', category: 'payment',
    vars: { ...USER, ...MONEY }, button: false,
    defaults: { subject: 'Pexerearn: Deposit {reference} received', heading: 'We received your deposit', body: 'Hello @{username},\n\nWe received your deposit of {amount} (reference {reference}). Our team will credit your balance as soon as it is found on our statement.' },
  },
  payment_wallet_deposit_confirmed: {
    title: 'Deposit credited', group: 'Payments', when: 'When staff confirm a deposit.', category: 'payment',
    vars: { ...USER, ...MONEY }, button: true,
    defaults: { subject: 'Pexerearn: Deposit {reference} credited', heading: 'Deposit credited', body: 'Hello @{username},\n\n{amount} has been credited to your balance (deposit {reference}).', buttonLabel: 'Open your dashboard' },
  },
  payment_wallet_deposit_rejected: {
    title: 'Deposit not credited', group: 'Payments', when: 'When staff reject a deposit.', category: 'payment',
    vars: { ...USER, ...MONEY, ...REASON }, button: false,
    defaults: { subject: 'Pexerearn: Deposit {reference} not credited', heading: 'We could not credit your deposit', body: 'Hello @{username},\n\nWe could not credit your deposit {reference}.\n\nReason: {reason}\n\nContact support if you think this is a mistake.' },
  },
  payment_withdrawal_requested: {
    title: 'Withdrawal requested', group: 'Payments', when: 'When a member asks for a withdrawal.', category: 'payment',
    vars: { ...USER, ...MONEY }, button: false,
    defaults: { subject: 'Pexerearn: Withdrawal {reference} requested', heading: 'Withdrawal requested', body: 'Hello @{username},\n\nYour withdrawal of {amount} (reference {reference}) is waiting for approval. The amount and fee are on hold until it is paid.' },
  },
  payment_withdrawal_approved: {
    title: 'Withdrawal approved', group: 'Payments', when: 'When staff approve a withdrawal.', category: 'payment',
    vars: { ...USER, ...MONEY }, button: false,
    defaults: { subject: 'Pexerearn: Withdrawal {reference} approved', heading: 'Withdrawal approved', body: 'Hello @{username},\n\nYour withdrawal of {amount} (reference {reference}) is approved and will be sent to your verified phone soon.' },
  },
  payment_withdrawal_paid: {
    title: 'Withdrawal paid', group: 'Payments', when: 'When staff record the payout.', category: 'payment',
    vars: { ...USER, ...MONEY, payout: { about: 'The payout transaction ID (paragraph left out without one)', sample: 'MP2610290815' } }, button: true,
    defaults: { subject: 'Pexerearn: Withdrawal {reference} paid', heading: 'Withdrawal paid', body: 'Hello @{username},\n\n{amount} has been sent to your verified phone (withdrawal {reference}).\n\nPayout transaction: {payout}\n\nIf it has not arrived, open the Withdraw page and use Report a problem, or contact support.', buttonLabel: 'Open the Withdraw page' },
  },
  payment_withdrawal_failed: {
    title: 'Withdrawal failed', group: 'Payments', when: 'When a payout fails.', category: 'payment',
    vars: { ...USER, ...MONEY, ...REASON }, button: false,
    defaults: { subject: 'Pexerearn: Withdrawal {reference} failed', heading: 'Withdrawal failed', body: 'Hello @{username},\n\nWe could not send your withdrawal {reference}. The full amount and fee are back in your balance.\n\nReason: {reason}' },
  },
  payment_withdrawal_cancelled: {
    title: 'Withdrawal cancelled', group: 'Payments', when: 'When a withdrawal is cancelled by the member or staff.', category: 'payment',
    vars: { ...USER, ...MONEY, ...REASON }, button: false,
    defaults: { subject: 'Pexerearn: Withdrawal {reference} cancelled', heading: 'Withdrawal cancelled', body: 'Hello @{username},\n\nYour withdrawal {reference} was cancelled. The full amount and fee are back in your balance.\n\nReason: {reason}' },
  },
  issue_reply: {
    title: 'Reply to a payment report', group: 'Support', when: 'When staff answer a payment report.', category: 'payment',
    vars: { ...USER, reply: { about: "The staff member's reply", sample: 'We found your payment and confirmed it. Thank you for your patience.' } }, required: ['reply'], button: false,
    defaults: { subject: 'Pexerearn: reply to your payment report', heading: 'Reply to your payment report', body: 'Hello @{username},\n\nOur payments team replied to your report:\n\n{reply}\n\nTo answer, use Report a problem again or contact support.' },
  },
} satisfies Record<string, TemplateDef>;

export type TemplateKind = keyof typeof TEMPLATES;
export const isTemplateKind = (kind: string): kind is TemplateKind => Object.hasOwn(TEMPLATES, kind);
const def = (kind: TemplateKind): TemplateDef => TEMPLATES[kind];

const FILL_IN = /\{([A-Za-z]+)\}/g;
const fillIns = (text: string) => [...text.matchAll(FILL_IN)].map(m => m[1]!);

export const ContentSchema = z.strictObject({
  subject: z.string().trim().min(3).max(150),
  heading: z.string().trim().min(1).max(150),
  body: z.string().trim().min(1).max(5000),
  buttonLabel: z.string().trim().min(1).max(40).optional(),
});

// Checks an admin's wording against the kind: only its fill-ins, the required ones kept, a button label when
// the email has a button.
export function validateContent(kind: TemplateKind, raw: unknown): TemplateContent {
  const content = parse(ContentSchema, raw);
  const d = def(kind);
  const errors: Record<string, string[]> = {};
  for (const field of ['subject', 'heading', 'body'] as const) {
    const unknown = fillIns(content[field]).filter(n => !Object.hasOwn(d.vars, n));
    if (unknown.length) errors[field] = [`Unknown fill-in ${unknown.map(n => `{${n}}`).join(', ')}. This email can use ${Object.keys(d.vars).map(n => `{${n}}`).join(', ') || 'none'}.`];
  }
  const all = fillIns(`${content.subject} ${content.heading} ${content.body}`);
  const missing = (d.required ?? []).filter(n => !all.includes(n));
  if (missing.length) errors.body = [...(errors.body ?? []), `Keep ${missing.map(n => `{${n}}`).join(', ')}: this email is useless without it.`];
  if (d.button && !content.buttonLabel) errors.buttonLabel = ['This email has a button. Give it a label.'];
  if (Object.keys(errors).length) throw badRequest('validation_failed', 'Check the email wording.', errors);
  return d.button ? content : { subject: content.subject, heading: content.heading, body: content.body };
}

export async function currentContent(db: Db, kind: TemplateKind): Promise<{ content: TemplateContent; version: number; custom: boolean }> {
  const row = await maybeOne<{ content: TemplateContent | null; version: number }>(db, 'SELECT content, version FROM current_email_templates WHERE kind = $1', [kind]);
  return row?.content ? { content: row.content, version: row.version, custom: true } : { content: def(kind).defaults, version: row?.version ?? 0, custom: false };
}

// Saves a new version (null goes back to the built-in wording).
export async function saveContent(db: Db, kind: TemplateKind, content: TemplateContent | null, actorUserId: number, note: string): Promise<number> {
  const row = await one<{ version: number }>(
    db,
    `INSERT INTO email_templates (kind, version, content, note, created_by)
     SELECT $1, coalesce(max(version), 0) + 1, $2, $3, $4 FROM email_templates WHERE kind = $1 RETURNING version`,
    [kind, content === null ? null : JSON.stringify(content), note, actorUserId],
  );
  return row.version;
}

export interface FilledEmail {
  subject: string;
  heading: string;
  paragraphs: string[];
  buttonLabel?: string;
  note?: string;
}

// Puts the values into the wording. A paragraph with a fill-in that has no value is left out.
export function fill(kind: TemplateKind, content: TemplateContent, values: Record<string, string | null | undefined>): FilledEmail {
  const put = (text: string) => text.replace(FILL_IN, (_m, name: string) => values[name] ?? '');
  const paragraphs = content.body.split(/\n\s*\n/)
    .filter(p => fillIns(p).every(n => (values[n] ?? '').trim() !== ''))
    .map(p => put(p).trim())
    .filter(Boolean);
  const d = def(kind);
  return {
    subject: put(content.subject).replace(/\s+/g, ' ').trim().slice(0, 200),
    heading: put(content.heading),
    paragraphs,
    ...(d.button && content.buttonLabel ? { buttonLabel: put(content.buttonLabel) } : {}),
    ...(d.note ? { note: d.note } : {}),
  };
}

export const sampleValues = (kind: TemplateKind) => Object.fromEntries(Object.entries(def(kind).vars).map(([n, v]) => [n, v.sample]));

export interface TemplatedEmail {
  kind: TemplateKind;
  to: string;
  userId?: number | null;
  ref?: string;
  values: Record<string, string | null | undefined>;
  /** Where the button goes; required for kinds with a button. */
  buttonUrl?: string;
}

// Sends an automatic email in the current wording. Never throws (sendEmail logs and records failures).
export async function sendTemplated(services: Services, email: TemplatedEmail): Promise<SendOutcome> {
  let filled: FilledEmail;
  try {
    filled = fill(email.kind, (await currentContent(services.pool, email.kind)).content, email.values);
  } catch (err) {
    services.logger.error({ err, kind: email.kind }, 'email template unreadable; using the built-in wording');
    filled = fill(email.kind, def(email.kind).defaults, email.values);
  }
  return sendEmail(services, {
    to: email.to, userId: email.userId ?? null, kind: email.kind, category: def(email.kind).category, ...(email.ref ? { ref: email.ref } : {}),
    subject: filled.subject, heading: filled.heading, paragraphs: filled.paragraphs,
    ...(filled.buttonLabel && email.buttonUrl ? { button: { label: filled.buttonLabel, url: email.buttonUrl } } : {}),
    ...(filled.note ? { note: filled.note } : {}),
  });
}

export function templateCatalogue() {
  return (Object.keys(TEMPLATES) as TemplateKind[]).map(kind => {
    const d = def(kind);
    return {
      kind, title: d.title, group: d.group, when: d.when, category: d.category, button: d.button, note: d.note ?? null,
      fillIns: Object.entries(d.vars).map(([name, v]) => ({ name, about: v.about, sample: v.sample })),
      required: d.required ?? [], defaults: d.defaults,
    };
  });
}
