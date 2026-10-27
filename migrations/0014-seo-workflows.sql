-- Per-event durable discovery workers replace frequent cron, including on Hobby.
ALTER TABLE editorial_outbox ADD COLUMN discovery_workflow_id text;
ALTER TABLE editorial_outbox ADD COLUMN discovery_generation integer NOT NULL DEFAULT 1 CHECK(discovery_generation>0);
ALTER TABLE editorial_outbox ADD COLUMN discovery_dispatch_token text;
ALTER TABLE editorial_outbox ADD COLUMN discovery_dispatch_expires_at timestamptz;
