-- Development-only deterministic fixtures. The password hash is for the non-production password "password".
INSERT INTO stores (id, code, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'JKT-01', 'Jakarta Store'),
  ('11111111-1111-1111-1111-111111111112', 'BDG-01', 'Bandung Store')
ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name;

INSERT INTO users (id, store_id, email, name, password_hash, role) VALUES
  ('22222222-2222-2222-2222-222222222201', '11111111-1111-1111-1111-111111111111', 'staff.jakarta@example.test', 'Jakarta Staff', '$2b$12$OhJKfyx1HvGW/dL7/JfI0ei7.5jQYjbIeK1f7jDGA.XhpUGrfnVsu', 'STAFF'),
  ('22222222-2222-2222-2222-222222222202', '11111111-1111-1111-1111-111111111111', 'manager.jakarta@example.test', 'Jakarta Manager', '$2b$12$OhJKfyx1HvGW/dL7/JfI0ei7.5jQYjbIeK1f7jDGA.XhpUGrfnVsu', 'MANAGER'),
  ('22222222-2222-2222-2222-222222222203', '11111111-1111-1111-1111-111111111112', 'staff.bandung@example.test', 'Bandung Staff', '$2b$12$OhJKfyx1HvGW/dL7/JfI0ei7.5jQYjbIeK1f7jDGA.XhpUGrfnVsu', 'STAFF'),
  ('22222222-2222-2222-2222-222222222204', '11111111-1111-1111-1111-111111111112', 'manager.bandung@example.test', 'Bandung Manager', '$2b$12$OhJKfyx1HvGW/dL7/JfI0ei7.5jQYjbIeK1f7jDGA.XhpUGrfnVsu', 'MANAGER')
ON CONFLICT (id) DO UPDATE SET
  store_id = EXCLUDED.store_id, email = EXCLUDED.email, name = EXCLUDED.name,
  password_hash = EXCLUDED.password_hash, role = EXCLUDED.role;

INSERT INTO products (id, sku, name, unit) VALUES
  ('33333333-3333-3333-3333-333333333301', 'RICE-5KG', 'Rice 5 kg', 'bag'),
  ('33333333-3333-3333-3333-333333333302', 'OIL-1L', 'Cooking Oil 1 L', 'bottle')
ON CONFLICT (id) DO UPDATE SET sku = EXCLUDED.sku, name = EXCLUDED.name, unit = EXCLUDED.unit;

INSERT INTO inventory_balances (store_id, product_id, quantity, version) VALUES
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333301', 0, 0),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333302', 0, 0),
  ('11111111-1111-1111-1111-111111111112', '33333333-3333-3333-3333-333333333301', 0, 0),
  ('11111111-1111-1111-1111-111111111112', '33333333-3333-3333-3333-333333333302', 0, 0)
ON CONFLICT (store_id, product_id) DO NOTHING;

WITH opening_movements (id, store_id, product_id, quantity_delta, actor_id, reference_id) AS (
  VALUES
    ('44444444-4444-4444-4444-444444444401'::uuid, '11111111-1111-1111-1111-111111111111'::uuid, '33333333-3333-3333-3333-333333333301'::uuid, 25.000::numeric, '22222222-2222-2222-2222-222222222202'::uuid, 'opening-jkt-rice'),
    ('44444444-4444-4444-4444-444444444402'::uuid, '11111111-1111-1111-1111-111111111111'::uuid, '33333333-3333-3333-3333-333333333302'::uuid, 40.000::numeric, '22222222-2222-2222-2222-222222222202'::uuid, 'opening-jkt-oil'),
    ('44444444-4444-4444-4444-444444444403'::uuid, '11111111-1111-1111-1111-111111111112'::uuid, '33333333-3333-3333-3333-333333333301'::uuid, 15.000::numeric, '22222222-2222-2222-2222-222222222204'::uuid, 'opening-bdg-rice'),
    ('44444444-4444-4444-4444-444444444404'::uuid, '11111111-1111-1111-1111-111111111112'::uuid, '33333333-3333-3333-3333-333333333302'::uuid, 30.000::numeric, '22222222-2222-2222-2222-222222222204'::uuid, 'opening-bdg-oil')
), inserted AS (
  INSERT INTO inventory_movements (
    id, store_id, product_id, inventory_version, movement_type, quantity_delta,
    reference_type, reference_id, actor_id
  )
  SELECT id, store_id, product_id, 1, 'OPENING_BALANCE', quantity_delta,
         'DEVELOPMENT_SEED', reference_id, actor_id
  FROM opening_movements
  ON CONFLICT (id) DO NOTHING
  RETURNING store_id, product_id, quantity_delta, inventory_version
)
UPDATE inventory_balances balances
SET quantity = balances.quantity + inserted.quantity_delta,
    version = inserted.inventory_version
FROM inserted
WHERE balances.store_id = inserted.store_id AND balances.product_id = inserted.product_id;
