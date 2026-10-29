-- Decorative accent cut-outs extend a collection's artwork beyond the hero and background.
ALTER TABLE collection_theme_generation DROP CONSTRAINT collection_theme_generation_part_check,
  ADD CONSTRAINT collection_theme_generation_part_check CHECK(part IN ('all','hero','background','accents'));
ALTER TABLE collection_theme_job DROP CONSTRAINT collection_theme_job_kind_check,
  ADD CONSTRAINT collection_theme_job_kind_check CHECK(kind IN ('spec','hero','atmosphere','corner','garland','spot'));
ALTER TABLE collection_asset DROP CONSTRAINT collection_asset_kind_check,
  ADD CONSTRAINT collection_asset_kind_check CHECK(kind IN ('inspiration','hero','atmosphere','corner','garland','spot'));
