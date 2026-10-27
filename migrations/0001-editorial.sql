CREATE TABLE IF NOT EXISTS editorial_recipe (
  id text PRIMARY KEY,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  content jsonb NOT NULL,
  content_hash text NOT NULL,
  editorial_status text NOT NULL DEFAULT 'draft' CHECK (editorial_status IN ('draft', 'in_review', 'approved', 'archived')),
  publication_status text NOT NULL DEFAULT 'never_published' CHECK (publication_status IN ('never_published', 'published', 'unpublished')),
  checks jsonb NOT NULL,
  checks_revision integer NOT NULL DEFAULT 1,
  approved_revision integer,
  published_id text,
  published_revision integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  updated_by_name text NOT NULL
);
CREATE INDEX IF NOT EXISTS editorial_recipe_updated_idx ON editorial_recipe (updated_at);
CREATE INDEX IF NOT EXISTS editorial_recipe_publication_idx ON editorial_recipe (publication_status);

CREATE TABLE IF NOT EXISTS editorial_version (
  recipe_id text NOT NULL REFERENCES editorial_recipe(id),
  revision integer NOT NULL,
  content jsonb NOT NULL,
  content_hash text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  created_by_name text NOT NULL,
  PRIMARY KEY(recipe_id, revision)
);

CREATE TABLE IF NOT EXISTS editorial_publication (
  id text PRIMARY KEY,
  recipe_id text NOT NULL REFERENCES editorial_recipe(id),
  revision integer NOT NULL,
  snapshot jsonb NOT NULL,
  content_hash text NOT NULL,
  checks jsonb NOT NULL,
  approval_origin text NOT NULL CHECK (approval_origin IN ('manual', 'legacy_demo_import')),
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by text NOT NULL,
  published_by_name text NOT NULL,
  UNIQUE(recipe_id, revision),
  UNIQUE(id, recipe_id)
);
ALTER TABLE editorial_recipe ADD CONSTRAINT editorial_active_publication_fk
  FOREIGN KEY(published_id, id) REFERENCES editorial_publication(id, recipe_id);

CREATE TABLE IF NOT EXISTS editorial_slug (
  locale text NOT NULL CHECK (locale IN ('pl', 'en')),
  slug text NOT NULL,
  recipe_id text NOT NULL REFERENCES editorial_recipe(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(locale, slug)
);

CREATE TABLE IF NOT EXISTS editorial_audit (
  id text PRIMARY KEY,
  recipe_id text NOT NULL REFERENCES editorial_recipe(id),
  revision integer NOT NULL,
  action text NOT NULL,
  actor_id text NOT NULL,
  actor_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS editorial_outbox (
  id text PRIMARY KEY,
  recipe_id text NOT NULL REFERENCES editorial_recipe(id),
  revision integer NOT NULL,
  event text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS editorial_outbox_pending_idx ON editorial_outbox (created_at) WHERE processed_at IS NULL;

CREATE FUNCTION editorial_reject_history_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Editorial history is immutable' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER editorial_version_immutable BEFORE UPDATE OR DELETE ON editorial_version
  FOR EACH ROW EXECUTE FUNCTION editorial_reject_history_mutation();
CREATE TRIGGER editorial_publication_immutable BEFORE UPDATE OR DELETE ON editorial_publication
  FOR EACH ROW EXECUTE FUNCTION editorial_reject_history_mutation();
CREATE TRIGGER editorial_audit_immutable BEFORE UPDATE OR DELETE ON editorial_audit
  FOR EACH ROW EXECUTE FUNCTION editorial_reject_history_mutation();

COMMENT ON TABLE editorial_recipe IS 'Mutable editorial draft; active publication is an immutable separate snapshot.';
COMMENT ON TABLE editorial_publication IS 'Manual publications and explicitly labelled legacy demo import, never auto-generated approvals.';
