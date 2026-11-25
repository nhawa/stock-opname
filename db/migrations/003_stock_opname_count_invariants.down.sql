-- Development-only rollback. Deploy compatible application code before removing reservations.
DROP TRIGGER IF EXISTS inventory_movements_reservation_guard ON inventory_movements;
DROP FUNCTION IF EXISTS inventory_movements_reservation_guard();
DROP TRIGGER IF EXISTS stock_opname_items_state_guard ON stock_opname_items;
DROP FUNCTION IF EXISTS stock_opname_items_state_guard();
DROP TRIGGER IF EXISTS stock_opname_sessions_state_guard ON stock_opname_sessions;
DROP FUNCTION IF EXISTS stock_opname_sessions_state_guard();

CREATE TRIGGER stock_opname_sessions_set_updated_at BEFORE UPDATE ON stock_opname_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER stock_opname_items_set_updated_at BEFORE UPDATE ON stock_opname_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP INDEX IF EXISTS stock_opname_items_live_reservation_idx;
ALTER TABLE stock_opname_items
  DROP CONSTRAINT IF EXISTS stock_opname_items_reservation_complete_check,
  DROP COLUMN IF EXISTS reservation_expires_at,
  DROP COLUMN IF EXISTS reservation_version,
  DROP COLUMN IF EXISTS reserved_by,
  DROP COLUMN IF EXISTS reservation_token,
  DROP COLUMN IF EXISTS draft_version;
