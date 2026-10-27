-- Each bounded repair is an ordinary separately reserved/billed ai_job.
CREATE TABLE ai_recipe_recovery (
  job_id text PRIMARY KEY REFERENCES ai_job(id),
  root_job_id text NOT NULL REFERENCES ai_job(id),
  parent_job_id text UNIQUE REFERENCES ai_job(id),
  attempt integer NOT NULL CHECK(attempt BETWEEN 0 AND 2),
  trend_generation integer CHECK(trend_generation>0),
  repair_issues jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(repair_issues)='array'),
  failure_issues jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(failure_issues)='array'),
  repairable boolean NOT NULL DEFAULT false,
  blocked_code text,
  blocked_message text,
  generation integer NOT NULL DEFAULT 1 CHECK(generation>0),
  workflow_run_id text,
  dispatch_claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(root_job_id,attempt),
  CHECK((attempt=0 AND parent_job_id IS NULL AND root_job_id=job_id)
    OR (attempt>0 AND parent_job_id IS NOT NULL AND root_job_id<>job_id))
);
CREATE INDEX ai_recipe_recovery_root_idx ON ai_recipe_recovery(root_job_id,attempt DESC);
ALTER TABLE ai_recipe_recovery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ai_recipe_recovery FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON ai_recipe_recovery FROM anon'; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON ai_recipe_recovery FROM authenticated'; END IF;
END $$;
CREATE FUNCTION protect_recipe_recovery_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.job_id,NEW.root_job_id,NEW.parent_job_id,NEW.attempt,NEW.trend_generation,NEW.repair_issues,NEW.created_at)
    IS DISTINCT FROM (OLD.job_id,OLD.root_job_id,OLD.parent_job_id,OLD.attempt,OLD.trend_generation,OLD.repair_issues,OLD.created_at) THEN
    RAISE EXCEPTION 'RECIPE_RECOVERY_IDENTITY_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_recipe_recovery_identity_immutable BEFORE UPDATE OR DELETE ON ai_recipe_recovery
  FOR EACH ROW EXECUTE FUNCTION protect_recipe_recovery_identity();
REVOKE ALL ON FUNCTION protect_recipe_recovery_identity() FROM PUBLIC;
