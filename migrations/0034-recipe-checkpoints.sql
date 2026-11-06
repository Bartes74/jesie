-- Keep paid recipe responses before any fallible local validation or ingredient research.
CREATE TABLE ai_recipe_response (
  job_id text PRIMARY KEY REFERENCES ai_job(id),
  request_id text NOT NULL,
  response jsonb NOT NULL CHECK(jsonb_typeof(response)='object' AND response->>'id'=request_id AND response->>'status'='completed'),
  digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_recipe_manual_repair (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES ai_job(id),
  recipe_id text NOT NULL REFERENCES editorial_recipe(id),
  version integer NOT NULL CHECK(version>0),
  proposal jsonb NOT NULL CHECK(jsonb_typeof(proposal)='object'),
  reviewed_ingredients jsonb NOT NULL CHECK(jsonb_typeof(reviewed_ingredients)='array'),
  reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 2000),
  actor_id text NOT NULL,
  actor_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ai_recipe_response_request_unique ON ai_recipe_response(request_id);
CREATE UNIQUE INDEX ai_recipe_manual_repair_version_unique ON ai_recipe_manual_repair(job_id,version);
CREATE INDEX ai_recipe_manual_repair_recipe_idx ON ai_recipe_manual_repair(recipe_id);

CREATE FUNCTION require_recipe_checkpoint_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='ai_recipe_response' THEN
    IF NOT EXISTS(SELECT 1 FROM ai_job WHERE id=NEW.job_id AND kind='recipe' AND provider='openai' AND provider_request_id=NEW.request_id) THEN
      RAISE EXCEPTION 'RECIPE_CHECKPOINT_RECEIPT_MISMATCH';
    END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM ai_job WHERE id=NEW.job_id AND kind='recipe' AND recipe_id=NEW.recipe_id) THEN
    RAISE EXCEPTION 'RECIPE_CHECKPOINT_RECIPE_MISMATCH';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_recipe_response_identity BEFORE INSERT ON ai_recipe_response FOR EACH ROW EXECUTE FUNCTION require_recipe_checkpoint_identity();
CREATE TRIGGER ai_recipe_manual_repair_identity BEFORE INSERT ON ai_recipe_manual_repair FOR EACH ROW EXECUTE FUNCTION require_recipe_checkpoint_identity();
REVOKE ALL ON FUNCTION require_recipe_checkpoint_identity() FROM PUBLIC;

CREATE FUNCTION protect_recipe_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'RECIPE_CHECKPOINT_IMMUTABLE';
END $$;
CREATE TRIGGER ai_recipe_response_immutable BEFORE UPDATE OR DELETE ON ai_recipe_response FOR EACH ROW EXECUTE FUNCTION protect_recipe_checkpoint();
CREATE TRIGGER ai_recipe_manual_repair_immutable BEFORE UPDATE OR DELETE ON ai_recipe_manual_repair FOR EACH ROW EXECUTE FUNCTION protect_recipe_checkpoint();
REVOKE ALL ON FUNCTION protect_recipe_checkpoint() FROM PUBLIC;
ALTER TABLE ai_recipe_response ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_recipe_manual_repair ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ai_recipe_response,ai_recipe_manual_repair FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON ai_recipe_response,ai_recipe_manual_repair FROM anon'; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON ai_recipe_response,ai_recipe_manual_repair FROM authenticated'; END IF;
END $$;
