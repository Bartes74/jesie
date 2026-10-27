-- Authorization is explicit and is not inferred/backfilled from an old enabled flag.
ALTER TABLE trend_setting ADD COLUMN publication_authorized_by text;
ALTER TABLE trend_setting DROP CONSTRAINT trend_setting_monthly_limit_usd_check;
ALTER TABLE trend_setting ADD CONSTRAINT trend_setting_monthly_limit_usd_check
  CHECK (monthly_limit_usd >= 0 AND monthly_limit_usd <= 1000000);
ALTER TABLE editorial_publication DROP CONSTRAINT editorial_publication_approval_origin_check;
ALTER TABLE editorial_publication ADD CONSTRAINT editorial_publication_approval_origin_check
  CHECK (approval_origin IN ('manual','legacy_demo_import','automated'));

CREATE TABLE trend_publication_day (
  date text PRIMARY KEY CHECK (date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','expired')),
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  workflow_id text,
  recipe_id text REFERENCES editorial_recipe(id),
  run_id text REFERENCES trend_run(id),
  publication_id text UNIQUE REFERENCES editorial_publication(id),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (due_at = (date::date + time '06:00') AT TIME ZONE 'Europe/Warsaw'),
  CHECK ((status='published') = (recipe_id IS NOT NULL AND run_id IS NOT NULL AND publication_id IS NOT NULL AND published_at IS NOT NULL))
);
ALTER TABLE trend_publication_day ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trend_publication_day FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON trend_publication_day FROM anon'; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON trend_publication_day FROM authenticated'; END IF;
END $$;

CREATE FUNCTION protect_trend_publication_day() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PUBLICATION_DAY_IMMUTABLE'; END IF;
  IF NEW.date IS DISTINCT FROM OLD.date OR NEW.due_at IS DISTINCT FROM OLD.due_at OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR ((NEW.generation IS DISTINCT FROM OLD.generation OR (OLD.workflow_id IS NOT NULL AND NEW.workflow_id IS DISTINCT FROM OLD.workflow_id))
      AND NOT (OLD.status='pending' AND NEW.status='pending' AND NEW.generation=OLD.generation+1 AND NEW.workflow_id IS NULL))
    OR (OLD.status IN ('published','expired') AND NEW IS DISTINCT FROM OLD)
    THEN RAISE EXCEPTION 'PUBLICATION_DAY_IMMUTABLE'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trend_publication_day_immutable BEFORE UPDATE OR DELETE ON trend_publication_day
  FOR EACH ROW EXECUTE FUNCTION protect_trend_publication_day();
REVOKE ALL ON FUNCTION protect_trend_publication_day() FROM PUBLIC;

CREATE TABLE trend_setting_audit (
  id uuid PRIMARY KEY,
  actor_id text NOT NULL,
  actor_name text NOT NULL,
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE trend_setting_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trend_setting_audit FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON trend_setting_audit FROM anon'; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON trend_setting_audit FROM authenticated'; END IF;
END $$;
CREATE FUNCTION protect_trend_setting_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'TREND_SETTING_AUDIT_IMMUTABLE'; END $$;
CREATE TRIGGER trend_setting_audit_immutable BEFORE UPDATE OR DELETE ON trend_setting_audit
  FOR EACH ROW EXECUTE FUNCTION protect_trend_setting_audit();
REVOKE ALL ON FUNCTION protect_trend_setting_audit() FROM PUBLIC;
