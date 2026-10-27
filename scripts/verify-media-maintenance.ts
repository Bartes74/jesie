import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { closeDb } from '../src/server/db';
import { snapshotBackup,newRestoreScope,verifyRestore } from '../src/server/media-backup/service';
import { reserveMaintenanceRun,claimMaintenanceRun,advanceMaintenance,maintenancePool } from '../src/server/media-maintenance/store';
import { maintenanceErrorCode } from '../src/server/media-maintenance/policy';

async function main(){
  if(!process.argv[2])throw new Error('EXPLICIT_BACKUP_ENV_REQUIRED');
  config({path:process.argv[2],quiet:true,override:true});
  const run=await reserveMaintenanceRun();
  if(!run)throw new Error('MEDIA_MAINTENANCE_ALREADY_RUNNING');
  const owner=`bootstrap-${randomUUID()}`;
  if(!await claimMaintenanceRun(run.id,run.generation,owner))throw new Error('MEDIA_MAINTENANCE_CLAIM_FAILED');
  try{
    const receipt=await snapshotBackup(run.id);
    await advanceMaintenance(run.id,run.generation,{snapshot_receipt:receipt});
    const scope=newRestoreScope(run.id);
    await advanceMaintenance(run.id,run.generation,{restore_scope:scope});
    const restore=await verifyRestore(run.id,scope);
    await advanceMaintenance(run.id,run.generation,{restore_receipt:restore});
    console.log(JSON.stringify({ok:restore.verified&&restore.cleanupConfirmed,id:run.id,day:run.day,snapshot:receipt,restore}));
    if(!restore.verified||!restore.cleanupConfirmed)process.exitCode=1;
  }finally{
    // Only this explicitly claimed bootstrap owner is released for the actual
    // cloud workflow. No other running worker can be unlocked by this script.
    await maintenancePool().query(`UPDATE media_maintenance_run SET workflow_run_id=NULL,dispatch_claimed_at=NULL,status='queued'
      WHERE id=$1 AND generation=$2 AND workflow_run_id=$3`,[run.id,run.generation,owner]);
  }
}
main().catch(error=>{console.error(JSON.stringify({ok:false,code:maintenanceErrorCode(error)}));process.exitCode=1;}).finally(closeDb);
