import assert from 'node:assert/strict';
import test from 'node:test';
import type { MediaBackupProof } from '@/server/media-backup/types';
import { buildArchiveCatalog, referenceScopes, type ArchiveCatalog, type ArchiveReferenceSnapshot } from './reference-graph';
import { mediaArchiveQuarantineMs, planArchiveGc, type ArchiveQuarantine } from './retention-policy';

const now = Date.parse('2026-10-17T00:00:00.000Z'), at = new Date(now).toISOString();
const uploadedAt = '2026-08-01T00:00:00.000Z';
const pathname = 'seo/delivery/12345678-abcd-abcd-abcd-123456789012/v1.webp';
function fixture() {
  const snapshot: ArchiveReferenceSnapshot = { capturedAt: at, coverage: Object.fromEntries(referenceScopes.map(scope => [scope, true])) as ArchiveReferenceSnapshot['coverage'], assets: [], jobs: [], documents: [], compactions: [] };
  const catalog = buildArchiveCatalog('primary123', [{ pathname, size: 42, etag: '"source"', uploadedAt }], snapshot);
  const proof: MediaBackupProof = { sourceStoreId: 'primary123', sourcePath: pathname, sourceEtag: '"source"', sourceUploadedAt: uploadedAt, size: 42, sha256: 'a'.repeat(64), backupStoreId: 'backup123', backupPath: 'backup/v1/object.enc', backupEtag: '"backup"', keyId: 'key-v1', cipherSha256: 'b'.repeat(64), cipherBytes: 123, readbackVerifiedAt: at, restoreVerifiedAt: at, status: 'complete' };
  const quarantine: ArchiveQuarantine = { sourceStoreId: 'primary123', sourcePath: pathname, sourceEtag: '"source"', sourceUploadedAt: uploadedAt, size: 42, firstSeenAt: new Date(now - mediaArchiveQuarantineMs).toISOString(), lastCheckedAt: at };
  return { catalog, proof, quarantine };
}

test('only restored independent derivative after unchanged 30-day quarantine reaches review, never deletion', () => {
  const { catalog, proof, quarantine } = fixture();
  const plan = planArchiveGc(catalog, [proof], [quarantine], now);
  assert.equal(plan.mode, 'dry_run'); assert.equal(plan.deletionEnabled, false);
  assert.deepEqual(plan.decisions, [{ pathname, disposition: 'eligible_for_review', reason: 'unreferenced_derivative_with_independent_restore_and_quarantine', conditionalEtag: '"source"' }]);
});

test('same store aliases, stale/corrupt/incomplete proof, lost keys and changed source preserve the file', () => {
  const { catalog, proof, quarantine } = fixture();
  const invalidProofs = [
    { ...proof, backupStoreId: 'store_PRIMARY123' }, { ...proof, sourceStoreId: 'invalid' },
    { ...proof, sourceEtag: '"changed"' }, { ...proof, size: 1 }, { ...proof, sha256: '' },
    { ...proof, keyId: '' }, { ...proof, cipherSha256: 'bad' }, { ...proof, cipherBytes: 0 },
    { ...proof, backupPath: '../escape' }, { ...proof, backupEtag: 'W/"weak"' },
    { ...proof, readbackVerifiedAt: new Date(now - 86_400_001).toISOString() },
    { ...proof, restoreVerifiedAt: new Date(now + 1).toISOString() },
  ];
  for (const invalid of invalidProofs) assert.equal(planArchiveGc(catalog, [invalid], [quarantine], now).decisions[0].disposition, 'preserve');
});

test('changing reference, incomplete/stale snapshot or non-derivative role always protects original and unknown files', () => {
  const { catalog, proof, quarantine } = fixture();
  const variants: ArchiveCatalog[] = [
    { ...catalog, complete: false }, { ...catalog, capturedAt: new Date(now - 900_001).toISOString() },
    { ...catalog, referencedPathsAbsentFromInventory: ['ai/retained-but-absent/original.webp'] },
    { ...catalog, objects: [{ ...catalog.objects[0], references: ['versions:old'] }] },
    ...(['editing_archive', 'final_master', 'recovery_source', 'compacted_source', 'mask', 'unknown'] as const).map(role => ({ ...catalog, objects: [{ ...catalog.objects[0], roles: [role] }] })),
  ];
  for (const changed of variants) assert.equal(planArchiveGc(changed, [proof], [quarantine], now).decisions[0].disposition, 'preserve');
});

test('new object version, short quarantine and stale final check restart quarantine', () => {
  const { catalog, proof, quarantine } = fixture();
  for (const q of [undefined, { ...quarantine, sourceEtag: '"old"' }, { ...quarantine, firstSeenAt: new Date(now - mediaArchiveQuarantineMs + 1).toISOString() }, { ...quarantine, lastCheckedAt: new Date(now - 900_001).toISOString() }]) {
    assert.equal(planArchiveGc(catalog, [proof], q ? [q] : [], now).decisions[0].disposition, 'quarantine');
  }
});
