import type { BackupBlobMetadata, MediaBackupProof } from '@/server/media-backup/types';

export const maintenancePhases = ['warm', 'snapshot', 'media', 'bundle', 'catalog', 'restore', 'finalize', 'retention', 'complete'] as const;
export type MaintenancePhase = typeof maintenancePhases[number];
export const staleMaintenanceMs = 20 * 60 * 1000;
export const backupReverificationMs = 7 * 24 * 60 * 60 * 1000;
// Historical prewarming is optional; daily data protection must take priority.
export const backgroundVariantBudget = 200;
export function backupCopyWaves<T extends {size:number}>(items:T[]):T[][] {
  const waves:T[][]=[];let current:T[]=[];let bytes=0;
  for(const item of items){
    if(!Number.isSafeInteger(item.size)||item.size<0)throw new Error('BACKUP_SOURCE_METADATA_INVALID');
    if(current.length&&(current.length>=4||bytes+item.size>64*1024*1024)){waves.push(current);current=[];bytes=0;}
    current.push(item);bytes+=item.size;
  }
  if(current.length)waves.push(current);
  return waves;
}

export function maintenanceDay(now = new Date()) { return now.toISOString().slice(0, 10); }
export function maintenanceErrorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^(?:BACKUP|MEDIA|ARCHIVE|BUNDLED)_[A-Z0-9_]{1,80}$/.test(code) ? code : 'MEDIA_MAINTENANCE_RETRY';
}
export function backupProofIsFresh(proof: { readbackVerifiedAt: string; restoreVerifiedAt: string }, now = Date.now()) {
  return [proof.readbackVerifiedAt, proof.restoreVerifiedAt].every(value => {
    const at = Date.parse(value); return Number.isFinite(at) && at <= now && now - at < backupReverificationMs;
  });
}

export function reusableBackupProof(proof:MediaBackupProof|null,blob:BackupBlobMetadata,destinationStoreId:string,keyId:string,now=Date.now()):proof is MediaBackupProof {
  return Boolean(proof&&proof.status==='complete'&&/^[a-f0-9]{64}$/.test(proof.sha256)&&/^[a-f0-9]{64}$/.test(proof.cipherSha256)
    &&proof.backupEtag&&proof.backupPath===`vault/v1/${keyId}/objects/sha256/${proof.sha256.slice(0,2)}/${proof.sha256}.aesgcm`
    &&proof.backupStoreId===destinationStoreId&&proof.keyId===keyId&&proof.sourcePath===blob.pathname
    &&(!blob.sourceStoreId||proof.sourceStoreId===blob.sourceStoreId)
    &&proof.sourceEtag===blob.etag&&proof.size===blob.size&&proof.sourceUploadedAt===blob.uploadedAt
    &&proof.sourceFile===blob.sourceFile&&JSON.stringify(proof.aliases??[])===JSON.stringify(blob.aliases??[])
    &&backupProofIsFresh(proof,now));
}
