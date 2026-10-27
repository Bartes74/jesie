import 'server-only';
import type { BackupBlobMetadata,BackupEncryption,PrivateBackupBlobStore } from '@/server/media-backup/types';
import { copyMediaBackupObject } from '@/server/media-backup/objects';
import { backupCopyWaves,reusableBackupProof } from './policy';
import { recordBackupProof,storedBackupProof } from './store';

/** Up to four streams / 64MiB of source bytes; every successful sibling persists. */
export async function copyMaintenancePage(options:{id:string;generation:number;blobs:BackupBlobMetadata[];source:PrivateBackupBlobStore;destination:PrivateBackupBlobStore;encryption:BackupEncryption;maximumObjectBytes:number}) {
  for(const wave of backupCopyWaves(options.blobs)) {
    const settled=await Promise.allSettled(wave.map(async blob=>{
      const existing=await storedBackupProof(options.source.storeId,blob);
      const proof=reusableBackupProof(existing,blob,options.destination.storeId,options.encryption.keyId)?existing:await copyMediaBackupObject(blob,options);
      await recordBackupProof(options.id,options.generation,blob,proof);
    }));
    const failed=settled.find(result=>result.status==='rejected');
    if(failed?.status==='rejected')throw failed.reason;
  }
}
