ALTER TABLE stock_opname_items
  ADD COLUMN draft_version bigint NOT NULL DEFAULT 0 CHECK (draft_version >= 0),
  ADD COLUMN reservation_token uuid,
  ADD COLUMN reserved_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN reservation_version bigint CHECK (reservation_version >= 0),
  ADD COLUMN reservation_expires_at timestamptz,
  ADD CONSTRAINT stock_opname_items_reservation_complete_check CHECK (
    (reservation_token IS NULL AND reserved_by IS NULL AND reservation_version IS NULL AND reservation_expires_at IS NULL)
    OR
    (reservation_token IS NOT NULL AND reserved_by IS NOT NULL AND reservation_version IS NOT NULL AND reservation_expires_at IS NOT NULL)
  );

CREATE INDEX stock_opname_items_live_reservation_idx
  ON stock_opname_items (product_id, reservation_expires_at)
  WHERE reservation_token IS NOT NULL;

DROP TRIGGER stock_opname_items_set_updated_at ON stock_opname_items;
DROP TRIGGER stock_opname_sessions_set_updated_at ON stock_opname_sessions;

CREATE OR REPLACE FUNCTION stock_opname_items_state_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_row stock_opname_sessions%ROWTYPE;
  balance_version bigint;
BEGIN
  SELECT * INTO session_row FROM stock_opname_sessions WHERE id = NEW.session_id;

  IF NEW.id <> OLD.id
     OR NEW.session_id <> OLD.session_id
     OR NEW.product_id <> OLD.product_id
     OR NEW.snapshot_qty <> OLD.snapshot_qty
     OR NEW.snapshot_version <> OLD.snapshot_version
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Stock opname item identity and snapshot are immutable' USING ERRCODE = '23514';
  END IF;

  IF session_row.status <> 'COUNTING' THEN
    RAISE EXCEPTION 'Stock opname item cannot change outside COUNTING' USING ERRCODE = '23514';
  END IF;

  IF OLD.counted_qty IS NOT NULL THEN
    RAISE EXCEPTION 'Saved count is immutable' USING ERRCODE = '23514';
  END IF;

  IF NEW.reservation_token IS NOT NULL THEN
    IF NEW.counted_qty IS NOT NULL
       OR NEW.draft_version <> OLD.draft_version
       OR (OLD.reservation_token IS NOT NULL AND OLD.reservation_expires_at > transaction_timestamp()) THEN
      RAISE EXCEPTION 'Invalid reservation transition' USING ERRCODE = '23514';
    END IF;

    SELECT version INTO balance_version
    FROM inventory_balances
    WHERE store_id = session_row.store_id AND product_id = NEW.product_id
    FOR UPDATE;

    IF balance_version IS NULL OR NEW.reservation_version <> balance_version THEN
      RAISE EXCEPTION 'Reservation version is stale' USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM users
      WHERE id = NEW.reserved_by AND store_id = session_row.store_id AND role = 'STAFF' AND is_active
    ) THEN
      RAISE EXCEPTION 'Reservation user must be active same-store staff' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.reservation_token IS NOT NULL THEN
    IF NEW.counted_qty IS NULL
       OR NEW.count_cutoff_version <> OLD.reservation_version
       OR NEW.counted_by <> OLD.reserved_by
       OR NEW.draft_version <> OLD.draft_version + 1
       OR NEW.counted_at IS DISTINCT FROM transaction_timestamp() THEN
      RAISE EXCEPTION 'Invalid count save transition' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'Invalid stock opname item update' USING ERRCODE = '23514';
  END IF;

  NEW.updated_at = transaction_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER stock_opname_items_state_guard
  BEFORE UPDATE ON stock_opname_items
  FOR EACH ROW EXECUTE FUNCTION stock_opname_items_state_guard();

CREATE OR REPLACE FUNCTION stock_opname_sessions_state_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'COUNTING'
       OR NEW.submitted_by IS NOT NULL OR NEW.submitted_at IS NOT NULL
       OR NOT EXISTS (
         SELECT 1 FROM users
         WHERE id = NEW.initiated_by AND store_id = NEW.store_id AND role = 'MANAGER' AND is_active
       ) THEN
      RAISE EXCEPTION 'Invalid stock opname session initiation' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id OR NEW.store_id <> OLD.store_id
     OR NEW.initiated_by <> OLD.initiated_by OR NEW.initiated_at <> OLD.initiated_at
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Session initiation fields are immutable' USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'COUNTING' AND NEW.status = 'SUBMITTED'
     AND NEW.submitted_by IS NOT NULL AND NEW.submitted_at = transaction_timestamp()
     AND EXISTS (
       SELECT 1 FROM users
       WHERE id = NEW.submitted_by AND store_id = NEW.store_id AND role = 'STAFF' AND is_active
     ) THEN
    NEW.updated_at = transaction_timestamp();
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid stock opname session transition' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER stock_opname_sessions_state_guard
  BEFORE INSERT OR UPDATE ON stock_opname_sessions
  FOR EACH ROW EXECUTE FUNCTION stock_opname_sessions_state_guard();

CREATE OR REPLACE FUNCTION inventory_movements_reservation_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM 1 FROM inventory_balances
  WHERE store_id = NEW.store_id AND product_id = NEW.product_id
  FOR UPDATE;

  IF EXISTS (
    SELECT 1
    FROM stock_opname_items item
    JOIN stock_opname_sessions session ON session.id = item.session_id
    WHERE session.store_id = NEW.store_id
      AND item.product_id = NEW.product_id
      AND session.status = 'COUNTING'
      AND item.reservation_expires_at > transaction_timestamp()
  ) THEN
    RAISE EXCEPTION 'Count is in progress for this product' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_movements_reservation_guard
  BEFORE INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION inventory_movements_reservation_guard();
