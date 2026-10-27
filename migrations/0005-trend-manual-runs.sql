-- Preserve daily idempotency while allowing an explicit, owner-authorized paid request.
-- Existing rows retain their original Warsaw date, source evidence, cost and publication.
ALTER TABLE trend_run ADD COLUMN manual_request_key uuid;
ALTER TABLE trend_run ADD CONSTRAINT trend_run_manual_control CHECK(manual_request_key IS NULL OR mode='control');
CREATE UNIQUE INDEX trend_run_manual_request_unique ON trend_run(manual_request_key);
ALTER TABLE trend_run DROP CONSTRAINT trend_run_date_key;
CREATE UNIQUE INDEX trend_run_date_unique ON trend_run(date) WHERE manual_request_key IS NULL;
