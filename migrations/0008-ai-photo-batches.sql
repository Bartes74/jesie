CREATE TABLE ai_photo_batch (
  id text PRIMARY KEY,
  recipe_id text NOT NULL REFERENCES editorial_recipe(id), base_revision integer NOT NULL CHECK(base_revision > 0),
  source_job_id text REFERENCES ai_job(id), input jsonb NOT NULL, input_hash text NOT NULL,
  slots jsonb NOT NULL CHECK(jsonb_typeof(slots)='array'),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','generating','ready','blocked','failed','applied')),
  request_key text NOT NULL, created_by text NOT NULL, created_by_name text NOT NULL,
  reserved_usd numeric(16,8) NOT NULL CHECK(reserved_usd >= 0),
  remaining_reserved_usd numeric(16,8) NOT NULL CHECK(remaining_reserved_usd >= 0 AND remaining_reserved_usd <= reserved_usd),
  generation integer NOT NULL DEFAULT 1 CHECK(generation > 0), workflow_run_id text,
  error_code text, error_message text, applied_revision integer,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(created_by,request_key)
);
CREATE INDEX ai_photo_batch_recipe_created_idx ON ai_photo_batch(recipe_id,created_at);
CREATE UNIQUE INDEX ai_photo_batch_active_input_unique ON ai_photo_batch(recipe_id,input_hash)
  WHERE status IN ('queued','generating','ready','blocked');
ALTER TABLE ai_job ADD COLUMN photo_batch_id text REFERENCES ai_photo_batch(id);
ALTER TABLE ai_job ADD CONSTRAINT ai_job_single_scope CHECK(trend_run_id IS NULL OR photo_batch_id IS NULL);
CREATE INDEX ai_job_photo_batch_idx ON ai_job(photo_batch_id);

CREATE OR REPLACE FUNCTION ai_guard_job_capture() RETURNS trigger AS $$
BEGIN
  IF (NEW.id,NEW.recipe_id,NEW.base_revision,NEW.kind,NEW.target_id,NEW.provider,NEW.model,NEW.brief,NEW.request_key,NEW.input_hash,NEW.input,NEW.created_by,NEW.created_by_name,NEW.reserved_usd,NEW.created_at,NEW.ingredient_key,NEW.reuse_source_job_id,NEW.photo_batch_id)
     IS DISTINCT FROM (OLD.id,OLD.recipe_id,OLD.base_revision,OLD.kind,OLD.target_id,OLD.provider,OLD.model,OLD.brief,OLD.request_key,OLD.input_hash,OLD.input,OLD.created_by,OLD.created_by_name,OLD.reserved_usd,OLD.created_at,OLD.ingredient_key,OLD.reuse_source_job_id,OLD.photo_batch_id) THEN
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
CREATE FUNCTION ai_photo_batch_guard() RETURNS trigger AS $$
BEGIN
  IF (NEW.id,NEW.recipe_id,NEW.base_revision,NEW.source_job_id,NEW.input,NEW.input_hash,NEW.request_key,NEW.created_by,NEW.created_by_name,NEW.reserved_usd,NEW.created_at)
     IS DISTINCT FROM (OLD.id,OLD.recipe_id,OLD.base_revision,OLD.source_job_id,OLD.input,OLD.input_hash,OLD.request_key,OLD.created_by,OLD.created_by_name,OLD.reserved_usd,OLD.created_at) THEN
    RAISE EXCEPTION 'AI photo batch capture is immutable' USING ERRCODE='55000';
  END IF;
  IF (SELECT coalesce(jsonb_agg(value-'jobId'-'recoverySourceJobId'),'[]'::jsonb) FROM jsonb_array_elements(NEW.slots))
      IS DISTINCT FROM (SELECT coalesce(jsonb_agg(value-'jobId'-'recoverySourceJobId'),'[]'::jsonb) FROM jsonb_array_elements(OLD.slots)) THEN
    RAISE EXCEPTION 'AI photo batch targets are immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.generation < OLD.generation OR (NEW.generation=OLD.generation AND OLD.workflow_run_id IS NOT NULL AND NEW.workflow_run_id IS DISTINCT FROM OLD.workflow_run_id) THEN
    RAISE EXCEPTION 'AI photo batch worker identity is immutable within a generation' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ai_photo_batch_capture_immutable BEFORE UPDATE ON ai_photo_batch FOR EACH ROW EXECUTE FUNCTION ai_photo_batch_guard();
COMMENT ON TABLE ai_photo_batch IS 'Reserved Studio photograph package; private previews require explicit atomic application and never publish.';
