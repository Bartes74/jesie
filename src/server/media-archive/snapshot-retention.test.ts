import assert from 'node:assert/strict';
import test from 'node:test';
import { planSnapshotRetention, type RetainedSnapshot } from './snapshot-retention';

const now = Date.parse('2026-10-17T23:00:00.000Z');
const snapshot = (id: string, createdAt: string, overrides: Partial<RetainedSnapshot> = {}): RetainedSnapshot => ({
  id, kind: 'database', createdAt, status: 'complete', integrityVerified: true,
  readbackVerifiedAt: new Date(now).toISOString(), restoreVerified: true, restoreVerifiedAt: new Date(now).toISOString(), ...overrides,
});

test('keeps 30 daily and 12 monthly points plus latest good, regardless of input order', () => {
  const snapshots = Array.from({ length: 400 }, (_, day) => snapshot(String(day), new Date(now - day * 86_400_000).toISOString()));
  const plan = planSnapshotRetention([...snapshots].reverse(), now);
  const retained = new Set(plan.filter(row => row.disposition === 'retain').map(row => row.id));
  for (let day = 0; day < 30; day++) assert.ok(retained.has(String(day)));
  const monthly = new Map<string, string>();
  for (const row of snapshots) if (monthly.size < 12 && !monthly.has(row.createdAt.slice(0, 7))) monthly.set(row.createdAt.slice(0, 7), row.id);
  for (const id of monthly.values()) assert.ok(retained.has(id));
  assert.equal(retained.size, 40);
  assert.equal(plan.filter(row => row.disposition === 'superseded').length, 360);
});

test('bad latest run cannot remove latest good; media objects and incomplete/unrestored snapshots never expire', () => {
  const rows = [
    snapshot('good', '2026-09-01T00:00:00Z'),
    snapshot('bad-latest', '2026-10-17T00:00:00Z', { status: 'failed' }),
    snapshot('media', '2024-01-01T00:00:00Z', { kind: 'media_object' }),
    snapshot('database-unrestored', '2024-01-01T00:00:00Z', { restoreVerified: false, restoreVerifiedAt: null }),
    snapshot('no-readback', '2024-01-02T00:00:00Z', { readbackVerifiedAt: null }),
    snapshot('corrupt', '2024-01-03T00:00:00Z', { integrityVerified: false }),
    snapshot('future', '2027-01-01T00:00:00Z'),
  ];
  for (const row of planSnapshotRetention(rows, now)) assert.equal(row.disposition, 'retain', row.id);
});

test('database and manifest have independent retention points and stale replacement proofs prevent expiration', () => {
  const rows = Array.from({ length: 45 }, (_, day) => snapshot(`db-${day}`, new Date(now - day * 86_400_000).toISOString(), {
    readbackVerifiedAt: new Date(now - 86_400_001).toISOString(), restoreVerifiedAt: new Date(now - 86_400_001).toISOString(),
  }));
  rows.push(snapshot('manifest-old', '2025-01-01T00:00:00Z', { kind: 'media_manifest' }));
  assert.ok(planSnapshotRetention(rows, now).every(row => row.disposition === 'retain'));
  assert.throws(() => planSnapshotRetention([rows[0], rows[0]], now), /ARCHIVE_SNAPSHOT_DUPLICATE/);
});
