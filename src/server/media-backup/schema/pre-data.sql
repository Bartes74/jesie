--
-- PostgreSQL database dump
--

\restrict 0wazyogWEF1axT7gmwkar4Tpf9aDpiZrAjGgSBQ3M2jXzx1tzzo15K5KBguftvF

-- Dumped from database version 18.6 (Homebrew)
-- Dumped by pg_dump version 18.6 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: ai_budget_settings_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_budget_settings_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'AI budget settings require the next revision' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: ai_guard_job_capture(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_guard_job_capture() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (NEW.id,NEW.recipe_id,NEW.base_revision,NEW.kind,NEW.target_id,NEW.provider,NEW.model,NEW.brief,NEW.request_key,NEW.input_hash,NEW.input,NEW.created_by,NEW.created_by_name,NEW.reserved_usd,NEW.created_at,NEW.ingredient_key,NEW.reuse_source_job_id,NEW.photo_batch_id)
     IS DISTINCT FROM (OLD.id,OLD.recipe_id,OLD.base_revision,OLD.kind,OLD.target_id,OLD.provider,OLD.model,OLD.brief,OLD.request_key,OLD.input_hash,OLD.input,OLD.created_by,OLD.created_by_name,OLD.reserved_usd,OLD.created_at,OLD.ingredient_key,OLD.reuse_source_job_id,OLD.photo_batch_id) THEN
    RAISE EXCEPTION 'AI captured input is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.provider_request_id IS NOT NULL AND NEW.provider_request_id IS DISTINCT FROM OLD.provider_request_id THEN
    RAISE EXCEPTION 'AI provider request identity is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result THEN
    RAISE EXCEPTION 'AI completed result is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: ai_guard_trend_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_guard_trend_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.trend_run_id IS DISTINCT FROM OLD.trend_run_id THEN
  RAISE EXCEPTION 'Generation scope is immutable' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END;
$$;


--
-- Name: ai_photo_batch_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_photo_batch_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (NEW.id,NEW.recipe_id,NEW.base_revision,NEW.source_job_id,NEW.input,NEW.input_hash,NEW.request_key,NEW.created_by,NEW.created_by_name,NEW.reserved_usd,NEW.created_at)
     IS DISTINCT FROM (OLD.id,OLD.recipe_id,OLD.base_revision,OLD.source_job_id,OLD.input,OLD.input_hash,OLD.request_key,OLD.created_by,OLD.created_by_name,OLD.reserved_usd,OLD.created_at) THEN
    RAISE EXCEPTION 'AI photo batch capture is immutable' USING ERRCODE='55000';
  END IF;
  IF (SELECT coalesce(jsonb_agg(value-'jobId'-'recoverySourceJobId'),'[]'::jsonb) FROM jsonb_array_elements(NEW.slots))
      IS DISTINCT FROM (SELECT coalesce(jsonb_agg(value-'jobId'-'recoverySourceJobId'),'[]'::jsonb) FROM jsonb_array_elements(OLD.slots)) THEN
    RAISE EXCEPTION 'AI photo batch targets are immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.generation < OLD.generation OR (NEW.generation=OLD.generation AND OLD.workflow_run_id IS NOT NULL AND NEW.workflow_run_id IS DISTINCT FROM OLD.workflow_run_id) THEN
    RAISE EXCEPTION 'AI photo batch worker identity is immutable within a generation' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: editorial_reject_history_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.editorial_reject_history_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'Editorial history is immutable' USING ERRCODE = '55000';
END;
$$;


--
-- Name: ingredient_image_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ingredient_image_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Ingredient image identity is immutable' USING ERRCODE='55000'; END IF;
  IF (NEW.key,NEW.product,NEW.form,NEW.style_profile,NEW.asset_id,NEW.source_job_id,NEW.photo,NEW.created_at)
      IS DISTINCT FROM (OLD.key,OLD.product,OLD.form,OLD.style_profile,OLD.asset_id,OLD.source_job_id,OLD.photo,OLD.created_at) THEN
    RAISE EXCEPTION 'Ingredient image identity is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: protect_collection_asset_history(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_collection_asset_history() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN RAISE EXCEPTION 'Collection media and settled costs are immutable'; END;
$$;


--
-- Name: protect_collection_generation_identity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_collection_generation_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.collection_id IS DISTINCT FROM OLD.collection_id
    OR NEW.base_revision IS DISTINCT FROM OLD.base_revision OR NEW.part IS DISTINCT FROM OLD.part
    OR NEW.brief IS DISTINCT FROM OLD.brief OR NEW.inspiration_asset_id IS DISTINCT FROM OLD.inspiration_asset_id
    OR NEW.base_theme IS DISTINCT FROM OLD.base_theme OR NEW.input IS DISTINCT FROM OLD.input
    OR NEW.request_key IS DISTINCT FROM OLD.request_key OR NEW.input_hash IS DISTINCT FROM OLD.input_hash
    OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.status='ready' AND (NEW.theme IS DISTINCT FROM OLD.theme OR NEW.proposal IS DISTINCT FROM OLD.proposal OR NEW.status<>'ready'))
  THEN RAISE EXCEPTION 'Collection generation identity and completed proposals are immutable'; END IF;
  RETURN NEW;
END;
$$;


--
-- Name: protect_collection_identity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_collection_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.id,NEW.created_at,NEW.created_by) IS DISTINCT FROM (OLD.id,OLD.created_at,OLD.created_by) THEN
    RAISE EXCEPTION 'COLLECTION_IDENTITY_IMMUTABLE';
  END IF;
  IF OLD.first_published_at IS NOT NULL AND (NEW.first_published_at IS DISTINCT FROM OLD.first_published_at
    OR NEW.content->'slug' IS DISTINCT FROM OLD.content->'slug') THEN
    RAISE EXCEPTION 'COLLECTION_PUBLISHED_SLUG_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: protect_collection_job_identity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_collection_job_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (NEW.id,NEW.generation_id,NEW.kind,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.generation_id,OLD.kind,OLD.created_at)
    OR (NEW.model IS DISTINCT FROM OLD.model AND (OLD.provider_request_id IS NOT NULL OR NEW.model<>replace(OLD.model,'/text-to-image','/edit')))
    OR (OLD.provider_request_id IS NOT NULL AND NEW.provider_request_id IS DISTINCT FROM OLD.provider_request_id)
    OR (OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result)
    OR (OLD.charged_usd IS NOT NULL AND NEW.charged_usd IS DISTINCT FROM OLD.charged_usd)
  THEN RAISE EXCEPTION 'Collection provider identity, completed result and settled cost are immutable'; END IF;
  RETURN NEW;
END;
$$;


--
-- Name: protect_editorial_publication_plan_audit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_editorial_publication_plan_audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN RAISE EXCEPTION 'PUBLICATION_PLAN_AUDIT_IMMUTABLE'; END $$;


