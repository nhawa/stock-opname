import type { PoolClient } from 'pg';
import { withTransaction } from '../db.js';
import { AppError } from '../errors.js';
import type { TransactionCapableDatabase } from '../types.js';
import {
  calculateNextBalance,
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
    await lockBalance(client, command.storeId, command.productId);
    if (await hasLiveCountReservation(client, command.storeId, command.productId)) {
      throw new AppError(409, 'COUNT_IN_PROGRESS', 'A physical count is in progress for this product.');
    }

    const existingAfterBalanceLock = await findMovementByIdempotencyKey(client, command.storeId, command.idempotencyKey);
    if (existingAfterBalanceLock) return replayOrReject(client, command, existingAfterBalanceLock);

    const quantityDelta = command.movementType === 'STOCK_OUT' ? `-${command.quantity}` : command.quantity;
    const nextBalance = await calculateNextBalance(client, command.storeId, command.productId, quantityDelta);

    if (command.movementType === 'OPENING_BALANCE' && nextBalance.hasOpeningBalance) {
      throw new AppError(409, 'OPENING_BALANCE_EXISTS', 'Opening balance has already been set for this product.');
    }
    if (!nextBalance.isNonNegative) {
      throw new AppError(409, 'INSUFFICIENT_STOCK', 'Stock-out would make inventory negative.');
    }
    if (!nextBalance.isWithinRange) {
      throw new AppError(400, 'QUANTITY_OUT_OF_RANGE', 'Resulting quantity is out of range.');
    }

    const movement = await insertMovement(client, {
      ...command,
      version: nextBalance.nextVersion,
      quantityDelta,
    });
    const balanceQuantity = nextBalance.nextQuantity;
    await updateBalance(client, command.storeId, command.productId, balanceQuantity, nextBalance.nextVersion);
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
  const expectedDelta = command.movementType === 'STOCK_OUT' ? `-${command.quantity}` : command.quantity;
  if (
    movement.product_id !== command.productId
    || movement.movement_type !== command.movementType
    || normalizeDecimal(movement.quantity_delta) !== normalizeDecimal(expectedDelta)
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
  if (!QUANTITY_PATTERN.test(command.quantity) || isZeroDecimal(command.quantity)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Quantity must be a positive decimal with up to 11 integral and 3 fractional digits.');
  }
}

function isZeroDecimal(value: string): boolean {
  return /^0(?:\.0{1,3})?$/.test(value);
}

function normalizeDecimal(value: string): string {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  return `${negative ? '-' : ''}${whole.replace(/^0+(?=\d)/, '')}.${fraction.padEnd(3, '0')}`;
}
