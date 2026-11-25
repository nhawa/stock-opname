import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/types.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
if (!databaseUrl) throw new Error('DATABASE_URL_TEST is required to run API integration tests.');

const config: AppConfig = {
  jwt: {
    secret: 'test-jwt-secret-that-is-at-least-thirty-two-characters',
    issuer: 'stock-opname-api-test',
    audience: 'stock-opname-client-test',
    expiresInSeconds: 900,
  },
};
const pool = new Pool({ connectionString: databaseUrl });
const app = createApp(config, pool);
const rice = '33333333-3333-3333-3333-333333333301';

const jakartaStore = '11111111-1111-1111-1111-111111111111';

beforeEach(async () => {
  await pool.query('DELETE FROM inventory_movements WHERE store_id = $1 AND product_id = $2', [jakartaStore, rice]);
  await pool.query('UPDATE inventory_balances SET quantity = 0, version = 0 WHERE store_id = $1 AND product_id = $2', [jakartaStore, rice]);
});
after(async () => {
  await pool.query('DELETE FROM inventory_movements WHERE store_id = $1 AND product_id = $2', [jakartaStore, rice]);
  await pool.query('UPDATE inventory_balances SET quantity = 25, version = 1 WHERE store_id = $1 AND product_id = $2', [jakartaStore, rice]);
  await pool.query(
    `INSERT INTO inventory_movements (
       id, store_id, product_id, inventory_version, movement_type, quantity_delta,
       reference_type, reference_id, actor_id
     ) VALUES (
       '44444444-4444-4444-4444-444444444401', $1, $2, 1, 'OPENING_BALANCE', 25,
       'DEVELOPMENT_SEED', 'opening-jkt-rice', '22222222-2222-2222-2222-222222222202'
     )`,
    [jakartaStore, rice],
  );
  await pool.end();
});

async function login(email: string): Promise<string> {
  const response = await request(app).post('/api/auth/login').send({ email, password: 'password' }).expect(200);
  return response.body.accessToken as string;
}

test('manager posts idempotent inventory movements and staff may only read', async () => {
  const manager = await login('manager.jakarta@example.test');
  const staff = await login('staff.jakarta@example.test');
  const opening = {
    productId: rice,
    quantity: '10.5',
    referenceType: 'OPENING_BALANCE',
    referenceId: 'initial-rice',
    idempotencyKey: 'opening-rice-test',
  };

  const first = await request(app).post('/api/inventory/opening-balance').set('Authorization', `Bearer ${manager}`).send(opening).expect(201);
  assert.equal(first.body.inventoryVersion, '1');
  assert.equal(first.body.balanceQuantity, '10.500');

  const replay = await request(app).post('/api/inventory/opening-balance').set('Authorization', `Bearer ${manager}`).send(opening).expect(201);
  assert.deepEqual(replay.body, first.body);

  await request(app)
    .post('/api/inventory/receipts')
    .set('Authorization', `Bearer ${manager}`)
    .send({ productId: rice, quantity: '2', referenceType: 'GOODS_RECEIPT', referenceId: 'gr-1', idempotencyKey: 'receipt-rice-test' })
    .expect(201);

  await request(app)
    .post('/api/inventory/stock-outs')
    .set('Authorization', `Bearer ${manager}`)
    .send({ productId: rice, quantity: '13', referenceType: 'STOCK_OUT', referenceId: 'so-1', idempotencyKey: 'stock-out-rice-test' })
    .expect(409);

  await request(app).post('/api/inventory/receipts').set('Authorization', `Bearer ${staff}`).send({}).expect(403);
  const products = await request(app).get('/api/products').set('Authorization', `Bearer ${staff}`).expect(200);
  assert.ok(products.body.some((item: { id: string }) => item.id === rice));
  const balances = await request(app).get('/api/inventory').set('Authorization', `Bearer ${staff}`).expect(200);
  const balance = balances.body.find((item: { id: string }) => item.id === rice);
  assert.equal(balance.quantity, '12.500');
  assert.equal(balance.version, '2');
});

test('idempotency key cannot be repurposed', async () => {
  const manager = await login('manager.jakarta@example.test');
  await request(app)
    .post('/api/inventory/receipts')
    .set('Authorization', `Bearer ${manager}`)
    .send({ productId: rice, quantity: '1', referenceType: 'GOODS_RECEIPT', referenceId: 'first', idempotencyKey: 'shared-key' })
    .expect(201);
  await request(app)
    .post('/api/inventory/receipts')
    .set('Authorization', `Bearer ${manager}`)
    .send({ productId: rice, quantity: '2', referenceType: 'GOODS_RECEIPT', referenceId: 'different', idempotencyKey: 'shared-key' })
    .expect(409);
});

test('concurrent receipts serialize versions without losing stock', async () => {
  const manager = await login('manager.jakarta@example.test');
  const receive = (idempotencyKey: string, referenceId: string) => request(app)
    .post('/api/inventory/receipts')
    .set('Authorization', `Bearer ${manager}`)
    .send({ productId: rice, quantity: '2', referenceType: 'GOODS_RECEIPT', referenceId, idempotencyKey });

  const [first, second] = await Promise.all([
    receive('concurrent-receipt-a', 'receipt-a'),
    receive('concurrent-receipt-b', 'receipt-b'),
  ]);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);

  const balance = await pool.query<{ quantity: string; version: string }>(
    'SELECT quantity::text AS quantity, version::text AS version FROM inventory_balances WHERE store_id = $1 AND product_id = $2',
    [jakartaStore, rice],
  );
  assert.equal(balance.rows[0]!.quantity, '4.000');
  assert.equal(balance.rows[0]!.version, '2');

  const movements = await pool.query<{ version: string }>(
    'SELECT inventory_version::text AS version FROM inventory_movements WHERE store_id = $1 AND product_id = $2 ORDER BY inventory_version',
    [jakartaStore, rice],
  );
  assert.deepEqual(movements.rows.map((row) => row.version), ['1', '2']);
});

test('concurrent stock-outs do not make the balance negative', async () => {
  const manager = await login('manager.jakarta@example.test');
  await request(app)
    .post('/api/inventory/opening-balance')
    .set('Authorization', `Bearer ${manager}`)
    .send({ productId: rice, quantity: '10', referenceType: 'OPENING_BALANCE', referenceId: 'opening', idempotencyKey: 'opening' })
    .expect(201);

  const stockOut = (idempotencyKey: string) => request(app)
    .post('/api/inventory/stock-outs')
    .set('Authorization', `Bearer ${manager}`)
    .send({ productId: rice, quantity: '7', referenceType: 'STOCK_OUT', referenceId: idempotencyKey, idempotencyKey });
  const results = await Promise.all([stockOut('stock-out-a'), stockOut('stock-out-b')]);
  assert.equal(results.filter((result) => result.status === 201).length, 1);
  assert.equal(results.filter((result) => result.status === 409).length, 1);

  const balance = await pool.query<{ quantity: string; version: string }>(
    'SELECT quantity::text AS quantity, version::text AS version FROM inventory_balances WHERE store_id = $1 AND product_id = $2',
    [jakartaStore, rice],
  );
  assert.equal(balance.rows[0]!.quantity, '3.000');
  assert.equal(balance.rows[0]!.version, '2');
});
