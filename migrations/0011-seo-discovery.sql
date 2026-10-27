-- A reviewed publishing schedule is independent from paid preparation and radar pauses.
ALTER TABLE trend_setting ADD COLUMN reviewed_publication_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE trend_setting ADD COLUMN reviewed_publication_authorized_by text;
UPDATE trend_setting SET reviewed_publication_enabled=enabled,
  reviewed_publication_authorized_by=publication_authorized_by;

ALTER TABLE editorial_publication ADD COLUMN reviewed_by text;
ALTER TABLE editorial_publication ADD COLUMN reviewed_by_name text;
ALTER TABLE editorial_publication ADD COLUMN reviewed_revision integer;
ALTER TABLE editorial_publication DROP CONSTRAINT editorial_publication_approval_origin_check;
ALTER TABLE editorial_publication ADD CONSTRAINT editorial_publication_approval_origin_check
  CHECK (approval_origin IN ('manual','legacy_demo_import','automated','manual_scheduled'));
ALTER TABLE editorial_publication ADD CONSTRAINT editorial_publication_scheduled_review_check
  CHECK (approval_origin <> 'manual_scheduled' OR
    (reviewed_by IS NOT NULL AND reviewed_by_name IS NOT NULL AND reviewed_revision=revision-1));

-- Reviewed manual recipes do not require a radar run.
DO $$ DECLARE constraint_name text; BEGIN
  FOR constraint_name IN SELECT conname FROM pg_constraint
    WHERE conrelid='trend_publication_day'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%run_id IS NOT NULL%'
  LOOP EXECUTE format('ALTER TABLE trend_publication_day DROP CONSTRAINT %I', constraint_name); END LOOP;
END $$;
ALTER TABLE trend_publication_day ADD CONSTRAINT reviewed_publication_day_result_check
  CHECK ((status='published') = (recipe_id IS NOT NULL AND publication_id IS NOT NULL AND published_at IS NOT NULL));

ALTER TABLE editorial_outbox ADD COLUMN cache_processed_at timestamptz;
ALTER TABLE editorial_outbox ADD COLUMN status text NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending','processing','retry','completed','disabled'));
ALTER TABLE editorial_outbox ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0);
ALTER TABLE editorial_outbox ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE editorial_outbox ADD COLUMN lease_token text;
ALTER TABLE editorial_outbox ADD COLUMN lease_expires_at timestamptz;
ALTER TABLE editorial_outbox ADD COLUMN last_error text;
ALTER TABLE editorial_outbox ADD COLUMN indexnow_status integer;
UPDATE editorial_outbox SET status='completed',cache_processed_at=processed_at WHERE processed_at IS NOT NULL;
CREATE INDEX editorial_outbox_retry_idx ON editorial_outbox(next_attempt_at,created_at) WHERE processed_at IS NULL;
COMMENT ON TABLE editorial_publication IS 'Immutable published snapshot; scheduled publication preserves exact human approval checks and reviewer.';
