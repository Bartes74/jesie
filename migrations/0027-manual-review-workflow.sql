-- Daily research may prepare cooking text, but a human decides on photographs
-- and every publication. Keep all historical approvals, publications and costs.
ALTER TABLE editorial_publication ADD CONSTRAINT editorial_publication_manual_release_required
  CHECK (approval_origin NOT IN ('automated','manual_scheduled')) NOT VALID;
ALTER TABLE editorial_content_approval ADD CONSTRAINT editorial_content_approval_manual_review_required
  CHECK (origin <> 'automated') NOT VALID;

-- A captured manual approval binds new worker photo jobs to the explicit owner
-- decision in the same preparation generation. Old workers cannot invent it.
ALTER TABLE ai_job ADD COLUMN manual_content_approval_hash text
  CHECK (manual_content_approval_hash IS NULL OR manual_content_approval_hash ~ '^[a-f0-9]{64}$');
CREATE FUNCTION protect_manual_photo_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.manual_content_approval_hash IS DISTINCT FROM OLD.manual_content_approval_hash THEN
      RAISE EXCEPTION 'AI_MANUAL_APPROVAL_CAPTURE_IMMUTABLE' USING ERRCODE='55000';
    END IF;
    -- Accepted receipts, saved results and their later accounting remain readable
    -- and settleable. The guard prevents a new provider submission from a queue.
    IF OLD.provider_request_id IS NOT NULL OR OLD.provider_finished_at IS NOT NULL OR OLD.result IS NOT NULL
      OR OLD.status<>'queued' OR NEW.status NOT IN ('submitting','generating') THEN RETURN NEW; END IF;
  END IF;
  IF NEW.kind='recipe' OR NEW.created_by<>'jesie-trend-worker' THEN RETURN NEW; END IF;
  IF NEW.manual_content_approval_hash IS NULL OR NOT EXISTS (
    SELECT 1 FROM trend_run r
    JOIN editorial_recipe e ON e.id=r.recipe_id
    JOIN editorial_content_approval a ON a.recipe_id=e.id AND a.origin='manual'
      AND a.content_hash=NEW.manual_content_approval_hash AND a.revision<=e.revision
    JOIN auth_user u ON u.id=r.search_diagnostics#>>'{preparation,requestedBy}' AND u.role='owner' AND NOT u.disabled
    WHERE r.id=NEW.trend_run_id AND r.recipe_id=NEW.recipe_id AND r.status='generating'
      AND r.expected_revision=e.revision AND e.deleted_at IS NULL AND e.editorial_status<>'archived'
      AND r.search_diagnostics#>>'{preparation,generation}'=r.generation::text
      AND coalesce(r.search_diagnostics#>>'{preparation,requestKey}','')<>''
      AND r.search_diagnostics#>>'{preparation,approvedContentHash}'=NEW.manual_content_approval_hash
      AND EXISTS(SELECT 1 FROM trend_automation_takeover t WHERE t.recipe_id=e.id)
  ) THEN RAISE EXCEPTION 'MANUAL_PHOTO_DECISION_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_job_manual_photo_decision BEFORE INSERT OR UPDATE ON ai_job
  FOR EACH ROW EXECUTE FUNCTION protect_manual_photo_decision();
REVOKE ALL ON FUNCTION protect_manual_photo_decision() FROM PUBLIC;
COMMENT ON COLUMN ai_job.manual_content_approval_hash IS 'Immutable manual cooking-text approval captured for an explicitly requested worker photograph; NULL for historical jobs and other work.';
