import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../db.js';
import { AppError } from '../errors.js';
import type { TransactionCapableDatabase } from '../types.js';
import {
  approveSession as updateSessionApproval,
  ensureAndLockBalances,
  findActiveSession,
  getSession,
  hasLiveReservations,
  insertAudit,
  insertSessionWithItems,
  insertApprovalAdjustment,
  listCountedItemsForApproval,
  listItems,
  listScopedProducts,
  listSessions,
  lockSessionOperation,
  lockStoreInitiation,
  reconcileCountedItems,
  rejectSession as updateSessionRejection,
  reserveItem,
  saveDraftItem,
  submitSession as updateSessionSubmission,
} from './repository.js';
import type { StockOpnameItem, StockOpnameReview, StockOpnameReviewItem, StockOpnameSession } from './types.js';

export async function initiateSession(database: TransactionCapableDatabase, storeId: string, actorId: string): Promise<StockOpnameSession> {
  try {
    return await withTransaction(database, async (client) => {
      await lockStoreInitiation(client, storeId);
      if (await findActiveSession(client, storeId)) {
        throw new AppError(409, 'ACTIVE_SESSION_EXISTS', 'An active stock opname session already exists.');
      }
      const products = await listScopedProducts(client);
      const balances = await ensureAndLockBalances(client, storeId, products.map((product) => product.id));
      const sessionId = await insertSessionWithItems(client, storeId, actorId, balances);
      return getLockedSessionDetail(client, storeId, sessionId);
    }, { isolationLevel: 'serializable', maxAttempts: 3 });
  } catch (error) {
    if (isActiveSessionConflict(error)) {
      throw new AppError(409, 'ACTIVE_SESSION_EXISTS', 'An active stock opname session already exists.');
    }
    throw error;
  }
}

export async function listStoreSessions(database: TransactionCapableDatabase, storeId: string): Promise<StockOpnameSession[]> {
  return listSessions(database, storeId);
}

export async function getSessionDetail(database: TransactionCapableDatabase, storeId: string, sessionId: string): Promise<StockOpnameSession> {
  const session = await getSession(database, storeId, sessionId);
  if (!session) throw new AppError(404, 'SESSION_NOT_FOUND', 'Stock opname session not found.');
  session.items = await listItems(database, sessionId);
  return session;
}

export async function reserveCount(
  database: TransactionCapableDatabase,
  storeId: string,
  actorId: string,
  sessionId: string,
  productId: string,
  reservationActiveSeconds: number,
): Promise<StockOpnameItem> {
  return withTransaction(database, async (client) => {
    const session = await lockSessionOperation(client, storeId, sessionId);
    if (!session) throw new AppError(404, 'SESSION_NOT_FOUND', 'Stock opname session not found.');
    if (session.status !== 'COUNTING') throw new AppError(409, 'SESSION_NOT_COUNTING', 'Session is not accepting counts.');
    const reserved = await reserveItem(client, sessionId, productId, actorId, randomUUID(), reservationActiveSeconds);
    if (!reserved) throw new AppError(409, 'COUNT_RESERVATION_CONFLICT', 'Count reservation is unavailable.');
    const [item] = await listItems(client, sessionId, [productId]);
    if (!item) throw new AppError(404, 'SESSION_ITEM_NOT_FOUND', 'Session item not found.');
    return item;
  });
}

export async function saveDraftCounts(
  database: TransactionCapableDatabase,
  storeId: string,
  actorId: string,
  sessionId: string,
  counts: readonly { productId: string; reservationToken: string; countedQty: string }[],
): Promise<StockOpnameItem[]> {
  return withTransaction(database, async (client) => {
    const session = await lockSessionOperation(client, storeId, sessionId);
    if (!session) throw new AppError(404, 'SESSION_NOT_FOUND', 'Stock opname session not found.');
    if (session.status !== 'COUNTING') throw new AppError(409, 'SESSION_NOT_COUNTING', 'Session is not accepting counts.');
    for (const count of [...counts].sort((left, right) => left.productId.localeCompare(right.productId))) {
      const saved = await saveDraftItem(client, sessionId, count.productId, actorId, count.reservationToken, count.countedQty);
      if (!saved) throw new AppError(409, 'STALE_DRAFT', 'Count reservation is no longer current.');
    }
    return listItems(client, sessionId, counts.map((count) => count.productId));
  });
}

