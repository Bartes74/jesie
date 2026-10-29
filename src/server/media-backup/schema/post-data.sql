--
-- PostgreSQL database dump
--

\restrict vRYBeW4AeLSIA6VtcqXiifaqZKJgh7gpHSotGiIcFnw1d2LxEzFUOeCjg17cxgU

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

SET default_tablespace = '';

--
-- Name: ai_asset ai_asset_blob_pathname_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_asset
    ADD CONSTRAINT ai_asset_blob_pathname_key UNIQUE (blob_pathname);


--
-- Name: ai_asset ai_asset_job_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_asset
    ADD CONSTRAINT ai_asset_job_id_key UNIQUE (job_id);


--
-- Name: ai_asset ai_asset_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_asset
    ADD CONSTRAINT ai_asset_pkey PRIMARY KEY (id);


--
-- Name: ai_budget_settings_audit ai_budget_settings_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_budget_settings_audit
    ADD CONSTRAINT ai_budget_settings_audit_pkey PRIMARY KEY (id);


--
-- Name: ai_budget_settings_audit ai_budget_settings_audit_revision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_budget_settings_audit
    ADD CONSTRAINT ai_budget_settings_audit_revision_key UNIQUE (revision);


--
-- Name: ai_budget_settings ai_budget_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_budget_settings
    ADD CONSTRAINT ai_budget_settings_pkey PRIMARY KEY (id);


--
-- Name: ai_cost_ledger ai_cost_ledger_job_id_entry_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_cost_ledger
    ADD CONSTRAINT ai_cost_ledger_job_id_entry_key UNIQUE (job_id, entry);


--
-- Name: ai_cost_ledger ai_cost_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_cost_ledger
    ADD CONSTRAINT ai_cost_ledger_pkey PRIMARY KEY (id);


--
-- Name: ai_ingredient_verification ai_ingredient_verification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_ingredient_verification
    ADD CONSTRAINT ai_ingredient_verification_pkey PRIMARY KEY (verification_key);


--
-- Name: ai_ingredient_verification ai_ingredient_verification_provider_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_ingredient_verification
    ADD CONSTRAINT ai_ingredient_verification_provider_request_id_key UNIQUE (provider_request_id);


--
-- Name: ai_job ai_job_created_by_request_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_job
    ADD CONSTRAINT ai_job_created_by_request_key_key UNIQUE (created_by, request_key);


--
-- Name: ai_job ai_job_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_job
    ADD CONSTRAINT ai_job_pkey PRIMARY KEY (id);


--
-- Name: ai_photo_batch ai_photo_batch_created_by_request_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_photo_batch
    ADD CONSTRAINT ai_photo_batch_created_by_request_key_key UNIQUE (created_by, request_key);


--
-- Name: ai_photo_batch ai_photo_batch_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_photo_batch
    ADD CONSTRAINT ai_photo_batch_pkey PRIMARY KEY (id);


--
-- Name: ai_recipe_recovery ai_recipe_recovery_parent_job_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_recipe_recovery
    ADD CONSTRAINT ai_recipe_recovery_parent_job_id_key UNIQUE (parent_job_id);


--
-- Name: ai_recipe_recovery ai_recipe_recovery_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_recipe_recovery
    ADD CONSTRAINT ai_recipe_recovery_pkey PRIMARY KEY (job_id);


--
-- Name: ai_recipe_recovery ai_recipe_recovery_root_job_id_attempt_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_recipe_recovery
    ADD CONSTRAINT ai_recipe_recovery_root_job_id_attempt_key UNIQUE (root_job_id, attempt);


--
-- Name: ai_verified_ingredient_alias ai_verified_ingredient_alias_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_verified_ingredient_alias
    ADD CONSTRAINT ai_verified_ingredient_alias_pkey PRIMARY KEY (normalized_alias);


--
-- Name: auth_account auth_account_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_account
    ADD CONSTRAINT auth_account_pkey PRIMARY KEY (id);


--
-- Name: auth_account auth_account_provider_id_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_account
    ADD CONSTRAINT auth_account_provider_id_account_id_key UNIQUE (provider_id, account_id);


--
-- Name: auth_event auth_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_event
    ADD CONSTRAINT auth_event_pkey PRIMARY KEY (id);


--
-- Name: auth_rate_limit auth_rate_limit_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_rate_limit
    ADD CONSTRAINT auth_rate_limit_key_key UNIQUE (key);


--
-- Name: auth_rate_limit auth_rate_limit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_rate_limit
    ADD CONSTRAINT auth_rate_limit_pkey PRIMARY KEY (id);


--
-- Name: auth_session auth_session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session
    ADD CONSTRAINT auth_session_pkey PRIMARY KEY (id);


--
-- Name: auth_session auth_session_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session
    ADD CONSTRAINT auth_session_token_key UNIQUE (token);


--
-- Name: auth_user auth_user_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_user
    ADD CONSTRAINT auth_user_email_key UNIQUE (email);


--
-- Name: auth_user auth_user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_user
    ADD CONSTRAINT auth_user_pkey PRIMARY KEY (id);


