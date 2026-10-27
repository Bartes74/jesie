import 'server-only';
import { gzipSync, gunzipSync } from 'node:zlib';
import { del, get } from '@vercel/blob';
import { cloudBackupConfiguration } from '@/server/media-backup/config';
import { createPrivateBackupBlobStore } from '@/server/media-backup/blob';
import { readEncryptedBackup, saveEncryptedBackup } from '@/server/media-backup/objects';
import { backupInventoryDigest } from '@/server/media-backup/manifest';
import { snapshotBackup, newRestoreScope, verifyRestore, finalizeBackup, type DatabaseRestoreReceipt, type RestoreScope } from '@/server/media-backup/service';
import type { BackupBlobMetadata, MediaBackupProof, EncryptedBackupProof } from '@/server/media-backup/types';
import { createBundledMediaSource, readBundledRecoveryRegistry } from '@/server/media-archive/bundled';
import { copyMaintenancePage } from './copy-page';
import { buildArchiveCatalog, loadArchiveReferenceSnapshot } from '@/server/media-archive/reference-graph';
import { planSnapshotRetention, type RetainedSnapshot } from '@/server/media-archive/snapshot-retention';
import { advanceMaintenance, completeMaintenance, maintenancePool, type MaintenanceRun } from './store';

const retry=(code:string):never=>{throw Object.assign(new Error(code),{code});};
async function runInventory(runId: string) {
  const result=await maintenancePool().query(`SELECT i.source_store_id,i.metadata,o.proof FROM media_backup_inventory i LEFT JOIN media_backup_object o
    ON o.source_store_id=i.source_store_id AND o.source_path=i.source_path AND o.source_etag=i.metadata->>'etag'
    WHERE i.run_id=$1 ORDER BY i.source_store_id,i.source_path`,[runId]);
  if(result.rows.some(row=>!row.proof))retry('BACKUP_INVENTORY_COPY_INCOMPLETE');
  return {inventory:result.rows.map(row=>({...row.metadata,sourceStoreId:row.source_store_id})) as BackupBlobMetadata[],proofs:result.rows.map(row=>row.proof) as MediaBackupProof[]};
}

/** Only superseded checkpoint files can reach this boundary; media never can. */
async function expireSupersededCheckpoints(current: MaintenanceRun) {
  const config=cloudBackupConfiguration();if(!config)return;
  const rows=(await maintenancePool().query(`SELECT *,day::text FROM media_maintenance_run
    WHERE retired_at IS NULL AND (status='complete' OR id=$1) ORDER BY media_maintenance_run.day DESC`,[current.id])).rows;
  const points:RetainedSnapshot[]=rows.map(row=>({id:row.id,kind:'database',createdAt:row.snapshot_receipt?.capturedAt??row.created_at.toISOString(),
    status:row.manifest_receipt&&row.restore_receipt?.verified?'complete':'pending',integrityVerified:row.snapshot_receipt?.integrityVerified===true,
    readbackVerifiedAt:row.manifest_receipt?.manifest?.readbackVerifiedAt??null,restoreVerified:row.restore_receipt?.verified===true&&row.restore_receipt?.cleanupConfirmed===true,
    restoreVerifiedAt:row.restore_receipt?.verifiedAt??null}));
  // Process a bounded number. Subsequent daily runs continue the same policy.
  for(const decision of planSnapshotRetention(points).filter(point=>point.disposition==='superseded').slice(0,1)) {
    const row=rows.find(item=>item.id===decision.id)!;
    if(row.id===current.id)retry('BACKUP_RETENTION_CURRENT_FORBIDDEN');
    const prefix=`vault/v1/${config.encryption.keyId}/checkpoints/${row.id}/`;
    const receipts=[row.snapshot_receipt?.database,row.snapshot_receipt?.schema,row.catalog_receipt,row.manifest_receipt?.manifest] as EncryptedBackupProof[];
    // Rotation keeps the previous key/store's restore points. Only checkpoints
    // owned by the currently configured namespace are eligible for deletion.
    if(receipts.some(proof=>proof?.keyId!==config.encryption.keyId||proof?.backupStoreId!==config.destination.storeId))continue;
    if(receipts.some(proof=>!proof||proof.backupStoreId!==config.destination.storeId||!proof.backupPath.startsWith(prefix)||!proof.backupEtag))retry('BACKUP_RETENTION_SCOPE_INVALID');
    for(const receipt of receipts) {
      await advanceMaintenance(current.id,current.generation,{});
      const live=await get(receipt.backupPath,{access:'private',token:config.destination.token,storeId:config.destination.storeId,useCache:false,abortSignal:AbortSignal.timeout(10_000)});
      if(!live)continue;
      await live.stream?.cancel();
      if(live.statusCode!==200||live.blob.etag!==receipt.backupEtag)retry('BACKUP_RETENTION_ETAG_CHANGED');
      await advanceMaintenance(current.id,current.generation,{});
      try{await del(receipt.backupPath,{token:config.destination.token,storeId:config.destination.storeId,ifMatch:receipt.backupEtag,abortSignal:AbortSignal.timeout(10_000)});}
      catch{ /* Reconcile an accepted DELETE whose response was lost. */ }
      const after=await get(receipt.backupPath,{access:'private',token:config.destination.token,storeId:config.destination.storeId,useCache:false,abortSignal:AbortSignal.timeout(10_000)});
      if(after){await after.stream?.cancel();retry('BACKUP_RETENTION_DELETE_UNCONFIRMED');}
    }
    await maintenancePool().query("UPDATE media_maintenance_run SET retired_at=clock_timestamp() WHERE id=$1 AND status='complete'",[row.id]);
  }
}

