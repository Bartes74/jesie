-- One switch now controls research and publication of a verified social trend.
-- Preserve paid-radar authorization, all drafts, reservations and immutable history.
UPDATE trend_setting SET reviewed_publication_enabled=false,
  reviewed_publication_authorized_by=NULL,updated_at=clock_timestamp();

-- Sleeping reviewed-FIFO workers must not release manually created drafts.
ALTER TABLE editorial_publication ADD CONSTRAINT editorial_publication_no_new_manual_scheduled
  CHECK (approval_origin <> 'manual_scheduled') NOT VALID;
ALTER TABLE editorial_publication DROP CONSTRAINT IF EXISTS editorial_publication_no_new_automated;
-- Only the new publisher sends this exact ledger hash. Old code omits it.
ALTER TABLE editorial_publication ADD COLUMN content_approval_hash text
  CHECK (content_approval_hash IS NULL OR content_approval_hash ~ '^[a-f0-9]{64}$');
UPDATE trend_publication_day SET workflow_id=NULL,generation=generation+1,updated_at=clock_timestamp()
  WHERE status='pending';

-- Fence every automatic insertion, including workers pinned to old deployments.
-- Application validation additionally checks the current culinary approval hash,
-- all registered media, bilingual content, pending provider receipts and fresh time.
CREATE FUNCTION protect_verified_daily_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE local_date text;
BEGIN
  IF NEW.approval_origin <> 'automated' THEN RETURN NEW; END IF;
  local_date := (NEW.published_at AT TIME ZONE 'Europe/Warsaw')::date::text;
  IF NEW.content_approval_hash IS NULL OR NEW.published_by <> 'jesie-trend-worker'
    OR NEW.reviewed_by IS NOT NULL OR NEW.reviewed_by_name IS NOT NULL OR NEW.reviewed_revision IS NOT NULL
    OR NEW.checks <> '{"pl":false,"en":false,"quantities":false,"method":false,"photos":false,"sources":false}'::jsonb
    OR NOT EXISTS (
      SELECT 1 FROM trend_setting s JOIN auth_user u ON u.id=s.publication_authorized_by
      WHERE s.id='global' AND s.enabled AND u.role='owner' AND NOT u.disabled
    ) OR NOT EXISTS (
      SELECT 1 FROM trend_publication_day d JOIN trend_run r ON r.date::date=d.date::date-1
      JOIN editorial_recipe e ON e.id=r.recipe_id
      JOIN trend_candidate c ON c.id=r.candidate_id AND c.run_id=r.id
      JOIN editorial_content_approval a ON a.recipe_id=e.id AND a.origin='automated' AND a.revision<=e.revision
        AND a.actor_id='jesie-trend-worker'
        AND a.content_hash=NEW.content_approval_hash
      WHERE d.date=local_date AND d.status='pending'
        AND NEW.published_at>=d.due_at AND NEW.published_at<d.due_at+interval '1 hour'
        AND r.mode='daily' AND r.manual_request_key IS NULL AND r.status='awaiting_review'
        AND r.search_request_id IS NOT NULL AND r.search_finished_at IS NOT NULL AND r.search_charged_usd IS NOT NULL
        AND r.expected_revision=e.revision AND NEW.revision=e.revision+1
        AND e.id=NEW.recipe_id AND e.publication_status='never_published' AND e.published_id IS NULL
        AND e.deleted_at IS NULL AND e.editorial_status<>'archived' AND e.updated_by='jesie-trend-worker'
        AND NEW.snapshot IS NOT DISTINCT FROM CASE
          WHEN jsonb_typeof(e.content#>'{recipe,substitutions}')='array' THEN
            jsonb_set(e.content,'{recipe,substitutions}',
              (SELECT coalesce(jsonb_agg(jsonb_set(item,'{status}','"approved"'::jsonb) ORDER BY position),'[]'::jsonb)
               FROM jsonb_array_elements(e.content#>'{recipe,substitutions}') WITH ORDINALITY AS alternatives(item,position)))
          ELSE e.content END
        AND c.selected AND c.data->>'eligible'='true' AND c.data->>'selected'='true'
        AND coalesce(c.data->>'editorChoice','null')='null'
        AND coalesce(c.data->>'automaticSelection','null')='null'
        AND coalesce(c.data->>'duplicateRecipeId','null')='null'
        AND coalesce(c.data->>'ambiguous','false')='false'
    ) THEN RAISE EXCEPTION 'VERIFIED_DAILY_PUBLICATION_REQUIRED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER editorial_publication_verified_daily_guard BEFORE INSERT ON editorial_publication
  FOR EACH ROW EXECUTE FUNCTION protect_verified_daily_publication();
REVOKE ALL ON FUNCTION protect_verified_daily_publication() FROM PUBLIC;
