import type { PoolClient } from 'pg';
import { withTransaction } from '../db.js';
import { AppError } from '../errors.js';
import type { TransactionCapableDatabase } from '../types.js';
import {
  ensureBalance,
  findActiveProduct,
  findMovementByIdempotencyKey,
  historicalQuantity,
  hasLiveCountReservation,
  insertMovement,
  lockBalance,
  toMovementResult,
  updateBalance,
} from './repository.js';
import type { InventoryCommand, InventoryMovementResult } from './types.js';

const QUANTITY_PATTERN = /^(?:0|[1-9]\d{0,10})(?:\.\d{1,3})?$/;
const MAX_QUANTITY = 99_999_999_999.999;

export async function createInventoryMovement(
  database: TransactionCapableDatabase,
  command: InventoryCommand,
): Promise<InventoryMovementResult> {
  validateCommand(command);

  return withTransaction(database, async (client) => {
    await lockIdempotencyKey(client, command.storeId, command.idempotencyKey);

    const existingMovement = await findMovementByIdempotencyKey(client, command.storeId, command.idempotencyKey);
    if (existingMovement) return replayOrReject(client, command, existingMovement);

    const product = await findActiveProduct(client, command.productId);
    if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Active product not found.');

    await ensureBalance(client, command.storeId, command.productId);
    const balance = await lockBalance(client, command.storeId, command.productId);
    if (await hasLiveCountReservation(client, command.storeId, command.productId)) {
      throw new AppError(409, 'COUNT_IN_PROGRESS', 'A physical count is in progress for this product.');
    }

    const existingAfterBalanceLock = await findMovementByIdempotencyKey(client, command.storeId, command.idempotencyKey);
    if (existingAfterBalanceLock) return replayOrReject(client, command, existingAfterBalanceLock);

    const currentQuantity = Number(balance.quantity);
    const requestedQuantity = Number(command.quantity);
    const quantityDelta = command.movementType === 'STOCK_OUT' ? -requestedQuantity : requestedQuantity;
    const nextQuantity = currentQuantity + quantityDelta;

    if (command.movementType === 'OPENING_BALANCE' && Number(balance.version) !== 0) {
      throw new AppError(409, 'OPENING_BALANCE_EXISTS', 'Opening balance has already been set for this product.');
    }
    if (nextQuantity < 0) {
      throw new AppError(409, 'INSUFFICIENT_STOCK', 'Stock-out would make inventory negative.');
    }
    if (nextQuantity > MAX_QUANTITY) {
      throw new AppError(400, 'QUANTITY_OUT_OF_RANGE', 'Resulting quantity is out of range.');
    }

    const nextVersion = String(Number(balance.version) + 1);
    const movement = await insertMovement(client, {
      ...command,
      version: nextVersion,
      quantityDelta: toDecimalString(quantityDelta),
    });
    const balanceQuantity = toDecimalString(nextQuantity);
    await updateBalance(client, command.storeId, command.productId, balanceQuantity, nextVersion);
    return toMovementResult(movement, balanceQuantity);
  });
}

async function lockIdempotencyKey(client: PoolClient, storeId: string, idempotencyKey: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${storeId}:${idempotencyKey}`]);
}

async function replayOrReject(
  client: PoolClient,
  command: InventoryCommand,
  movement: Awaited<ReturnType<typeof findMovementByIdempotencyKey>> & {},
): Promise<InventoryMovementResult> {
  if (!movement) throw new Error('Movement is required.');
  const expectedDelta = command.movementType === 'STOCK_OUT' ? -Number(command.quantity) : Number(command.quantity);
  if (
    movement.product_id !== command.productId
    || movement.movement_type !== command.movementType
    || Number(movement.quantity_delta) !== expectedDelta
    || movement.reference_type !== command.referenceType
    || movement.reference_id !== command.referenceId
  ) {
    throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was already used for a different request.');
  }

  const balanceQuantity = await historicalQuantity(
    client,
    command.storeId,
    movement.product_id,
    movement.inventory_version,
  );
  return toMovementResult(movement, balanceQuantity);
}

function validateCommand(command: InventoryCommand): void {
  if (!QUANTITY_PATTERN.test(command.quantity) || Number(command.quantity) <= 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Quantity must be a positive decimal with up to 11 integral and 3 fractional digits.');
  }
}

function toDecimalString(quantity: number): string {
  return quantity.toFixed(3);
}