--
-- Name: protect_editorial_publication_plan_release(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_editorial_publication_plan_release() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: protect_ingredient_verification_identity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_ingredient_verification_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.verification_key,NEW.input,NEW.model,NEW.claim_token,NEW.created_at)
    IS DISTINCT FROM (OLD.verification_key,OLD.input,OLD.model,OLD.claim_token,OLD.created_at) THEN
    RAISE EXCEPTION 'INGREDIENT_VERIFICATION_IDENTITY_IMMUTABLE';
  END IF;
  IF OLD.provider_request_id IS NOT NULL AND NEW.provider_request_id IS DISTINCT FROM OLD.provider_request_id THEN
    RAISE EXCEPTION 'INGREDIENT_VERIFICATION_RECEIPT_IMMUTABLE';
  END IF;
  IF OLD.cost_basis='usage' AND OLD.charged_usd IS NOT NULL AND (NEW.charged_usd,NEW.cost_basis)
    IS DISTINCT FROM (OLD.charged_usd,OLD.cost_basis) THEN
    RAISE EXCEPTION 'INGREDIENT_VERIFICATION_COST_IMMUTABLE';
  END IF;
  -- Eligibility is computed by application policy. All paid response facts,
  -- including its exact queried names and original sources, remain immutable.
  IF OLD.result IS NOT NULL AND ((OLD.result-'autoLearnEligible') IS DISTINCT FROM (NEW.result-'autoLearnEligible')
    OR jsonb_typeof(NEW.result->'autoLearnEligible') IS DISTINCT FROM 'boolean') THEN
    RAISE EXCEPTION 'INGREDIENT_VERIFICATION_RESULT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: protect_manual_photo_decision(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_manual_photo_decision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: protect_manual_takeover_publication(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_manual_takeover_publication() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.approval_origin='automated' AND EXISTS(SELECT 1 FROM trend_automation_takeover t WHERE t.recipe_id=NEW.recipe_id) THEN
    RAISE EXCEPTION 'AUTOMATED_RECIPE_TAKEN_OVER';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: protect_recipe_recovery_identity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_recipe_recovery_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.job_id,NEW.root_job_id,NEW.parent_job_id,NEW.attempt,NEW.trend_generation,NEW.repair_issues,NEW.created_at)
    IS DISTINCT FROM (OLD.job_id,OLD.root_job_id,OLD.parent_job_id,OLD.attempt,OLD.trend_generation,OLD.repair_issues,OLD.created_at) THEN
    RAISE EXCEPTION 'RECIPE_RECOVERY_IDENTITY_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: protect_trend_publication_day(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_trend_publication_day() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PUBLICATION_DAY_IMMUTABLE'; END IF;
  IF NEW.date IS DISTINCT FROM OLD.date OR NEW.due_at IS DISTINCT FROM OLD.due_at OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR ((NEW.generation IS DISTINCT FROM OLD.generation OR (OLD.workflow_id IS NOT NULL AND NEW.workflow_id IS DISTINCT FROM OLD.workflow_id))
      AND NOT (OLD.status='pending' AND NEW.status='pending' AND NEW.generation=OLD.generation+1 AND NEW.workflow_id IS NULL))
    OR (OLD.status IN ('published','expired') AND NEW IS DISTINCT FROM OLD)
    THEN RAISE EXCEPTION 'PUBLICATION_DAY_IMMUTABLE'; END IF;
  RETURN NEW;
END $$;


--
-- Name: protect_trend_setting_audit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_trend_setting_audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN RAISE EXCEPTION 'TREND_SETTING_AUDIT_IMMUTABLE'; END $$;


