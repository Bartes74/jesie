CREATE TABLE ai_ingredient_verification (
  verification_key text PRIMARY KEY CHECK(verification_key ~ '^[a-f0-9]{64}$'),
  input jsonb NOT NULL CHECK(jsonb_typeof(input)='object'),
  model text NOT NULL,
  origin_job_id text REFERENCES ai_job(id) ON DELETE SET NULL,
  origin_recipe_id text,
  status text NOT NULL CHECK(status IN ('submitting','generating','complete','uncertain','failed')),
  claim_token text NOT NULL,
  claim_expires_at timestamptz NOT NULL,
  provider_request_id text UNIQUE,
  result jsonb CHECK(result IS NULL OR jsonb_typeof(result)='object'),
  learned boolean NOT NULL DEFAULT false,
  charged_usd numeric(16,8) CHECK(charged_usd IS NULL OR charged_usd>=0),
  cost_basis text CHECK(cost_basis IS NULL OR cost_basis IN ('usage','reservation')),
  usage jsonb CHECK(usage IS NULL OR jsonb_typeof(usage)='object'),
  error_code text,
  error_message text,
  provider_finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(status<>'generating' OR provider_request_id IS NOT NULL),
  CHECK(status<>'complete' OR (provider_request_id IS NOT NULL AND result IS NOT NULL)),
  CHECK(NOT learned OR (status='complete' AND result->>'autoLearnEligible'='true' AND result->>'decision'='verified'))
);
CREATE INDEX ai_ingredient_verification_origin_job_idx ON ai_ingredient_verification(origin_job_id);
CREATE INDEX ai_ingredient_verification_origin_recipe_idx ON ai_ingredient_verification(origin_recipe_id);
CREATE TABLE ai_verified_ingredient_alias (
  normalized_alias text PRIMARY KEY CHECK(length(normalized_alias) BETWEEN 1 AND 500),
  verification_key text NOT NULL REFERENCES ai_ingredient_verification(verification_key),
  diet text NOT NULL CHECK(diet IN ('vegan','vegetarian','meat')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE ai_ingredient_verification ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_verified_ingredient_alias ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ai_ingredient_verification,ai_verified_ingredient_alias FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON ai_ingredient_verification,ai_verified_ingredient_alias FROM anon'; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON ai_ingredient_verification,ai_verified_ingredient_alias FROM authenticated'; END IF;
END $$;
CREATE FUNCTION protect_ingredient_verification_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.verification_key,NEW.input,NEW.model,NEW.claim_token,NEW.created_at)
    IS DISTINCT FROM (OLD.verification_key,OLD.input,OLD.model,OLD.claim_token,OLD.created_at) THEN
    RAISE EXCEPTION 'INGREDIENT_VERIFICATION_IDENTITY_IMMUTABLE';
  END IF;
  IF OLD.provider_request_id IS NOT NULL AND NEW.provider_request_id IS DISTINCT FROM OLD.provider_request_id THEN
    RAISE EXCEPTION 'INGREDIENT_VERIFICATION_RECEIPT_IMMUTABLE';
  END IF;
  IF OLD.cost_basis='usage' AND OLD.charged_usd IS NOT NULL AND (NEW.charged_usd,NEW.cost_basis)
    IS DISTINCT FROM (OLD.charged_usd,OLD.cost_basis) THEN
    RAISE EXCEPTION 'INGREDIENT_VERIFICATION_COST_IMMUTABLE';
  END IF;
  IF OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result THEN
    RAISE EXCEPTION 'INGREDIENT_VERIFICATION_RESULT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_ingredient_verification_identity_immutable BEFORE UPDATE OR DELETE ON ai_ingredient_verification
  FOR EACH ROW EXECUTE FUNCTION protect_ingredient_verification_identity();
REVOKE ALL ON FUNCTION protect_ingredient_verification_identity() FROM PUBLIC;
