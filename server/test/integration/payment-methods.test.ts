import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/tx.js';
import { accountId, move, post } from '../../src/modules/ledger/ledger.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import type { TestClient } from '../helpers/client.js';
import { createStaff, loginStaff, registerMember } from '../helpers/factories.js';

// Admins add, edit, remove and restore the payment methods members see, per country.
let app: TestApp;
let admin: TestClient;
let finance: TestClient;

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call */
type Body = Record<string, any> & { error?: { code: string; fields?: Record<string, string[]> } };
const kenyanPhone = () => `+25471${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
const method = { name: 'M-Pesa Paybill', accountName: 'PEXEREARN TEST', accountNumber: '400200', merchantCode: '400200' };

beforeAll(async () => {
  app = await startTestApp();
  admin = await loginStaff(app, await createStaff(app, ['admin']));
  finance = await loginStaff(app, await createStaff(app, ['finance']));
});
afterAll(async () => {
  await app.close();
});

describe('payment methods', () => {
  it('shows each country only its own methods, and an admin can add and edit them', async () => {
    const kenyan = await registerMember(app, { country: 'KE', phone: kenyanPhone() });
    const ugandan = await registerMember(app);
    expect((await finance.post<Body>('/api/admin/payments/channels', { country: 'KE', ...method })).status).toBe(403);
    const added = await admin.post<Body>('/api/admin/payments/channels', { country: 'KE', ...method });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body.code).toBe('m_pesa_paybill_ke');
    // Same name again gets its own code.
    expect((await admin.post<Body>('/api/admin/payments/channels', { country: 'KE', ...method, name: 'M-Pesa Paybill' })).body.code).toBe('m_pesa_paybill_ke_2');

    const seen = (await kenyan.client.get<Body>('/api/payments/channels')).body.channels;
    expect(seen.map((c: Body) => c.code)).toEqual(['m_pesa_paybill_ke', 'm_pesa_paybill_ke_2']);
    expect((await ugandan.client.get<Body>('/api/payments/channels')).body.channels.map((c: Body) => c.code)).not.toContain('m_pesa_paybill_ke');

    expect((await admin.patch<Body>('/api/admin/payments/channels/m_pesa_paybill_ke', { name: 'M-Pesa', ussdCode: '*334#' })).status).toBe(200);
    const edited = (await kenyan.client.get<Body>('/api/payments/channels')).body.channels.find((c: Body) => c.code === 'm_pesa_paybill_ke');
    expect([edited.name, edited.ussdCode]).toEqual(['M-Pesa', '*334#']);
    const ke = (await admin.get<Body>('/api/admin/payments/channels?country=KE')).body.channels;
    expect(ke.every((c: Body) => c.countryCode === 'KE')).toBe(true);
  });

  it('adds a payment link that members open, claimed and approved by hand (owner, 2026-11-01)', async () => {
    const kenyan = await registerMember(app, { country: 'KE', phone: kenyanPhone() });
    const link = { name: 'Pay by card', accountName: 'PEXEREARN', accountNumber: 'Card payment' };
    expect((await admin.post<Body>('/api/admin/payments/channels', { country: 'KE', ...link, payUrl: 'http://pay.example/x' })).body.error?.fields?.payUrl).toBeDefined();
    const code = (await admin.post<Body>('/api/admin/payments/channels', { country: 'KE', ...link, payUrl: 'https://pay.example/pexerearn' })).body.code as string;
    const seen = () => kenyan.client.get<Body>('/api/payments/channels').then(r => r.body.channels.find((c: Body) => c.code === code));
    expect((await seen()).payUrl).toBe('https://pay.example/pexerearn');
    // The member claims with the reference; it waits for staff like any manual payment.
    const claim = await kenyan.client.post<Body>('/api/payments/deposits', { channel: code, senderPhone: kenyan.input.phone, providerTxnId: `TX${randomUUID().slice(0, 8)}` }, { 'idempotency-key': randomUUID() });
    expect(claim.status, JSON.stringify(claim.body)).toBe(201);
    expect(claim.body.deposit.status).toBe('pending');
    // Editing keeps the link unless it is cleared with an empty value.
    await admin.patch<Body>(`/api/admin/payments/channels/${code}`, { name: 'Card or bank (link)' });
    expect((await seen()).payUrl).toBe('https://pay.example/pexerearn');
    await admin.patch<Body>(`/api/admin/payments/channels/${code}`, { payUrl: '' });
    expect((await seen()).payUrl).toBeNull();
  });

  it('removes an unused method from members, restores it switched off, and refuses one that holds money', async () => {
    const kenyan = await registerMember(app, { country: 'KE', phone: kenyanPhone() });
    const code = (await admin.post<Body>('/api/admin/payments/channels', { country: 'KE', ...method, name: 'Airtel KE' })).body.code as string;
    expect((await admin.post<Body>(`/api/admin/payments/channels/${code}/remove`, { reason: 'Number closed' })).status).toBe(200);
    expect((await kenyan.client.get<Body>('/api/payments/channels')).body.channels.map((c: Body) => c.code)).not.toContain(code);
    expect((await admin.get<Body>('/api/admin/payments/channels?country=KE')).body.channels.map((c: Body) => c.code)).not.toContain(code);
    const archived = (await admin.get<Body>('/api/admin/payments/channels?country=KE&removed=1')).body.channels.find((c: Body) => c.code === code);
    expect([archived.depositsEnabled, archived.payoutsEnabled, Boolean(archived.removedAt)]).toEqual([false, false, true]);
    // A member cannot pay into a removed method.
    const claim = await kenyan.client.post<Body>('/api/payments/deposits', { channel: code, senderPhone: kenyan.input.phone, providerTxnId: `TX${randomUUID().slice(0, 8)}` }, { 'idempotency-key': randomUUID() });
    expect(claim.body.error?.code).toBe('payments.channel_unavailable');

    expect((await admin.patch<Body>(`/api/admin/payments/channels/${code}`, { depositsEnabled: true })).body.error?.code).toBe('channel.removed');
    expect((await admin.post<Body>(`/api/admin/payments/channels/${code}/restore`, {})).status).toBe(200);
    expect((await admin.patch<Body>(`/api/admin/payments/channels/${code}`, { depositsEnabled: true })).status).toBe(200);
    expect((await kenyan.client.get<Body>('/api/payments/channels')).body.channels.map((c: Body) => c.code)).toContain(code);

    // A method the ledger says holds money cannot be removed.
    const channelId = (await app.owner.query<{ id: string }>('SELECT id FROM payment_channels WHERE code = $1', [code])).rows[0]!.id;
    await withTransaction(app.services.pool, async db => {
      const cash = await accountId(db, { kind: 'payment_clearing', channelId: Number(channelId), currency: 'KES' });
      const capital = await accountId(db, { kind: 'owner_capital', currency: 'KES' });
      await post(db, { kind: 'test_capital', memo: 'test float', legs: move(cash, capital, 1000n) });
    });
    expect((await admin.post<Body>(`/api/admin/payments/channels/${code}/remove`, { reason: 'Number closed' })).body.error?.code).toBe('channel.holds_money');
    const audited = await app.owner.query(`SELECT action FROM audit_log WHERE target_id = $1 ORDER BY id`, [code]);
    expect(audited.rows.map(r => r.action)).toEqual(['channel.created', 'channel.removed', 'channel.restored', 'channel.updated']);
  });
});
