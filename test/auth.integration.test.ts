import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { Client } from 'pg';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { attachStoreOwnedResource, authenticate, requireRoles } from '../src/auth/middleware.js';
import type { AppConfig } from '../src/types.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
if (!databaseUrl) {
  throw new Error('DATABASE_URL_TEST is required to run API integration tests.');
}

const config: AppConfig = {
  jwt: {
    secret: 'test-jwt-secret-that-is-at-least-thirty-two-characters',
    issuer: 'stock-opname-api-test',
    audience: 'stock-opname-client-test',
    expiresInSeconds: 900,
  },
  stockOpname: { countReservationActiveSeconds: 600 },
};

const jakartaStore = '11111111-1111-1111-1111-111111111111';
const bandungStore = '11111111-1111-1111-1111-111111111112';
const database = new Client({ connectionString: databaseUrl });

const app = createApp(config, database, (testApp) => {
  const auth = authenticate(database, config);

  testApp.get('/test/manager-only', auth, requireRoles('MANAGER'), (_request, response) => {
    response.status(204).send();
  });

  testApp.get(
    '/test/resources/:resourceId',
    auth,
    attachStoreOwnedResource(async (testRequest) => {
      const resourceStores: Record<string, string> = {
        'jakarta-rice': jakartaStore,
        'bandung-rice': bandungStore,
      };
      const resourceId = String(testRequest.params.resourceId);
      const storeId = resourceStores[resourceId];
      return storeId ? { id: resourceId, storeId } : null;
    }),
    (_request, response) => response.status(204).send(),
  );
});

before(async () => {
  await database.connect();
});

after(async () => {
  await database.end();
});

async function login(email: string): Promise<string> {
  const response = await request(app)
    .post('/api/auth/login')
    .set('Content-Type', 'application/json')
    .send({ email, password: 'password' })
    .expect(200);
  assert.equal(response.body.tokenType, 'Bearer');
  return response.body.accessToken as string;
}

test('login and current user expose only a safe profile', async () => {
  const token = await login('staff.jakarta@example.test');
  const response = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`).expect(200);

  assert.deepEqual(response.body, {
    id: '22222222-2222-2222-2222-222222222201',
    storeId: jakartaStore,
    email: 'staff.jakarta@example.test',
    name: 'Jakarta Staff',
    role: 'STAFF',
  });
  assert.equal('passwordHash' in response.body, false);
});

test('authentication rejects invalid credentials and missing tokens', async () => {
  await request(app)
    .post('/api/auth/login')
    .set('Content-Type', 'application/json')
    .send({ email: 'staff.jakarta@example.test', password: 'wrong-password' })
    .expect(401);
  await request(app).get('/api/auth/me').expect(401);
});

test('role middleware permits managers and rejects staff', async () => {
  const managerToken = await login('manager.jakarta@example.test');
  const staffToken = await login('staff.jakarta@example.test');

  await request(app).get('/test/manager-only').set('Authorization', `Bearer ${managerToken}`).expect(204);
  await request(app).get('/test/manager-only').set('Authorization', `Bearer ${staffToken}`).expect(403);
});

test('focused ownership middleware rejects a foreign-store identity', async () => {
  const jakartaToken = await login('staff.jakarta@example.test');
  const bandungToken = await login('staff.bandung@example.test');

  await request(app)
    .get('/test/resources/jakarta-rice?store_id=' + bandungStore)
    .set('Authorization', `Bearer ${jakartaToken}`)
    .expect(204);
  await request(app)
    .get('/test/resources/jakarta-rice?store_id=' + jakartaStore)
    .set('Authorization', `Bearer ${bandungToken}`)
    .expect(403);
  await request(app).get('/test/resources/unknown').set('Authorization', `Bearer ${jakartaToken}`).expect(404);
});

test('logout acknowledges client-side token disposal', async () => {
  const token = await login('manager.jakarta@example.test');
  await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${token}`).expect(204);
});