--
-- Name: auth_verification auth_verification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_verification
    ADD CONSTRAINT auth_verification_pkey PRIMARY KEY (id);


--
-- Name: collection_asset collection_asset_blob_pathname_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collection_asset
    ADD CONSTRAINT collection_asset_blob_pathname_key UNIQUE (blob_pathname);


--
-- Name: collection_asset collection_asset_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collection_asset
    ADD CONSTRAINT collection_asset_pkey PRIMARY KEY (id);


--
-- Name: collection_discovery_event collection_discovery_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collection_discovery_event
    ADD CONSTRAINT collection_discovery_event_pkey PRIMARY KEY (id);


--
-- Name: collection_theme_cost collection_theme_cost_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collection_theme_cost
    ADD CONSTRAINT collection_theme_cost_pkey PRIMARY KEY (job_id);


--
-- Name: collection_theme_generation collection_theme_generation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collection_theme_generation
    ADD CONSTRAINT collection_theme_generation_pkey PRIMARY KEY (id);


--
-- Name: collection_theme_job collection_theme_job_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collection_theme_job
    ADD CONSTRAINT collection_theme_job_pkey PRIMARY KEY (id);


--
-- Name: collection_theme_generation collection_theme_request_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collection_theme_generation
    ADD CONSTRAINT collection_theme_request_unique UNIQUE (created_by, request_key);


--
-- Name: collection_theme_job collection_theme_stage_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collection_theme_job
    ADD CONSTRAINT collection_theme_stage_unique UNIQUE (generation_id, kind);


--
-- Name: editorial_audit editorial_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editorial_audit
    ADD CONSTRAINT editorial_audit_pkey PRIMARY KEY (id);


--
-- Name: editorial_content_approval editorial_content_approval_manual_review_required; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.editorial_content_approval
    ADD CONSTRAINT editorial_content_approval_manual_review_required CHECK ((origin <> 'automated'::text)) NOT VALID;


--
-- Name: editorial_content_approval editorial_content_approval_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editorial_content_approval
    ADD CONSTRAINT editorial_content_approval_pkey PRIMARY KEY (recipe_id, content_hash, origin);


--
-- Name: editorial_migration editorial_migration_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editorial_migration
    ADD CONSTRAINT editorial_migration_pkey PRIMARY KEY (name);


--
-- Name: editorial_outbox editorial_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editorial_outbox
    ADD CONSTRAINT editorial_outbox_pkey PRIMARY KEY (id);


--
-- Name: editorial_publication editorial_publication_id_recipe_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editorial_publication
    ADD CONSTRAINT editorial_publication_id_recipe_id_key UNIQUE (id, recipe_id);


--
-- Name: editorial_publication editorial_publication_manual_release_required; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.editorial_publication
    ADD CONSTRAINT editorial_publication_manual_release_required CHECK ((approval_origin <> ALL (ARRAY['automated'::text, 'manual_scheduled'::text]))) NOT VALID;


--
-- Name: editorial_publication editorial_publication_no_new_manual_scheduled; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.editorial_publication
    ADD CONSTRAINT editorial_publication_no_new_manual_scheduled CHECK ((approval_origin <> 'manual_scheduled'::text)) NOT VALID;


--
-- Name: editorial_publication editorial_publication_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editorial_publication
    ADD CONSTRAINT editorial_publication_pkey PRIMARY KEY (id);


--
-- Name: editorial_publication_plan_audit editorial_publication_plan_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editorial_publication_plan_audit
    ADD CONSTRAINT editorial_publication_plan_audit_pkey PRIMARY KEY (id);


--
-- Name: editorial_publication_plan editorial_publication_plan_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editorial_publication_plan
    ADD CONSTRAINT editorial_publication_plan_pkey PRIMARY KEY (date);


--
-- Name: editorial_publication editorial_publication_recipe_id_revision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editorial_publication
    ADD CONSTRAINT editorial_publication_recipe_id_revision_key UNIQUE (recipe_id, revision);


--
-- Name: editorial_recipe editorial_recipe_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editorial_recipe
    ADD CONSTRAINT editorial_recipe_pkey PRIMARY KEY (id);


--
-- Name: editorial_slug editorial_slug_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editorial_slug
    ADD CONSTRAINT editorial_slug_pkey PRIMARY KEY (locale, slug);


--
-- Name: editorial_version editorial_version_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editorial_version
    ADD CONSTRAINT editorial_version_pkey PRIMARY KEY (recipe_id, revision);


--
-- Name: event_collection event_collection_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_collection
    ADD CONSTRAINT event_collection_pkey PRIMARY KEY (id);


--
-- Name: event_collection_publication event_collection_publication_collection_id_revision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_collection_publication
    ADD CONSTRAINT event_collection_publication_collection_id_revision_key UNIQUE (collection_id, revision);


--
-- Name: event_collection_publication event_collection_publication_id_collection_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_collection_publication
    ADD CONSTRAINT event_collection_publication_id_collection_id_key UNIQUE (id, collection_id);


--
-- Name: event_collection_publication event_collection_publication_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_collection_publication
    ADD CONSTRAINT event_collection_publication_pkey PRIMARY KEY (id);


