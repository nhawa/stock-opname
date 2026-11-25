export const movementTypes = ['OPENING_BALANCE', 'RECEIPT', 'STOCK_OUT', 'STOCK_OPNAME_ADJUSTMENT'] as const;
export type MovementType = (typeof movementTypes)[number];

export interface InventoryCommand {
  storeId: string;
  actorId: string;
  movementType: MovementType;
  productId: string;
  quantity: string;
  referenceType: string;
  referenceId: string;
  idempotencyKey: string;
}

export interface InventoryMovementResult {
  id: string;
  productId: string;
  movementType: MovementType;
  quantityDelta: string;
  inventoryVersion: string;
  balanceQuantity: string;
  referenceType: string;
  referenceId: string;
}

export interface InventoryMovementHistoryItem {
  id: string;
  productId: string;
  sku: string;
  name: string;
  unit: string;
  movementType: MovementType;
  quantityDelta: string;
  inventoryVersion: string;
  referenceType: string;
  referenceId: string;
  createdAt: string;
}

export interface InventoryMovementHistoryPage {
  items: InventoryMovementHistoryItem[];
  nextCursor: string | null;
}

export interface InventoryProduct {
  id: string;
  sku: string;
  name: string;
  unit: string;
}

export interface InventoryBalance extends InventoryProduct {
  quantity: string;
  version: string;
}
