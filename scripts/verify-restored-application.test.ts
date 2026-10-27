import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { patchRestoreCopy, prepareOfflineMedia, restoreEnvironment } from './verify-restored-application';
import type { VaultManifest } from './media-backup-vault';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const envOptions = { socketPath: '/private/restore/socket/.s.PGSQL.55439', databaseUrl: 'postgresql://restore@localhost/jesie_drill?host=%2Fprivate%2Frestore%2Fsocket&port=55439', port: 3129,
  guard: '/private/restore/guard.cjs', guardLogs: '/private/restore/logs', offlineMedia: '/private/restore/media', authSecret: 'synthetic-test-secret-longer-than-thirty-two-bytes' };

test('restore environment is constructed from an allowlist and cannot carry production/provider credentials', () => {
  const before = process.env.OPENAI_API_KEY;
  try {
    process.env.OPENAI_API_KEY = 'synthetic inherited credential';
    const env = restoreEnvironment(envOptions);
    assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.FAL_KEY, undefined); assert.equal(env.CRON_SECRET, undefined);
    assert.equal(env.BLOB_STORE_ID, undefined); assert.equal(env.BLOB_READ_WRITE_TOKEN, undefined); assert.equal(env.INDEXNOW_KEY, undefined);
    assert.equal(env.VERCEL_ENV, 'preview'); assert.equal(env.SEO_INDEXING_ENABLED, 'false'); assert.equal(env.JESIE_RESTORE_GUARD, '1');
    assert.equal(env.DATABASE_URL, envOptions.databaseUrl); assert.equal(env.BETTER_AUTH_URL, 'http://127.0.0.1:3129');
    assert.equal(env.HOME, undefined); assert.equal(env.HTTP_PROXY, undefined);
  } finally { if (before === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = before; }
});

test('runtime environment rejects remote databases, TCP-only localhost, passwords and mismatched Unix sockets', () => {
  for (const databaseUrl of ['postgresql://restore@neon.example/jesie_drill?host=%2Fprivate%2Frestore%2Fsocket', 'postgresql://restore@localhost/jesie_drill', 'postgresql://restore:password@localhost/jesie_drill?host=%2Fprivate%2Frestore%2Fsocket', 'postgresql://restore@localhost/jesie_drill?host=%2Fprivate%2Fother']) {
    assert.throws(() => restoreEnvironment({ ...envOptions, databaseUrl }), /RESTORE_ENV_LOCAL_DATABASE_REQUIRED/);
  }
});

test('offline restore validates hashes and rehydrates immutable compaction aliases without writing remote objects', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'jesie-restore-helper-')));
  try {
    await chmod(directory, 0o700);
    const media = join(directory, 'media'); const output = join(directory, 'offline');
    const bytes = await sharp({ create: { width: 48, height: 32, channels: 4, background: { r: 150, g: 80, b: 60, alpha: 0.8 } } }).webp({ lossless: true }).toBuffer();
    const hash = digest(bytes); const pathname = `ai/compact/v1/${hash}.webp`;
    await mkdir(join(media, 'blob/ai/compact/v1'), { recursive: true }); await writeFile(join(media, 'blob', pathname), bytes);
    const manifest = { entries: [{ source: 'blob', pathname, sha256: hash, bytes: bytes.length }] } as VaultManifest;
    const proof = await prepareOfflineMedia({ manifest, restoredMedia: media, directory: output, mappings: [{ source_pathname: 'ai/job/web.png', target_pathname: pathname, target_sha256: hash, target_bytes: bytes.length }] });
    assert.equal(proof.paths, 2); assert.equal(proof.files, 1);
    const restored = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
    assert.deepEqual(restored.entries['ai/job/web.png'], restored.entries[pathname]);
    assert.equal(digest(await readFile(join(output, restored.entries[pathname].file))), hash);
    await assert.rejects(prepareOfflineMedia({ manifest, restoredMedia: media, directory: join(directory, 'missing-proof'), mappings: [{ source_pathname: 'ai/job/web.png', target_pathname: pathname, target_sha256: '0'.repeat(64), target_bytes: bytes.length }] }), /RESTORE_COMPACTION_TARGET_MISSING/);
    await writeFile(join(media, 'blob', pathname), Buffer.alloc(bytes.length));
    await assert.rejects(prepareOfflineMedia({ manifest, restoredMedia: media, directory: join(directory, 'corrupt'), mappings: [] }), /RESTORE_MEDIA_SHA_MISMATCH/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('test-copy adapter keeps real media authorization, disables external automation and refuses an existing Proxy', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'jesie-restore-patch-')));
  try {
    await mkdir(join(directory, 'src/server/media'), { recursive: true }); await mkdir(join(directory, 'src/server/seo'), { recursive: true });
    await writeFile(join(directory, 'src/server/media/storage.ts'), 'Original isolated fixture source');
    await writeFile(join(directory, 'src/server/seo/media.ts'), 'function storageConfigured() { return Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID); }');
    await patchRestoreCopy(directory);
    const storage = await readFile(join(directory, 'src/server/media/storage.ts'), 'utf8');
    assert(storage.includes('createLocalRecoveryReader')); assert(storage.includes('RESTORE_MEDIA_SOURCE_MISSING')); assert.equal(storage.includes('@vercel/blob'), false);
    const proxy = await readFile(join(directory, 'src/proxy.ts'), 'utf8'); assert(proxy.includes('RESTORE_AUTOMATION_DISABLED')); assert(proxy.includes('/.well-known/workflow/:path*'));
    await assert.rejects(patchRestoreCopy(directory), /RESTORE_SOURCE_STORAGE_GATE_CHANGED/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
