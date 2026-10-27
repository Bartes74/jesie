import 'server-only';
import { backupLabelPattern, normalizedBackupStoreId, safeBackupPath, type MediaBackupProof } from '@/server/media-backup/types';
import { isKnownDerivativePath, type ArchiveCatalog, type ArchiveCatalogObject } from './reference-graph';

export const mediaArchiveQuarantineMs = 30 * 24 * 60 * 60 * 1000;
export const maximumReferenceSnapshotAgeMs = 15 * 60 * 1000;
export const maximumBackupProofAgeMs = 24 * 60 * 60 * 1000;
export type ArchiveQuarantine = {
  sourceStoreId: string; sourcePath: string; sourceEtag: string; sourceUploadedAt: string; size: number;
  firstSeenAt: string; lastCheckedAt: string;
};
export type ArchiveGcDecision = {
  pathname: string;
  disposition: 'preserve' | 'quarantine' | 'eligible_for_review';
  reason: string;
  /** This is a dry-run precondition, never an authorization to delete. */
  conditionalEtag?: string;
};
export type ArchiveGcPlan = {
  mode: 'dry_run'; deletionEnabled: false; sourceStoreId: string; referenceGraphSha256: string;
  checkedAt: string; decisions: ArchiveGcDecision[];
};
const sha256 = /^[a-f0-9]{64}$/;
const strongEtag = (value: string) => typeof value === 'string' && value === value.trim() && /^"[^"\r\n]{1,200}"$/.test(value);
const fresh = (value: string, now: number, maximumAge: number) => {
  const at = Date.parse(value);
  return Number.isFinite(at) && at <= now && now - at <= maximumAge;
};
function sameStore(first: string, second: string) {
  try { return normalizedBackupStoreId(first) === normalizedBackupStoreId(second); }
  catch { return false; }
}
function independentStores(first: string, second: string) {
  try { return normalizedBackupStoreId(first) !== normalizedBackupStoreId(second); }
  catch { return false; }
}
function validProof(proof: MediaBackupProof | undefined, object: ArchiveCatalogObject, storeId: string, now: number): boolean {
  if (!proof || proof.status !== 'complete' || !sameStore(proof.sourceStoreId, storeId)
    || !independentStores(proof.sourceStoreId, proof.backupStoreId) || proof.sourcePath !== object.pathname
    || proof.sourceEtag !== object.etag || proof.sourceUploadedAt !== object.uploadedAt || proof.size !== object.size
    || !sha256.test(proof.sha256) || !sha256.test(proof.cipherSha256) || !backupLabelPattern.test(proof.keyId)
    || !Number.isSafeInteger(proof.cipherBytes) || proof.cipherBytes <= 0 || !strongEtag(proof.backupEtag)
    || !fresh(proof.readbackVerifiedAt, now, maximumBackupProofAgeMs)
    || !fresh(proof.restoreVerifiedAt, now, maximumBackupProofAgeMs)) return false;
  try { safeBackupPath(proof.backupPath); } catch { return false; }
  return true;
}

/** No delete port exists. A future operator must rerun this with fresh inventory and proof. */
export function planArchiveGc(catalog: ArchiveCatalog, proofs: readonly MediaBackupProof[], quarantines: readonly ArchiveQuarantine[], now = Date.now()): ArchiveGcPlan {
  if (!Number.isFinite(now)) throw new Error('ARCHIVE_CLOCK_INVALID');
  const complete = catalog.complete && catalog.referencedPathsAbsentFromInventory.length === 0
    && fresh(catalog.capturedAt, now, maximumReferenceSnapshotAgeMs);
  const decisions = catalog.objects.map((object): ArchiveGcDecision => {
    const preserve = (reason: string): ArchiveGcDecision => ({ pathname: object.pathname, disposition: 'preserve', reason });
    if (!complete) return preserve('reference_snapshot_incomplete_or_stale');
    if (object.references.length) return preserve('referenced_by_current_history_or_recovery');
    if (object.roles.length !== 1 || object.roles[0] !== 'derivative' || !isKnownDerivativePath(object.pathname)) return preserve('immutable_source_or_unknown_object');
    if (!strongEtag(object.etag)) return preserve('strong_source_etag_required');
    const proof = proofs.find(item => item.sourcePath === object.pathname && item.sourceEtag === object.etag && sameStore(item.sourceStoreId, catalog.sourceStoreId));
    if (!validProof(proof, object, catalog.sourceStoreId, now)) return preserve('independent_verified_restore_required');
    const quarantine = quarantines.find(item => item.sourcePath === object.pathname && sameStore(item.sourceStoreId, catalog.sourceStoreId));
    const quarantineMatches = quarantine && quarantine.sourceEtag === object.etag && quarantine.size === object.size
      && quarantine.sourceUploadedAt === object.uploadedAt
      && Number.isFinite(Date.parse(quarantine.firstSeenAt)) && Date.parse(quarantine.firstSeenAt) >= Date.parse(object.uploadedAt)
      && Date.parse(quarantine.firstSeenAt) <= Date.parse(quarantine.lastCheckedAt)
      && fresh(quarantine.lastCheckedAt, now, maximumReferenceSnapshotAgeMs);
    if (!quarantineMatches || now - Date.parse(quarantine.firstSeenAt) < mediaArchiveQuarantineMs) {
      return { pathname: object.pathname, disposition: 'quarantine', reason: 'thirty_day_unchanged_quarantine_required' };
    }
    return { pathname: object.pathname, disposition: 'eligible_for_review', reason: 'unreferenced_derivative_with_independent_restore_and_quarantine', conditionalEtag: object.etag };
  });
  return { mode: 'dry_run', deletionEnabled: false, sourceStoreId: catalog.sourceStoreId,
    referenceGraphSha256: catalog.referenceGraphSha256, checkedAt: new Date(now).toISOString(), decisions };
}