--
-- Name: ingredient_image_catalog ingredient_image_catalog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingredient_image_catalog
    ADD CONSTRAINT ingredient_image_catalog_pkey PRIMARY KEY (key, asset_id);


--
-- Name: media_backup_inventory media_backup_inventory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_backup_inventory
    ADD CONSTRAINT media_backup_inventory_pkey PRIMARY KEY (run_id, source_store_id, source_path);


--
-- Name: media_backup_object media_backup_object_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_backup_object
    ADD CONSTRAINT media_backup_object_pkey PRIMARY KEY (source_store_id, source_path, source_etag);


--
-- Name: media_compaction media_compaction_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_compaction
    ADD CONSTRAINT media_compaction_pkey PRIMARY KEY (source_pathname);


--
-- Name: media_delivery_variant media_delivery_variant_asset_id_source_pathname_kind_varian_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_delivery_variant
    ADD CONSTRAINT media_delivery_variant_asset_id_source_pathname_kind_varian_key UNIQUE (asset_id, source_pathname, kind, variant_key, renderer_version);


--
-- Name: media_delivery_variant media_delivery_variant_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_delivery_variant
    ADD CONSTRAINT media_delivery_variant_pkey PRIMARY KEY (cache_key);


--
-- Name: media_maintenance_run media_maintenance_run_day_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_maintenance_run
    ADD CONSTRAINT media_maintenance_run_day_key UNIQUE (day);


--
-- Name: media_maintenance_run media_maintenance_run_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_maintenance_run
    ADD CONSTRAINT media_maintenance_run_pkey PRIMARY KEY (id);


--
-- Name: owner_activation owner_activation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.owner_activation
    ADD CONSTRAINT owner_activation_pkey PRIMARY KEY (id);


--
-- Name: owner_activation owner_activation_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.owner_activation
    ADD CONSTRAINT owner_activation_token_hash_key UNIQUE (token_hash);


--
-- Name: reader_feedback reader_feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_feedback
    ADD CONSTRAINT reader_feedback_pkey PRIMARY KEY (id);


--
-- Name: reader_feedback reader_feedback_request_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_feedback
    ADD CONSTRAINT reader_feedback_request_key_key UNIQUE (request_key);


--
-- Name: seo_usage_daily seo_usage_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_usage_daily
    ADD CONSTRAINT seo_usage_daily_pkey PRIMARY KEY (day, event, path, source);


--
-- Name: site_page site_page_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_page
    ADD CONSTRAINT site_page_pkey PRIMARY KEY (id);


--
-- Name: trend_automation_takeover trend_automation_takeover_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_automation_takeover
    ADD CONSTRAINT trend_automation_takeover_pkey PRIMARY KEY (recipe_id);


--
-- Name: trend_candidate trend_candidate_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_candidate
    ADD CONSTRAINT trend_candidate_pkey PRIMARY KEY (id);


--
-- Name: trend_publication_day trend_publication_day_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_publication_day
    ADD CONSTRAINT trend_publication_day_pkey PRIMARY KEY (date);


--
-- Name: trend_publication_day trend_publication_day_publication_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_publication_day
    ADD CONSTRAINT trend_publication_day_publication_id_key UNIQUE (publication_id);


--
-- Name: trend_run trend_run_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_run
    ADD CONSTRAINT trend_run_pkey PRIMARY KEY (id);


--
-- Name: trend_setting_audit trend_setting_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_setting_audit
    ADD CONSTRAINT trend_setting_audit_pkey PRIMARY KEY (id);


--
-- Name: trend_setting trend_setting_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_setting
    ADD CONSTRAINT trend_setting_pkey PRIMARY KEY (id);


--
-- Name: ai_asset_recipe_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_asset_recipe_idx ON public.ai_asset USING btree (recipe_id);


--
-- Name: ai_ingredient_producer_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ai_ingredient_producer_unique ON public.ai_job USING btree (ingredient_key) WHERE ((ingredient_key IS NOT NULL) AND (reuse_source_job_id IS NULL) AND (ingredient_resolved_at IS NULL) AND (result IS NULL) AND (status <> 'failed'::text));


--
-- Name: ai_ingredient_verification_origin_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_ingredient_verification_origin_job_idx ON public.ai_ingredient_verification USING btree (origin_job_id);


--
-- Name: ai_ingredient_verification_origin_recipe_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_ingredient_verification_origin_recipe_idx ON public.ai_ingredient_verification USING btree (origin_recipe_id);


--
-- Name: ai_job_active_input_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ai_job_active_input_unique ON public.ai_job USING btree (input_hash) WHERE (status = ANY (ARRAY['queued'::text, 'submitting'::text, 'generating'::text, 'uncertain'::text]));


--
-- Name: ai_job_ingredient_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_job_ingredient_key_idx ON public.ai_job USING btree (ingredient_key);


--
-- Name: ai_job_photo_batch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_job_photo_batch_idx ON public.ai_job USING btree (photo_batch_id);


