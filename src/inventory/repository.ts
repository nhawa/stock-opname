import type { QueryResultRow } from 'pg';
import type { Database } from '../types.js';
import type { InventoryBalance, InventoryMovementResult, InventoryProduct, MovementType } from './types.js';

interface ProductRow extends QueryResultRow {
  id: string;
  sku: string;
  name: string;
  unit: string;
}

interface BalanceRow extends QueryResultRow {
  store_id: string;
  product_id: string;
  quantity: string;
  version: string;
}

interface MovementRow extends QueryResultRow {
  id: string;
  product_id: string;
  movement_type: MovementType;
  quantity_delta: string;
  inventory_version: string;
  reference_type: string;
  reference_id: string;
}

export async function findActiveProduct(database: Database, productId: string): Promise<InventoryProduct | null> {
  const result = await database.query<ProductRow>(
    'SELECT id, sku, name, unit FROM products WHERE id = $1 AND is_active = true',
    [productId],
  );
  return result.rows[0] ?? null;
}

export async function listActiveProducts(database: Database): Promise<InventoryProduct[]> {
  const result = await database.query<ProductRow>(
    'SELECT id, sku, name, unit FROM products WHERE is_active = true ORDER BY sku',
  );
  return result.rows;
}

export async function listStoreBalances(database: Database, storeId: string): Promise<InventoryBalance[]> {
  const result = await database.query<InventoryBalance & QueryResultRow>(`
    SELECT p.id, p.sku, p.name, p.unit, b.quantity::text AS quantity, b.version::text AS version
    FROM inventory_balances b
    JOIN products p ON p.id = b.product_id
    WHERE b.store_id = $1 AND p.is_active = true
    ORDER BY p.sku
  `, [storeId]);
  return result.rows;
}

export async function ensureBalance(database: Database, storeId: string, productId: string): Promise<void> {
  await database.query(
    `INSERT INTO inventory_balances (store_id, product_id)
     VALUES ($1, $2)
     ON CONFLICT (store_id, product_id) DO NOTHING`,
    [storeId, productId],
  );
}

export async function lockBalance(database: Database, storeId: string, productId: string): Promise<BalanceRow> {
  const result = await database.query<BalanceRow>(
    `SELECT store_id, product_id, quantity::text AS quantity, version::text AS version
     FROM inventory_balances
     WHERE store_id = $1 AND product_id = $2
     FOR UPDATE`,
    [storeId, productId],
  );
  return result.rows[0]!;
}

export async function findMovementByIdempotencyKey(
  database: Database,
  storeId: string,
  idempotencyKey: string,
): Promise<MovementRow | null> {
  const result = await database.query<MovementRow>(
    `SELECT id, product_id, movement_type, quantity_delta::text AS quantity_delta,
            inventory_version::text AS inventory_version, reference_type, reference_id
     FROM inventory_movements
     WHERE store_id = $1 AND idempotency_key = $2`,
    [storeId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

export async function insertMovement(
  database: Database,
  values: {
    storeId: string;
    productId: string;
    version: string;
    movementType: MovementType;
    quantityDelta: string;
    referenceType: string;
    referenceId: string;
    actorId: string;
    idempotencyKey: string;
  },
): Promise<MovementRow> {
  const result = await database.query<MovementRow>(
    `INSERT INTO inventory_movements (
       store_id, product_id, inventory_version, movement_type, quantity_delta,
       reference_type, reference_id, actor_id, idempotency_key
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, product_id, movement_type, quantity_delta::text AS quantity_delta,
               inventory_version::text AS inventory_version, reference_type, reference_id`,
    [
      values.storeId,
      values.productId,
      values.version,
      values.movementType,
      values.quantityDelta,
      values.referenceType,
      values.referenceId,
      values.actorId,
      values.idempotencyKey,
    ],
  );
  return result.rows[0]!;
}

export async function updateBalance(
  database: Database,
  storeId: string,
  productId: string,
  quantity: string,
  version: string,
): Promise<void> {
  await database.query(
    `UPDATE inventory_balances
     SET quantity = $3, version = $4
     WHERE store_id = $1 AND product_id = $2`,
    [storeId, productId, quantity, version],
  );
}

export async function historicalQuantity(
  database: Database,
  storeId: string,
  productId: string,
  version: string,
): Promise<string> {
  const result = await database.query<{ quantity: string }>(
    `SELECT COALESCE(SUM(quantity_delta), 0)::text AS quantity
     FROM inventory_movements
     WHERE store_id = $1 AND product_id = $2 AND inventory_version <= $3`,
    [storeId, productId, version],
  );
  return result.rows[0]!.quantity;
}

export function toMovementResult(row: MovementRow, balanceQuantity: string): InventoryMovementResult {
  return {
    id: row.id,
    productId: row.product_id,
    movementType: row.movement_type,
    quantityDelta: row.quantity_delta,
    inventoryVersion: row.inventory_version,
    balanceQuantity,
    referenceType: row.reference_type,
    referenceId: row.reference_id,
  };
}
