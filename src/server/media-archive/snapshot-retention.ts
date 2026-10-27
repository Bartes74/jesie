/** Snapshot retention plans never expire content-addressed media objects. */
export type RetainedSnapshot = {
  id: string;
  kind: 'database' | 'media_manifest' | 'media_object';
  createdAt: string;
  status: 'complete' | 'pending' | 'failed';
  integrityVerified: boolean;
  readbackVerifiedAt: string | null;
  /** For a database this means an actual isolated PostgreSQL restore, not JSON/schema validation. */
  restoreVerified: boolean;
  restoreVerifiedAt: string | null;
};
export type SnapshotRetentionDecision = { id: string; disposition: 'retain' | 'superseded'; reason: string };

/** Keep 30 distinct daily points, 12 distinct monthly points, and the latest good per kind. */
export function planSnapshotRetention(snapshots: readonly RetainedSnapshot[], now = Date.now()): SnapshotRetentionDecision[] {
  if (!Number.isFinite(now)) throw new Error('ARCHIVE_CLOCK_INVALID');
  if (new Set(snapshots.map(snapshot => snapshot.id)).size !== snapshots.length) throw new Error('ARCHIVE_SNAPSHOT_DUPLICATE');
  const timestamp = (value: string | null) => value == null ? NaN : Date.parse(value);
  const verified = (snapshot: RetainedSnapshot) => {
    const created = timestamp(snapshot.createdAt), readback = timestamp(snapshot.readbackVerifiedAt), restored = timestamp(snapshot.restoreVerifiedAt);
    return snapshot.status === 'complete' && snapshot.integrityVerified && snapshot.restoreVerified
      && Number.isFinite(created) && Number.isFinite(readback) && Number.isFinite(restored)
      && created <= readback && created <= restored && readback <= now && restored <= now;
  };
  const protectedIds = new Set<string>();
  const latestVerifiedByKind = new Map<RetainedSnapshot['kind'], RetainedSnapshot>();
  for (const kind of ['database', 'media_manifest'] as const) {
    const candidates = snapshots.filter(snapshot => snapshot.kind === kind && verified(snapshot))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
    const days = new Set<string>(), months = new Set<string>();
    for (const snapshot of candidates) {
      const day = new Date(snapshot.createdAt).toISOString().slice(0, 10), month = day.slice(0, 7);
      if (!latestVerifiedByKind.has(kind)) { latestVerifiedByKind.set(kind, snapshot); protectedIds.add(snapshot.id); }
      if (!days.has(day) && days.size < 30) { days.add(day); protectedIds.add(snapshot.id); }
      if (!months.has(month) && months.size < 12) { months.add(month); protectedIds.add(snapshot.id); }
    }
  }
  return snapshots.map(snapshot => {
    const retain = (reason: string): SnapshotRetentionDecision => ({ id: snapshot.id, disposition: 'retain', reason });
    if (snapshot.kind === 'media_object') return retain('content_addressed_media_retained');
    if (!verified(snapshot)) return retain('unverified_or_incomplete_snapshot_retained');
    if (protectedIds.has(snapshot.id)) return retain('daily_monthly_or_latest_good_restore_point');
    const newer = latestVerifiedByKind.get(snapshot.kind);
    if (!newer || Date.parse(newer.createdAt) <= Date.parse(snapshot.createdAt)) return retain('newer_verified_restore_required');
    if (now - Date.parse(newer.readbackVerifiedAt!) > 24 * 60 * 60 * 1000
      || now - Date.parse(newer.restoreVerifiedAt!) > 24 * 60 * 60 * 1000) return retain('fresh_newer_readback_and_restore_required');
    // No deletion API is exposed; execution must recheck these immutable proofs and storage ETag.
    return { id: snapshot.id, disposition: 'superseded', reason: 'replaced_by_newer_restorable_snapshot_outside_retention_points' };
  });
}
