import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRoles } from '../auth/middleware.js';
import { AppError } from '../errors.js';
import type { AppConfig, Database, TransactionCapableDatabase } from '../types.js';
import { getSessionDetail, initiateSession, listStoreSessions, reserveCount, saveDraftCounts, submitSession } from './service.js';

const uuidSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
);
const quantitySchema = z.string().regex(/^(?:0|[1-9]\d{0,10})(?:\.\d{1,3})?$/);
const reservationSchema = z.object({ productId: uuidSchema }).strict();
const draftSchema = z.object({
  counts: z.array(z.object({
    productId: uuidSchema,
    reservationToken: uuidSchema,
    draftVersion: z.string().regex(/^\d+$/),
    countedQty: quantitySchema,
  }).strict()).min(1).max(25),
}).strict();

export function createStockOpnameRouter(database: Database & Partial<TransactionCapableDatabase>, config: AppConfig): Router {
  const router = Router();
  const auth = authenticate(database, config);

  router.get('/stock-opname/sessions', auth, async (request, response, next) => {
    try {
      response.status(200).json(await listStoreSessions(requireTransactionDatabase(database), request.auth!.storeId));
    } catch (error) { next(error); }
  });

  router.get('/stock-opname/sessions/:sessionId', auth, async (request, response, next) => {
    try {
      const sessionId = uuidSchema.parse(request.params.sessionId);
      response.status(200).json(await getSessionDetail(requireTransactionDatabase(database), request.auth!.storeId, sessionId));
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
      response.status(201).json(await reserveCount(requireTransactionDatabase(database), request.auth!.storeId, request.auth!.id, sessionId, body.productId));
    } catch (error) { next(error); }
  });

  router.post('/stock-opname/sessions/:sessionId/counts/draft', auth, requireRoles('STAFF'), async (request, response, next) => {
    try {
      requireJson(request.is('application/json'));
      const sessionId = uuidSchema.parse(request.params.sessionId);
      const body = draftSchema.parse(request.body);
      const ids = new Set(body.counts.map((count) => count.productId));
      if (ids.size !== body.counts.length) throw new AppError(400, 'VALIDATION_ERROR', 'Each product may appear only once.');
      response.status(200).json(await saveDraftCounts(requireTransactionDatabase(database), request.auth!.storeId, request.auth!.id, sessionId, body.counts));
    } catch (error) { next(error); }
  });

  router.post('/stock-opname/sessions/:sessionId/submit', auth, requireRoles('STAFF'), async (request, response, next) => {
    try {
      requireJson(request.is('application/json'));
      const sessionId = uuidSchema.parse(request.params.sessionId);
      response.status(200).json(await submitSession(requireTransactionDatabase(database), request.auth!.storeId, request.auth!.id, sessionId));
    } catch (error) { next(error); }
  });

  return router;
}

function requireTransactionDatabase(database: Database & Partial<TransactionCapableDatabase>): TransactionCapableDatabase {
  if ('connect' in database && typeof database.connect === 'function') return database as TransactionCapableDatabase;
  throw new AppError(500, 'INTERNAL_ERROR', 'Transaction-capable database is required.');
}

function requireJson(isJson: string | false | null): void {
  if (!isJson) throw new AppError(400, 'VALIDATION_ERROR', 'Request requires JSON.');
}
