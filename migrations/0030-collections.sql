CREATE TABLE event_collection (
  id text PRIMARY KEY,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  content jsonb NOT NULL CHECK(jsonb_typeof(content)='object'),
  content_hash text NOT NULL,
  publication_status text NOT NULL DEFAULT 'never_published' CHECK(publication_status IN ('never_published','published','unpublished')),
  published_id text,
  published_revision integer,
  first_published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  updated_by_name text NOT NULL,
  CHECK(publication_status<>'published' OR (published_id IS NOT NULL AND published_revision IS NOT NULL AND first_published_at IS NOT NULL)),
  CHECK(published_revision IS NULL OR (published_revision>0 AND published_revision<=revision)),
  CHECK(content->>'selectionMode'=CASE WHEN id='quick-dinners' THEN 'quick-dinners' ELSE 'manual' END),
  CHECK((content->>'minimumRecipes')::integer=CASE WHEN id IN ('quick-dinners','one-pot','pantry','seasonal') THEN 5 ELSE 1 END)
);
CREATE INDEX event_collection_updated_idx ON event_collection(updated_at);
CREATE UNIQUE INDEX event_collection_slug_pl_unique ON event_collection((content->'slug'->>'pl')) WHERE coalesce(content->'slug'->>'pl','')<>'';
CREATE UNIQUE INDEX event_collection_slug_en_unique ON event_collection((content->'slug'->>'en')) WHERE coalesce(content->'slug'->>'en','')<>'';

CREATE TABLE event_collection_publication (
  id text PRIMARY KEY,
  collection_id text NOT NULL REFERENCES event_collection(id),
  revision integer NOT NULL CHECK(revision>0),
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND snapshot->>'id'=collection_id),
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by text NOT NULL,
  published_by_name text NOT NULL,
  UNIQUE(collection_id,revision),
  UNIQUE(id,collection_id)
);
ALTER TABLE event_collection ADD CONSTRAINT event_collection_active_publication_fk
  FOREIGN KEY(published_id,id) REFERENCES event_collection_publication(id,collection_id);
CREATE TRIGGER event_collection_publication_immutable BEFORE UPDATE OR DELETE ON event_collection_publication
  FOR EACH ROW EXECUTE FUNCTION editorial_reject_history_mutation();

CREATE FUNCTION protect_collection_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.id,NEW.created_at,NEW.created_by) IS DISTINCT FROM (OLD.id,OLD.created_at,OLD.created_by) THEN
    RAISE EXCEPTION 'COLLECTION_IDENTITY_IMMUTABLE';
  END IF;
  IF OLD.first_published_at IS NOT NULL AND (NEW.first_published_at IS DISTINCT FROM OLD.first_published_at
    OR NEW.content->'slug' IS DISTINCT FROM OLD.content->'slug') THEN
    RAISE EXCEPTION 'COLLECTION_PUBLISHED_SLUG_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_collection_identity_immutable BEFORE UPDATE OR DELETE ON event_collection
  FOR EACH ROW EXECUTE FUNCTION protect_collection_identity();

ALTER TABLE event_collection ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_collection_publication ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON event_collection,event_collection_publication FROM PUBLIC;
REVOKE ALL ON FUNCTION protect_collection_identity() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON event_collection,event_collection_publication FROM anon'; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON event_collection,event_collection_publication FROM authenticated'; END IF;
END $$;
COMMENT ON TABLE event_collection IS 'Mutable bilingual collection drafts; dates promote the hero and never expire the public page.';
COMMENT ON TABLE event_collection_publication IS 'Immutable collection snapshots with ordered references to published recipe identities.';