export async function getSessionReview(
  database: TransactionCapableDatabase,
  storeId: string,
  sessionId: string,
): Promise<StockOpnameReview> {
  const session = await getSession(database, storeId, sessionId);
  if (!session) throw new AppError(404, 'SESSION_NOT_FOUND', 'Stock opname session not found.');
  if (session.status !== 'SUBMITTED') throw new AppError(409, 'SESSION_NOT_SUBMITTED', 'Session is not awaiting manager review.');
  const items = await listCountedItemsForApproval(database, sessionId);
  const reviewItems = await calculateReviewItems(database, storeId, items);
  return { ...session, items: reviewItems };
}

export async function approveSession(
  database: TransactionCapableDatabase,
  storeId: string,
  actorId: string,
  sessionId: string,
): Promise<StockOpnameSession> {
  return withTransaction(database, async (client) => {
    const session = await lockSessionOperation(client, storeId, sessionId);
    if (!session) throw new AppError(404, 'SESSION_NOT_FOUND', 'Stock opname session not found.');
    if (session.status !== 'SUBMITTED') throw new AppError(409, 'SESSION_NOT_SUBMITTED', 'Session is not awaiting manager approval.');
    const reservationExpiresAt = await hasLiveReservations(client, sessionId);
    if (reservationExpiresAt) throw new AppError(409, 'COUNT_RESERVATIONS_ACTIVE', 'Count reservation remains active.');

    const items = await listCountedItemsForApproval(client, sessionId);
    const reconciliations = await reconcileCountedItems(client, storeId, items);
    const auditItems: Record<string, unknown>[] = [];
    for (const item of items) {
      const reconciliation = reconciliations.get(item.productId);
      if (!reconciliation) throw new AppError(409, 'INVALID_COUNT_CUTOFF', 'Count cutoff is invalid for approval.');
      if (compareDecimal(reconciliation.nextQuantity, '0') < 0 || compareDecimal(reconciliation.nextQuantity, '99999999999.999') > 0) {
        throw new AppError(409, 'ADJUSTMENT_OUT_OF_RANGE', 'Approval would make inventory quantity invalid.');
      }
      auditItems.push({
        productId: item.productId,
        expectedAtCount: reconciliation.expectedAtCount,
        countedQty: item.countedQty,
        variance: reconciliation.variance,
        currentVersion: reconciliation.currentVersion,
        nextVersion: reconciliation.variance === '0.000' ? reconciliation.currentVersion : reconciliation.nextVersion,
      });
      if (compareDecimal(reconciliation.variance, '0') !== 0) {
        await insertApprovalAdjustment(client, {
          storeId,
          productId: item.productId,
          sessionId,
          actorId,
          quantityDelta: reconciliation.variance,
          version: reconciliation.nextVersion,
          nextQuantity: reconciliation.nextQuantity,
        });
      }
    }
    if (!await updateSessionApproval(client, sessionId, actorId)) {
      throw new AppError(409, 'SESSION_NOT_SUBMITTED', 'Session is not awaiting manager approval.');
    }
    await insertAudit(client, sessionId, actorId, 'STOCK_OPNAME_APPROVED', { items: auditItems });
    return getLockedSessionDetail(client, storeId, sessionId);
  }, { isolationLevel: 'serializable', maxAttempts: 3 });
}

export async function rejectSession(
  database: TransactionCapableDatabase,
  storeId: string,
  actorId: string,
  sessionId: string,
  reason: string,
): Promise<StockOpnameSession> {
  return withTransaction(database, async (client) => {
    const session = await lockSessionOperation(client, storeId, sessionId);
    if (!session) throw new AppError(404, 'SESSION_NOT_FOUND', 'Stock opname session not found.');
    if (session.status !== 'SUBMITTED') throw new AppError(409, 'SESSION_NOT_SUBMITTED', 'Session is not awaiting manager review.');
    if (!await updateSessionRejection(client, sessionId, actorId, reason)) {
      throw new AppError(409, 'SESSION_NOT_SUBMITTED', 'Session is not awaiting manager review.');
    }
    await insertAudit(client, sessionId, actorId, 'STOCK_OPNAME_REJECTED', { reason });
    return getLockedSessionDetail(client, storeId, sessionId);
  });
}

