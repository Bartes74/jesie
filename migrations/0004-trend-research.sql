-- Historical runs keep their original content, cost, status and null diagnostics.
ALTER TABLE trend_run ADD COLUMN search_model text;
ALTER TABLE trend_run ADD COLUMN search_diagnostics jsonb;
ALTER TABLE trend_run ADD COLUMN configuration_fingerprint text;
ALTER TABLE trend_setting ADD COLUMN auto_pause_reason text;
ALTER TABLE trend_setting ADD COLUMN auto_pause_token text;
ALTER TABLE trend_setting ADD COLUMN auto_pause_reviewed_at timestamptz;
