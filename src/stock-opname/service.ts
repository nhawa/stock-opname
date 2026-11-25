import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../db.js';
import { AppError } from '../errors.js';
import type { TransactionCapableDatabase } from '../types.js';
import {
  ensureAndLockBalances,
  findActiveSession,
  getSession,
  hasLiveReservations,
  insertAudit,
  insertSessionWithItems,
  listItems,
  listScopedProducts,
  listSessions,
  lockSessionOperation,
  lockStoreInitiation,
  reserveItem,
  saveDraftItem,
  submitSession as updateSessionSubmission,
} from './repository.js';
import type { StockOpnameItem, StockOpnameSession } from './types.js';

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
): Promise<StockOpnameItem> {
  return withTransaction(database, async (client) => {
    const session = await lockSessionOperation(client, storeId, sessionId);
    if (!session) throw new AppError(404, 'SESSION_NOT_FOUND', 'Stock opname session not found.');
    if (session.status !== 'COUNTING') throw new AppError(409, 'SESSION_NOT_COUNTING', 'Session is not accepting counts.');
    const reserved = await reserveItem(client, sessionId, productId, actorId, randomUUID());
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
  counts: readonly { productId: string; reservationToken: string; draftVersion: string; countedQty: string }[],
): Promise<StockOpnameItem[]> {
  return withTransaction(database, async (client) => {
    const session = await lockSessionOperation(client, storeId, sessionId);
    if (!session) throw new AppError(404, 'SESSION_NOT_FOUND', 'Stock opname session not found.');
    if (session.status !== 'COUNTING') throw new AppError(409, 'SESSION_NOT_COUNTING', 'Session is not accepting counts.');
    for (const count of [...counts].sort((left, right) => left.productId.localeCompare(right.productId))) {
      const saved = await saveDraftItem(client, sessionId, count.productId, actorId, count.reservationToken, count.draftVersion, count.countedQty);
      if (!saved) throw new AppError(409, 'STALE_DRAFT', 'Count reservation or draft version is no longer current.');
    }
    return listItems(client, sessionId, counts.map((count) => count.productId));
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

function isActiveSessionConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && error.code === '23505'
    && 'constraint' in error && error.constraint === 'stock_opname_one_active_session_per_store_idx';
}
