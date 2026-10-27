-- Independent approval of cooking text; media revisions never grant or erase it.
CREATE TABLE editorial_content_approval (
  recipe_id text NOT NULL REFERENCES editorial_recipe(id),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  origin text NOT NULL CHECK (origin IN ('manual', 'automated')),
  revision integer NOT NULL CHECK (revision > 0),
  actor_id text NOT NULL,
  actor_name text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recipe_id, content_hash, origin)
);
CREATE INDEX editorial_content_approval_recipe_idx ON editorial_content_approval(recipe_id, approved_at);
ALTER TABLE editorial_content_approval ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON editorial_content_approval FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON editorial_content_approval FROM anon'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON editorial_content_approval FROM authenticated'; END IF;
END;
$$;
CREATE TRIGGER editorial_content_approval_immutable BEFORE UPDATE OR DELETE ON editorial_content_approval
  FOR EACH ROW EXECUTE FUNCTION editorial_reject_history_mutation();
COMMENT ON TABLE editorial_content_approval IS 'Private append-only cooking-text approval receipts; no publication permission and no media-dependent hash.';
