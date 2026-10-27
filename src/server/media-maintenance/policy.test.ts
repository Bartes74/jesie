import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backupCopyWaves,backupProofIsFresh, maintenanceDay, maintenanceErrorCode,reusableBackupProof } from './policy';
import type { MediaBackupProof } from '@/server/media-backup/types';

test('UTC maintenance identity stays the same across a DST transition',()=>{
  assert.equal(maintenanceDay(new Date('2026-10-25T00:30:00Z')),maintenanceDay(new Date('2026-10-25T02:30:00Z')));
  assert.notEqual(maintenanceDay(new Date('2026-10-24T23:59:00Z')),maintenanceDay(new Date('2026-10-25T00:00:00Z')));
});
test('weekly media proof reuse requires both exact-byte restore and readback in the past',()=>{
  const now=Date.parse('2026-10-17T00:00:00Z');
  const fresh='2026-10-16T00:00:00Z';
  assert.equal(backupProofIsFresh({readbackVerifiedAt:fresh,restoreVerifiedAt:fresh},now),true);
  for(const invalid of ['invalid','2026-10-18T00:00:00Z','2026-10-09T00:00:00Z']) {
    assert.equal(backupProofIsFresh({readbackVerifiedAt:invalid,restoreVerifiedAt:fresh},now),false);
    assert.equal(backupProofIsFresh({readbackVerifiedAt:fresh,restoreVerifiedAt:invalid},now),false);
  }
});
test('driver errors, SQL and credentials cannot enter durable error records',()=>{
  assert.equal(maintenanceErrorCode(new Error('postgresql://secret@host')), 'MEDIA_MAINTENANCE_RETRY');
  assert.equal(maintenanceErrorCode({code:'23505',message:'secret SQL'}), 'MEDIA_MAINTENANCE_RETRY');
  assert.equal(maintenanceErrorCode({code:'BACKUP_STORAGE_UNAVAILABLE'}), 'BACKUP_STORAGE_UNAVAILABLE');
  assert.equal(maintenanceErrorCode({code:'BACKUP_SECRET\npostgresql://secret'}), 'MEDIA_MAINTENANCE_RETRY');
});
test('proof reuse cannot cross a key/store rotation or retain aliases from a different bundle',()=>{
  const at='2026-10-16T00:00:00Z',sha='a'.repeat(64);
  const blob={pathname:'app-private/published-recovery/source.webp',size:10,etag:'"source"',uploadedAt:'1970-01-01T00:00:00.000Z',sourceStoreId:'applicationbundle',sourceFile:'private-media/published-recovery/source.webp',aliases:['ai/job/master.webp']};
  const proof:MediaBackupProof={sourceStoreId:'applicationbundle',sourcePath:blob.pathname,sourceEtag:blob.etag,sourceUploadedAt:blob.uploadedAt,size:10,sha256:sha,
    backupStoreId:'backupstore',backupPath:`vault/v1/key-v1/objects/sha256/aa/${sha}.aesgcm`,backupEtag:'"backup"',keyId:'key-v1',cipherSha256:'b'.repeat(64),cipherBytes:100,
    readbackVerifiedAt:at,restoreVerifiedAt:at,status:'complete',sourceFile:blob.sourceFile,aliases:blob.aliases};
  const now=Date.parse('2026-10-17T00:00:00Z');
  assert.equal(reusableBackupProof(proof,blob,'backupstore','key-v1',now),true);
  assert.equal(reusableBackupProof(proof,blob,'differentstore','key-v1',now),false);
  assert.equal(reusableBackupProof(proof,blob,'backupstore','key-v2',now),false);
  assert.equal(reusableBackupProof(proof,{...blob,aliases:['ai/other/master.webp']},'backupstore','key-v1',now),false);
  assert.equal(reusableBackupProof({...proof,sha256:'invalid'},blob,'backupstore','key-v1',now),false);
});
test('copy waves bound both concurrency and aggregate memory for large media',()=>{
  const small=Array.from({length:10},(_,index)=>({index,size:1024}));
  assert.deepEqual(backupCopyWaves(small).map(wave=>wave.length),[4,4,2]);
  const large=[{size:40*1024*1024},{size:40*1024*1024},{size:20*1024*1024},{size:10*1024*1024}];
  assert.deepEqual(backupCopyWaves(large).map(wave=>wave.length),[1,2,1]);
  assert.deepEqual(backupCopyWaves([{size:100*1024*1024},{size:1}]).map(wave=>wave.length),[1,1]);
  assert.throws(()=>backupCopyWaves([{size:-1}]));
});
