CREATE TABLE collection_theme_generation (
  id text PRIMARY KEY, collection_id text NOT NULL REFERENCES event_collection(id),
  base_revision integer NOT NULL CHECK (base_revision>0), part text NOT NULL CHECK(part IN ('all','hero','background')),
  brief text NOT NULL, inspiration_asset_id text, base_theme jsonb, proposal jsonb, input jsonb NOT NULL,
  theme jsonb, status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','ready','failed','uncertain')),
  request_key text NOT NULL, input_hash text NOT NULL, created_by text NOT NULL, error text, applied_revision integer,
  dispatch_token text, dispatch_expires_at timestamptz, workflow_id text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT collection_theme_request_unique UNIQUE(created_by,request_key)
);
CREATE INDEX collection_theme_collection_idx ON collection_theme_generation(collection_id);
CREATE TABLE collection_theme_job (
  id text PRIMARY KEY, generation_id text NOT NULL REFERENCES collection_theme_generation(id),
  kind text NOT NULL CHECK(kind IN ('spec','hero','atmosphere')), model text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','submitting','generating','ready','failed','uncertain')),
  provider_request_id text, provider_finished_at timestamptz, charged_usd numeric(16,8) CHECK(charged_usd>=0),
  result jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT collection_theme_stage_unique UNIQUE(generation_id,kind)
);
CREATE TABLE collection_asset (
  id text PRIMARY KEY, collection_id text NOT NULL REFERENCES event_collection(id),
  generation_id text REFERENCES collection_theme_generation(id),
  kind text NOT NULL CHECK(kind IN ('inspiration','hero','atmosphere')),
  blob_pathname text NOT NULL UNIQUE, sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  width integer NOT NULL CHECK(width>0), height integer NOT NULL CHECK(height>0), content_type text NOT NULL CHECK(content_type='image/webp'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (blob_pathname='media/collections/' || id || '.webp'),
  CHECK ((kind='inspiration' AND generation_id IS NULL) OR (kind<>'inspiration' AND generation_id IS NOT NULL))
);
CREATE TABLE collection_theme_cost (
  job_id text PRIMARY KEY REFERENCES collection_theme_job(id), amount_usd numeric(16,8) NOT NULL CHECK(amount_usd>=0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE collection_discovery_event (
  id text PRIMARY KEY, collection_id text NOT NULL REFERENCES event_collection(id), paths jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token text, lease_expires_at timestamptz, completed_at timestamptz, last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX collection_discovery_pending_idx ON collection_discovery_event(next_attempt_at) WHERE completed_at IS NULL;
CREATE FUNCTION protect_collection_asset_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Collection media and settled costs are immutable'; END;
$$;
CREATE TRIGGER collection_asset_history_immutable BEFORE UPDATE OR DELETE ON collection_asset FOR EACH ROW EXECUTE FUNCTION protect_collection_asset_history();
CREATE TRIGGER collection_theme_cost_immutable BEFORE UPDATE OR DELETE ON collection_theme_cost FOR EACH ROW EXECUTE FUNCTION protect_collection_asset_history();
CREATE FUNCTION protect_collection_generation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.collection_id IS DISTINCT FROM OLD.collection_id
    OR NEW.base_revision IS DISTINCT FROM OLD.base_revision OR NEW.part IS DISTINCT FROM OLD.part
    OR NEW.brief IS DISTINCT FROM OLD.brief OR NEW.inspiration_asset_id IS DISTINCT FROM OLD.inspiration_asset_id
    OR NEW.base_theme IS DISTINCT FROM OLD.base_theme OR NEW.input IS DISTINCT FROM OLD.input
    OR NEW.request_key IS DISTINCT FROM OLD.request_key OR NEW.input_hash IS DISTINCT FROM OLD.input_hash
    OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.status='ready' AND (NEW.theme IS DISTINCT FROM OLD.theme OR NEW.proposal IS DISTINCT FROM OLD.proposal OR NEW.status<>'ready'))
  THEN RAISE EXCEPTION 'Collection generation identity and completed proposals are immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER collection_theme_identity_immutable BEFORE UPDATE ON collection_theme_generation FOR EACH ROW EXECUTE FUNCTION protect_collection_generation_identity();
CREATE TRIGGER collection_theme_history_retained BEFORE DELETE ON collection_theme_generation FOR EACH ROW EXECUTE FUNCTION protect_collection_asset_history();
CREATE FUNCTION protect_collection_job_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.generation_id,NEW.kind,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.generation_id,OLD.kind,OLD.created_at)
    OR (NEW.model IS DISTINCT FROM OLD.model AND (OLD.provider_request_id IS NOT NULL OR NEW.model<>replace(OLD.model,'/text-to-image','/edit')))
    OR (OLD.provider_request_id IS NOT NULL AND NEW.provider_request_id IS DISTINCT FROM OLD.provider_request_id)
    OR (OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result)
    OR (OLD.charged_usd IS NOT NULL AND NEW.charged_usd IS DISTINCT FROM OLD.charged_usd)
  THEN RAISE EXCEPTION 'Collection provider identity, completed result and settled cost are immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER collection_theme_job_immutable BEFORE UPDATE ON collection_theme_job FOR EACH ROW EXECUTE FUNCTION protect_collection_job_identity();
CREATE TRIGGER collection_theme_job_retained BEFORE DELETE ON collection_theme_job FOR EACH ROW EXECUTE FUNCTION protect_collection_asset_history();
ALTER TABLE collection_theme_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_theme_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_asset ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_theme_cost ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_discovery_event ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON collection_theme_generation,collection_theme_job,collection_asset,collection_theme_cost,collection_discovery_event FROM PUBLIC;
REVOKE ALL ON FUNCTION protect_collection_asset_history(),protect_collection_generation_identity(),protect_collection_job_identity() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON collection_theme_generation,collection_theme_job,collection_asset,collection_theme_cost,collection_discovery_event FROM anon'; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON collection_theme_generation,collection_theme_job,collection_asset,collection_theme_cost,collection_discovery_event FROM authenticated'; END IF;
END $$;

-- Catalogue interactions also originate from curated collection pages.
ALTER TABLE seo_usage_daily DROP CONSTRAINT seo_usage_daily_check;
ALTER TABLE seo_usage_daily ADD CONSTRAINT seo_usage_daily_check CHECK (
  event='page_view' OR path ~ '^/(pl|en)/recipes/[a-z0-9]+(-[a-z0-9]+)*$'
  OR (event IN ('pantry_use','search','no_results','shopping_copy','plan_remove') AND path ~ '^/(pl|en)(/plan|/kolekcje/[a-z0-9]+(-[a-z0-9]+)*)?$')
);
