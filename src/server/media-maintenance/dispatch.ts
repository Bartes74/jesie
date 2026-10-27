import 'server-only';
import { start } from 'workflow/api';
import { mediaMaintenance } from '@/workflows/media-maintenance';
import { cloudBackupConfiguration } from '@/server/media-backup/config';
import { maintenancePool, reserveMaintenanceRun } from './store';

export async function dispatchMediaMaintenance() {
  if (!cloudBackupConfiguration()) return {enabled:false,dispatched:false};
  const run=await reserveMaintenanceRun();
  if (!run) return {enabled:true,dispatched:false};
  // start() is not atomic with the DB. A 20-minute fenced dispatch lease makes
  // a lost response recoverable without allowing two workers to claim the row.
  const dispatched=await start(mediaMaintenance,[run.id,run.generation],{region:'fra1'});
  await maintenancePool().query(`UPDATE media_maintenance_run SET workflow_run_id=$3
    WHERE id=$1 AND generation=$2 AND workflow_run_id IS NULL`,[run.id,run.generation,dispatched.runId]);
  return {enabled:true,dispatched:true,id:run.id,generation:run.generation};
}
