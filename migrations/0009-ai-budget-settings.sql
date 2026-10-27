CREATE TABLE ai_budget_settings (
  id text PRIMARY KEY CHECK(id='studio'), revision integer NOT NULL DEFAULT 0 CHECK(revision >= 0),
  daily_limit_usd numeric(16,8) CHECK(daily_limit_usd BETWEEN 0 AND 1000000),
  monthly_limit_usd numeric(16,8) CHECK(monthly_limit_usd BETWEEN 0 AND 1000000),
  pilot_limit_usd numeric(16,8) CHECK(pilot_limit_usd BETWEEN 0 AND 1000000),
  bypass_started_at timestamptz, bypass_until timestamptz,
  updated_by text, updated_by_name text, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((daily_limit_usd IS NULL AND monthly_limit_usd IS NULL AND pilot_limit_usd IS NULL)
    OR (daily_limit_usd IS NOT NULL AND monthly_limit_usd IS NOT NULL AND pilot_limit_usd IS NOT NULL)),
  CHECK((bypass_started_at IS NULL AND bypass_until IS NULL)
    OR (bypass_started_at IS NOT NULL AND bypass_until IS NOT NULL AND bypass_until > bypass_started_at
      AND bypass_until <= bypass_started_at + interval '24 hours'))
);
-- Installing the feature retains deployment/environment caps and enforces them.
INSERT INTO ai_budget_settings(id) VALUES('studio');
CREATE TABLE ai_budget_settings_audit (
  id text PRIMARY KEY, revision integer NOT NULL UNIQUE CHECK(revision > 0),
  action text NOT NULL CHECK(action IN ('limits','suspend','resume')),
  actor_id text NOT NULL, actor_name text NOT NULL,
  before_state jsonb NOT NULL CHECK(jsonb_typeof(before_state)='object'),
  after_state jsonb NOT NULL CHECK(jsonb_typeof(after_state)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION ai_budget_settings_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'AI budget settings require the next revision' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ai_budget_settings_revision BEFORE UPDATE ON ai_budget_settings FOR EACH ROW EXECUTE FUNCTION ai_budget_settings_guard();
CREATE TRIGGER ai_budget_settings_no_delete BEFORE DELETE ON ai_budget_settings FOR EACH ROW EXECUTE FUNCTION editorial_reject_history_mutation();
CREATE TRIGGER ai_budget_settings_audit_immutable BEFORE UPDATE OR DELETE ON ai_budget_settings_audit FOR EACH ROW EXECUTE FUNCTION editorial_reject_history_mutation();
ALTER TABLE ai_budget_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_budget_settings_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ai_budget_settings,ai_budget_settings_audit FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON ai_budget_settings,ai_budget_settings_audit FROM anon'; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON ai_budget_settings,ai_budget_settings_audit FROM authenticated'; END IF;
END;
$$;
COMMENT ON TABLE ai_budget_settings IS 'Private Studio budget caps; timed bypass changes only new monetary allocations, never concurrency, receipts or ledger accounting.';
COMMENT ON TABLE ai_budget_settings_audit IS 'Append-only nonsecret budget change history, written atomically with revision CAS by active owner/admin.';
