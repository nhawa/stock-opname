CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code = upper(code) AND code ~ '^[A-Z0-9_-]+$'),
  name text NOT NULL CHECK (btrim(name) <> ''),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND position('@' IN email) > 1),
  name text NOT NULL CHECK (btrim(name) <> ''),
  password_hash text NOT NULL CHECK (btrim(password_hash) <> ''),
  role text NOT NULL CHECK (role IN ('STAFF', 'MANAGER')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX users_store_id_idx ON users (store_id);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku text NOT NULL UNIQUE CHECK (btrim(sku) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  unit text NOT NULL CHECK (btrim(unit) <> ''),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory_balances (
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity numeric(14,3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, product_id)
);

CREATE TABLE stock_opname_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('COUNTING', 'SUBMITTED', 'APPROVED', 'REJECTED')),
  initiated_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  initiated_at timestamptz NOT NULL DEFAULT now(),
  submitted_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  submitted_at timestamptz,
  approved_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  rejected_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  rejected_at timestamptz,
  rejection_reason text,
  recount_of_session_id uuid REFERENCES stock_opname_sessions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((submitted_by IS NULL) = (submitted_at IS NULL)),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CHECK ((rejected_by IS NULL) = (rejected_at IS NULL)),
  CHECK ((rejected_by IS NULL) = (rejection_reason IS NULL)),
  CHECK (approved_by IS NULL OR rejected_by IS NULL),
  CHECK ((status IN ('SUBMITTED', 'APPROVED', 'REJECTED')) = (submitted_by IS NOT NULL)),
  CHECK ((status = 'APPROVED') = (approved_by IS NOT NULL)),
  CHECK ((status = 'REJECTED') = (rejected_by IS NOT NULL))
);

CREATE UNIQUE INDEX stock_opname_one_active_session_per_store_idx
  ON stock_opname_sessions (store_id)
  WHERE status IN ('COUNTING', 'SUBMITTED');
CREATE INDEX stock_opname_sessions_store_status_idx ON stock_opname_sessions (store_id, status);

CREATE TABLE stock_opname_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES stock_opname_sessions(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  snapshot_qty numeric(14,3) NOT NULL CHECK (snapshot_qty >= 0),
  snapshot_version bigint NOT NULL CHECK (snapshot_version >= 0),
  counted_qty numeric(14,3) CHECK (counted_qty >= 0),
  count_cutoff_version bigint CHECK (count_cutoff_version >= 0),
  counted_at timestamptz,
  counted_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, product_id),
  CHECK (
    (counted_qty IS NULL AND count_cutoff_version IS NULL AND counted_at IS NULL AND counted_by IS NULL)
    OR
    (counted_qty IS NOT NULL AND count_cutoff_version IS NOT NULL AND counted_at IS NOT NULL AND counted_by IS NOT NULL)
  ),
  CHECK (count_cutoff_version IS NULL OR count_cutoff_version >= snapshot_version)
);

CREATE INDEX stock_opname_items_product_id_idx ON stock_opname_items (product_id);

CREATE TABLE inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL,
  product_id uuid NOT NULL,
  inventory_version bigint NOT NULL CHECK (inventory_version > 0),
  movement_type text NOT NULL CHECK (
    movement_type IN ('OPENING_BALANCE', 'RECEIPT', 'STOCK_OUT', 'STOCK_OPNAME_ADJUSTMENT')
  ),
  quantity_delta numeric(14,3) NOT NULL CHECK (quantity_delta <> 0),
  reference_type text NOT NULL CHECK (btrim(reference_type) <> ''),
  reference_id text NOT NULL CHECK (btrim(reference_id) <> ''),
  stock_opname_session_id uuid REFERENCES stock_opname_sessions(id) ON DELETE RESTRICT,
  actor_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (store_id, product_id)
    REFERENCES inventory_balances(store_id, product_id) ON DELETE RESTRICT,
  UNIQUE (store_id, product_id, inventory_version),
  CHECK (
    (movement_type IN ('OPENING_BALANCE', 'RECEIPT') AND quantity_delta > 0)
    OR (movement_type = 'STOCK_OUT' AND quantity_delta < 0)
    OR (movement_type = 'STOCK_OPNAME_ADJUSTMENT' AND quantity_delta <> 0)
  ),
  CHECK (
    (movement_type = 'STOCK_OPNAME_ADJUSTMENT'
      AND stock_opname_session_id IS NOT NULL
      AND reference_type = 'STOCK_OPNAME_SESSION')
    OR (movement_type <> 'STOCK_OPNAME_ADJUSTMENT' AND stock_opname_session_id IS NULL)
  )
);

CREATE UNIQUE INDEX inventory_movements_one_opname_adjustment_per_product_idx
  ON inventory_movements (stock_opname_session_id, product_id)
  WHERE movement_type = 'STOCK_OPNAME_ADJUSTMENT';
CREATE UNIQUE INDEX inventory_movements_external_reference_idempotency_idx
  ON inventory_movements (movement_type, store_id, product_id, reference_id)
  WHERE movement_type IN ('RECEIPT', 'STOCK_OUT');
CREATE INDEX inventory_movements_store_product_created_at_idx
  ON inventory_movements (store_id, product_id, created_at);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES stock_opname_sessions(id) ON DELETE RESTRICT,
  actor_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (btrim(action) <> ''),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_session_created_at_idx ON audit_logs (session_id, created_at);
CREATE INDEX audit_logs_actor_created_at_idx ON audit_logs (actor_id, created_at);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER stores_set_updated_at BEFORE UPDATE ON stores
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER products_set_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER inventory_balances_set_updated_at BEFORE UPDATE ON inventory_balances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER stock_opname_sessions_set_updated_at BEFORE UPDATE ON stock_opname_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER stock_opname_items_set_updated_at BEFORE UPDATE ON stock_opname_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
