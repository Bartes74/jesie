import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readEncryptedBackup } from '@/server/media-backup/objects';
import type { BackupBlobRead, PrivateBackupBlobStore } from '@/server/media-backup/types';
import { copyBundledMediaPage, createBundledMediaSource, readBundledMediaAliasPage, readBundledRecoveryRegistry } from './bundled';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jesie-bundle-backup-'));
  for (const folder of ['public/images', 'private-media/provider-recovery', 'private-media/published-recovery', 'private-media/quota-public-recovery']) await mkdir(join(root, folder), { recursive: true });
  await writeFile(join(root, 'public/images/photo.webp'), 'public exact image bytes');
  await writeFile(join(root, 'private-media/provider-recovery/source.webp'), 'private exact original bytes');
  await writeFile(join(root, 'private-media/provider-recovery/manifest.json'), '[]');
  for (const name of ['published-recovery', 'quota-public-recovery']) await writeFile(join(root, `private-media/${name}/manifest.json`), JSON.stringify({ version: 1, entries: {} }));
  await writeFile(join(root, '.env.production.local'), 'NEVER_INCLUDE_THIS');
  await writeFile(join(root, 'public/images/.env'), 'NEVER_INCLUDE_THIS_EITHER');
  return { root, clean: () => rm(root, { recursive: true, force: true }) };
}

