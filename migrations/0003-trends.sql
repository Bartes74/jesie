CREATE TABLE trend_setting (
 id text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false,
 monthly_limit_usd numeric(16,8) NOT NULL DEFAULT 150 CHECK(monthly_limit_usd > 0 AND monthly_limit_usd <= 150),
 last_control_at timestamptz, control_fingerprint text, updated_at timestamptz NOT NULL DEFAULT now(), updated_by text
);
INSERT INTO trend_setting(id) VALUES('global');
CREATE TABLE trend_run (
 id text PRIMARY KEY, date text NOT NULL, mode text NOT NULL CHECK(mode IN('daily','control')),
 generation integer NOT NULL DEFAULT 1 CHECK(generation>0),status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','searching','generating','awaiting_review','no_candidate','paused','failed','uncertain','rejected','published')),
 recipe_id text REFERENCES editorial_recipe(id),expected_revision integer,candidate_id text,workflow_id text,
 search_request_id text,search_claimed_at timestamptz,search_finished_at timestamptz,
 search_reserved_usd numeric(16,8) NOT NULL DEFAULT 2 CHECK(search_reserved_usd>=0),search_charged_usd numeric(16,8),
 packet_remaining_usd numeric(16,8) NOT NULL DEFAULT 0 CHECK(packet_remaining_usd>=0),sources jsonb NOT NULL,error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(date)
);
CREATE INDEX trend_run_recipe_idx ON trend_run(recipe_id);
CREATE TABLE trend_candidate(id text PRIMARY KEY,run_id text NOT NULL REFERENCES trend_run(id),dish_key text NOT NULL,data jsonb NOT NULL,selected boolean NOT NULL DEFAULT false);
CREATE INDEX trend_candidate_run_idx ON trend_candidate(run_id);
ALTER TABLE ai_job ADD COLUMN trend_run_id text REFERENCES trend_run(id);
CREATE INDEX ai_job_trend_run_idx ON ai_job(trend_run_id);

CREATE FUNCTION ai_guard_trend_scope() RETURNS trigger AS $$
BEGIN
 IF NEW.trend_run_id IS DISTINCT FROM OLD.trend_run_id THEN
  RAISE EXCEPTION 'Generation scope is immutable' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ai_job_trend_scope_immutable BEFORE UPDATE ON ai_job FOR EACH ROW EXECUTE FUNCTION ai_guard_trend_scope();
