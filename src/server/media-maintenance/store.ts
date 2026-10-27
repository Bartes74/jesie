import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { getDb } from '@/server/db';
import type { BackupBlobMetadata, MediaBackupProof } from '@/server/media-backup/types';
import { maintenanceDay, type MaintenancePhase } from './policy';

export const maintenancePool = () => getDb().$client as Pool;
export type MaintenanceRun = {
  id: string; day: string; generation: number; phase: MaintenancePhase; status: string;
  warm_cursor: string | null; media_cursor: string | null; bundle_cursor: string | null;
  snapshot_receipt: Record<string, unknown> | null; restore_scope: Record<string, unknown> | null;
  restore_receipt: Record<string, unknown> | null; catalog_receipt: Record<string, unknown> | null;
  manifest_receipt: Record<string, unknown> | null; workflow_run_id: string | null;
};
export async function getMaintenanceRun(id: string, generation: number): Promise<MaintenanceRun | null> {
  const result = await maintenancePool().query('SELECT *,day::text FROM media_maintenance_run WHERE id=$1 AND generation=$2', [id, generation]);
  return result.rows[0] ?? null;
}
/** Reserve before start(). An uncertain dispatch is retried only after the fenced lease expires. */
export async function reserveMaintenanceRun(now = new Date(), pool = maintenancePool()): Promise<MaintenanceRun | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('jesie-media-maintenance-dispatch'))");
    // A persistently failing old checkpoint must never suppress a new day's
    // snapshot. Once today's copy is complete, older interrupted work can resume.
    await client.query(`INSERT INTO media_maintenance_run(id,day) VALUES($1,$2) ON CONFLICT(day) DO NOTHING`, [randomUUID(), maintenanceDay(now)]);
    const run = (await client.query(`SELECT *,day::text FROM media_maintenance_run WHERE status<>'complete' ORDER BY media_maintenance_run.day DESC LIMIT 1 FOR UPDATE`)).rows[0];
    if (!run || run.status === 'complete') { await client.query('COMMIT'); return null; }
    const claimed = await client.query(`UPDATE media_maintenance_run SET generation=generation+1,status='queued',workflow_run_id=NULL,
      dispatch_claimed_at=clock_timestamp(),heartbeat_at=clock_timestamp(),error_code=NULL
      WHERE id=$1 AND (dispatch_claimed_at IS NULL OR heartbeat_at<clock_timestamp()-interval '20 minutes'
        OR status='retry' AND next_retry_at<=clock_timestamp()) RETURNING *,day::text`, [run.id]);
    await client.query('COMMIT'); return claimed.rows[0] ?? null;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function claimMaintenanceRun(id: string, generation: number, workflowId: string, pool = maintenancePool()) {
  const result = await pool.query(`UPDATE media_maintenance_run SET status='running',workflow_run_id=$3,heartbeat_at=clock_timestamp()
    WHERE id=$1 AND generation=$2 AND status<>'complete' AND (workflow_run_id IS NULL OR workflow_run_id=$3) RETURNING id`, [id,generation,workflowId]);
  return result.rowCount === 1;
}
export async function advanceMaintenance(id: string, generation: number, values: Partial<Pick<MaintenanceRun,
  'phase'|'warm_cursor'|'media_cursor'|'bundle_cursor'|'snapshot_receipt'|'restore_scope'|'restore_receipt'|'catalog_receipt'|'manifest_receipt'>>, pool = maintenancePool()) {
  const entries = Object.entries(values);
  const allowed = new Set(['phase','warm_cursor','media_cursor','bundle_cursor','snapshot_receipt','restore_scope','restore_receipt','catalog_receipt','manifest_receipt']);
  if(entries.some(([key])=>!allowed.has(key)))throw new Error('MEDIA_MAINTENANCE_FIELD_INVALID');
  const parameters: unknown[] = [id,generation];
  const assignments = entries.map(([key,value]) => { parameters.push(value); return `${key}=$${parameters.length}`; });
  const result = await pool.query(`UPDATE media_maintenance_run SET ${assignments.length ? assignments.join(',')+',' : ''}
    heartbeat_at=clock_timestamp(),status='running',error_code=NULL WHERE id=$1 AND generation=$2 AND status<>'complete' RETURNING id`, parameters);
  if (!result.rowCount) throw Object.assign(new Error('MEDIA_MAINTENANCE_FENCED'), {code:'MEDIA_MAINTENANCE_FENCED'});
}
export async function deferMaintenance(id: string, generation: number, code: string) {
  await maintenancePool().query(`UPDATE media_maintenance_run SET status='retry',error_code=$3,next_retry_at=clock_timestamp()+interval '30 minutes',heartbeat_at=clock_timestamp()
    WHERE id=$1 AND generation=$2 AND status<>'complete'`, [id,generation,code]);
}
export async function completeMaintenance(id: string, generation: number, retentionDeferred = false) {
  const result = await maintenancePool().query(`UPDATE media_maintenance_run SET status='complete',phase='complete',completed_at=clock_timestamp(),heartbeat_at=clock_timestamp(),error_code=$3
    WHERE id=$1 AND generation=$2 AND manifest_receipt IS NOT NULL AND (restore_receipt->>'verified')='true' RETURNING id`, [id,generation,retentionDeferred?'BACKUP_RETENTION_DEFERRED':null]);
  if (!result.rowCount) throw Object.assign(new Error('BACKUP_RESTORE_REQUIRED'), {code:'BACKUP_RESTORE_REQUIRED'});
  await maintenancePool().query('DELETE FROM media_backup_inventory WHERE run_id=$1',[id]);
}
export async function recordBackupProof(id: string, generation: number, metadata: BackupBlobMetadata, proof: MediaBackupProof) {
  const client = await maintenancePool().connect();
  try {
    await client.query('BEGIN');
    const fence = await client.query('SELECT id FROM media_maintenance_run WHERE id=$1 AND generation=$2 AND status<>\'complete\' FOR UPDATE',[id,generation]);
    if (!fence.rowCount) throw Object.assign(new Error('MEDIA_MAINTENANCE_FENCED'),{code:'MEDIA_MAINTENANCE_FENCED'});
    await client.query(`INSERT INTO media_backup_object(source_store_id,source_path,source_etag,source_uploaded_at,byte_length,proof,last_seen_run_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(source_store_id,source_path,source_etag) DO UPDATE SET proof=EXCLUDED.proof,last_seen_run_id=EXCLUDED.last_seen_run_id,updated_at=clock_timestamp()`,
      [proof.sourceStoreId,proof.sourcePath,proof.sourceEtag,proof.sourceUploadedAt,proof.size,proof,id]);
    await client.query(`INSERT INTO media_backup_inventory(run_id,source_store_id,source_path,metadata) VALUES($1,$2,$3,$4)
      ON CONFLICT(run_id,source_store_id,source_path) DO UPDATE SET metadata=EXCLUDED.metadata`,[id,proof.sourceStoreId,metadata.pathname,metadata]);
    await client.query('UPDATE media_maintenance_run SET heartbeat_at=clock_timestamp() WHERE id=$1 AND generation=$2',[id,generation]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function storedBackupProof(storeId: string, blob: BackupBlobMetadata): Promise<MediaBackupProof | null> {
  const result = await maintenancePool().query('SELECT proof FROM media_backup_object WHERE source_store_id=$1 AND source_path=$2 AND source_etag=$3',[storeId,blob.pathname,blob.etag]);
  const proof = result.rows[0]?.proof as MediaBackupProof | undefined;
  return proof && proof.size===blob.size && proof.sourceUploadedAt===blob.uploadedAt ? proof : null;
}