test('pages exact approved roots, stable SHA metadata and virtual names without reading secrets or repository files', async () => {
  const f = await fixture();
  try {
    const source = createBundledMediaSource({ projectDirectory: f.root });
    let cursor: string | undefined;
    const files = [];
    do {
      const page = await source.list(cursor, 2); assert.ok(page.blobs.length <= 2);
      files.push(...page.blobs); cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    assert.equal(files.length, 5);
    assert.ok(files.every(file => /^(?:app-public\/images|app-private\/(?:provider-recovery|published-recovery|quota-public-recovery))\//.test(file.pathname)));
    assert.ok(!JSON.stringify(files).includes('.env'));
    const original = await source.get('app-private/provider-recovery/source.webp', 1024);
    assert.equal(original!.bytes.toString(), 'private exact original bytes');
    assert.equal(original!.etag, `"sha256:${createHash('sha256').update(original!.bytes).digest('hex')}"`);
    assert.equal(await source.get('../.env.production.local', 1024), null);
    await assert.rejects(source.putImmutable('x', Buffer.alloc(0), 'x'), /BUNDLED_BACKUP_SOURCE_READ_ONLY/);
    await assert.rejects(source.list(undefined, 6), /BUNDLED_BACKUP_PAGE_LIMIT/);
  } finally { await f.clean(); }
});

test('a symlink or deployment change fails closed rather than following or silently skipping files', async () => {
  const f = await fixture();
  try {
    const source = createBundledMediaSource({ projectDirectory: f.root });
    const first = await source.list(undefined, 1);
    await writeFile(join(f.root, 'public/images/new.webp'), 'new deployment file');
    await assert.rejects(source.list(first.cursor, 1), /BUNDLED_BACKUP_CURSOR_INVALID_OR_DEPLOYMENT_CHANGED/);
    await symlink(join(f.root, '.env.production.local'), join(f.root, 'public/images/stolen.webp'));
    await assert.rejects(source.list(undefined, 1), /BUNDLED_BACKUP_SYMLINK_REJECTED/);
  } finally { await f.clean(); }
});

test('bounded bundle copies restore identical bytes from encrypted independent store and retries reuse objects', async () => {
  const f = await fixture();
  try {
    const files = new Map<string, BackupBlobRead>(); let writes = 0;
    const destination: PrivateBackupBlobStore = {
      storeId: 'backup123', list: async () => ({ blobs: [], hasMore: false }),
      get: async pathname => files.get(pathname) ?? null,
      putImmutable: async (pathname, bytes, contentType) => {
        assert.equal(files.has(pathname), false); writes++;
        files.set(pathname, { pathname, size: bytes.length, bytes, contentType, etag: `"cipher-${writes}"`, uploadedAt: new Date().toISOString() });
      },
    };
    const encryption = { keyId: 'test-key', key: Buffer.alloc(32, 3) };
    const page = await copyBundledMediaPage({ projectDirectory: f.root, pageSize: 5, destination, encryption });
    assert.equal(page.proofs.length, 5); assert.equal(page.hasMore, false);
    for (const proof of page.proofs) {
      assert.equal(proof.sourceStoreId, 'applicationbundle'); assert.equal(proof.status, 'complete');
      assert.equal(proof.restoreVerifiedAt, proof.readbackVerifiedAt);
      const restored = await readEncryptedBackup({ pathname: proof.backupPath, context: `media/sha256/${proof.sha256}`, maximumBytes: proof.size, destination, encryption });
      assert.equal(restored!.proof.plaintextSha256, proof.sha256);
      assert.equal(restored!.plaintext.length, proof.size);
      assert.ok(!files.get(proof.backupPath)!.bytes.includes(Buffer.from('private exact original bytes')));
    }
    const previousWrites = writes;
    await copyBundledMediaPage({ projectDirectory: f.root, pageSize: 5, destination, encryption });
    assert.equal(writes, previousWrites);
  } finally { await f.clean(); }
});

test('default registry reads exactly three bounded manifests and missing proof prevents complete backup', async () => {
  const f = await fixture();
  try {
    const registry = await readBundledRecoveryRegistry(f.root);
    assert.deepEqual(registry, [[], { version: 1, entries: {} }, { version: 1, entries: {} }]);
    await unlink(join(f.root, 'private-media/provider-recovery/manifest.json'));
    await assert.rejects(readBundledRecoveryRegistry(f.root), /BUNDLED_RECOVERY_MANIFEST_MISSING/);
  } finally { await f.clean(); }
});

test('cursor and source identity survive different OS timestamps and inodes for the same deployment bytes', async () => {
  const f = await fixture();
  try {
    const first = await createBundledMediaSource({ projectDirectory: f.root }).list(undefined, 1);
    const physical = join(f.root, first.blobs[0].sourceFile!);
    const bytes = await readFile(physical);
    await unlink(physical); await writeFile(physical, bytes); await utimes(physical, 1, 1);
    const source = createBundledMediaSource({ projectDirectory: f.root });
    const next = await source.list(first.cursor, 1);
    assert.equal(next.blobs.length, 1);
    const same = await source.get(first.blobs[0].pathname, 1024);
    assert.equal(same!.etag, first.blobs[0].etag);
    assert.equal(same!.uploadedAt, first.blobs[0].uploadedAt);
  } finally { await f.clean(); }
});

test('canonical aliases are emitted only after matching bundled SHA-256 and byte length', async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from('verified canonical original');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const file = `${sha}.webp`, canonical = 'ai/12345678-abcd-abcd-abcd-123456789012/original.webp';
    await writeFile(join(f.root, 'private-media/published-recovery', file), bytes);
    await writeFile(join(f.root, 'private-media/published-recovery/manifest.json'), JSON.stringify({ version: 1, entries: {
      [canonical]: { file, sha256: sha, byteLength: bytes.length, contentType: 'image/webp' },
    } }));
    const source = createBundledMediaSource({ projectDirectory: f.root });
    const original = await source.get(`app-private/published-recovery/${file}`, 1024);
    assert.deepEqual(original!.aliases, [canonical]);
    assert.equal(original!.sourceStoreId, 'applicationbundle');
    assert.equal(original!.sourceFile, `private-media/published-recovery/${file}`);
    const page = await readBundledMediaAliasPage({ projectDirectory: f.root, pageSize: 5 });
    assert.ok(page.blobs.some(row => row.aliases?.includes(canonical)));
    await writeFile(join(f.root, 'private-media/published-recovery', file), Buffer.alloc(bytes.length, 1));
    await assert.rejects(source.get(`app-private/published-recovery/${file}`, 1024), /BUNDLED_ALIAS_INTEGRITY_FAILED/);
  } finally { await f.clean(); }
});
