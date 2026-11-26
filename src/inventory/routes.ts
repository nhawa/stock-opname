import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRoles } from '../auth/middleware.js';
import { AppError } from '../errors.js';
import type { AppConfig, Database, TransactionCapableDatabase } from '../types.js';
import { listActiveProducts, listStoreBalances, listStoreMovements } from './repository.js';
import { createInventoryMovement } from './service.js';
import type { MovementType } from './types.js';

const quantitySchema = z.string().regex(/^(?:0|[1-9]\d{0,10})(?:\.\d{1,3})?$/);
const uuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

const commandSchema = z.object({
  productId: uuidSchema,
  quantity: quantitySchema,
  referenceType: z.string().trim().min(1).max(100),
  referenceId: z.string().trim().min(1).max(200),
  idempotencyKey: z.string().trim().min(1).max(200),
}).strict();

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(500).optional(),
}).strict();

const endpointReferenceTypes: Record<Exclude<MovementType, 'STOCK_OPNAME_ADJUSTMENT'>, string> = {
  OPENING_BALANCE: 'OPENING_BALANCE',
  RECEIPT: 'GOODS_RECEIPT',
  STOCK_OUT: 'STOCK_OUT',
};

export function createInventoryRouter(database: Database & Partial<TransactionCapableDatabase>, config: AppConfig): Router {
  const router = Router();
  const auth = authenticate(database, config);

  router.get('/products', auth, async (_request, response, next) => {
    try {
      response.status(200).json(await listActiveProducts(database));
    } catch (error) {
      next(error);
    }
  });

  router.get('/inventory', auth, requireRoles('MANAGER'), async (request, response, next) => {
    try {
      response.status(200).json(await listStoreBalances(database, request.auth!.storeId));
    } catch (error) {
      next(error);
    }
  });

  router.get('/inventory/movements', auth, requireRoles('MANAGER'), async (request, response, next) => {
    try {
      const query = historyQuerySchema.parse(request.query);
      response.status(200).json(await listStoreMovements(database, request.auth!.storeId, {
        limit: query.limit,
        cursor: query.cursor ? parseMovementCursor(query.cursor) : null,
      }));
    } catch (error) {
      next(error);
    }
  });

  addMovementRoute(router, '/inventory/opening-balance', 'OPENING_BALANCE', database, config);
  addMovementRoute(router, '/inventory/receipts', 'RECEIPT', database, config);
  addMovementRoute(router, '/inventory/stock-outs', 'STOCK_OUT', database, config);

  return router;
}

function parseMovementCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return z.object({ createdAt: z.string().datetime({ offset: true }), id: uuidSchema }).strict().parse(value);
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', 'Movement history cursor is invalid.');
  }
}

function addMovementRoute(
  router: Router,
  path: string,
  movementType: Exclude<MovementType, 'STOCK_OPNAME_ADJUSTMENT'>,
  database: Database & Partial<TransactionCapableDatabase>,
  config: AppConfig,
): void {
  router.post(path, authenticate(database, config), requireRoles('MANAGER'), async (request, response, next) => {
    try {
      if (!request.is('application/json')) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Request requires JSON.');
      }
      if (!('connect' in database) || typeof database.connect !== 'function') {
        throw new AppError(500, 'INTERNAL_ERROR', 'Transaction-capable database is required.');
      }

      const body = commandSchema.parse(request.body);
      if (body.referenceType !== endpointReferenceTypes[movementType]) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Reference type is not allowed for this endpoint.');
      }

      const result = await createInventoryMovement(database as TransactionCapableDatabase, {
        storeId: request.auth!.storeId,
        actorId: request.auth!.id,
        movementType,
        ...body,
      });
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });
}
