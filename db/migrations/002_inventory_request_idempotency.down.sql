LOCK TABLE inventory_movements IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM inventory_movements
    WHERE movement_type IN ('RECEIPT', 'STOCK_OUT')
    GROUP BY movement_type, store_id, product_id, reference_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot roll back migration 002: duplicate receipt or stock-out references exist.';
  END IF;
END;
$$;

DROP INDEX inventory_movements_store_idempotency_key_idx;
ALTER TABLE inventory_movements DROP CONSTRAINT inventory_movements_idempotency_key_check;

-- Keep the nullable column and existing values for a lossless compatible rollback.
CREATE UNIQUE INDEX inventory_movements_external_reference_idempotency_idx
  ON inventory_movements (movement_type, store_id, product_id, reference_id)
  WHERE movement_type IN ('RECEIPT', 'STOCK_OUT');