--
-- Name: ai_job_recipe_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_job_recipe_created_idx ON public.ai_job USING btree (recipe_id, created_at);


--
-- Name: ai_job_trend_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_job_trend_run_idx ON public.ai_job USING btree (trend_run_id);


--
-- Name: ai_photo_batch_active_input_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ai_photo_batch_active_input_unique ON public.ai_photo_batch USING btree (recipe_id, input_hash) WHERE (status = ANY (ARRAY['queued'::text, 'generating'::text, 'ready'::text, 'blocked'::text]));


--
-- Name: ai_photo_batch_recipe_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_photo_batch_recipe_created_idx ON public.ai_photo_batch USING btree (recipe_id, created_at);


--
-- Name: ai_recipe_recovery_root_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_recipe_recovery_root_idx ON public.ai_recipe_recovery USING btree (root_job_id, attempt DESC);


--
-- Name: auth_account_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_account_user_idx ON public.auth_account USING btree (user_id);


--
-- Name: auth_event_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_event_created_idx ON public.auth_event USING btree (created_at);


--
-- Name: auth_one_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX auth_one_owner_idx ON public.auth_user USING btree (role) WHERE (role = 'owner'::text);


--
-- Name: auth_session_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_session_user_idx ON public.auth_session USING btree (user_id);


--
-- Name: auth_verification_identifier_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_verification_identifier_idx ON public.auth_verification USING btree (identifier);


--
-- Name: collection_discovery_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX collection_discovery_pending_idx ON public.collection_discovery_event USING btree (next_attempt_at) WHERE (completed_at IS NULL);


--
-- Name: collection_theme_collection_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX collection_theme_collection_idx ON public.collection_theme_generation USING btree (collection_id);


--
-- Name: editorial_content_approval_recipe_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX editorial_content_approval_recipe_idx ON public.editorial_content_approval USING btree (recipe_id, approved_at);


--
-- Name: editorial_outbox_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX editorial_outbox_pending_idx ON public.editorial_outbox USING btree (created_at) WHERE (processed_at IS NULL);


--
-- Name: editorial_outbox_retry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX editorial_outbox_retry_idx ON public.editorial_outbox USING btree (next_attempt_at, created_at) WHERE (processed_at IS NULL);


--
-- Name: editorial_publication_plan_audit_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX editorial_publication_plan_audit_date_idx ON public.editorial_publication_plan_audit USING btree (date, created_at);


--
-- Name: editorial_publication_plan_recipe_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX editorial_publication_plan_recipe_unique ON public.editorial_publication_plan USING btree (recipe_id);


--
-- Name: editorial_recipe_deleted_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX editorial_recipe_deleted_idx ON public.editorial_recipe USING btree (deleted_at);


--
-- Name: editorial_recipe_publication_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX editorial_recipe_publication_idx ON public.editorial_recipe USING btree (publication_status);


--
-- Name: editorial_recipe_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX editorial_recipe_updated_idx ON public.editorial_recipe USING btree (updated_at);


--
-- Name: event_collection_slug_en_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX event_collection_slug_en_unique ON public.event_collection USING btree ((((content -> 'slug'::text) ->> 'en'::text))) WHERE (COALESCE(((content -> 'slug'::text) ->> 'en'::text), ''::text) <> ''::text);


--
-- Name: event_collection_slug_pl_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX event_collection_slug_pl_unique ON public.event_collection USING btree ((((content -> 'slug'::text) ->> 'pl'::text))) WHERE (COALESCE(((content -> 'slug'::text) ->> 'pl'::text), ''::text) <> ''::text);


--
-- Name: event_collection_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_collection_updated_idx ON public.event_collection USING btree (updated_at);


--
-- Name: ingredient_image_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ingredient_image_key_idx ON public.ingredient_image_catalog USING btree (key);


--
-- Name: media_delivery_variant_work_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_delivery_variant_work_idx ON public.media_delivery_variant USING btree (status, lease_until, updated_at);


--
-- Name: media_maintenance_recovery_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_maintenance_recovery_idx ON public.media_maintenance_run USING btree (status, heartbeat_at, day);


--
-- Name: reader_feedback_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reader_feedback_status_created_idx ON public.reader_feedback USING btree (status, created_at DESC);


--
-- Name: trend_automation_takeover_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trend_automation_takeover_run_idx ON public.trend_automation_takeover USING btree (run_id);


--
-- Name: trend_candidate_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trend_candidate_run_idx ON public.trend_candidate USING btree (run_id);


--
-- Name: trend_run_date_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX trend_run_date_unique ON public.trend_run USING btree (date) WHERE (manual_request_key IS NULL);


--
-- Name: trend_run_manual_request_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX trend_run_manual_request_unique ON public.trend_run USING btree (manual_request_key);


--
-- Name: trend_run_recipe_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trend_run_recipe_idx ON public.trend_run USING btree (recipe_id);


--
-- Name: ai_asset ai_asset_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_asset_immutable BEFORE DELETE OR UPDATE ON public.ai_asset FOR EACH ROW EXECUTE FUNCTION public.editorial_reject_history_mutation();


