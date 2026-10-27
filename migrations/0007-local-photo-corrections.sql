ALTER TABLE ai_job ADD COLUMN ingredient_resolved_at timestamptz;
UPDATE ai_job SET ingredient_resolved_at=coalesce(provider_finished_at,updated_at)
 WHERE ingredient_key IS NOT NULL AND (result IS NOT NULL OR (status='failed' AND provider_finished_at IS NOT NULL) OR (status='cancelled' AND provider_finished_at IS NOT NULL AND provider_request_id IS NULL AND charged_usd=0 AND cost_basis='usage'));
DROP INDEX ai_ingredient_producer_unique;
CREATE UNIQUE INDEX ai_ingredient_producer_unique ON ai_job(ingredient_key)
 WHERE ingredient_key IS NOT NULL AND reuse_source_job_id IS NULL AND reserved_usd>0 AND ingredient_resolved_at IS NULL AND result IS NULL AND status<>'failed';
ALTER TABLE ai_job DROP CONSTRAINT ai_job_reserved_usd_check;
ALTER TABLE ai_job ADD CONSTRAINT ai_job_reserved_usd_check CHECK(reserved_usd>=0 AND (reserved_usd>0 OR kind='ingredient' OR (kind='step' AND model='jesie/step-photo-21-9') OR (kind='hero' AND model='jesie/hero-cutout-filled')));
COMMENT ON COLUMN ai_job.ingredient_resolved_at IS 'Product identity remains occupied through provider completion and image validation, until a saved result or a confirmed failed/unsubmitted request.';
