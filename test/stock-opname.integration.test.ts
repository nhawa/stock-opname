import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/types.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
if (!databaseUrl) throw new Error('DATABASE_URL_TEST is required to run API integration tests.');

const config: AppConfig = { jwt: { secret: 'test-jwt-secret-that-is-at-least-thirty-two-characters', issuer: 'stock-opname-api-test', audience: 'stock-opname-client-test', expiresInSeconds: 900 } };
const pool = new Pool({ connectionString: databaseUrl });
const app = createApp(config, pool);
const jakartaStore = '11111111-1111-1111-1111-111111111111';
const bandungStore = '11111111-1111-1111-1111-111111111112';
const rice = '33333333-3333-3333-3333-333333333301';

beforeEach(async () => {
  await pool.query('DELETE FROM audit_logs WHERE session_id IN (SELECT id FROM stock_opname_sessions WHERE store_id IN ($1, $2))', [jakartaStore, bandungStore]);
  await pool.query('DELETE FROM stock_opname_items WHERE session_id IN (SELECT id FROM stock_opname_sessions WHERE store_id IN ($1, $2))', [jakartaStore, bandungStore]);
  await pool.query('DELETE FROM stock_opname_sessions WHERE store_id IN ($1, $2)', [jakartaStore, bandungStore]);
});
after(async () => { await pool.end(); });

async function login(email: string): Promise<string> {
  const response = await request(app).post('/api/auth/login').send({ email, password: 'password' }).expect(200);
  return response.body.accessToken as string;
}

async function createSession(manager: string): Promise<{ id: string; items: { productId: string; snapshotQty: string; snapshotVersion: string }[] }> {
  const response = await request(app).post('/api/stock-opname/sessions').set('Authorization', `Bearer ${manager}`).send({}).expect(201);
  return response.body;
}

async function reserve(staff: string, sessionId: string, productId = rice): Promise<{ reservationToken: string; draftVersion: string }> {
  const response = await request(app)
    .post(`/api/stock-opname/sessions/${sessionId}/counts/reservations`)
    .set('Authorization', `Bearer ${staff}`).send({ productId }).expect(201);
  return response.body;
}

async function save(staff: string, sessionId: string, productId: string, reservationToken: string, draftVersion: string, countedQty: string): Promise<request.Response> {
  return request(app)
    .post(`/api/stock-opname/sessions/${sessionId}/counts/draft`)
    .set('Authorization', `Bearer ${staff}`)
    .send({ counts: [{ productId, reservationToken, draftVersion, countedQty }] });
}

test('manager initiates an active-product snapshot after prior movements', async () => {
  const manager = await login('manager.jakarta@example.test');
  const movement = await request(app).post('/api/inventory/receipts').set('Authorization', `Bearer ${manager}`)
    .send({ productId: rice, quantity: '1', referenceType: 'GOODS_RECEIPT', referenceId: 'snapshot-prior-movement', idempotencyKey: 'snapshot-prior-movement' }).expect(201);
  const session = await createSession(manager);
  const item = session.items.find((candidate) => candidate.productId === rice)!;
  assert.equal(item.snapshotQty, movement.body.balanceQuantity);
  assert.equal(item.snapshotVersion, movement.body.inventoryVersion);
});

test('duplicate active initiation is rejected', async () => {
  const manager = await login('manager.jakarta@example.test');
  await createSession(manager);
  await request(app).post('/api/stock-opname/sessions').set('Authorization', `Bearer ${manager}`).send({}).expect(409);
});

test('concurrent initiation allows exactly one active session', async () => {
  const manager = await login('manager.jakarta@example.test');
  const [first, second] = await Promise.all([
    request(app).post('/api/stock-opname/sessions').set('Authorization', `Bearer ${manager}`).send({}),
    request(app).post('/api/stock-opname/sessions').set('Authorization', `Bearer ${manager}`).send({}),
  ]);
  assert.equal([first.status, second.status].filter((status) => status === 201).length, 1);
  assert.equal([first.status, second.status].filter((status) => status === 409).length, 1);
});

