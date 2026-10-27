import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);

test('missing local PostgreSQL tools produces an explicit integration-test setup hint', { timeout: 15_000 }, async () => {
  const env: NodeJS.ProcessEnv = { PATH: '', LANG: 'C', LC_ALL: 'C', TZ: 'UTC', NODE_ENV: 'test' };
  await assert.rejects(execute(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('scripts/update-kitchen-backup-schema.ts'), '--verify-only'], { env, maxBuffer: 1024 * 1024, timeout: 10_000 }), (error: unknown) => {
    assert.ok(error && typeof error === 'object' && 'stderr' in error);
    const receipt = JSON.parse(String(error.stderr).trim());
    assert.equal(receipt.detailCode, 'PG18_TOOLS_REQUIRED');
    assert.match(receipt.hint, /PATH or set MEDIA_BACKUP_TEST_PG_BIN/);
    assert.equal(receipt.productionConnections, false);
    return true;
  });
});

test('the shipped schema bundle restores collection drafts, publications, artwork and costs with matching structural proofs (requires local PostgreSQL 18 tools)', { timeout: 90_000 }, async () => {
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') throw new Error('Local schema regression test refuses production.');
  // No inherited application DSNs, cookies, provider credentials or PG services.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC', NODE_ENV: 'test',
    ...(process.env.MEDIA_BACKUP_TEST_PG_BIN ? { MEDIA_BACKUP_TEST_PG_BIN: process.env.MEDIA_BACKUP_TEST_PG_BIN } : {}) };
  const result = await execute(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('scripts/update-kitchen-backup-schema.ts'), '--verify-only'], { env, maxBuffer: 1024 * 1024, timeout: 85_000 });
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.ok, true);
  assert.equal(receipt.updated, false, 'Regression verification must never rewrite the checked-in bundle.');
  assert.equal(receipt.baselineFingerprintMatched, true);
  assert.equal(receipt.previousFingerprint, receipt.schemaFingerprint);
  assert.equal(receipt.restoreVerified, true);
  assert.equal(receipt.cleanupConfirmed, true);
  assert.equal(receipt.productionConnections, false);
  assert.ok(receipt.tableCount > 1);
  assert.ok(receipt.rowCount >= 4);
  assert.ok(receipt.acceptedMetricRows >= 12, 'Both plan routes and existing public path families must survive SQL constraints and restore.');
  assert.equal(receipt.rejectedMetricRows, 7, 'Private paths and recipe-only actions on plan routes must stay rejected.');
  assert.equal(receipt.seededCollections, 4, 'All existing collection identities must survive the migration and restore.');
  assert.equal(receipt.collectionArtworkRequired, true, 'Published collection artwork must be included in backup references.');
  assert.equal(receipt.collectionGuardsMatched, true, 'Collection media and provider identities must retain their database guards.');
});
