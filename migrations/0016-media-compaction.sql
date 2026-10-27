-- Append-only redirects preserve immutable asset records and all public media URLs.
CREATE TABLE media_compaction (
  source_pathname text PRIMARY KEY CHECK (source_pathname LIKE 'ai/%'),
  target_pathname text NOT NULL CHECK (target_pathname ~ '^ai/compact/v1/[a-f0-9]{64}\.webp$'),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  target_sha256 text NOT NULL CHECK (target_sha256 ~ '^[a-f0-9]{64}$'),
  pixel_sha256 text NOT NULL CHECK (pixel_sha256 ~ '^[a-f0-9]{64}$'),
  source_bytes integer NOT NULL CHECK (source_bytes > 0),
  target_bytes integer NOT NULL CHECK (target_bytes > 0 AND target_bytes <= source_bytes),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 3840),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 3840),
  verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER media_compaction_immutable BEFORE UPDATE OR DELETE ON media_compaction
  FOR EACH ROW EXECUTE FUNCTION editorial_reject_history_mutation();