--
-- Name: protect_verified_daily_publication(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_verified_daily_publication() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: record_daily_content_takeover(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_daily_content_takeover() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.origin='manual' THEN
    INSERT INTO trend_automation_takeover(run_id,recipe_id,reason,actor_id)
    VALUES ((SELECT id FROM trend_run WHERE recipe_id=NEW.recipe_id ORDER BY created_at LIMIT 1),NEW.recipe_id,'content_approval',NEW.actor_id)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: record_daily_preparation_takeover(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_daily_preparation_takeover() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.mode='daily' AND NEW.manual_request_key IS NULL AND NEW.recipe_id IS NOT NULL
    AND NEW.search_diagnostics->'preparation' IS NOT NULL AND NEW.search_diagnostics->'preparation'<>'null'::jsonb THEN
    INSERT INTO trend_automation_takeover(run_id,recipe_id,reason) VALUES(NEW.id,NEW.recipe_id,'preparation') ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: record_daily_recipe_takeover(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_daily_recipe_takeover() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.updated_by<>'jesie-trend-worker' THEN
    INSERT INTO trend_automation_takeover(run_id,recipe_id,reason,actor_id)
    VALUES ((SELECT id FROM trend_run WHERE recipe_id=NEW.id ORDER BY created_at LIMIT 1),NEW.id,'recipe_edit',NEW.updated_by)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: record_manual_studio_takeover(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_manual_studio_takeover() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.created_by<>'jesie-trend-worker' THEN
    INSERT INTO trend_automation_takeover(recipe_id,reason,actor_id)
    VALUES(NEW.recipe_id,'studio',NEW.created_by) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: ai_asset; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_asset (
    id text NOT NULL,
    recipe_id text NOT NULL,
    job_id text NOT NULL,
    kind text NOT NULL,
    target_id text,
    blob_pathname text NOT NULL,
    original_blob_pathname text,
    width integer NOT NULL,
    height integer NOT NULL,
    content_type text NOT NULL,
    alt jsonb NOT NULL,
    caption jsonb NOT NULL,
    model text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_asset_content_type_check CHECK ((content_type = ANY (ARRAY['image/webp'::text, 'image/png'::text, 'image/jpeg'::text]))),
    CONSTRAINT ai_asset_height_check CHECK (((height > 0) AND (height <= 10000))),
    CONSTRAINT ai_asset_kind_check CHECK ((kind = ANY (ARRAY['hero'::text, 'ingredient'::text, 'step'::text]))),
    CONSTRAINT ai_asset_width_check CHECK (((width > 0) AND (width <= 10000)))
);


--
-- Name: TABLE ai_asset; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_asset IS 'Immutable private blob paths. DTOs expose only controlled /media/id routes.';


--
-- Name: ai_budget_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_budget_settings (
    id text NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    daily_limit_usd numeric(16,8),
    monthly_limit_usd numeric(16,8),
    pilot_limit_usd numeric(16,8),
    bypass_started_at timestamp with time zone,
    bypass_until timestamp with time zone,
    updated_by text,
    updated_by_name text,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ai_budget_settings_check CHECK ((((daily_limit_usd IS NULL) AND (monthly_limit_usd IS NULL) AND (pilot_limit_usd IS NULL)) OR ((daily_limit_usd IS NOT NULL) AND (monthly_limit_usd IS NOT NULL) AND (pilot_limit_usd IS NOT NULL)))),
    CONSTRAINT ai_budget_settings_check1 CHECK ((((bypass_started_at IS NULL) AND (bypass_until IS NULL)) OR ((bypass_started_at IS NOT NULL) AND (bypass_until IS NOT NULL) AND (bypass_until > bypass_started_at) AND (bypass_until <= (bypass_started_at + '24:00:00'::interval))))),
    CONSTRAINT ai_budget_settings_daily_limit_usd_check CHECK (((daily_limit_usd >= (0)::numeric) AND (daily_limit_usd <= (1000000)::numeric))),
    CONSTRAINT ai_budget_settings_id_check CHECK ((id = 'studio'::text)),
    CONSTRAINT ai_budget_settings_monthly_limit_usd_check CHECK (((monthly_limit_usd >= (0)::numeric) AND (monthly_limit_usd <= (1000000)::numeric))),
    CONSTRAINT ai_budget_settings_pilot_limit_usd_check CHECK (((pilot_limit_usd >= (0)::numeric) AND (pilot_limit_usd <= (1000000)::numeric))),
    CONSTRAINT ai_budget_settings_revision_check CHECK ((revision >= 0))
);


--
-- Name: TABLE ai_budget_settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_budget_settings IS 'Private Studio budget caps; timed bypass changes only new monetary allocations, never concurrency, receipts or ledger accounting.';


--
-- Name: ai_budget_settings_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_budget_settings_audit (
    id text NOT NULL,
    revision integer NOT NULL,
    action text NOT NULL,
    actor_id text NOT NULL,
    actor_name text NOT NULL,
    before_state jsonb NOT NULL,
    after_state jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ai_budget_settings_audit_action_check CHECK ((action = ANY (ARRAY['limits'::text, 'suspend'::text, 'resume'::text]))),
    CONSTRAINT ai_budget_settings_audit_after_state_check CHECK ((jsonb_typeof(after_state) = 'object'::text)),
    CONSTRAINT ai_budget_settings_audit_before_state_check CHECK ((jsonb_typeof(before_state) = 'object'::text)),
    CONSTRAINT ai_budget_settings_audit_revision_check CHECK ((revision > 0))
);


--
-- Name: TABLE ai_budget_settings_audit; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_budget_settings_audit IS 'Append-only nonsecret budget change history, written atomically with revision CAS by active owner/admin.';


--
-- Name: ai_cost_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_cost_ledger (
    id text NOT NULL,
    job_id text NOT NULL,
    entry text NOT NULL,
    amount_usd numeric(16,8) NOT NULL,
    basis text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_cost_ledger_basis_check CHECK ((basis = ANY (ARRAY['reservation'::text, 'usage'::text, 'cancelled'::text, 'not_charged'::text]))),
    CONSTRAINT ai_cost_ledger_entry_check CHECK ((entry = ANY (ARRAY['reserve'::text, 'settle'::text, 'reconcile'::text])))
);


--
-- Name: ai_ingredient_verification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_ingredient_verification (
    verification_key text NOT NULL,
    input jsonb NOT NULL,
    model text NOT NULL,
    origin_job_id text,
    origin_recipe_id text,
    status text NOT NULL,
    claim_token text NOT NULL,
    claim_expires_at timestamp with time zone NOT NULL,
    provider_request_id text,
    result jsonb,
    learned boolean DEFAULT false NOT NULL,
    charged_usd numeric(16,8),
    cost_basis text,
    usage jsonb,
    error_code text,
    error_message text,
    provider_finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    eligibility_policy_version text DEFAULT 'ingredient-evidence-v1'::text NOT NULL,
    CONSTRAINT ai_ingredient_verification_charged_usd_check CHECK (((charged_usd IS NULL) OR (charged_usd >= (0)::numeric))),
    CONSTRAINT ai_ingredient_verification_check CHECK (((status <> 'generating'::text) OR (provider_request_id IS NOT NULL))),
    CONSTRAINT ai_ingredient_verification_check1 CHECK (((status <> 'complete'::text) OR ((provider_request_id IS NOT NULL) AND (result IS NOT NULL)))),
    CONSTRAINT ai_ingredient_verification_check2 CHECK (((NOT learned) OR ((status = 'complete'::text) AND ((result ->> 'autoLearnEligible'::text) = 'true'::text) AND ((result ->> 'decision'::text) = 'verified'::text)))),
    CONSTRAINT ai_ingredient_verification_cost_basis_check CHECK (((cost_basis IS NULL) OR (cost_basis = ANY (ARRAY['usage'::text, 'reservation'::text])))),
    CONSTRAINT ai_ingredient_verification_input_check CHECK ((jsonb_typeof(input) = 'object'::text)),
    CONSTRAINT ai_ingredient_verification_result_check CHECK (((result IS NULL) OR (jsonb_typeof(result) = 'object'::text))),
    CONSTRAINT ai_ingredient_verification_status_check CHECK ((status = ANY (ARRAY['submitting'::text, 'generating'::text, 'complete'::text, 'uncertain'::text, 'failed'::text]))),
    CONSTRAINT ai_ingredient_verification_usage_check CHECK (((usage IS NULL) OR (jsonb_typeof(usage) = 'object'::text))),
    CONSTRAINT ai_ingredient_verification_verification_key_check CHECK ((verification_key ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: ai_job; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_job (
    id text NOT NULL,
    recipe_id text NOT NULL,
    base_revision integer NOT NULL,
    kind text NOT NULL,
    target_id text,
    status text DEFAULT 'queued'::text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    brief text NOT NULL,
    request_key text NOT NULL,
    input_hash text NOT NULL,
    input jsonb NOT NULL,
    created_by text NOT NULL,
    created_by_name text NOT NULL,
    provider_request_id text,
    provider_finished_at timestamp with time zone,
    reserved_usd numeric(16,8) DEFAULT 0 NOT NULL,
    charged_usd numeric(16,8),
    cost_basis text,
    usage jsonb,
    result jsonb,
    error_code text,
    error_message text,
    applied_revision integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    trend_run_id text,
    ingredient_key text,
    reuse_source_job_id text,
    ingredient_resolved_at timestamp with time zone,
    photo_batch_id text,
    manual_content_approval_hash text,
    CONSTRAINT ai_job_base_revision_check CHECK ((base_revision > 0)),
    CONSTRAINT ai_job_charged_usd_check CHECK ((charged_usd >= (0)::numeric)),
    CONSTRAINT ai_job_check CHECK ((((kind = ANY (ARRAY['recipe'::text, 'hero'::text])) AND (target_id IS NULL)) OR ((kind = ANY (ARRAY['ingredient'::text, 'step'::text])) AND (target_id IS NOT NULL)))),
    CONSTRAINT ai_job_cost_basis_check CHECK ((cost_basis = ANY (ARRAY['usage'::text, 'reservation'::text]))),
    CONSTRAINT ai_job_kind_check CHECK ((kind = ANY (ARRAY['recipe'::text, 'hero'::text, 'ingredient'::text, 'step'::text]))),
    CONSTRAINT ai_job_manual_content_approval_hash_check CHECK (((manual_content_approval_hash IS NULL) OR (manual_content_approval_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT ai_job_provider_check CHECK ((provider = ANY (ARRAY['openai'::text, 'fal'::text]))),
    CONSTRAINT ai_job_reserved_usd_check CHECK ((reserved_usd >= (0)::numeric)),
    CONSTRAINT ai_job_reuse_valid CHECK (((reuse_source_job_id IS NULL) OR ((kind = 'ingredient'::text) AND (ingredient_key IS NOT NULL) AND (reserved_usd = (0)::numeric)))),
    CONSTRAINT ai_job_single_scope CHECK (((trend_run_id IS NULL) OR (photo_batch_id IS NULL))),
    CONSTRAINT ai_job_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'submitting'::text, 'generating'::text, 'ready'::text, 'failed'::text, 'uncertain'::text, 'cancelled'::text, 'applied'::text])))
);


--
-- Name: TABLE ai_job; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_job IS 'Captured AI proposals, durable submission identity, conservative reserved cost; no automatic publication.';


--
-- Name: COLUMN ai_job.ingredient_resolved_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_job.ingredient_resolved_at IS 'Product identity remains occupied through provider completion and image validation, until a saved result or a confirmed failed/unsubmitted request.';


--
-- Name: COLUMN ai_job.manual_content_approval_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_job.manual_content_approval_hash IS 'Immutable manual cooking-text approval captured for an explicitly requested worker photograph; NULL for historical jobs and other work.';


--
-- Name: ai_photo_batch; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_photo_batch (
    id text NOT NULL,
    recipe_id text NOT NULL,
    base_revision integer NOT NULL,
    source_job_id text,
    input jsonb NOT NULL,
    input_hash text NOT NULL,
    slots jsonb NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    request_key text NOT NULL,
    created_by text NOT NULL,
    created_by_name text NOT NULL,
    reserved_usd numeric(16,8) DEFAULT 0 NOT NULL,
    remaining_reserved_usd numeric(16,8) DEFAULT 0 NOT NULL,
    generation integer DEFAULT 1 NOT NULL,
    workflow_run_id text,
    error_code text,
    error_message text,
    applied_revision integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_photo_batch_base_revision_check CHECK ((base_revision > 0)),
    CONSTRAINT ai_photo_batch_check CHECK (((remaining_reserved_usd >= (0)::numeric) AND (remaining_reserved_usd <= reserved_usd))),
    CONSTRAINT ai_photo_batch_generation_check CHECK ((generation > 0)),
    CONSTRAINT ai_photo_batch_reserved_usd_check CHECK ((reserved_usd >= (0)::numeric)),
    CONSTRAINT ai_photo_batch_slots_check CHECK ((jsonb_typeof(slots) = 'array'::text)),
    CONSTRAINT ai_photo_batch_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'generating'::text, 'ready'::text, 'blocked'::text, 'failed'::text, 'applied'::text])))
);


--
-- Name: TABLE ai_photo_batch; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_photo_batch IS 'Reserved Studio photograph package; private previews require explicit atomic application and never publish.';


--
-- Name: ai_recipe_recovery; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_recipe_recovery (
    job_id text NOT NULL,
    root_job_id text NOT NULL,
    parent_job_id text,
    attempt integer NOT NULL,
    trend_generation integer,
    repair_issues jsonb DEFAULT '[]'::jsonb NOT NULL,
    failure_issues jsonb DEFAULT '[]'::jsonb NOT NULL,
    repairable boolean DEFAULT false NOT NULL,
    blocked_code text,
    blocked_message text,
    generation integer DEFAULT 1 NOT NULL,
    workflow_run_id text,
    dispatch_claimed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ai_recipe_recovery_attempt_check CHECK (((attempt >= 0) AND (attempt <= 2))),
    CONSTRAINT ai_recipe_recovery_check CHECK ((((attempt = 0) AND (parent_job_id IS NULL) AND (root_job_id = job_id)) OR ((attempt > 0) AND (parent_job_id IS NOT NULL) AND (root_job_id <> job_id)))),
    CONSTRAINT ai_recipe_recovery_failure_issues_check CHECK ((jsonb_typeof(failure_issues) = 'array'::text)),
    CONSTRAINT ai_recipe_recovery_generation_check CHECK ((generation > 0)),
    CONSTRAINT ai_recipe_recovery_repair_issues_check CHECK ((jsonb_typeof(repair_issues) = 'array'::text)),
    CONSTRAINT ai_recipe_recovery_trend_generation_check CHECK ((trend_generation > 0))
);


--
-- Name: ai_verified_ingredient_alias; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_verified_ingredient_alias (
    normalized_alias text NOT NULL,
    verification_key text NOT NULL,
    diet text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ai_verified_ingredient_alias_diet_check CHECK ((diet = ANY (ARRAY['vegan'::text, 'vegetarian'::text, 'meat'::text]))),
    CONSTRAINT ai_verified_ingredient_alias_normalized_alias_check CHECK (((length(normalized_alias) >= 1) AND (length(normalized_alias) <= 500)))
);


--
-- Name: auth_account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_account (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    user_id text NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamp with time zone,
    refresh_token_expires_at timestamp with time zone,
    scope text,
    password text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_event (
    id text NOT NULL,
    user_id text,
    action text NOT NULL,
    success boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_rate_limit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_rate_limit (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    key text NOT NULL,
    count integer NOT NULL,
    last_request bigint NOT NULL
);


--
-- Name: auth_session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_session (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    token text NOT NULL,
    user_id text NOT NULL,
    ip_address text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_user (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    image text,
    role text DEFAULT 'admin'::text NOT NULL,
    disabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT auth_user_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text])))
);


--
-- Name: auth_verification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_verification (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: collection_asset; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.collection_asset (
    id text NOT NULL,
    collection_id text NOT NULL,
    generation_id text,
    kind text NOT NULL,
    blob_pathname text NOT NULL,
    sha256 text NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    content_type text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT collection_asset_check CHECK ((blob_pathname = (('media/collections/'::text || id) || '.webp'::text))),
    CONSTRAINT collection_asset_check1 CHECK ((((kind = 'inspiration'::text) AND (generation_id IS NULL)) OR ((kind <> 'inspiration'::text) AND (generation_id IS NOT NULL)))),
    CONSTRAINT collection_asset_content_type_check CHECK ((content_type = 'image/webp'::text)),
    CONSTRAINT collection_asset_height_check CHECK ((height > 0)),
    CONSTRAINT collection_asset_kind_check CHECK ((kind = ANY (ARRAY['inspiration'::text, 'hero'::text, 'atmosphere'::text, 'corner'::text, 'garland'::text, 'spot'::text]))),
    CONSTRAINT collection_asset_sha256_check CHECK ((sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT collection_asset_width_check CHECK ((width > 0))
);


--
-- Name: collection_discovery_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.collection_discovery_event (
    id text NOT NULL,
    collection_id text NOT NULL,
    paths jsonb NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_token text,
    lease_expires_at timestamp with time zone,
    completed_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: collection_theme_cost; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.collection_theme_cost (
    job_id text NOT NULL,
    amount_usd numeric(16,8) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT collection_theme_cost_amount_usd_check CHECK ((amount_usd >= (0)::numeric))
);


--
-- Name: collection_theme_generation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.collection_theme_generation (
    id text NOT NULL,
    collection_id text NOT NULL,
    base_revision integer NOT NULL,
    part text NOT NULL,
    brief text NOT NULL,
    inspiration_asset_id text,
    base_theme jsonb,
    proposal jsonb,
    input jsonb NOT NULL,
    theme jsonb,
    status text DEFAULT 'queued'::text NOT NULL,
    request_key text NOT NULL,
    input_hash text NOT NULL,
    created_by text NOT NULL,
    error text,
    applied_revision integer,
    dispatch_token text,
    dispatch_expires_at timestamp with time zone,
    workflow_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT collection_theme_generation_base_revision_check CHECK ((base_revision > 0)),
    CONSTRAINT collection_theme_generation_part_check CHECK ((part = ANY (ARRAY['all'::text, 'hero'::text, 'background'::text, 'accents'::text]))),
    CONSTRAINT collection_theme_generation_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'ready'::text, 'failed'::text, 'uncertain'::text])))
);


--
-- Name: collection_theme_job; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.collection_theme_job (
    id text NOT NULL,
    generation_id text NOT NULL,
    kind text NOT NULL,
    model text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    provider_request_id text,
    provider_finished_at timestamp with time zone,
    charged_usd numeric(16,8),
    result jsonb,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT collection_theme_job_charged_usd_check CHECK ((charged_usd >= (0)::numeric)),
    CONSTRAINT collection_theme_job_kind_check CHECK ((kind = ANY (ARRAY['spec'::text, 'hero'::text, 'atmosphere'::text, 'corner'::text, 'garland'::text, 'spot'::text]))),
    CONSTRAINT collection_theme_job_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'submitting'::text, 'generating'::text, 'ready'::text, 'failed'::text, 'uncertain'::text])))
);


