import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { withTransaction } from '../src/db.js';
import { AppError } from '../src/errors.js';

function databaseError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function fakeDatabase(commitError?: Error): { database: any; queries: string[]; getCallbackCalls: () => number } {
  const queries: string[] = [];
  let callbackCalls = 0;
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql === 'COMMIT' && commitError) throw commitError;
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return {
    database: { connect: async () => client },
    queries,
    getCallbackCalls: () => callbackCalls,
  };
}

test('retries serializable failures (40001) without duplicating the callback result', async () => {
  const fixture = fakeDatabase();
  let attempts = 0;
  const result = await withTransaction(fixture.database, async () => {
    attempts += 1;
    if (attempts === 1) throw databaseError('40001');
    return 'committed';
  }, { isolationLevel: 'serializable', maxAttempts: 3 });

  assert.equal(result, 'committed');
  assert.equal(attempts, 2);
  assert.deepEqual(fixture.queries, ['BEGIN ISOLATION LEVEL SERIALIZABLE', 'ROLLBACK', 'BEGIN ISOLATION LEVEL SERIALIZABLE', 'COMMIT']);
});

test('retries deadlocks (40P01) and fails only after the retry budget is exhausted', async () => {
  const fixture = fakeDatabase();
  let attempts = 0;
  const result = await withTransaction(fixture.database, async () => {
    attempts += 1;
    if (attempts < 3) throw databaseError('40P01');
    return 'committed';
  }, { maxAttempts: 3 });

  assert.equal(result, 'committed');
  assert.equal(attempts, 3);
  assert.equal(fixture.queries.filter((sql) => sql === 'ROLLBACK').length, 2);
});

test('rolls back an injected failure after a ledger write', { skip: !process.env.DATABASE_URL_TEST }, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL_TEST });
  const referenceId = `rollback-check-${Date.now()}`;
  try {
    await assert.rejects(withTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO inventory_movements (
           store_id, product_id, inventory_version, movement_type, quantity_delta, reference_type, reference_id
         ) VALUES ($1, $2, 999999, 'RECEIPT', 1, 'ROLLBACK_TEST', $3)`,
        ['11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333302', referenceId],
      );
      throw new Error('injected failure');
    }));
    const result = await pool.query('SELECT 1 FROM inventory_movements WHERE reference_id = $1', [referenceId]);
    assert.equal(result.rowCount, 0);
  } finally {
    await pool.end();
  }
});

test('does not replay a callback after an unknown COMMIT outcome', async () => {
  const fixture = fakeDatabase(new Error('connection reset'));
  let callbackCalls = 0;
  await assert.rejects(
    withTransaction(fixture.database, async () => {
      callbackCalls += 1;
      return 'committed';
    }),
    (error: unknown) => error instanceof AppError && error.code === 'COMMIT_OUTCOME_UNKNOWN',
  );
  assert.equal(callbackCalls, 1);
  assert.deepEqual(fixture.queries, ['BEGIN', 'COMMIT', 'ROLLBACK']);
});
