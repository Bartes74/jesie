-- CHECK must reject NULL as well as false: an absent receipt is not a restore.
ALTER TABLE media_maintenance_run ADD CONSTRAINT media_maintenance_verified_restore
 CHECK(status<>'complete' OR (
   restore_receipt IS NOT NULL
   AND (restore_receipt->>'verified') IS NOT DISTINCT FROM 'true'
   AND (restore_receipt->>'cleanupConfirmed') IS NOT DISTINCT FROM 'true'
 ));
ALTER TABLE media_backup_object ADD CONSTRAINT media_backup_object_complete_proof
 CHECK((proof->>'status') IS NOT DISTINCT FROM 'complete');
