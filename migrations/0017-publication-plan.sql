-- Reservations never approve recipes. The existing owner-authorized publisher
-- still requires the current human review, complete media and an unchanged hash.
CREATE TABLE editorial_publication_plan (
  date text PRIMARY KEY REFERENCES trend_publication_day(date),
  recipe_id text NOT NULL REFERENCES editorial_recipe(id),
  expected_content_hash text NOT NULL CHECK (expected_content_hash ~ '^[0-9a-f]{64}$'),
  planned_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX editorial_publication_plan_recipe_unique ON editorial_publication_plan(recipe_id);
ALTER TABLE editorial_publication_plan ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON editorial_publication_plan FROM PUBLIC;

CREATE TABLE editorial_publication_plan_audit (
  id uuid PRIMARY KEY,
  date text NOT NULL CHECK (date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  action text NOT NULL CHECK (action IN ('save','remove')),
  actor_id text NOT NULL,
  actor_name text NOT NULL,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((action='save' AND after_state IS NOT NULL) OR
    (action='remove' AND before_state IS NOT NULL AND after_state IS NULL))
);
CREATE INDEX editorial_publication_plan_audit_date_idx ON editorial_publication_plan_audit(date,created_at);
ALTER TABLE editorial_publication_plan_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON editorial_publication_plan_audit FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    EXECUTE 'REVOKE ALL ON editorial_publication_plan FROM anon';
    EXECUTE 'REVOKE ALL ON editorial_publication_plan_audit FROM anon';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    EXECUTE 'REVOKE ALL ON editorial_publication_plan FROM authenticated';
    EXECUTE 'REVOKE ALL ON editorial_publication_plan_audit FROM authenticated';
  END IF;
END $$;
CREATE FUNCTION protect_editorial_publication_plan_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'PUBLICATION_PLAN_AUDIT_IMMUTABLE'; END $$;
CREATE TRIGGER editorial_publication_plan_audit_immutable BEFORE UPDATE OR DELETE ON editorial_publication_plan_audit
  FOR EACH ROW EXECUTE FUNCTION protect_editorial_publication_plan_audit();
REVOKE ALL ON FUNCTION protect_editorial_publication_plan_audit() FROM PUBLIC;
-- A sleeping worker from an older deployment must also obey new reservations.
CREATE FUNCTION protect_editorial_publication_plan_release() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE publication_date text; reservation editorial_publication_plan%ROWTYPE;
BEGIN
  IF NEW.approval_origin <> 'manual_scheduled' THEN RETURN NEW; END IF;
  publication_date := (NEW.published_at AT TIME ZONE 'Europe/Warsaw')::date::text;
  SELECT * INTO reservation FROM editorial_publication_plan WHERE date=publication_date;
  IF FOUND THEN
    IF reservation.recipe_id <> NEW.recipe_id OR reservation.expected_content_hash <> NEW.content_hash THEN
      RAISE EXCEPTION 'PUBLICATION_PLAN_MISMATCH';
    END IF;
  ELSIF EXISTS(SELECT 1 FROM editorial_publication_plan WHERE recipe_id=NEW.recipe_id) THEN
    RAISE EXCEPTION 'RECIPE_RESERVED_FOR_PUBLICATION';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER editorial_publication_plan_release_guard BEFORE INSERT ON editorial_publication
  FOR EACH ROW EXECUTE FUNCTION protect_editorial_publication_plan_release();
REVOKE ALL ON FUNCTION protect_editorial_publication_plan_release() FROM PUBLIC;
COMMENT ON TABLE editorial_publication_plan IS 'Owner-selected recipe and content hash for an exact Warsaw publication date; missed reservations remain until explicit replanning or cancellation.';
