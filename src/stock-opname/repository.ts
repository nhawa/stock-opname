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
  approved_by: string | null;
  approved_at: Date | null;
  rejected_by: string | null;
  rejected_at: Date | null;
  rejection_reason: string | null;
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

export async function insertAudit(
  database: Database,
  sessionId: string,
  actorId: string,
  action: string,
  metadata: unknown = {},
): Promise<void> {
  await database.query(
    'INSERT INTO audit_logs (session_id, actor_id, action, metadata) VALUES ($1, $2, $3, $4::jsonb)',
    [sessionId, actorId, action, JSON.stringify(metadata)],
  );
}

export async function listSessions(database: Database, storeId: string): Promise<StockOpnameSession[]> {
  const result = await database.query<SessionRow>(
    `SELECT id, store_id, status, initiated_by, initiated_at, submitted_by, submitted_at,
            approved_by, approved_at, rejected_by, rejected_at, rejection_reason
     FROM stock_opname_sessions WHERE store_id = $1 ORDER BY initiated_at DESC`,
    [storeId],
  );
  return result.rows.map(toSession);
}

export async function getSession(database: Database, storeId: string, sessionId: string, lock = false): Promise<StockOpnameSession | null> {
  const result = await database.query<SessionRow>(
    `SELECT id, store_id, status, initiated_by, initiated_at, submitted_by, submitted_at,
            approved_by, approved_at, rejected_by, rejected_at, rejection_reason
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

export async function reserveItem(
  database: Database,
  sessionId: string,
  productId: string,
  actorId: string,
  token: string,
  reservationActiveSeconds: number,
): Promise<boolean> {
  const result = await database.query(
    `UPDATE stock_opname_items item
     SET reservation_token = $4, reserved_by = $3, reservation_version = balance.version,
         reservation_expires_at = transaction_timestamp() + ($5 * interval '1 second')
     FROM stock_opname_sessions session, inventory_balances balance
     WHERE item.session_id = $1 AND item.product_id = $2
       AND session.id = item.session_id AND session.status = 'COUNTING'
       AND balance.store_id = session.store_id AND balance.product_id = item.product_id
       AND item.counted_qty IS NULL
       AND (item.reservation_token IS NULL OR item.reservation_expires_at <= transaction_timestamp())`,
    [sessionId, productId, actorId, token, reservationActiveSeconds],
  );
  return result.rowCount === 1;
}

export async function saveDraftItem(
  database: Database,
  sessionId: string,
  productId: string,
  actorId: string,
  token: string,
  countedQty: string,
): Promise<boolean> {
  const result = await database.query(
    `UPDATE stock_opname_items
     SET counted_qty = $5::numeric, count_cutoff_version = reservation_version,
         counted_at = transaction_timestamp(), counted_by = $3,
         draft_version = draft_version + 1,
         reservation_token = NULL, reserved_by = NULL, reservation_version = NULL, reservation_expires_at = NULL
     WHERE session_id = $1 AND product_id = $2 AND counted_qty IS NULL
       AND reservation_token = $4 AND reserved_by = $3
       AND reservation_expires_at > transaction_timestamp()`,
    [sessionId, productId, actorId, token, countedQty],
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

export async function listCountedItemsForApproval(database: Database, sessionId: string): Promise<StockOpnameItem[]> {
  const result = await database.query<ItemRow>(
    `SELECT i.id, i.product_id, p.sku, p.name, p.unit,
            i.snapshot_qty::text AS snapshot_qty, i.snapshot_version::text AS snapshot_version,
            i.counted_qty::text AS counted_qty, i.count_cutoff_version::text AS count_cutoff_version,
            i.counted_at, i.counted_by, i.draft_version::text AS draft_version,
            i.reservation_token, i.reserved_by, i.reservation_version::text AS reservation_version,
            i.reservation_expires_at
     FROM stock_opname_items i JOIN products p ON p.id = i.product_id
     WHERE i.session_id = $1 AND i.counted_qty IS NOT NULL
     ORDER BY i.product_id`,
    [sessionId],
  );
  return result.rows.map(toItem);
}

export async function reconcileCountedItems(
  database: Database,
  storeId: string,
  items: readonly StockOpnameItem[],
): Promise<Map<string, { expectedAtCount: string; variance: string; currentQuantity: string; currentVersion: string; nextQuantity: string; nextVersion: string }>> {
  if (items.length === 0) return new Map();
  const productIds = items.map((item) => item.productId);
  const snapshots = items.map((item) => item.snapshotQty);
  const snapshotVersions = items.map((item) => item.snapshotVersion);
  const cutoffs = items.map((item) => item.countCutoffVersion!);
  const counts = items.map((item) => item.countedQty!);
  const result = await database.query<QueryResultRow & {
    product_id: string; expected_at_count: string; variance: string; current_quantity: string;
    current_version: string; next_quantity: string; next_version: string;
  }>(
    `WITH counted AS (
       SELECT * FROM unnest($2::uuid[], $3::numeric[], $4::bigint[], $5::bigint[], $6::numeric[])
         AS c(product_id, snapshot_qty, snapshot_version, cutoff_version, counted_qty)
     ), locked AS (
       SELECT b.product_id, b.quantity, b.version
       FROM inventory_balances b
       JOIN counted c ON c.product_id = b.product_id
       WHERE b.store_id = $1
       ORDER BY b.product_id
       FOR UPDATE
     ), reconciled AS (
       SELECT c.product_id,
              c.snapshot_qty + COALESCE(SUM(m.quantity_delta) FILTER (
                WHERE m.inventory_version > c.snapshot_version AND m.inventory_version <= c.cutoff_version
              ), 0) AS expected_at_count,
              l.quantity AS current_quantity, l.version AS current_version, c.counted_qty
       FROM counted c
       JOIN locked l ON l.product_id = c.product_id
       LEFT JOIN inventory_movements m ON m.store_id = $1 AND m.product_id = c.product_id
       GROUP BY c.product_id, c.snapshot_qty, c.snapshot_version, c.cutoff_version, c.counted_qty, l.quantity, l.version
     )
     SELECT product_id, expected_at_count::text, (counted_qty - expected_at_count)::text AS variance,
            current_quantity::text, current_version::text,
            (current_quantity + counted_qty - expected_at_count)::text AS next_quantity,
            (current_version + 1)::text AS next_version
     FROM reconciled
     WHERE current_version >= (SELECT cutoff_version FROM counted WHERE counted.product_id = reconciled.product_id)
       AND (
         (SELECT cutoff_version = snapshot_version FROM counted WHERE counted.product_id = reconciled.product_id)
         OR EXISTS (
           SELECT 1 FROM inventory_movements cutoff_movement
           WHERE cutoff_movement.store_id = $1
             AND cutoff_movement.product_id = reconciled.product_id
             AND cutoff_movement.inventory_version = (SELECT cutoff_version FROM counted WHERE counted.product_id = reconciled.product_id)
         )
       )
     ORDER BY product_id`,
    [storeId, productIds, snapshots, snapshotVersions, cutoffs, counts],
  );
  if (result.rows.length !== items.length) throw new Error('Count cutoff or inventory balance is invalid.');
  return new Map(result.rows.map((row) => [row.product_id, {
    expectedAtCount: row.expected_at_count,
    variance: row.variance,
    currentQuantity: row.current_quantity,
    currentVersion: row.current_version,
    nextQuantity: row.next_quantity,
    nextVersion: row.next_version,
  }]));
}

export async function insertApprovalAdjustment(
  database: Database,
  values: { storeId: string; productId: string; sessionId: string; actorId: string; quantityDelta: string; version: string; nextQuantity: string },
): Promise<void> {
  await database.query(
    `INSERT INTO inventory_movements (
       store_id, product_id, inventory_version, movement_type, quantity_delta,
       reference_type, reference_id, stock_opname_session_id, actor_id
     ) VALUES ($1, $2, $3::bigint, 'STOCK_OPNAME_ADJUSTMENT', $4::numeric,
               'STOCK_OPNAME_SESSION', $5::text, $5::uuid, $6)`,
    [values.storeId, values.productId, values.version, values.quantityDelta, values.sessionId, values.actorId],
  );
  await database.query(
    `UPDATE inventory_balances SET quantity = $3::numeric, version = $4::bigint
     WHERE store_id = $1 AND product_id = $2`,
    [values.storeId, values.productId, values.nextQuantity, values.version],
  );
}

export async function approveSession(database: Database, sessionId: string, actorId: string): Promise<boolean> {
  const result = await database.query(
    `UPDATE stock_opname_sessions
     SET status = 'APPROVED', approved_by = $2, approved_at = transaction_timestamp()
     WHERE id = $1 AND status = 'SUBMITTED'`,
    [sessionId, actorId],
  );
  return result.rowCount === 1;
}

export async function rejectSession(database: Database, sessionId: string, actorId: string, reason: string): Promise<boolean> {
  const result = await database.query(
    `UPDATE stock_opname_sessions
     SET status = 'REJECTED', rejected_by = $2, rejected_at = transaction_timestamp(), rejection_reason = $3
     WHERE id = $1 AND status = 'SUBMITTED'`,
    [sessionId, actorId, reason],
  );
  return result.rowCount === 1;
}

function toSession(row: SessionRow): StockOpnameSession {
  return {
    id: row.id, storeId: row.store_id, status: row.status, initiatedBy: row.initiated_by,
    initiatedAt: row.initiated_at.toISOString(), submittedBy: row.submitted_by,
    submittedAt: row.submitted_at?.toISOString() ?? null,
    approvedBy: row.approved_by, approvedAt: row.approved_at?.toISOString() ?? null,
    rejectedBy: row.rejected_by, rejectedAt: row.rejected_at?.toISOString() ?? null,
    rejectionReason: row.rejection_reason,
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