--
-- Name: ai_budget_settings_audit ai_budget_settings_audit_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_budget_settings_audit_immutable BEFORE DELETE OR UPDATE ON public.ai_budget_settings_audit FOR EACH ROW EXECUTE FUNCTION public.editorial_reject_history_mutation();


--
-- Name: ai_budget_settings ai_budget_settings_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_budget_settings_no_delete BEFORE DELETE ON public.ai_budget_settings FOR EACH ROW EXECUTE FUNCTION public.editorial_reject_history_mutation();


--
-- Name: ai_budget_settings ai_budget_settings_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_budget_settings_revision BEFORE UPDATE ON public.ai_budget_settings FOR EACH ROW EXECUTE FUNCTION public.ai_budget_settings_guard();


--
-- Name: ai_cost_ledger ai_cost_ledger_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_cost_ledger_immutable BEFORE DELETE OR UPDATE ON public.ai_cost_ledger FOR EACH ROW EXECUTE FUNCTION public.editorial_reject_history_mutation();


--
-- Name: ai_ingredient_verification ai_ingredient_verification_identity_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_ingredient_verification_identity_immutable BEFORE DELETE OR UPDATE ON public.ai_ingredient_verification FOR EACH ROW EXECUTE FUNCTION public.protect_ingredient_verification_identity();


--
-- Name: ai_job ai_job_capture_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_job_capture_immutable BEFORE UPDATE ON public.ai_job FOR EACH ROW EXECUTE FUNCTION public.ai_guard_job_capture();


--
-- Name: ai_job ai_job_manual_photo_decision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_job_manual_photo_decision BEFORE INSERT OR UPDATE ON public.ai_job FOR EACH ROW EXECUTE FUNCTION public.protect_manual_photo_decision();


--
-- Name: ai_job ai_job_manual_studio_takeover; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_job_manual_studio_takeover AFTER INSERT ON public.ai_job FOR EACH ROW EXECUTE FUNCTION public.record_manual_studio_takeover();


--
-- Name: ai_job ai_job_trend_scope_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_job_trend_scope_immutable BEFORE UPDATE ON public.ai_job FOR EACH ROW EXECUTE FUNCTION public.ai_guard_trend_scope();


--
-- Name: ai_photo_batch ai_photo_batch_capture_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_photo_batch_capture_immutable BEFORE UPDATE ON public.ai_photo_batch FOR EACH ROW EXECUTE FUNCTION public.ai_photo_batch_guard();


--
-- Name: ai_recipe_recovery ai_recipe_recovery_identity_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_recipe_recovery_identity_immutable BEFORE DELETE OR UPDATE ON public.ai_recipe_recovery FOR EACH ROW EXECUTE FUNCTION public.protect_recipe_recovery_identity();


--
-- Name: collection_asset collection_asset_history_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER collection_asset_history_immutable BEFORE DELETE OR UPDATE ON public.collection_asset FOR EACH ROW EXECUTE FUNCTION public.protect_collection_asset_history();


--
-- Name: collection_theme_cost collection_theme_cost_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER collection_theme_cost_immutable BEFORE DELETE OR UPDATE ON public.collection_theme_cost FOR EACH ROW EXECUTE FUNCTION public.protect_collection_asset_history();


--
-- Name: collection_theme_generation collection_theme_history_retained; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER collection_theme_history_retained BEFORE DELETE ON public.collection_theme_generation FOR EACH ROW EXECUTE FUNCTION public.protect_collection_asset_history();


--
-- Name: collection_theme_generation collection_theme_identity_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER collection_theme_identity_immutable BEFORE UPDATE ON public.collection_theme_generation FOR EACH ROW EXECUTE FUNCTION public.protect_collection_generation_identity();


--
-- Name: collection_theme_job collection_theme_job_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER collection_theme_job_immutable BEFORE UPDATE ON public.collection_theme_job FOR EACH ROW EXECUTE FUNCTION public.protect_collection_job_identity();


--
-- Name: collection_theme_job collection_theme_job_retained; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER collection_theme_job_retained BEFORE DELETE ON public.collection_theme_job FOR EACH ROW EXECUTE FUNCTION public.protect_collection_asset_history();


--
-- Name: editorial_audit editorial_audit_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER editorial_audit_immutable BEFORE DELETE OR UPDATE ON public.editorial_audit FOR EACH ROW EXECUTE FUNCTION public.editorial_reject_history_mutation();


--
-- Name: editorial_content_approval editorial_content_approval_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER editorial_content_approval_immutable BEFORE DELETE OR UPDATE ON public.editorial_content_approval FOR EACH ROW EXECUTE FUNCTION public.editorial_reject_history_mutation();


--
-- Name: editorial_content_approval editorial_content_manual_takeover; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER editorial_content_manual_takeover AFTER INSERT ON public.editorial_content_approval FOR EACH ROW EXECUTE FUNCTION public.record_daily_content_takeover();


--
-- Name: editorial_publication editorial_publication_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER editorial_publication_immutable BEFORE DELETE OR UPDATE ON public.editorial_publication FOR EACH ROW EXECUTE FUNCTION public.editorial_reject_history_mutation();


