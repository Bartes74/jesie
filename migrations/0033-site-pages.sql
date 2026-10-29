-- Editable static pages (currently only "about"). Saved content is live; the code keeps a fallback.
CREATE TABLE site_page (
  id text PRIMARY KEY CHECK(id IN ('about')),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  content jsonb NOT NULL CHECK(jsonb_typeof(content)='object' AND jsonb_typeof(content->'pl')='object' AND jsonb_typeof(content->'en')='object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  updated_by_name text NOT NULL
);
ALTER TABLE site_page ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON site_page FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON site_page FROM anon'; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON site_page FROM authenticated'; END IF;
END $$;
COMMENT ON TABLE site_page IS 'Bilingual editable static page content; saving is live and the application keeps a built-in fallback.';