export async function submitSession(
  database: TransactionCapableDatabase,
  storeId: string,
  actorId: string,
  sessionId: string,
): Promise<StockOpnameSession> {
  return withTransaction(database, async (client) => {
    const session = await lockSessionOperation(client, storeId, sessionId);
    if (!session) throw new AppError(404, 'SESSION_NOT_FOUND', 'Stock opname session not found.');
    if (session.status !== 'COUNTING') throw new AppError(409, 'SESSION_NOT_COUNTING', 'Session is not accepting counts.');
    const reservationExpiresAt = await hasLiveReservations(client, sessionId);
    if (reservationExpiresAt) {
      throw new AppError(409, 'COUNT_RESERVATIONS_ACTIVE', `Count reservation remains active until ${reservationExpiresAt}.`);
    }
    const items = await listItems(client, sessionId);
    if (!items.some((item) => item.countedQty !== null)) {
      throw new AppError(409, 'NO_PHYSICAL_COUNTS', 'Enter at least one physical count before submitting the session.');
    }
    if (!await updateSessionSubmission(client, sessionId, actorId)) {
      throw new AppError(409, 'SESSION_NOT_COUNTING', 'Session is not accepting counts.');
    }
    await insertAudit(client, sessionId, actorId, 'STOCK_OPNAME_SUBMITTED');
    return getLockedSessionDetail(client, storeId, sessionId);
  });
}

async function getLockedSessionDetail(database: PoolClient, storeId: string, sessionId: string): Promise<StockOpnameSession> {
  const session = await getSession(database, storeId, sessionId);
  if (!session) throw new AppError(404, 'SESSION_NOT_FOUND', 'Stock opname session not found.');
  session.items = await listItems(database, sessionId);
  return session;
}

async function calculateReviewItems(
  database: TransactionCapableDatabase,
  storeId: string,
  items: readonly StockOpnameItem[],
): Promise<StockOpnameReviewItem[]> {
  if (items.length === 0) return [];
  const productIds = items.map((item) => item.productId);
  const snapshots = items.map((item) => item.snapshotQty);
  const snapshotVersions = items.map((item) => item.snapshotVersion);
  const cutoffs = items.map((item) => item.countCutoffVersion!);
  const result = await database.query<{ product_id: string; expected_at_count: string; variance: string }>(
    `WITH counted AS (
       SELECT * FROM unnest($2::uuid[], $3::numeric[], $4::bigint[], $5::bigint[], $6::numeric[])
         AS c(product_id, snapshot_qty, snapshot_version, cutoff_version, counted_qty)
     )
     SELECT c.product_id,
            (c.snapshot_qty + COALESCE(SUM(m.quantity_delta) FILTER (
              WHERE m.inventory_version > c.snapshot_version AND m.inventory_version <= c.cutoff_version
            ), 0))::text AS expected_at_count,
            (c.counted_qty - c.snapshot_qty - COALESCE(SUM(m.quantity_delta) FILTER (
              WHERE m.inventory_version > c.snapshot_version AND m.inventory_version <= c.cutoff_version
            ), 0))::text AS variance
     FROM counted c
     LEFT JOIN inventory_movements m ON m.store_id = $1 AND m.product_id = c.product_id
     GROUP BY c.product_id, c.snapshot_qty, c.snapshot_version, c.cutoff_version, c.counted_qty
     ORDER BY c.product_id`,
    [storeId, productIds, snapshots, snapshotVersions, cutoffs, items.map((item) => item.countedQty!)],
  );
  const byProduct = new Map(result.rows.map((row) => [row.product_id, row]));
  return items.map((item) => {
    const reconciliation = byProduct.get(item.productId)!;
    return { ...item, expectedAtCount: reconciliation.expected_at_count, variance: reconciliation.variance };
  });
}

function compareDecimal(left: string, right: string): number {
  const normalize = (value: string): { sign: number; digits: string } => {
    const negative = value.startsWith('-');
    const unsigned = negative ? value.slice(1) : value;
    const [whole, fraction = ''] = unsigned.split('.');
    const digits = `${whole.replace(/^0+/, '') || '0'}${fraction.padEnd(3, '0')}`.replace(/^0+/, '') || '0';
    return { sign: digits === '0' ? 1 : negative ? -1 : 1, digits };
  };
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  if (normalizedLeft.sign !== normalizedRight.sign) return normalizedLeft.sign - normalizedRight.sign;
  if (normalizedLeft.digits.length !== normalizedRight.digits.length) {
    return (normalizedLeft.digits.length - normalizedRight.digits.length) * normalizedLeft.sign;
  }
  return normalizedLeft.digits.localeCompare(normalizedRight.digits) * normalizedLeft.sign;
}

function isActiveSessionConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && error.code === '23505'
    && 'constraint' in error && error.constraint === 'stock_opname_one_active_session_per_store_idx';
}
