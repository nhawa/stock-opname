import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRoles } from '../auth/middleware.js';
import { AppError } from '../errors.js';
import type { AppConfig, Database, TransactionCapableDatabase } from '../types.js';
import { approveSession, getSessionDetail, getSessionReview, initiateSession, listStoreSessions, rejectSession, reserveCount, saveDraftCounts, submitSession } from './service.js';
import type { StaffStockOpnameItem, StaffStockOpnameSession, StockOpnameItem, StockOpnameSession } from './types.js';

const uuidSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
);
const quantitySchema = z.string().regex(/^(?:0|[1-9]\d{0,10})(?:\.\d{1,3})?$/);
const reservationSchema = z.object({ productId: uuidSchema }).strict();
const rejectionSchema = z.object({
  reason: z.string().trim().min(1).max(1_000),
}).strict();
const draftSchema = z.object({
  counts: z.array(z.object({
    productId: uuidSchema,
    reservationToken: uuidSchema,
    countedQty: quantitySchema,
  }).strict()).min(1).max(25),
}).strict();

export function createStockOpnameRouter(database: Database & Partial<TransactionCapableDatabase>, config: AppConfig): Router {
  const router = Router();
  const auth = authenticate(database, config);

  router.get('/stock-opname/sessions', auth, async (request, response, next) => {
    try {
      response.status(200).json(toRoleSessionList(await listStoreSessions(requireTransactionDatabase(database), request.auth!.storeId), request.auth!.role, request.auth!.id));
    } catch (error) { next(error); }
  });

  router.get('/stock-opname/sessions/:sessionId', auth, async (request, response, next) => {
    try {
      const sessionId = uuidSchema.parse(request.params.sessionId);
      response.status(200).json(toRoleSession(await getSessionDetail(requireTransactionDatabase(database), request.auth!.storeId, sessionId), request.auth!.role, request.auth!.id));
    } catch (error) { next(error); }
  });

  router.post('/stock-opname/sessions', auth, requireRoles('MANAGER'), async (request, response, next) => {
    try {
      requireJson(request.is('application/json'));
      response.status(201).json(await initiateSession(requireTransactionDatabase(database), request.auth!.storeId, request.auth!.id));
    } catch (error) { next(error); }
  });

  router.post('/stock-opname/sessions/:sessionId/counts/reservations', auth, requireRoles('STAFF'), async (request, response, next) => {
    try {
      requireJson(request.is('application/json'));
      const sessionId = uuidSchema.parse(request.params.sessionId);
      const body = reservationSchema.parse(request.body);
      response.status(201).json(toStaffItem(await reserveCount(
        requireTransactionDatabase(database),
        request.auth!.storeId,
        request.auth!.id,
        sessionId,
        body.productId,
        config.stockOpname.countReservationActiveSeconds,
      ), request.auth!.id));
    } catch (error) { next(error); }
  });

  router.post('/stock-opname/sessions/:sessionId/counts/draft', auth, requireRoles('STAFF'), async (request, response, next) => {
    try {
      requireJson(request.is('application/json'));
      const sessionId = uuidSchema.parse(request.params.sessionId);
      const body = draftSchema.parse(request.body);
      const ids = new Set(body.counts.map((count) => count.productId));
      if (ids.size !== body.counts.length) throw new AppError(400, 'VALIDATION_ERROR', 'Each product may appear only once.');
      response.status(200).json((await saveDraftCounts(requireTransactionDatabase(database), request.auth!.storeId, request.auth!.id, sessionId, body.counts)).map((item) => toStaffItem(item, request.auth!.id)));
    } catch (error) { next(error); }
  });

  router.get('/stock-opname/sessions/:sessionId/review', auth, requireRoles('MANAGER'), async (request, response, next) => {
    try {
      const sessionId = uuidSchema.parse(request.params.sessionId);
      response.status(200).json(await getSessionReview(requireTransactionDatabase(database), request.auth!.storeId, sessionId));
    } catch (error) { next(error); }
  });

  router.post('/stock-opname/sessions/:sessionId/approve', auth, requireRoles('MANAGER'), async (request, response, next) => {
    try {
      requireJson(request.is('application/json'));
      const sessionId = uuidSchema.parse(request.params.sessionId);
      response.status(200).json(await approveSession(requireTransactionDatabase(database), request.auth!.storeId, request.auth!.id, sessionId));
    } catch (error) { next(error); }
  });

  router.post('/stock-opname/sessions/:sessionId/reject', auth, requireRoles('MANAGER'), async (request, response, next) => {
    try {
      requireJson(request.is('application/json'));
      const sessionId = uuidSchema.parse(request.params.sessionId);
      const body = rejectionSchema.parse(request.body);
      response.status(200).json(await rejectSession(requireTransactionDatabase(database), request.auth!.storeId, request.auth!.id, sessionId, body.reason));
    } catch (error) { next(error); }
  });

  router.post('/stock-opname/sessions/:sessionId/submit', auth, requireRoles('STAFF'), async (request, response, next) => {
    try {
      requireJson(request.is('application/json'));
      const sessionId = uuidSchema.parse(request.params.sessionId);
      response.status(200).json(toRoleSession(await submitSession(requireTransactionDatabase(database), request.auth!.storeId, request.auth!.id, sessionId), request.auth!.role, request.auth!.id));
    } catch (error) { next(error); }
  });

  return router;
}

function toRoleSessionList(sessions: StockOpnameSession[], role: 'STAFF' | 'MANAGER', actorId: string): StockOpnameSession[] | StaffStockOpnameSession[] {
  return role === 'MANAGER' ? sessions : sessions.map((session) => toStaffSession(session, actorId));
}

function toRoleSession(session: StockOpnameSession, role: 'STAFF' | 'MANAGER', actorId: string): StockOpnameSession | StaffStockOpnameSession {
  return role === 'MANAGER' ? session : toStaffSession(session, actorId);
}

function toStaffSession(session: StockOpnameSession, actorId: string): StaffStockOpnameSession {
  const { items, ...summary } = session;
  return { ...summary, items: items?.map((item) => toStaffItem(item, actorId)) };
}

function toStaffItem(item: StockOpnameItem, actorId: string): StaffStockOpnameItem {
  const isReserved = item.reservationToken !== null && item.reservationExpiresAt !== null && new Date(item.reservationExpiresAt) > new Date();
  return {
    id: item.id,
    productId: item.productId,
    sku: item.sku,
    name: item.name,
    unit: item.unit,
    countedQty: item.countedQty,
    countedAt: item.countedAt,
    reservationToken: isReserved && item.reservedBy === actorId ? item.reservationToken : null,
    reservationStatus: item.countedQty !== null ? 'COUNTED' : isReserved ? 'RESERVED' : 'AVAILABLE',
  };
}

function requireTransactionDatabase(database: Database & Partial<TransactionCapableDatabase>): TransactionCapableDatabase {
  if ('connect' in database && typeof database.connect === 'function') return database as TransactionCapableDatabase;
  throw new AppError(500, 'INTERNAL_ERROR', 'Transaction-capable database is required.');
}

function requireJson(isJson: string | false | null): void {
  if (!isJson) throw new AppError(400, 'VALIDATION_ERROR', 'Request requires JSON.');
}
