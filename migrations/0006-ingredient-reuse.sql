ALTER TABLE ai_job ADD COLUMN ingredient_key text;
ALTER TABLE ai_job ADD COLUMN reuse_source_job_id text REFERENCES ai_job(id);
ALTER TABLE ai_job DROP CONSTRAINT ai_job_reserved_usd_check;
ALTER TABLE ai_job ADD CONSTRAINT ai_job_reserved_usd_check CHECK(reserved_usd>=0 AND (reserved_usd>0 OR kind='ingredient' OR (kind='step' AND model='jesie/step-photo-21-9')));
ALTER TABLE ai_job ADD CONSTRAINT ai_job_reuse_valid CHECK(reuse_source_job_id IS NULL OR (kind='ingredient' AND ingredient_key IS NOT NULL AND reserved_usd=0));
CREATE UNIQUE INDEX ai_ingredient_producer_unique ON ai_job(ingredient_key)
  WHERE ingredient_key IS NOT NULL AND reuse_source_job_id IS NULL AND reserved_usd>0 AND provider_finished_at IS NULL;
CREATE INDEX ai_job_ingredient_key_idx ON ai_job(ingredient_key);
CREATE TABLE ingredient_image_catalog (
  key text NOT NULL, product text NOT NULL, form text NOT NULL, style_profile text NOT NULL,
  asset_id text NOT NULL REFERENCES ai_asset(id), source_job_id text NOT NULL REFERENCES ai_job(id), photo jsonb NOT NULL,
  eligibility text NOT NULL DEFAULT 'usable' CHECK(eligibility IN ('usable','approved','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(key,asset_id)
);
CREATE INDEX ingredient_image_key_idx ON ingredient_image_catalog(key);
CREATE FUNCTION ingredient_image_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Ingredient image identity is immutable' USING ERRCODE='55000'; END IF;
  IF (NEW.key,NEW.product,NEW.form,NEW.style_profile,NEW.asset_id,NEW.source_job_id,NEW.photo,NEW.created_at)
      IS DISTINCT FROM (OLD.key,OLD.product,OLD.form,OLD.style_profile,OLD.asset_id,OLD.source_job_id,OLD.photo,OLD.created_at) THEN
    RAISE EXCEPTION 'Ingredient image identity is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ingredient_image_identity_immutable BEFORE UPDATE OR DELETE ON ingredient_image_catalog FOR EACH ROW EXECUTE FUNCTION ingredient_image_guard();
CREATE OR REPLACE FUNCTION ai_guard_job_capture() RETURNS trigger AS $$
BEGIN
  IF (NEW.id,NEW.recipe_id,NEW.base_revision,NEW.kind,NEW.target_id,NEW.provider,NEW.model,NEW.brief,NEW.request_key,NEW.input_hash,NEW.input,NEW.created_by,NEW.created_by_name,NEW.reserved_usd,NEW.created_at,NEW.ingredient_key,NEW.reuse_source_job_id)
     IS DISTINCT FROM (OLD.id,OLD.recipe_id,OLD.base_revision,OLD.kind,OLD.target_id,OLD.provider,OLD.model,OLD.brief,OLD.request_key,OLD.input_hash,OLD.input,OLD.created_by,OLD.created_by_name,OLD.reserved_usd,OLD.created_at,OLD.ingredient_key,OLD.reuse_source_job_id) THEN
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
COMMENT ON TABLE ingredient_image_catalog IS 'Verified reusable ingredient photographs keyed by canonical product, preparation form and common photographic style; no duplicate paid generation.';
