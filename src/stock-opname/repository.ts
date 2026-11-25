import type { QueryResultRow } from 'pg';
import type { Database } from '../types.js';
import type { StockOpnameItem, StockOpnameSession } from './types.js';

interface SessionRow extends QueryResultRow {
  id: string;
  store_id: string;
  status: StockOpnameSession['status'];
  initiated_by: string;
  initiated_at: Date;
  submitted_by: string | null;
  submitted_at: Date | null;
}

interface ItemRow extends QueryResultRow {
  id: string;
  product_id: string;
  sku: string;
  name: string;
  unit: string;
  snapshot_qty: string;
  snapshot_version: string;
  counted_qty: string | null;
  count_cutoff_version: string | null;
  counted_at: Date | null;
  counted_by: string | null;
  draft_version: string;
  reservation_token: string | null;
  reserved_by: string | null;
  reservation_version: string | null;
  reservation_expires_at: Date | null;
}

export async function lockStoreInitiation(database: Database, storeId: string): Promise<void> {
  await database.query("SELECT pg_advisory_xact_lock(hashtext('stock-opname:store'), hashtext($1))", [storeId]);
}

export async function listScopedProducts(database: Database): Promise<{ id: string }[]> {
  const result = await database.query<{ id: string } & QueryResultRow>(
    'SELECT id FROM products WHERE is_active = true ORDER BY id FOR SHARE',
  );
  return result.rows;
}

export async function ensureAndLockBalances(database: Database, storeId: string, productIds: readonly string[]): Promise<Map<string, { quantity: string; version: string }>> {
  if (productIds.length === 0) return new Map();
  await database.query(
    `INSERT INTO inventory_balances (store_id, product_id)
     SELECT $1, unnest($2::uuid[])
     ON CONFLICT (store_id, product_id) DO NOTHING`,
    [storeId, productIds],
  );
  const result = await database.query<{ product_id: string; quantity: string; version: string } & QueryResultRow>(
    `SELECT product_id, quantity::text AS quantity, version::text AS version
     FROM inventory_balances
     WHERE store_id = $1 AND product_id = ANY($2::uuid[])
     ORDER BY product_id
     FOR UPDATE`,
    [storeId, productIds],
  );
  return new Map(result.rows.map((row) => [row.product_id, { quantity: row.quantity, version: row.version }]));
}

export async function findActiveSession(database: Database, storeId: string): Promise<string | null> {
  const result = await database.query<{ id: string } & QueryResultRow>(
    "SELECT id FROM stock_opname_sessions WHERE store_id = $1 AND status IN ('COUNTING', 'SUBMITTED')",
    [storeId],
  );
  return result.rows[0]?.id ?? null;
}

export async function insertSessionWithItems(
  database: Database,
  storeId: string,
  actorId: string,
  balances: Map<string, { quantity: string; version: string }>,
): Promise<string> {
  const session = await database.query<{ id: string } & QueryResultRow>(
    `INSERT INTO stock_opname_sessions (store_id, status, initiated_by)
     VALUES ($1, 'COUNTING', $2) RETURNING id`,
    [storeId, actorId],
  );
  const sessionId = session.rows[0]!.id;
  for (const [productId, balance] of balances) {
    await database.query(
      `INSERT INTO stock_opname_items (session_id, product_id, snapshot_qty, snapshot_version)
       VALUES ($1, $2, $3, $4)`,
      [sessionId, productId, balance.quantity, balance.version],
    );
  }
  await insertAudit(database, sessionId, actorId, 'STOCK_OPNAME_INITIATED');
  return sessionId;
}

export async function insertAudit(database: Database, sessionId: string, actorId: string, action: string): Promise<void> {
  await database.query('INSERT INTO audit_logs (session_id, actor_id, action) VALUES ($1, $2, $3)', [sessionId, actorId, action]);
}

export async function listSessions(database: Database, storeId: string): Promise<StockOpnameSession[]> {
  const result = await database.query<SessionRow>(
    `SELECT id, store_id, status, initiated_by, initiated_at, submitted_by, submitted_at
     FROM stock_opname_sessions WHERE store_id = $1 ORDER BY initiated_at DESC`,
    [storeId],
  );
  return result.rows.map(toSession);
}

