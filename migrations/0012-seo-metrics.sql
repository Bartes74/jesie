-- Anonymous counters only: never create visit rows, cookies or visitor identifiers.
CREATE TABLE seo_usage_daily (
  day date NOT NULL,
  event text NOT NULL CHECK (event IN ('page_view','servings_change','recipe_save','cooking_step','ingredient_check','print_recipe')),
  path text NOT NULL CHECK (length(path)<=500 AND path ~ '^/(pl|en)(/o-serwisie|/(recipes|kolekcje|poradniki)/[a-z0-9]+(-[a-z0-9]+)*)?$'),
  source text NOT NULL CHECK (source IN ('direct','google','bing','pinterest','chatgpt','perplexity','claude','other')),
  count bigint NOT NULL DEFAULT 1 CHECK (count > 0),
  PRIMARY KEY(day,event,path,source),
  CHECK (event='page_view' OR path ~ '^/(pl|en)/recipes/')
);
COMMENT ON TABLE seo_usage_daily IS 'Europe/Warsaw calendar aggregates; no raw referrers, queries, IP addresses, cookies or user identifiers.';