--
-- Name: editorial_publication editorial_publication_no_manual_takeover; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER editorial_publication_no_manual_takeover BEFORE INSERT ON public.editorial_publication FOR EACH ROW EXECUTE FUNCTION public.protect_manual_takeover_publication();


--
-- Name: editorial_publication_plan_audit editorial_publication_plan_audit_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER editorial_publication_plan_audit_immutable BEFORE DELETE OR UPDATE ON public.editorial_publication_plan_audit FOR EACH ROW EXECUTE FUNCTION public.protect_editorial_publication_plan_audit();


--
-- Name: editorial_publication editorial_publication_plan_release_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER editorial_publication_plan_release_guard BEFORE INSERT ON public.editorial_publication FOR EACH ROW EXECUTE FUNCTION public.protect_editorial_publication_plan_release();


--
-- Name: editorial_publication editorial_publication_verified_daily_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER editorial_publication_verified_daily_guard BEFORE INSERT ON public.editorial_publication FOR EACH ROW EXECUTE FUNCTION public.protect_verified_daily_publication();


--
-- Name: editorial_recipe editorial_recipe_daily_takeover; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER editorial_recipe_daily_takeover AFTER INSERT OR UPDATE ON public.editorial_recipe FOR EACH ROW EXECUTE FUNCTION public.record_daily_recipe_takeover();


--
-- Name: editorial_version editorial_version_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER editorial_version_immutable BEFORE DELETE OR UPDATE ON public.editorial_version FOR EACH ROW EXECUTE FUNCTION public.editorial_reject_history_mutation();


--
-- Name: event_collection event_collection_identity_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER event_collection_identity_immutable BEFORE DELETE OR UPDATE ON public.event_collection FOR EACH ROW EXECUTE FUNCTION public.protect_collection_identity();


--
-- Name: event_collection_publication event_collection_publication_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER event_collection_publication_immutable BEFORE DELETE OR UPDATE ON public.event_collection_publication FOR EACH ROW EXECUTE FUNCTION public.editorial_reject_history_mutation();


--
-- Name: ingredient_image_catalog ingredient_image_identity_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ingredient_image_identity_immutable BEFORE DELETE OR UPDATE ON public.ingredient_image_catalog FOR EACH ROW EXECUTE FUNCTION public.ingredient_image_guard();


--
-- Name: media_compaction media_compaction_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER media_compaction_immutable BEFORE DELETE OR UPDATE ON public.media_compaction FOR EACH ROW EXECUTE FUNCTION public.editorial_reject_history_mutation();


--
-- Name: trend_automation_takeover trend_automation_takeover_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trend_automation_takeover_immutable BEFORE DELETE OR UPDATE ON public.trend_automation_takeover FOR EACH ROW EXECUTE FUNCTION public.editorial_reject_history_mutation();


--
-- Name: trend_publication_day trend_publication_day_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trend_publication_day_immutable BEFORE DELETE OR UPDATE ON public.trend_publication_day FOR EACH ROW EXECUTE FUNCTION public.protect_trend_publication_day();


--
-- Name: trend_run trend_run_manual_preparation_takeover; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trend_run_manual_preparation_takeover AFTER INSERT OR UPDATE ON public.trend_run FOR EACH ROW EXECUTE FUNCTION public.record_daily_preparation_takeover();


--
-- Name: trend_setting_audit trend_setting_audit_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trend_setting_audit_immutable BEFORE DELETE OR UPDATE ON public.trend_setting_audit FOR EACH ROW EXECUTE FUNCTION public.protect_trend_setting_audit();


--
-- Name: ai_asset ai_asset_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_asset
    ADD CONSTRAINT ai_asset_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.ai_job(id);


--
-- Name: ai_asset ai_asset_recipe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_asset
    ADD CONSTRAINT ai_asset_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES public.editorial_recipe(id);


--
-- Name: ai_cost_ledger ai_cost_ledger_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_cost_ledger
    ADD CONSTRAINT ai_cost_ledger_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.ai_job(id);


--
-- Name: ai_ingredient_verification ai_ingredient_verification_origin_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_ingredient_verification
    ADD CONSTRAINT ai_ingredient_verification_origin_job_id_fkey FOREIGN KEY (origin_job_id) REFERENCES public.ai_job(id) ON DELETE SET NULL;


--
-- Name: ai_job ai_job_photo_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_job
    ADD CONSTRAINT ai_job_photo_batch_id_fkey FOREIGN KEY (photo_batch_id) REFERENCES public.ai_photo_batch(id);


--
-- Name: ai_job ai_job_recipe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_job
    ADD CONSTRAINT ai_job_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES public.editorial_recipe(id);


--
-- Name: ai_job ai_job_reuse_source_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_job
    ADD CONSTRAINT ai_job_reuse_source_job_id_fkey FOREIGN KEY (reuse_source_job_id) REFERENCES public.ai_job(id);


--
-- Name: ai_job ai_job_trend_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_job
    ADD CONSTRAINT ai_job_trend_run_id_fkey FOREIGN KEY (trend_run_id) REFERENCES public.trend_run(id);


