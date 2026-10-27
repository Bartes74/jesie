-- Add only aggregate event dimensions. No visitor or session identifiers.
ALTER TABLE seo_usage_daily DROP CONSTRAINT IF EXISTS seo_usage_daily_event_check;
ALTER TABLE seo_usage_daily DROP CONSTRAINT IF EXISTS seo_usage_daily_path_check;
ALTER TABLE seo_usage_daily DROP CONSTRAINT IF EXISTS seo_usage_daily_check;
ALTER TABLE seo_usage_daily ADD CONSTRAINT seo_usage_daily_event_check CHECK (event IN ('page_view','servings_change','recipe_save','cooking_step','cooking_step_undo','ingredient_check','ingredient_uncheck','print_recipe','cooking_start','cooking_complete','repeat_cook','shopping_copy','plan_add','plan_remove','pantry_use','search','no_results','feedback_submit'));
ALTER TABLE seo_usage_daily ADD CONSTRAINT seo_usage_daily_path_check CHECK (length(path)<=500 AND path ~ '^/(pl|en)(/o-serwisie|/(kolekcje|poradniki)|/(recipes|kolekcje|poradniki)/[a-z0-9]+(-[a-z0-9]+)*)?$');
ALTER TABLE seo_usage_daily ADD CONSTRAINT seo_usage_daily_check CHECK (event='page_view' OR path ~ '^/(pl|en)/recipes/' OR (event IN ('pantry_use','search','no_results','shopping_copy','plan_remove') AND path IN ('/pl','/en')));

CREATE TABLE reader_feedback (
  id uuid PRIMARY KEY,
  request_key uuid NOT NULL UNIQUE,
  recipe_id text NOT NULL REFERENCES editorial_recipe(id),
  publication_revision integer NOT NULL CHECK(publication_revision > 0),
  kind text NOT NULL CHECK(kind IN ('success','changed','problem')),
  step_id text CHECK(length(step_id)<=200),
  message text NOT NULL DEFAULT '' CHECK(length(message)<=1500),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by text
);
CREATE INDEX reader_feedback_status_created_idx ON reader_feedback(status,created_at DESC);
COMMENT ON TABLE reader_feedback IS 'Voluntary recipe feedback; no email, IP, device, visitor or cooking-session identifiers. request_key deduplicates a single form submission.';