export async function advanceBackupPhase(run: MaintenanceRun) {
  const {id,generation}=run;
  const config=cloudBackupConfiguration();if(!config)return {state:'disabled' as const};
  if(run.phase==='snapshot') {
    const receipt=await snapshotBackup(id);
    await advanceMaintenance(id,generation,{snapshot_receipt:receipt,phase:'media'});
    return {state:'continue' as const,phase:'snapshot',tables:receipt.tableCount};
  }
  if(run.phase==='bundle') {
    const source=createBundledMediaSource(),destination=createPrivateBackupBlobStore(config.destination);
    let page;
    try{page=await source.list(run.bundle_cursor??undefined,5);}
    catch(error){
      if((error as {code?:string})?.code!=='BUNDLED_BACKUP_CURSOR_INVALID_OR_DEPLOYMENT_CHANGED')throw error;
      const client=await maintenancePool().connect();
      try{
        await client.query('BEGIN');
        const fence=await client.query("SELECT id FROM media_maintenance_run WHERE id=$1 AND generation=$2 AND phase='bundle' FOR UPDATE",[id,generation]);
        if(!fence.rowCount)retry('MEDIA_MAINTENANCE_FENCED');
        await client.query("DELETE FROM media_backup_inventory WHERE run_id=$1 AND source_store_id='applicationbundle'",[id]);
        await client.query('UPDATE media_maintenance_run SET bundle_cursor=NULL,heartbeat_at=clock_timestamp() WHERE id=$1 AND generation=$2',[id,generation]);
        await client.query('COMMIT');
      }catch(resetError){await client.query('ROLLBACK');throw resetError;}finally{client.release();}
      return {state:'continue' as const,phase:'bundle',restarted:true};
    }
    await copyMaintenancePage({id,generation,blobs:page.blobs,source,destination,encryption:config.encryption,maximumObjectBytes:32*1024*1024});
    await advanceMaintenance(id,generation,page.hasMore?{bundle_cursor:page.cursor!}:{phase:'catalog',bundle_cursor:null});
    return {state:'continue' as const,phase:'bundle',processed:page.blobs.length};
  }
  if(run.phase==='catalog') {
    if(!run.catalog_receipt) {
      const {inventory,proofs}=await runInventory(id);
      const pathname=`vault/v1/${config.encryption.keyId}/checkpoints/${id}/catalog-${backupInventoryDigest(inventory)}.json.gz.aesgcm`;
      const destination=createPrivateBackupBlobStore(config.destination);
      const existing=await readEncryptedBackup({pathname,context:`checkpoint/${id}/catalog`,maximumBytes:64*1024*1024,destination,encryption:config.encryption});
      if(existing){
        const previous=JSON.parse(gunzipSync(existing.plaintext,{maxOutputLength:128*1024*1024}).toString('utf8'));
        if(previous.format!=='jesie-archive-catalog-v1'||previous.runId!==id||!previous.catalog?.complete)retry('ARCHIVE_CATALOG_SCOPE_INVALID');
        await advanceMaintenance(id,generation,{catalog_receipt:existing.proof,phase:'restore'});
        return {state:'continue' as const,phase:'catalog'};
      }
      const registry=await readBundledRecoveryRegistry();
      const client=await maintenancePool().connect();
      let snapshot;
      try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');snapshot=await loadArchiveReferenceSnapshot(statement=>client.query(statement),registry);}
      finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
      const catalog=buildArchiveCatalog(config.source.storeId,inventory.filter(item=>!item.sourceStoreId||item.sourceStoreId===config.source.storeId),snapshot);
      if(!catalog.complete)retry('ARCHIVE_REFERENCE_SNAPSHOT_INCOMPLETE');
      const plaintext=gzipSync(Buffer.from(JSON.stringify({format:'jesie-archive-catalog-v1',runId:id,catalog,bundled:inventory.filter(item=>item.sourceStoreId==='applicationbundle'),proofs})),{level:6});
      const proof=await saveEncryptedBackup({pathname,context:`checkpoint/${id}/catalog`,plaintext,destination,encryption:config.encryption});
      await advanceMaintenance(id,generation,{catalog_receipt:proof,phase:'restore'});
    }else await advanceMaintenance(id,generation,{phase:'restore'});
    return {state:'continue' as const,phase:'catalog'};
  }
  if(run.phase==='restore') {
    if(run.restore_receipt?.verified===true&&run.restore_receipt?.cleanupConfirmed===true&&run.restore_receipt.runId===id){
      await advanceMaintenance(id,generation,{phase:'finalize'});
      return {state:'continue' as const,phase:'restore',verified:true};
    }
    if(!run.restore_scope) {
      await advanceMaintenance(id,generation,{restore_scope:newRestoreScope(id)});
      return {state:'continue' as const,phase:'restore'};
    }
    const restored=await verifyRestore(id,run.restore_scope as RestoreScope);
    const retainedTargets=Array.isArray(run.restore_receipt?.retainedTargets)?run.restore_receipt.retainedTargets:[];
    const receipt={...restored,...(retainedTargets.length?{retainedTargets}:{})};
    if(!restored.verified&&restored.code==='BACKUP_RESTORE_OWNERSHIP_UNCONFIRMED'&&retainedTargets.length<16){
      // A process can die between CREATE DATABASE and its ownership marker.
      // Preserve an unconfirmed target, record it, and verify in a fresh scope.
      // It can never authorize a DROP or block every subsequent backup attempt.
      await advanceMaintenance(id,generation,{restore_receipt:{...receipt,retainedTargets:[...retainedTargets,{databaseName:restored.targetDatabase,reason:restored.code}]},restore_scope:newRestoreScope(id)});
      return {state:'continue' as const,phase:'restore',newScope:true};
    }
    await advanceMaintenance(id,generation,{restore_receipt:receipt});
    if(!restored.verified||!restored.cleanupConfirmed)retry(restored.code??'BACKUP_RESTORE_NOT_VERIFIED');
    await advanceMaintenance(id,generation,{phase:'finalize'});
    return {state:'continue' as const,phase:'restore',verified:true};
  }
  if(run.phase==='finalize') {
    const {inventory,proofs}=await runInventory(id);
    const receipt=await finalizeBackup(id,inventory,proofs,run.restore_receipt as DatabaseRestoreReceipt,run.catalog_receipt as EncryptedBackupProof);
    await advanceMaintenance(id,generation,{manifest_receipt:receipt,phase:'retention'});
    return {state:'continue' as const,phase:'finalize',objects:receipt.objects};
  }
  if(run.phase==='retention') {
    let retentionDeferred=false;
    try{await expireSupersededCheckpoints(run);}
    catch{retentionDeferred=true;console.info('BACKUP_RETENTION_DEFERRED');}
    // Cleanup failure retains extra copies; it does not invalidate a newly
    // restored, complete backup. The following daily pass retries retention.
    await completeMaintenance(id,generation,retentionDeferred);
    return {state:'done' as const};
  }
  return {state:'done' as const};
}
