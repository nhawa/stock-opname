DROP TRIGGER IF EXISTS stock_opname_sessions_state_guard ON stock_opname_sessions;
DROP FUNCTION IF EXISTS stock_opname_sessions_state_guard();

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
