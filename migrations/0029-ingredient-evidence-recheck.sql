ALTER TABLE ai_ingredient_verification ADD COLUMN eligibility_policy_version text NOT NULL DEFAULT 'ingredient-evidence-v1';

CREATE OR REPLACE FUNCTION protect_ingredient_verification_identity() RETURNS trigger LANGUAGE plpgsql AS $$
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
  -- Eligibility is computed by application policy. All paid response facts,
  -- including its exact queried names and original sources, remain immutable.
  IF OLD.result IS NOT NULL AND ((OLD.result-'autoLearnEligible') IS DISTINCT FROM (NEW.result-'autoLearnEligible')
    OR jsonb_typeof(NEW.result->'autoLearnEligible') IS DISTINCT FROM 'boolean') THEN
    RAISE EXCEPTION 'INGREDIENT_VERIFICATION_RESULT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION protect_ingredient_verification_identity() FROM PUBLIC;