export async function getSession(database: Database, storeId: string, sessionId: string, lock = false): Promise<StockOpnameSession | null> {
  const result = await database.query<SessionRow>(
    `SELECT id, store_id, status, initiated_by, initiated_at, submitted_by, submitted_at
     FROM stock_opname_sessions WHERE id = $1 AND store_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [sessionId, storeId],
  );
  return result.rows[0] ? toSession(result.rows[0]) : null;
}

export async function listItems(database: Database, sessionId: string, productIds?: readonly string[]): Promise<StockOpnameItem[]> {
  const values: unknown[] = [sessionId];
  const productFilter = productIds ? ' AND i.product_id = ANY($2::uuid[])' : '';
  if (productIds) values.push(productIds);
  const result = await database.query<ItemRow>(
    `SELECT i.id, i.product_id, p.sku, p.name, p.unit,
            i.snapshot_qty::text AS snapshot_qty, i.snapshot_version::text AS snapshot_version,
            i.counted_qty::text AS counted_qty, i.count_cutoff_version::text AS count_cutoff_version,
            i.counted_at, i.counted_by, i.draft_version::text AS draft_version,
            i.reservation_token, i.reserved_by, i.reservation_version::text AS reservation_version,
            i.reservation_expires_at
     FROM stock_opname_items i JOIN products p ON p.id = i.product_id
     WHERE i.session_id = $1${productFilter} ORDER BY i.product_id`,
    values,
  );
  return result.rows.map(toItem);
}

export async function lockSessionOperation(database: Database, storeId: string, sessionId: string): Promise<StockOpnameSession | null> {
  await database.query("SELECT pg_advisory_xact_lock(hashtext('stock-opname:session'), hashtext($1))", [sessionId]);
  return getSession(database, storeId, sessionId, true);
}

export async function reserveItem(database: Database, sessionId: string, productId: string, actorId: string, token: string): Promise<boolean> {
  const result = await database.query(
    `UPDATE stock_opname_items item
     SET reservation_token = $4, reserved_by = $3, reservation_version = balance.version,
         reservation_expires_at = transaction_timestamp() + interval '10 minutes'
     FROM stock_opname_sessions session, inventory_balances balance
     WHERE item.session_id = $1 AND item.product_id = $2
       AND session.id = item.session_id AND session.status = 'COUNTING'
       AND balance.store_id = session.store_id AND balance.product_id = item.product_id
       AND item.counted_qty IS NULL
       AND (item.reservation_token IS NULL OR item.reservation_expires_at <= transaction_timestamp())`,
    [sessionId, productId, actorId, token],
  );
  return result.rowCount === 1;
}

export async function saveDraftItem(
  database: Database,
  sessionId: string,
  productId: string,
  actorId: string,
  token: string,
  draftVersion: string,
  countedQty: string,
): Promise<boolean> {
  const result = await database.query(
    `UPDATE stock_opname_items
     SET counted_qty = $6::numeric, count_cutoff_version = reservation_version,
         counted_at = transaction_timestamp(), counted_by = $3,
         draft_version = draft_version + 1,
         reservation_token = NULL, reserved_by = NULL, reservation_version = NULL, reservation_expires_at = NULL
     WHERE session_id = $1 AND product_id = $2 AND counted_qty IS NULL
       AND reservation_token = $4 AND reserved_by = $3
       AND draft_version = $5::bigint AND reservation_expires_at > transaction_timestamp()`,
    [sessionId, productId, actorId, token, draftVersion, countedQty],
  );
  return result.rowCount === 1;
}

export async function hasLiveReservations(database: Database, sessionId: string): Promise<string | null> {
  const result = await database.query<{ reservation_expires_at: Date } & QueryResultRow>(
    `SELECT reservation_expires_at FROM stock_opname_items
     WHERE session_id = $1 AND reservation_expires_at > transaction_timestamp()
     ORDER BY reservation_expires_at LIMIT 1`,
    [sessionId],
  );
  return result.rows[0]?.reservation_expires_at.toISOString() ?? null;
}

export async function submitSession(database: Database, sessionId: string, actorId: string): Promise<boolean> {
  const result = await database.query(
    `UPDATE stock_opname_sessions
     SET status = 'SUBMITTED', submitted_by = $2, submitted_at = transaction_timestamp()
     WHERE id = $1 AND status = 'COUNTING'`,
    [sessionId, actorId],
  );
  return result.rowCount === 1;
}

function toSession(row: SessionRow): StockOpnameSession {
  return {
    id: row.id, storeId: row.store_id, status: row.status, initiatedBy: row.initiated_by,
    initiatedAt: row.initiated_at.toISOString(), submittedBy: row.submitted_by,
    submittedAt: row.submitted_at?.toISOString() ?? null,
  };
}

function toItem(row: ItemRow): StockOpnameItem {
  return {
    id: row.id, productId: row.product_id, sku: row.sku, name: row.name, unit: row.unit,
    snapshotQty: row.snapshot_qty, snapshotVersion: row.snapshot_version, countedQty: row.counted_qty,
    countCutoffVersion: row.count_cutoff_version, countedAt: row.counted_at?.toISOString() ?? null,
    countedBy: row.counted_by, draftVersion: row.draft_version, reservationToken: row.reservation_token,
    reservedBy: row.reserved_by, reservationVersion: row.reservation_version,
    reservationExpiresAt: row.reservation_expires_at?.toISOString() ?? null,
  };
}
