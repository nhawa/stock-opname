CREATE INDEX inventory_movements_store_created_at_id_desc_idx
  ON inventory_movements (store_id, created_at DESC, id DESC);
