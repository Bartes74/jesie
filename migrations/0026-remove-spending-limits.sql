-- Keep immutable historical accounting. New work has no financial reservation.
ALTER TABLE ai_job DROP CONSTRAINT ai_job_reserved_usd_check;
ALTER TABLE ai_job ADD CONSTRAINT ai_job_reserved_usd_check CHECK (reserved_usd >= 0);
ALTER TABLE ai_job ALTER COLUMN reserved_usd SET DEFAULT 0;
ALTER TABLE ai_photo_batch ALTER COLUMN reserved_usd SET DEFAULT 0;
ALTER TABLE ai_photo_batch ALTER COLUMN remaining_reserved_usd SET DEFAULT 0;
ALTER TABLE trend_run ALTER COLUMN search_reserved_usd SET DEFAULT 0;

-- Producer identity protects against duplicate paid requests independently of money.
DROP INDEX ai_ingredient_producer_unique;
CREATE UNIQUE INDEX ai_ingredient_producer_unique ON ai_job(ingredient_key)
 WHERE ingredient_key IS NOT NULL AND reuse_source_job_id IS NULL
 AND ingredient_resolved_at IS NULL AND result IS NULL AND status <> 'failed';