--
-- Name: ai_photo_batch ai_photo_batch_recipe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_photo_batch
    ADD CONSTRAINT ai_photo_batch_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES public.editorial_recipe(id);


--
-- Name: ai_photo_batch ai_photo_batch_source_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_photo_batch
    ADD CONSTRAINT ai_photo_batch_source_job_id_fkey FOREIGN KEY (source_job_id) REFERENCES public.ai_job(id);


--
-- Name: ai_recipe_recovery ai_recipe_recovery_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_recipe_recovery
    ADD CONSTRAINT ai_recipe_recovery_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.ai_job(id);


--
-- Name: ai_recipe_recovery ai_recipe_recovery_parent_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_recipe_recovery
    ADD CONSTRAINT ai_recipe_recovery_parent_job_id_fkey FOREIGN KEY (parent_job_id) REFERENCES public.ai_job(id);


--
-- Name: ai_recipe_recovery ai_recipe_recovery_root_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_recipe_recovery
    ADD CONSTRAINT ai_recipe_recovery_root_job_id_fkey FOREIGN KEY (root_job_id) REFERENCES public.ai_job(id);


--
-- Name: ai_verified_ingredient_alias ai_verified_ingredient_alias_verification_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_verified_ingredient_alias
    ADD CONSTRAINT ai_verified_ingredient_alias_verification_key_fkey FOREIGN KEY (verification_key) REFERENCES public.ai_ingredient_verification(verification_key);


--
-- Name: auth_account auth_account_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_account
    ADD CONSTRAINT auth_account_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.auth_user(id) ON DELETE CASCADE;


--
-- Name: auth_event auth_event_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_event
    ADD CONSTRAINT auth_event_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.auth_user(id) ON DELETE SET NULL;


--
-- Name: auth_session auth_session_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session
    ADD CONSTRAINT auth_session_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.auth_user(id) ON DELETE CASCADE;


--
-- Name: collection_asset collection_asset_collection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collection_asset
    ADD CONSTRAINT collection_asset_collection_id_fkey FOREIGN KEY (collection_id) REFERENCES public.event_collection(id);


--
-- Name: collection_asset collection_asset_generation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collection_asset
    ADD CONSTRAINT collection_asset_generation_id_fkey FOREIGN KEY (generation_id) REFERENCES public.collection_theme_generation(id);


--
-- Name: collection_discovery_event collection_discovery_event_collection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collection_discovery_event
    ADD CONSTRAINT collection_discovery_event_collection_id_fkey FOREIGN KEY (collection_id) REFERENCES public.event_collection(id);


--
-- Name: collection_theme_cost collection_theme_cost_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collection_theme_cost
    ADD CONSTRAINT collection_theme_cost_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.collection_theme_job(id);


--
-- Name: collection_theme_generation collection_theme_generation_collection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collection_theme_generation
    ADD CONSTRAINT collection_theme_generation_collection_id_fkey FOREIGN KEY (collection_id) REFERENCES public.event_collection(id);


--
-- Name: collection_theme_job collection_theme_job_generation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collection_theme_job
    ADD CONSTRAINT collection_theme_job_generation_id_fkey FOREIGN KEY (generation_id) REFERENCES public.collection_theme_generation(id);


--
-- Name: editorial_recipe editorial_active_publication_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editorial_recipe
    ADD CONSTRAINT editorial_active_publication_fk FOREIGN KEY (published_id, id) REFERENCES public.editorial_publication(id, recipe_id);


--
-- Name: editorial_audit editorial_audit_recipe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editorial_audit
    ADD CONSTRAINT editorial_audit_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES public.editorial_recipe(id);


--
-- Name: editorial_content_approval editorial_content_approval_recipe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editorial_content_approval
    ADD CONSTRAINT editorial_content_approval_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES public.editorial_recipe(id);


--
-- Name: editorial_outbox editorial_outbox_recipe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editorial_outbox
    ADD CONSTRAINT editorial_outbox_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES public.editorial_recipe(id);


--
-- Name: editorial_publication_plan editorial_publication_plan_date_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editorial_publication_plan
    ADD CONSTRAINT editorial_publication_plan_date_fkey FOREIGN KEY (date) REFERENCES public.trend_publication_day(date);


--
-- Name: editorial_publication_plan editorial_publication_plan_recipe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editorial_publication_plan
    ADD CONSTRAINT editorial_publication_plan_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES public.editorial_recipe(id);


--
-- Name: editorial_publication editorial_publication_recipe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editorial_publication
    ADD CONSTRAINT editorial_publication_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES public.editorial_recipe(id);


--
-- Name: editorial_slug editorial_slug_recipe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editorial_slug
    ADD CONSTRAINT editorial_slug_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES public.editorial_recipe(id);


--
-- Name: editorial_version editorial_version_recipe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editorial_version
    ADD CONSTRAINT editorial_version_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES public.editorial_recipe(id);


--
-- Name: event_collection event_collection_active_publication_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_collection
    ADD CONSTRAINT event_collection_active_publication_fk FOREIGN KEY (published_id, id) REFERENCES public.event_collection_publication(id, collection_id);


