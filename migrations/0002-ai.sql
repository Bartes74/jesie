CREATE TABLE ai_job (
  id text PRIMARY KEY,
  recipe_id text NOT NULL REFERENCES editorial_recipe(id), base_revision integer NOT NULL CHECK(base_revision > 0),
  kind text NOT NULL CHECK(kind IN ('recipe','hero','ingredient','step')), target_id text,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','submitting','generating','ready','failed','uncertain','cancelled','applied')),
  provider text NOT NULL CHECK(provider IN ('openai','fal')), model text NOT NULL, brief text NOT NULL,
  request_key text NOT NULL, input_hash text NOT NULL, input jsonb NOT NULL,
  created_by text NOT NULL, created_by_name text NOT NULL, provider_request_id text, provider_finished_at timestamptz,
  reserved_usd numeric(16,8) NOT NULL CHECK(reserved_usd > 0), charged_usd numeric(16,8) CHECK(charged_usd >= 0),
  cost_basis text CHECK(cost_basis IN ('usage','reservation')), usage jsonb, result jsonb, error_code text, error_message text, applied_revision integer,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(created_by, request_key),
  CHECK((kind IN ('recipe','hero') AND target_id IS NULL) OR (kind IN ('ingredient','step') AND target_id IS NOT NULL))
);
CREATE INDEX ai_job_recipe_created_idx ON ai_job(recipe_id,created_at);
CREATE UNIQUE INDEX ai_job_active_input_unique ON ai_job(input_hash) WHERE status IN ('queued','submitting','generating','uncertain');

CREATE TABLE ai_asset (
  id text PRIMARY KEY, recipe_id text NOT NULL REFERENCES editorial_recipe(id), job_id text NOT NULL UNIQUE REFERENCES ai_job(id),
  kind text NOT NULL CHECK(kind IN ('hero','ingredient','step')), target_id text, blob_pathname text NOT NULL UNIQUE, original_blob_pathname text,
  width integer NOT NULL CHECK(width > 0 AND width <= 10000), height integer NOT NULL CHECK(height > 0 AND height <= 10000),
  content_type text NOT NULL CHECK(content_type IN ('image/webp','image/png','image/jpeg')),
  alt jsonb NOT NULL, caption jsonb NOT NULL, model text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_asset_recipe_idx ON ai_asset(recipe_id);

CREATE TABLE ai_cost_ledger (
  id text PRIMARY KEY, job_id text NOT NULL REFERENCES ai_job(id), entry text NOT NULL CHECK(entry IN ('reserve','settle','reconcile')),
  amount_usd numeric(16,8) NOT NULL, basis text NOT NULL CHECK(basis IN ('reservation','usage','cancelled','not_charged')),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(job_id,entry)
);

CREATE FUNCTION ai_guard_job_capture() RETURNS trigger AS $$
BEGIN
  IF (NEW.id,NEW.recipe_id,NEW.base_revision,NEW.kind,NEW.target_id,NEW.provider,NEW.model,NEW.brief,NEW.request_key,NEW.input_hash,NEW.input,NEW.created_by,NEW.created_by_name,NEW.reserved_usd,NEW.created_at)
     IS DISTINCT FROM (OLD.id,OLD.recipe_id,OLD.base_revision,OLD.kind,OLD.target_id,OLD.provider,OLD.model,OLD.brief,OLD.request_key,OLD.input_hash,OLD.input,OLD.created_by,OLD.created_by_name,OLD.reserved_usd,OLD.created_at) THEN
    RAISE EXCEPTION 'AI captured input is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.provider_request_id IS NOT NULL AND NEW.provider_request_id IS DISTINCT FROM OLD.provider_request_id THEN
    RAISE EXCEPTION 'AI provider request identity is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result THEN
    RAISE EXCEPTION 'AI completed result is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ai_job_capture_immutable BEFORE UPDATE ON ai_job FOR EACH ROW EXECUTE FUNCTION ai_guard_job_capture();
CREATE TRIGGER ai_asset_immutable BEFORE UPDATE OR DELETE ON ai_asset FOR EACH ROW EXECUTE FUNCTION editorial_reject_history_mutation();
CREATE TRIGGER ai_cost_ledger_immutable BEFORE UPDATE OR DELETE ON ai_cost_ledger FOR EACH ROW EXECUTE FUNCTION editorial_reject_history_mutation();

COMMENT ON TABLE ai_job IS 'Captured AI proposals, durable submission identity, conservative reserved cost; no automatic publication.';
COMMENT ON TABLE ai_asset IS 'Immutable private blob paths. DTOs expose only controlled /media/id routes.';
