-- A human taking over a daily draft permanently removes it from automatic
-- publishing. Later worker photo revisions or diagnostic refresh cannot undo it.
CREATE TABLE trend_automation_takeover (
  recipe_id text PRIMARY KEY REFERENCES editorial_recipe(id),
  run_id text REFERENCES trend_run(id),
  reason text NOT NULL CHECK (reason IN ('recipe_edit','content_approval','preparation','studio')),
  actor_id text,
  taken_over_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX trend_automation_takeover_run_idx ON trend_automation_takeover(run_id);
ALTER TABLE trend_automation_takeover ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trend_automation_takeover FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON trend_automation_takeover FROM anon'; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON trend_automation_takeover FROM authenticated'; END IF;
END $$;
CREATE TRIGGER trend_automation_takeover_immutable BEFORE UPDATE OR DELETE ON trend_automation_takeover
  FOR EACH ROW EXECUTE FUNCTION editorial_reject_history_mutation();

-- Include takeovers that happened before this deployment, even if a worker has
-- since overwritten updated_by or an old diagnostic refresh removed preparation.
INSERT INTO trend_automation_takeover(run_id,recipe_id,reason)
SELECT r.id,r.recipe_id,'preparation' FROM trend_run r
WHERE r.mode='daily' AND r.manual_request_key IS NULL AND r.recipe_id IS NOT NULL
  AND r.search_diagnostics->'preparation' IS NOT NULL AND r.search_diagnostics->'preparation'<>'null'::jsonb
ON CONFLICT DO NOTHING;
INSERT INTO trend_automation_takeover(run_id,recipe_id,reason,actor_id)
SELECT r.id,e.id,'recipe_edit',nullif(e.updated_by,'jesie-trend-worker')
FROM editorial_recipe e LEFT JOIN LATERAL (
  SELECT id FROM trend_run WHERE recipe_id=e.id ORDER BY created_at LIMIT 1
) r ON true
WHERE e.created_by<>'jesie-trend-worker' OR e.updated_by<>'jesie-trend-worker' OR EXISTS(
    SELECT 1 FROM editorial_audit a WHERE a.recipe_id=e.id AND a.actor_id<>'jesie-trend-worker')
ON CONFLICT DO NOTHING;
INSERT INTO trend_automation_takeover(recipe_id,reason,actor_id)
SELECT DISTINCT ON(a.recipe_id) a.recipe_id,'content_approval',a.actor_id
FROM editorial_content_approval a WHERE a.origin='manual'
ORDER BY a.recipe_id,a.approved_at
ON CONFLICT DO NOTHING;
INSERT INTO trend_automation_takeover(recipe_id,reason,actor_id)
SELECT DISTINCT ON(j.recipe_id) j.recipe_id,'studio',j.created_by FROM ai_job j
WHERE j.created_by<>'jesie-trend-worker' ORDER BY j.recipe_id,j.created_at
ON CONFLICT DO NOTHING;

CREATE FUNCTION record_daily_recipe_takeover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.updated_by<>'jesie-trend-worker' THEN
    INSERT INTO trend_automation_takeover(run_id,recipe_id,reason,actor_id)
    VALUES ((SELECT id FROM trend_run WHERE recipe_id=NEW.id ORDER BY created_at LIMIT 1),NEW.id,'recipe_edit',NEW.updated_by)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER editorial_recipe_daily_takeover AFTER INSERT OR UPDATE ON editorial_recipe
  FOR EACH ROW EXECUTE FUNCTION record_daily_recipe_takeover();

CREATE FUNCTION record_daily_content_takeover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.origin='manual' THEN
    INSERT INTO trend_automation_takeover(run_id,recipe_id,reason,actor_id)
    VALUES ((SELECT id FROM trend_run WHERE recipe_id=NEW.recipe_id ORDER BY created_at LIMIT 1),NEW.recipe_id,'content_approval',NEW.actor_id)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER editorial_content_manual_takeover AFTER INSERT ON editorial_content_approval
  FOR EACH ROW EXECUTE FUNCTION record_daily_content_takeover();

CREATE FUNCTION record_daily_preparation_takeover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.mode='daily' AND NEW.manual_request_key IS NULL AND NEW.recipe_id IS NOT NULL
    AND NEW.search_diagnostics->'preparation' IS NOT NULL AND NEW.search_diagnostics->'preparation'<>'null'::jsonb THEN
    INSERT INTO trend_automation_takeover(run_id,recipe_id,reason) VALUES(NEW.id,NEW.recipe_id,'preparation') ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trend_run_manual_preparation_takeover AFTER INSERT OR UPDATE ON trend_run
  FOR EACH ROW EXECUTE FUNCTION record_daily_preparation_takeover();

CREATE FUNCTION record_manual_studio_takeover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.created_by<>'jesie-trend-worker' THEN
    INSERT INTO trend_automation_takeover(recipe_id,reason,actor_id)
    VALUES(NEW.recipe_id,'studio',NEW.created_by) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_job_manual_studio_takeover AFTER INSERT ON ai_job
  FOR EACH ROW EXECUTE FUNCTION record_manual_studio_takeover();

-- Fence publishers pinned to the preceding deployment as well as new ones.
CREATE FUNCTION protect_manual_takeover_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.approval_origin='automated' AND EXISTS(SELECT 1 FROM trend_automation_takeover t WHERE t.recipe_id=NEW.recipe_id) THEN
    RAISE EXCEPTION 'AUTOMATED_RECIPE_TAKEN_OVER';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER editorial_publication_no_manual_takeover BEFORE INSERT ON editorial_publication
  FOR EACH ROW EXECUTE FUNCTION protect_manual_takeover_publication();
REVOKE ALL ON FUNCTION record_daily_recipe_takeover(),record_daily_content_takeover(),record_daily_preparation_takeover(),record_manual_studio_takeover(),protect_manual_takeover_publication() FROM PUBLIC;
