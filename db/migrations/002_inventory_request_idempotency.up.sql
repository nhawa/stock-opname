ALTER TABLE inventory_movements
  ADD COLUMN idempotency_key text;

ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_idempotency_key_check
  CHECK (idempotency_key IS NULL OR (btrim(idempotency_key) <> '' AND length(idempotency_key) <= 200));

DROP INDEX inventory_movements_external_reference_idempotency_idx;

CREATE UNIQUE INDEX inventory_movements_store_idempotency_key_idx
  ON inventory_movements (store_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
