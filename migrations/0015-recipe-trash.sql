-- Recovery preserves editorial versions, paid provider receipts, images and slug ownership.
ALTER TABLE editorial_recipe ADD COLUMN deleted_at timestamptz;
ALTER TABLE editorial_recipe ADD CONSTRAINT editorial_deleted_not_publishable
  CHECK (deleted_at IS NULL OR (publication_status <> 'published' AND approved_revision IS NULL));
CREATE INDEX editorial_recipe_deleted_idx ON editorial_recipe(deleted_at);
