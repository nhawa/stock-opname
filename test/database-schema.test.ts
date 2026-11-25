import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_URL_TEST;
if (!databaseUrl) {
  throw new Error('DATABASE_URL_TEST is required to run database schema verification.');
}

const jakartaStore = '11111111-1111-1111-1111-111111111111';
const jakartaManager = '22222222-2222-2222-2222-222222222202';
const rice = '33333333-3333-3333-3333-333333333301';

async function expectConstraintFailure(
  client: Client,
  action: () => Promise<unknown>,
): Promise<void> {
  await client.query('SAVEPOINT constraint_check');
  await assert.rejects(action, (error: { code?: string }) =>
    error.code === '23505' || error.code === '23514',
  );
  await client.query('ROLLBACK TO SAVEPOINT constraint_check');
}

test('seeded balances equal their ledger movements and versions', async () => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{
      quantity: string;
      version: string;
      ledger_quantity: string;
      ledger_version: string;
    }>(`
      SELECT b.quantity, b.version,
             COALESCE(SUM(m.quantity), 0) AS ledger_quantity,
             COALESCE(MAX(m.inventory_version), 0) AS ledger_version
      FROM inventory_balances b
      LEFT JOIN LATERAL (
        SELECT quantity_delta AS quantity, inventory_version
        FROM inventory_movements m
        WHERE m.store_id = b.store_id AND m.product_id = b.product_id
      ) m ON true
      GROUP BY b.store_id, b.product_id, b.quantity, b.version
      ORDER BY b.store_id, b.product_id
    `);
    assert.equal(result.rowCount, 4);
    for (const row of result.rows) {
      assert.equal(row.quantity, row.ledger_quantity);
      assert.equal(row.version, row.ledger_version);
    }
  } finally {
    await client.end();
  }
});

test('critical schema constraints reject invalid records', async () => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');

    await expectConstraintFailure(client, () =>
      client.query(
        'UPDATE inventory_balances SET quantity = -1 WHERE store_id = $1 AND product_id = $2',
        [jakartaStore, rice],
      ),
    );

    const session = await client.query<{ id: string }>(`
      INSERT INTO stock_opname_sessions (store_id, status, initiated_by)
      VALUES ($1, 'COUNTING', $2)
      RETURNING id
    `, [jakartaStore, jakartaManager]);

    await expectConstraintFailure(client, () =>
      client.query(
        `INSERT INTO stock_opname_sessions (store_id, status, initiated_by)
         VALUES ($1, 'COUNTING', $2)`,
        [jakartaStore, jakartaManager],
      ),
    );

    await expectConstraintFailure(client, () =>
      client.query(
        `INSERT INTO inventory_movements (
           store_id, product_id, inventory_version, movement_type, quantity_delta, reference_type, reference_id
         ) VALUES ($1, $2, 1, 'RECEIPT', 1, 'PURCHASE_ORDER', 'duplicate-version')`,
        [jakartaStore, rice],
      ),
    );

    await client.query(
      `INSERT INTO inventory_movements (
         store_id, product_id, inventory_version, movement_type, quantity_delta,
         reference_type, reference_id, stock_opname_session_id, actor_id
       ) VALUES ($1, $2, 2, 'STOCK_OPNAME_ADJUSTMENT', -1,
                 'STOCK_OPNAME_SESSION', $3, $4, $5)`,
      [jakartaStore, rice, session.rows[0].id, session.rows[0].id, jakartaManager],
    );

    await expectConstraintFailure(client, () =>
      client.query(
        `INSERT INTO inventory_movements (
           store_id, product_id, inventory_version, movement_type, quantity_delta,
           reference_type, reference_id, stock_opname_session_id, actor_id
         ) VALUES ($1, $2, 3, 'STOCK_OPNAME_ADJUSTMENT', 1,
                   'STOCK_OPNAME_SESSION', $3, $4, $5)`,
        [jakartaStore, rice, session.rows[0].id, session.rows[0].id, jakartaManager],
      ),
    );

    await client.query('ROLLBACK');
  } finally {
    await client.end();
  }
});
