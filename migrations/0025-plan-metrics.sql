-- Preserve all existing anonymous metric dimensions and allow the public plan page.
ALTER TABLE seo_usage_daily DROP CONSTRAINT seo_usage_daily_path_check;
ALTER TABLE seo_usage_daily DROP CONSTRAINT seo_usage_daily_check;
ALTER TABLE seo_usage_daily ADD CONSTRAINT seo_usage_daily_path_check CHECK (length(path)<=500 AND path ~ '^/(pl|en)(/(o-serwisie|plan)|/(kolekcje|poradniki)|/(recipes|kolekcje|poradniki)/[a-z0-9]+(-[a-z0-9]+)*)?$');
ALTER TABLE seo_usage_daily ADD CONSTRAINT seo_usage_daily_check CHECK (event='page_view' OR path ~ '^/(pl|en)/recipes/' OR (event IN ('pantry_use','search','no_results','shopping_copy','plan_remove') AND path IN ('/pl','/en','/pl/plan','/en/plan')));