--
-- Name: event_collection_publication event_collection_publication_collection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_collection_publication
    ADD CONSTRAINT event_collection_publication_collection_id_fkey FOREIGN KEY (collection_id) REFERENCES public.event_collection(id);


--
-- Name: ingredient_image_catalog ingredient_image_catalog_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingredient_image_catalog
    ADD CONSTRAINT ingredient_image_catalog_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.ai_asset(id);


--
-- Name: ingredient_image_catalog ingredient_image_catalog_source_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingredient_image_catalog
    ADD CONSTRAINT ingredient_image_catalog_source_job_id_fkey FOREIGN KEY (source_job_id) REFERENCES public.ai_job(id);


--
-- Name: media_backup_inventory media_backup_inventory_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_backup_inventory
    ADD CONSTRAINT media_backup_inventory_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.media_maintenance_run(id);


--
-- Name: media_backup_object media_backup_object_last_seen_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_backup_object
    ADD CONSTRAINT media_backup_object_last_seen_run_id_fkey FOREIGN KEY (last_seen_run_id) REFERENCES public.media_maintenance_run(id);


--
-- Name: media_delivery_variant media_delivery_variant_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_delivery_variant
    ADD CONSTRAINT media_delivery_variant_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.ai_asset(id);


--
-- Name: reader_feedback reader_feedback_recipe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_feedback
    ADD CONSTRAINT reader_feedback_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES public.editorial_recipe(id);


--
-- Name: trend_automation_takeover trend_automation_takeover_recipe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_automation_takeover
    ADD CONSTRAINT trend_automation_takeover_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES public.editorial_recipe(id);


--
-- Name: trend_automation_takeover trend_automation_takeover_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_automation_takeover
    ADD CONSTRAINT trend_automation_takeover_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.trend_run(id);


--
-- Name: trend_candidate trend_candidate_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_candidate
    ADD CONSTRAINT trend_candidate_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.trend_run(id);


--
-- Name: trend_publication_day trend_publication_day_publication_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_publication_day
    ADD CONSTRAINT trend_publication_day_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.editorial_publication(id);


--
-- Name: trend_publication_day trend_publication_day_recipe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_publication_day
    ADD CONSTRAINT trend_publication_day_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES public.editorial_recipe(id);


--
-- Name: trend_publication_day trend_publication_day_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_publication_day
    ADD CONSTRAINT trend_publication_day_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.trend_run(id);


--
-- Name: trend_run trend_run_recipe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_run
    ADD CONSTRAINT trend_run_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES public.editorial_recipe(id);


--
-- Name: ai_budget_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_budget_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_budget_settings_audit; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_budget_settings_audit ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_ingredient_verification; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_ingredient_verification ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_recipe_recovery; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_recipe_recovery ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_verified_ingredient_alias; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_verified_ingredient_alias ENABLE ROW LEVEL SECURITY;

--
-- Name: collection_asset; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.collection_asset ENABLE ROW LEVEL SECURITY;

--
-- Name: collection_discovery_event; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.collection_discovery_event ENABLE ROW LEVEL SECURITY;

--
-- Name: collection_theme_cost; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.collection_theme_cost ENABLE ROW LEVEL SECURITY;

--
-- Name: collection_theme_generation; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.collection_theme_generation ENABLE ROW LEVEL SECURITY;

--
-- Name: collection_theme_job; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.collection_theme_job ENABLE ROW LEVEL SECURITY;

--
-- Name: editorial_content_approval; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.editorial_content_approval ENABLE ROW LEVEL SECURITY;

--
-- Name: editorial_publication_plan; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.editorial_publication_plan ENABLE ROW LEVEL SECURITY;

--
-- Name: editorial_publication_plan_audit; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.editorial_publication_plan_audit ENABLE ROW LEVEL SECURITY;

--
-- Name: event_collection; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.event_collection ENABLE ROW LEVEL SECURITY;

--
-- Name: event_collection_publication; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.event_collection_publication ENABLE ROW LEVEL SECURITY;

--
-- Name: media_backup_inventory; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_backup_inventory ENABLE ROW LEVEL SECURITY;

--
-- Name: media_backup_object; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_backup_object ENABLE ROW LEVEL SECURITY;

--
-- Name: media_delivery_variant; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_delivery_variant ENABLE ROW LEVEL SECURITY;

--
-- Name: media_maintenance_run; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_maintenance_run ENABLE ROW LEVEL SECURITY;

--
-- Name: site_page; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.site_page ENABLE ROW LEVEL SECURITY;

--
-- Name: trend_automation_takeover; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.trend_automation_takeover ENABLE ROW LEVEL SECURITY;

--
-- Name: trend_publication_day; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.trend_publication_day ENABLE ROW LEVEL SECURITY;

--
-- Name: trend_setting_audit; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.trend_setting_audit ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict vRYBeW4AeLSIA6VtcqXiifaqZKJgh7gpHSotGiIcFnw1d2LxEzFUOeCjg17cxgU