test('permissions enforce manager initiation, staff counting, and own-store session access', async () => {
  const jakartaManager = await login('manager.jakarta@example.test');
  const jakartaStaff = await login('staff.jakarta@example.test');
  const bandungManager = await login('manager.bandung@example.test');
  const session = await createSession(jakartaManager);

  await request(app).post('/api/stock-opname/sessions').set('Authorization', `Bearer ${jakartaStaff}`).send({}).expect(403);
  await request(app).post(`/api/stock-opname/sessions/${session.id}/counts/reservations`).set('Authorization', `Bearer ${jakartaManager}`).send({ productId: rice }).expect(403);
  await request(app).get(`/api/stock-opname/sessions/${session.id}`).set('Authorization', `Bearer ${bandungManager}`).expect(404);
  await request(app).post(`/api/stock-opname/sessions/${session.id}/counts/reservations`).set('Authorization', `Bearer ${jakartaStaff}`).send({ productId: rice }).expect(201);
});

test('partial draft preserves zero as a count and rejects duplicate SKUs', async () => {
  const manager = await login('manager.jakarta@example.test');
  const staff = await login('staff.jakarta@example.test');
  const session = await createSession(manager);
  const reservation = await reserve(staff, session.id);
  const duplicate = await request(app).post(`/api/stock-opname/sessions/${session.id}/counts/draft`).set('Authorization', `Bearer ${staff}`).send({
    counts: [
      { productId: rice, reservationToken: reservation.reservationToken, draftVersion: reservation.draftVersion, countedQty: '0' },
      { productId: rice, reservationToken: reservation.reservationToken, draftVersion: reservation.draftVersion, countedQty: '0' },
    ],
  });
  assert.equal(duplicate.status, 400);
  const saved = await save(staff, session.id, rice, reservation.reservationToken, reservation.draftVersion, '0');
  assert.equal(saved.status, 200);
  assert.equal(saved.body[0].countedQty, '0.000');
  const detail = await request(app).get(`/api/stock-opname/sessions/${session.id}`).set('Authorization', `Bearer ${staff}`).expect(200);
  assert.ok(detail.body.items.some((item: { productId: string; countedQty: string | null }) => item.productId !== rice && item.countedQty === null));
});

test('concurrent drafts resolve to one save and a stale-draft conflict', async () => {
  const manager = await login('manager.jakarta@example.test');
  const staff = await login('staff.jakarta@example.test');
  const session = await createSession(manager);
  const reservation = await reserve(staff, session.id);
  const [first, second] = await Promise.all([
    save(staff, session.id, rice, reservation.reservationToken, reservation.draftVersion, '2'),
    save(staff, session.id, rice, reservation.reservationToken, reservation.draftVersion, '2'),
  ]);
  assert.equal([first.status, second.status].filter((status) => status === 200).length, 1);
  assert.equal([first.status, second.status].filter((status) => status === 409).length, 1);
});

test('submission leaves inventory unchanged and blocks later edits', async () => {
  const manager = await login('manager.jakarta@example.test');
  const staff = await login('staff.jakarta@example.test');
  const session = await createSession(manager);
  const before = await pool.query<{ quantity: string; version: string }>(
    'SELECT quantity::text AS quantity, version::text AS version FROM inventory_balances WHERE store_id = $1 AND product_id = $2', [jakartaStore, rice],
  );
  const reservation = await reserve(staff, session.id);
  await save(staff, session.id, rice, reservation.reservationToken, reservation.draftVersion, '0').then((response) => assert.equal(response.status, 200));
  await request(app).post(`/api/stock-opname/sessions/${session.id}/submit`).set('Authorization', `Bearer ${staff}`).send({}).expect(200);
  const afterBalance = await pool.query<{ quantity: string; version: string }>(
    'SELECT quantity::text AS quantity, version::text AS version FROM inventory_balances WHERE store_id = $1 AND product_id = $2', [jakartaStore, rice],
  );
  assert.deepEqual(afterBalance.rows, before.rows);
  await request(app).post(`/api/stock-opname/sessions/${session.id}/counts/reservations`).set('Authorization', `Bearer ${staff}`).send({ productId: rice }).expect(409);
  await save(staff, session.id, rice, reservation.reservationToken, reservation.draftVersion, '1').then((response) => assert.equal(response.status, 409));
});
