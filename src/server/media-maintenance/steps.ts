import { getMaintenanceRun, claimMaintenanceRun, advanceMaintenance, deferMaintenance, maintenancePool } from './store';
import { backgroundVariantBudget,maintenanceErrorCode } from './policy';
import { cloudBackupConfiguration } from '@/server/media-backup/config';
import { createPrivateBackupBlobStore } from '@/server/media-backup/blob';
import { copyMaintenancePage } from './copy-page';
import { listPendingMediaDeliveryVariants, warmMediaDeliveryVariants } from '@/server/media/delivery-variant-store';

export async function claimMediaMaintenanceStep(id: string,generation: number,workflowId: string) {
  'use step';
  try { return await claimMaintenanceRun(id,generation,workflowId); }
  catch { throw new Error('MEDIA_MAINTENANCE_CLAIM_RETRY'); }
}

/** Every result is a small public-to-the-workflow DTO, never a DB snapshot or key. */
export async function advanceMediaMaintenanceStep(id: string,generation: number) {
  'use step';
  try {
    const config=cloudBackupConfiguration();
    if (!config) return {state:'disabled' as const};
    const run=await getMaintenanceRun(id,generation);
    if (!run || run.status==='complete') return {state:'done' as const};
    await advanceMaintenance(id,generation,{});
    if (run.phase==='warm') {
      const prepared=await maintenancePool().query(`SELECT count(*)::int AS count FROM media_delivery_variant v
        JOIN media_maintenance_run r ON r.id=$1 AND r.generation=$2
        WHERE v.status='ready' AND v.verified_at>=r.created_at`,[id,generation]);
      if(Number(prepared.rows[0]?.count??0)>=backgroundVariantBudget){
        await advanceMaintenance(id,generation,{phase:'snapshot',warm_cursor:null});
        return {state:'continue' as const,phase:'warm',backgroundBudgetReached:true};
      }
      const page=await listPendingMediaDeliveryVariants({...(run.warm_cursor?{afterAssetId:run.warm_cursor}:{}),limit:2});
      // Bound Sharp/Blob concurrency while sharing each already saved result.
      const results=await warmMediaDeliveryVariants(page.inputs);
      const deferred=results.filter(result=>result.status==='busy'||result.status==='unavailable').length;
      // A derivative can be rebuilt on demand or in the next daily pass. Its
      // temporary renderer failure must never suppress the database backup.
      await advanceMaintenance(id,generation,page.nextAssetId?{warm_cursor:page.nextAssetId}:{phase:'snapshot',warm_cursor:null});
      return {state:'continue' as const,phase:'warm',processed:page.inputs.length,deferred};
    }
    if (run.phase==='media') {
      const source=createPrivateBackupBlobStore(config.source),destination=createPrivateBackupBlobStore(config.destination);
      const page=await source.list(run.media_cursor??undefined,12);
      await copyMaintenancePage({id,generation,blobs:page.blobs,source,destination,encryption:config.encryption,maximumObjectBytes:config.maximumObjectBytes});
      await advanceMaintenance(id,generation,page.hasMore?{media_cursor:page.cursor!}:{phase:'bundle',media_cursor:null});
      return {state:'continue' as const,phase:'media',processed:page.blobs.length};
    }
    // Heavy backup/restore and archive modules stay outside the workflow sandbox.
    const { advanceBackupPhase }=await import('./backup-phases');
    return await advanceBackupPhase(run);
  } catch(error) {
    const code=maintenanceErrorCode(error);
    // The next hourly trigger resumes this phase. A stale worker cannot advance
    // the replacement generation, even if an old storage response arrives late.
    await deferMaintenance(id,generation,code).catch(()=>{});
    throw new Error(code);
  }
}

export async function stopMediaMaintenanceStep(id: string,generation: number) {
  'use step';
  await deferMaintenance(id,generation,'MEDIA_MAINTENANCE_RETRY');
}

export async function maintenanceHeartbeatStep(id: string,generation: number) {
  'use step';
  return (await maintenancePool().query('SELECT status FROM media_maintenance_run WHERE id=$1 AND generation=$2',[id,generation])).rows[0]?.status ?? 'fenced';
}
