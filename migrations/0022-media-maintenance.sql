CREATE TABLE media_delivery_variant (
  cache_key text PRIMARY KEY CHECK (cache_key ~ '^[a-f0-9]{64}$'),
  asset_id text NOT NULL REFERENCES ai_asset(id),
  source_pathname text NOT NULL CHECK (source_pathname LIKE 'ai/%' AND length(source_pathname) <= 1000),
  kind text NOT NULL CHECK (kind IN ('hero','ingredient','step')),
  variant_key text NOT NULL CHECK (
    variant_key ~ '^responsive:(96|160|320|480|640|960|1280|1600)$'
    OR kind='hero' AND (variant_key='hero:full' OR variant_key ~ '^recipe:(1600x1200|1600x900|1200x1200|1200x630|1000x1500)$')
  ),
  renderer_version text NOT NULL CHECK (renderer_version='webp-delivery-v1'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','rendering','ready')),
  lease_token uuid,
  lease_until timestamptz,
  source_sha256 text CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_bytes integer CHECK (source_bytes BETWEEN 1 AND 33554432),
  blob_pathname text CHECK (blob_pathname ~ '^media-variants/webp-delivery-v1/[a-f0-9]{64}/(hero|ingredient|step)/[a-f0-9]{64}\.webp$'),
  content_sha256 text CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  byte_length integer CHECK (byte_length BETWEEN 1 AND 4194304),
  width integer CHECK (width BETWEEN 1 AND 3840),
  height integer CHECK (height BETWEEN 1 AND 3840),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  UNIQUE(asset_id,source_pathname,kind,variant_key,renderer_version),
  CHECK (width IS NULL OR height IS NULL OR width::bigint*height <= 8500000),
  CHECK (
    status='rendering' AND lease_token IS NOT NULL AND lease_until IS NOT NULL
    OR status IN ('pending','ready') AND lease_token IS NULL AND lease_until IS NULL
  ),
  CHECK (status<>'ready' OR (
    source_sha256 IS NOT NULL AND source_bytes IS NOT NULL AND blob_pathname IS NOT NULL
    AND content_sha256 IS NOT NULL AND byte_length IS NOT NULL AND width IS NOT NULL
    AND height IS NOT NULL AND verified_at IS NOT NULL
  ))
);
CREATE INDEX media_delivery_variant_work_idx ON media_delivery_variant(status,lease_until,updated_at);
ALTER TABLE media_delivery_variant ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON media_delivery_variant FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON media_delivery_variant FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON media_delivery_variant FROM authenticated;
  END IF;
END $$;

-- Durable daily snapshots and bounded, restartable media inventory.
CREATE TABLE media_maintenance_run (
 id text PRIMARY KEY,
 day date NOT NULL UNIQUE,
 generation integer NOT NULL DEFAULT 0 CHECK(generation>=0),
 phase text NOT NULL DEFAULT 'warm' CHECK(phase IN ('warm','snapshot','media','bundle','catalog','restore','finalize','retention','complete')),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','retry','complete')),
 workflow_run_id text,
 dispatch_claimed_at timestamptz,
 heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 next_retry_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 warm_cursor text,media_cursor text,bundle_cursor text,
 snapshot_receipt jsonb,restore_scope jsonb,restore_receipt jsonb,catalog_receipt jsonb,manifest_receipt jsonb,
 error_code text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 completed_at timestamptz,
 retired_at timestamptz,
 CHECK(status<>'complete' OR (completed_at IS NOT NULL AND manifest_receipt IS NOT NULL AND (restore_receipt->>'verified')='true'))
);
CREATE INDEX media_maintenance_recovery_idx ON media_maintenance_run(status,heartbeat_at,day);
CREATE TABLE media_backup_object (
 source_store_id text NOT NULL,source_path text NOT NULL,source_etag text NOT NULL,
 source_uploaded_at timestamptz NOT NULL,byte_length bigint NOT NULL CHECK(byte_length>=0),
 proof jsonb NOT NULL CHECK(proof->>'status'='complete'),
 last_seen_run_id text NOT NULL REFERENCES media_maintenance_run(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(source_store_id,source_path,source_etag)
);
CREATE TABLE media_backup_inventory (
 run_id text NOT NULL REFERENCES media_maintenance_run(id),source_store_id text NOT NULL,source_path text NOT NULL,
 metadata jsonb NOT NULL,
 PRIMARY KEY(run_id,source_store_id,source_path)
);
ALTER TABLE media_maintenance_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_backup_object ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_backup_inventory ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON media_maintenance_run,media_backup_object,media_backup_inventory FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON media_maintenance_run,media_backup_object,media_backup_inventory FROM anon; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON media_maintenance_run,media_backup_object,media_backup_inventory FROM authenticated; END IF;
END $$;