--
-- Name: editorial_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.editorial_audit (
    id text NOT NULL,
    recipe_id text NOT NULL,
    revision integer NOT NULL,
    action text NOT NULL,
    actor_id text NOT NULL,
    actor_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: editorial_content_approval; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.editorial_content_approval (
    recipe_id text NOT NULL,
    content_hash text NOT NULL,
    origin text NOT NULL,
    revision integer NOT NULL,
    actor_id text NOT NULL,
    actor_name text NOT NULL,
    approved_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT editorial_content_approval_content_hash_check CHECK ((content_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT editorial_content_approval_origin_check CHECK ((origin = ANY (ARRAY['manual'::text, 'automated'::text]))),
    CONSTRAINT editorial_content_approval_revision_check CHECK ((revision > 0))
);


--
-- Name: TABLE editorial_content_approval; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.editorial_content_approval IS 'Private append-only cooking-text approval receipts; no publication permission and no media-dependent hash.';


--
-- Name: editorial_migration; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.editorial_migration (
    name text NOT NULL,
    hash text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: editorial_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.editorial_outbox (
    id text NOT NULL,
    recipe_id text NOT NULL,
    revision integer NOT NULL,
    event text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    cache_processed_at timestamp with time zone,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_token text,
    lease_expires_at timestamp with time zone,
    last_error text,
    indexnow_status integer,
    discovery_workflow_id text,
    discovery_generation integer DEFAULT 1 NOT NULL,
    discovery_dispatch_token text,
    discovery_dispatch_expires_at timestamp with time zone,
    CONSTRAINT editorial_outbox_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT editorial_outbox_discovery_generation_check CHECK ((discovery_generation > 0)),
    CONSTRAINT editorial_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'retry'::text, 'completed'::text, 'disabled'::text])))
);


