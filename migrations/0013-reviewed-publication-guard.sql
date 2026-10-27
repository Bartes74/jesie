-- Preserve immutable historical automated snapshots while denying every new one.
-- Durable workflows from an older deployment must not bypass human review after rollout.
ALTER TABLE editorial_publication ADD CONSTRAINT editorial_publication_no_new_automated
  CHECK (approval_origin <> 'automated') NOT VALID;

-- Revoke only unpaid publication timer leases from the previous deployment.
-- Sleeping workers will observe a different generation; paid preparation runs are untouched.
UPDATE trend_publication_day SET workflow_id=NULL,generation=generation+1,updated_at=clock_timestamp()
  WHERE status='pending' AND workflow_id IS NOT NULL;