--
-- Name: editorial_publication; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.editorial_publication (
    id text NOT NULL,
    recipe_id text NOT NULL,
    revision integer NOT NULL,
    snapshot jsonb NOT NULL,
    content_hash text NOT NULL,
    checks jsonb NOT NULL,
    approval_origin text NOT NULL,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    published_by text NOT NULL,
    published_by_name text NOT NULL,
    reviewed_by text,
    reviewed_by_name text,
    reviewed_revision integer,
    content_approval_hash text,
    CONSTRAINT editorial_publication_approval_origin_check CHECK ((approval_origin = ANY (ARRAY['manual'::text, 'legacy_demo_import'::text, 'automated'::text, 'manual_scheduled'::text]))),
    CONSTRAINT editorial_publication_content_approval_hash_check CHECK (((content_approval_hash IS NULL) OR (content_approval_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT editorial_publication_scheduled_review_check CHECK (((approval_origin <> 'manual_scheduled'::text) OR ((reviewed_by IS NOT NULL) AND (reviewed_by_name IS NOT NULL) AND (reviewed_revision = (revision - 1)))))
);


--
-- Name: TABLE editorial_publication; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.editorial_publication IS 'Immutable published snapshot; scheduled publication preserves exact human approval checks and reviewer.';


--
-- Name: editorial_publication_plan; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.editorial_publication_plan (
    date text NOT NULL,
    recipe_id text NOT NULL,
    expected_content_hash text NOT NULL,
    planned_by text NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT editorial_publication_plan_expected_content_hash_check CHECK ((expected_content_hash ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: TABLE editorial_publication_plan; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.editorial_publication_plan IS 'Owner-selected recipe and content hash for an exact Warsaw publication date; missed reservations remain until explicit replanning or cancellation.';


--
-- Name: editorial_publication_plan_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.editorial_publication_plan_audit (
    id uuid NOT NULL,
    date text NOT NULL,
    action text NOT NULL,
    actor_id text NOT NULL,
    actor_name text NOT NULL,
    before_state jsonb,
    after_state jsonb,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT editorial_publication_plan_audit_action_check CHECK ((action = ANY (ARRAY['save'::text, 'remove'::text]))),
    CONSTRAINT editorial_publication_plan_audit_check CHECK ((((action = 'save'::text) AND (after_state IS NOT NULL)) OR ((action = 'remove'::text) AND (before_state IS NOT NULL) AND (after_state IS NULL)))),
    CONSTRAINT editorial_publication_plan_audit_date_check CHECK ((date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'::text))
);


--
-- Name: editorial_recipe; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.editorial_recipe (
    id text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    content jsonb NOT NULL,
    content_hash text NOT NULL,
    editorial_status text DEFAULT 'draft'::text NOT NULL,
    publication_status text DEFAULT 'never_published'::text NOT NULL,
    checks jsonb NOT NULL,
    checks_revision integer DEFAULT 1 NOT NULL,
    approved_revision integer,
    published_id text,
    published_revision integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text NOT NULL,
    updated_by_name text NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT editorial_deleted_not_publishable CHECK (((deleted_at IS NULL) OR ((publication_status <> 'published'::text) AND (approved_revision IS NULL)))),
    CONSTRAINT editorial_recipe_editorial_status_check CHECK ((editorial_status = ANY (ARRAY['draft'::text, 'in_review'::text, 'approved'::text, 'archived'::text]))),
    CONSTRAINT editorial_recipe_publication_status_check CHECK ((publication_status = ANY (ARRAY['never_published'::text, 'published'::text, 'unpublished'::text]))),
    CONSTRAINT editorial_recipe_revision_check CHECK ((revision > 0))
);


--
-- Name: TABLE editorial_recipe; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.editorial_recipe IS 'Mutable editorial draft; active publication is an immutable separate snapshot.';


--
-- Name: editorial_slug; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.editorial_slug (
    locale text NOT NULL,
    slug text NOT NULL,
    recipe_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT editorial_slug_locale_check CHECK ((locale = ANY (ARRAY['pl'::text, 'en'::text])))
);


--
-- Name: editorial_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.editorial_version (
    recipe_id text NOT NULL,
    revision integer NOT NULL,
    content jsonb NOT NULL,
    content_hash text NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    created_by_name text NOT NULL
);


--
-- Name: event_collection; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_collection (
    id text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    content jsonb NOT NULL,
    content_hash text NOT NULL,
    publication_status text DEFAULT 'never_published'::text NOT NULL,
    published_id text,
    published_revision integer,
    first_published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text NOT NULL,
    updated_by_name text NOT NULL,
    CONSTRAINT event_collection_check CHECK (((publication_status <> 'published'::text) OR ((published_id IS NOT NULL) AND (published_revision IS NOT NULL) AND (first_published_at IS NOT NULL)))),
    CONSTRAINT event_collection_check1 CHECK (((published_revision IS NULL) OR ((published_revision > 0) AND (published_revision <= revision)))),
    CONSTRAINT event_collection_check2 CHECK (((content ->> 'selectionMode'::text) =
CASE
    WHEN (id = 'quick-dinners'::text) THEN 'quick-dinners'::text
    ELSE 'manual'::text
END)),
    CONSTRAINT event_collection_check3 CHECK ((((content ->> 'minimumRecipes'::text))::integer =
CASE
    WHEN (id = ANY (ARRAY['quick-dinners'::text, 'one-pot'::text, 'pantry'::text, 'seasonal'::text])) THEN 5
    ELSE 1
END)),
    CONSTRAINT event_collection_content_check CHECK ((jsonb_typeof(content) = 'object'::text)),
    CONSTRAINT event_collection_publication_status_check CHECK ((publication_status = ANY (ARRAY['never_published'::text, 'published'::text, 'unpublished'::text]))),
    CONSTRAINT event_collection_revision_check CHECK ((revision > 0))
);


--
-- Name: TABLE event_collection; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.event_collection IS 'Mutable bilingual collection drafts; dates promote the hero and never expire the public page.';


--
-- Name: event_collection_publication; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_collection_publication (
    id text NOT NULL,
    collection_id text NOT NULL,
    revision integer NOT NULL,
    snapshot jsonb NOT NULL,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    published_by text NOT NULL,
    published_by_name text NOT NULL,
    CONSTRAINT event_collection_publication_check CHECK (((jsonb_typeof(snapshot) = 'object'::text) AND ((snapshot ->> 'id'::text) = collection_id))),
    CONSTRAINT event_collection_publication_revision_check CHECK ((revision > 0))
);


--
-- Name: TABLE event_collection_publication; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.event_collection_publication IS 'Immutable collection snapshots with ordered references to published recipe identities.';


--
-- Name: ingredient_image_catalog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ingredient_image_catalog (
    key text NOT NULL,
    product text NOT NULL,
    form text NOT NULL,
    style_profile text NOT NULL,
    asset_id text NOT NULL,
    source_job_id text NOT NULL,
    photo jsonb NOT NULL,
    eligibility text DEFAULT 'usable'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ingredient_image_catalog_eligibility_check CHECK ((eligibility = ANY (ARRAY['usable'::text, 'approved'::text, 'rejected'::text])))
);


--
-- Name: TABLE ingredient_image_catalog; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ingredient_image_catalog IS 'Verified reusable ingredient photographs keyed by canonical product, preparation form and common photographic style; no duplicate paid generation.';


--
-- Name: media_backup_inventory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_backup_inventory (
    run_id text NOT NULL,
    source_store_id text NOT NULL,
    source_path text NOT NULL,
    metadata jsonb NOT NULL
);


--
-- Name: media_backup_object; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_backup_object (
    source_store_id text NOT NULL,
    source_path text NOT NULL,
    source_etag text NOT NULL,
    source_uploaded_at timestamp with time zone NOT NULL,
    byte_length bigint NOT NULL,
    proof jsonb NOT NULL,
    last_seen_run_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT media_backup_object_byte_length_check CHECK ((byte_length >= 0)),
    CONSTRAINT media_backup_object_complete_proof CHECK ((NOT ((proof ->> 'status'::text) IS DISTINCT FROM 'complete'::text))),
    CONSTRAINT media_backup_object_proof_check CHECK (((proof ->> 'status'::text) = 'complete'::text))
);


--
-- Name: media_compaction; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_compaction (
    source_pathname text NOT NULL,
    target_pathname text NOT NULL,
    source_sha256 text NOT NULL,
    target_sha256 text NOT NULL,
    pixel_sha256 text NOT NULL,
    source_bytes integer NOT NULL,
    target_bytes integer NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    verified_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT media_compaction_check CHECK (((target_bytes > 0) AND (target_bytes <= source_bytes))),
    CONSTRAINT media_compaction_height_check CHECK (((height >= 1) AND (height <= 3840))),
    CONSTRAINT media_compaction_pixel_sha256_check CHECK ((pixel_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT media_compaction_source_bytes_check CHECK ((source_bytes > 0)),
    CONSTRAINT media_compaction_source_pathname_check CHECK ((source_pathname ~~ 'ai/%'::text)),
    CONSTRAINT media_compaction_source_sha256_check CHECK ((source_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT media_compaction_target_pathname_check CHECK ((target_pathname ~ '^ai/compact/v1/[a-f0-9]{64}\.webp$'::text)),
    CONSTRAINT media_compaction_target_sha256_check CHECK ((target_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT media_compaction_width_check CHECK (((width >= 1) AND (width <= 3840)))
);


--
-- Name: media_delivery_variant; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_delivery_variant (
    cache_key text NOT NULL,
    asset_id text NOT NULL,
    source_pathname text NOT NULL,
    kind text NOT NULL,
    variant_key text NOT NULL,
    renderer_version text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    lease_token uuid,
    lease_until timestamp with time zone,
    source_sha256 text,
    source_bytes integer,
    blob_pathname text,
    content_sha256 text,
    byte_length integer,
    width integer,
    height integer,
    attempts integer DEFAULT 0 NOT NULL,
    error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    verified_at timestamp with time zone,
    CONSTRAINT media_delivery_variant_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT media_delivery_variant_blob_pathname_check CHECK ((blob_pathname ~ '^media-variants/webp-delivery-v1/[a-f0-9]{64}/(hero|ingredient|step)/[a-f0-9]{64}\.webp$'::text)),
    CONSTRAINT media_delivery_variant_byte_length_check CHECK (((byte_length >= 1) AND (byte_length <= 4194304))),
    CONSTRAINT media_delivery_variant_cache_key_check CHECK ((cache_key ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT media_delivery_variant_check CHECK (((variant_key ~ '^responsive:(96|160|320|480|640|960|1280|1600)$'::text) OR ((kind = 'hero'::text) AND ((variant_key = 'hero:full'::text) OR (variant_key ~ '^recipe:(1600x1200|1600x900|1200x1200|1200x630|1000x1500)$'::text))))),
    CONSTRAINT media_delivery_variant_check1 CHECK (((width IS NULL) OR (height IS NULL) OR (((width)::bigint * height) <= 8500000))),
    CONSTRAINT media_delivery_variant_check2 CHECK ((((status = 'rendering'::text) AND (lease_token IS NOT NULL) AND (lease_until IS NOT NULL)) OR ((status = ANY (ARRAY['pending'::text, 'ready'::text])) AND (lease_token IS NULL) AND (lease_until IS NULL)))),
    CONSTRAINT media_delivery_variant_check3 CHECK (((status <> 'ready'::text) OR ((source_sha256 IS NOT NULL) AND (source_bytes IS NOT NULL) AND (blob_pathname IS NOT NULL) AND (content_sha256 IS NOT NULL) AND (byte_length IS NOT NULL) AND (width IS NOT NULL) AND (height IS NOT NULL) AND (verified_at IS NOT NULL)))),
    CONSTRAINT media_delivery_variant_content_sha256_check CHECK ((content_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT media_delivery_variant_height_check CHECK (((height >= 1) AND (height <= 3840))),
    CONSTRAINT media_delivery_variant_kind_check CHECK ((kind = ANY (ARRAY['hero'::text, 'ingredient'::text, 'step'::text]))),
    CONSTRAINT media_delivery_variant_renderer_version_check CHECK ((renderer_version = 'webp-delivery-v1'::text)),
    CONSTRAINT media_delivery_variant_source_bytes_check CHECK (((source_bytes >= 1) AND (source_bytes <= 33554432))),
    CONSTRAINT media_delivery_variant_source_pathname_check CHECK (((source_pathname ~~ 'ai/%'::text) AND (length(source_pathname) <= 1000))),
    CONSTRAINT media_delivery_variant_source_sha256_check CHECK ((source_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT media_delivery_variant_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'rendering'::text, 'ready'::text]))),
    CONSTRAINT media_delivery_variant_width_check CHECK (((width >= 1) AND (width <= 3840)))
);


--
-- Name: media_maintenance_run; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_maintenance_run (
    id text NOT NULL,
    day date NOT NULL,
    generation integer DEFAULT 0 NOT NULL,
    phase text DEFAULT 'warm'::text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    workflow_run_id text,
    dispatch_claimed_at timestamp with time zone,
    heartbeat_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    next_retry_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    warm_cursor text,
    media_cursor text,
    bundle_cursor text,
    snapshot_receipt jsonb,
    restore_scope jsonb,
    restore_receipt jsonb,
    catalog_receipt jsonb,
    manifest_receipt jsonb,
    error_code text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    completed_at timestamp with time zone,
    retired_at timestamp with time zone,
    CONSTRAINT media_maintenance_run_check CHECK (((status <> 'complete'::text) OR ((completed_at IS NOT NULL) AND (manifest_receipt IS NOT NULL) AND ((restore_receipt ->> 'verified'::text) = 'true'::text)))),
    CONSTRAINT media_maintenance_run_generation_check CHECK ((generation >= 0)),
    CONSTRAINT media_maintenance_run_phase_check CHECK ((phase = ANY (ARRAY['warm'::text, 'snapshot'::text, 'media'::text, 'bundle'::text, 'catalog'::text, 'restore'::text, 'finalize'::text, 'retention'::text, 'complete'::text]))),
    CONSTRAINT media_maintenance_run_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'retry'::text, 'complete'::text]))),
    CONSTRAINT media_maintenance_verified_restore CHECK (((status <> 'complete'::text) OR ((restore_receipt IS NOT NULL) AND (NOT ((restore_receipt ->> 'verified'::text) IS DISTINCT FROM 'true'::text)) AND (NOT ((restore_receipt ->> 'cleanupConfirmed'::text) IS DISTINCT FROM 'true'::text)))))
);


--
-- Name: owner_activation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.owner_activation (
    id text NOT NULL,
    email text NOT NULL,
    token_hash text NOT NULL,
    purpose text DEFAULT 'activation'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT owner_activation_id_check CHECK ((id = 'owner'::text)),
    CONSTRAINT owner_activation_purpose_check CHECK ((purpose = ANY (ARRAY['activation'::text, 'recovery'::text])))
);


--
-- Name: reader_feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reader_feedback (
    id uuid NOT NULL,
    request_key uuid NOT NULL,
    recipe_id text NOT NULL,
    publication_revision integer NOT NULL,
    kind text NOT NULL,
    step_id text,
    message text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by text,
    CONSTRAINT reader_feedback_kind_check CHECK ((kind = ANY (ARRAY['success'::text, 'changed'::text, 'problem'::text]))),
    CONSTRAINT reader_feedback_message_check CHECK ((length(message) <= 1500)),
    CONSTRAINT reader_feedback_publication_revision_check CHECK ((publication_revision > 0)),
    CONSTRAINT reader_feedback_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text]))),
    CONSTRAINT reader_feedback_step_id_check CHECK ((length(step_id) <= 200))
);


--
-- Name: TABLE reader_feedback; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.reader_feedback IS 'Voluntary recipe feedback; no email, IP, device, visitor or cooking-session identifiers. request_key deduplicates a single form submission.';


--
-- Name: seo_usage_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seo_usage_daily (
    day date NOT NULL,
    event text NOT NULL,
    path text NOT NULL,
    source text NOT NULL,
    count bigint DEFAULT 1 NOT NULL,
    CONSTRAINT seo_usage_daily_check CHECK (((event = 'page_view'::text) OR (path ~ '^/(pl|en)/recipes/[a-z0-9]+(-[a-z0-9]+)*$'::text) OR ((event = ANY (ARRAY['pantry_use'::text, 'search'::text, 'no_results'::text, 'shopping_copy'::text, 'plan_remove'::text])) AND (path ~ '^/(pl|en)(/plan|/kolekcje/[a-z0-9]+(-[a-z0-9]+)*)?$'::text)))),
    CONSTRAINT seo_usage_daily_count_check CHECK ((count > 0)),
    CONSTRAINT seo_usage_daily_event_check CHECK ((event = ANY (ARRAY['page_view'::text, 'servings_change'::text, 'recipe_save'::text, 'cooking_step'::text, 'cooking_step_undo'::text, 'ingredient_check'::text, 'ingredient_uncheck'::text, 'print_recipe'::text, 'cooking_start'::text, 'cooking_complete'::text, 'repeat_cook'::text, 'shopping_copy'::text, 'plan_add'::text, 'plan_remove'::text, 'pantry_use'::text, 'search'::text, 'no_results'::text, 'feedback_submit'::text]))),
    CONSTRAINT seo_usage_daily_path_check CHECK (((length(path) <= 500) AND (path ~ '^/(pl|en)(/(o-serwisie|plan)|/(kolekcje|poradniki)|/(recipes|kolekcje|poradniki)/[a-z0-9]+(-[a-z0-9]+)*)?$'::text))),
    CONSTRAINT seo_usage_daily_source_check CHECK ((source = ANY (ARRAY['direct'::text, 'google'::text, 'bing'::text, 'pinterest'::text, 'chatgpt'::text, 'perplexity'::text, 'claude'::text, 'other'::text])))
);


--
-- Name: TABLE seo_usage_daily; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.seo_usage_daily IS 'Europe/Warsaw calendar aggregates; no raw referrers, queries, IP addresses, cookies or user identifiers.';


--
-- Name: trend_automation_takeover; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trend_automation_takeover (
    recipe_id text NOT NULL,
    run_id text,
    reason text NOT NULL,
    actor_id text,
    taken_over_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT trend_automation_takeover_reason_check CHECK ((reason = ANY (ARRAY['recipe_edit'::text, 'content_approval'::text, 'preparation'::text, 'studio'::text])))
);


--
-- Name: trend_candidate; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trend_candidate (
    id text NOT NULL,
    run_id text NOT NULL,
    dish_key text NOT NULL,
    data jsonb NOT NULL,
    selected boolean DEFAULT false NOT NULL
);


--
-- Name: trend_publication_day; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trend_publication_day (
    date text NOT NULL,
    due_at timestamp with time zone NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    generation integer DEFAULT 1 NOT NULL,
    workflow_id text,
    recipe_id text,
    run_id text,
    publication_id text,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT reviewed_publication_day_result_check CHECK (((status = 'published'::text) = ((recipe_id IS NOT NULL) AND (publication_id IS NOT NULL) AND (published_at IS NOT NULL)))),
    CONSTRAINT trend_publication_day_check CHECK ((due_at = (((date)::date + '06:00:00'::time without time zone) AT TIME ZONE 'Europe/Warsaw'::text))),
    CONSTRAINT trend_publication_day_date_check CHECK ((date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'::text)),
    CONSTRAINT trend_publication_day_generation_check CHECK ((generation > 0)),
    CONSTRAINT trend_publication_day_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'published'::text, 'expired'::text])))
);


--
-- Name: trend_run; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trend_run (
    id text NOT NULL,
    date text NOT NULL,
    mode text NOT NULL,
    generation integer DEFAULT 1 NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    recipe_id text,
    expected_revision integer,
    candidate_id text,
    workflow_id text,
    search_request_id text,
    search_claimed_at timestamp with time zone,
    search_finished_at timestamp with time zone,
    search_reserved_usd numeric(16,8) DEFAULT 0 NOT NULL,
    search_charged_usd numeric(16,8),
    packet_remaining_usd numeric(16,8) DEFAULT 0 NOT NULL,
    sources jsonb NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    search_model text,
    search_diagnostics jsonb,
    configuration_fingerprint text,
    manual_request_key uuid,
    CONSTRAINT trend_run_generation_check CHECK ((generation > 0)),
    CONSTRAINT trend_run_manual_control CHECK (((manual_request_key IS NULL) OR (mode = 'control'::text))),
    CONSTRAINT trend_run_mode_check CHECK ((mode = ANY (ARRAY['daily'::text, 'control'::text]))),
    CONSTRAINT trend_run_packet_remaining_usd_check CHECK ((packet_remaining_usd >= (0)::numeric)),
    CONSTRAINT trend_run_search_reserved_usd_check CHECK ((search_reserved_usd >= (0)::numeric)),
    CONSTRAINT trend_run_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'searching'::text, 'generating'::text, 'awaiting_review'::text, 'no_candidate'::text, 'paused'::text, 'failed'::text, 'uncertain'::text, 'rejected'::text, 'published'::text])))
);


--
-- Name: trend_setting; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trend_setting (
    id text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    monthly_limit_usd numeric(16,8) DEFAULT 150 NOT NULL,
    last_control_at timestamp with time zone,
    control_fingerprint text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text,
    auto_pause_reason text,
    auto_pause_token text,
    auto_pause_reviewed_at timestamp with time zone,
    publication_authorized_by text,
    reviewed_publication_enabled boolean DEFAULT false NOT NULL,
    reviewed_publication_authorized_by text,
    CONSTRAINT trend_setting_monthly_limit_usd_check CHECK (((monthly_limit_usd >= (0)::numeric) AND (monthly_limit_usd <= (1000000)::numeric)))
);


--
-- Name: trend_setting_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trend_setting_audit (
    id uuid NOT NULL,
    actor_id text NOT NULL,
    actor_name text NOT NULL,
    before_state jsonb NOT NULL,
    after_state jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- PostgreSQL database dump complete
--

\unrestrict 0wazyogWEF1axT7gmwkar4Tpf9aDpiZrAjGgSBQ3M2jXzx1tzzo15K5KBguftvF

