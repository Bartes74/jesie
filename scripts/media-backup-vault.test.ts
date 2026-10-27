import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consolidateLegacy, exportVault, mirrorVault, parseVaultManifest, restoreVault, safeRelativePath, vaultObjectRelativePath, verifyVault } from './media-backup-vault';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jesie-vault-test-')));
  const { mkdir } = await import('node:fs/promises');
  const source = join(root, 'legacy'), app = join(root, 'app'), vault = join(root, 'vault');
  await mkdir(source); await mkdir(app);
  await writeFile(join(source, 'original.source'), Buffer.from('immutable source pixels'));
  await writeFile(join(source, 'duplicate.png'), Buffer.from('immutable source pixels'));
  await writeFile(join(source, 'final.webp'), Buffer.from('distinct final alpha pixels'));
  await writeFile(join(source, 'proof.json'), JSON.stringify({ source: 'original.source', final: 'final.webp', checked: true }));
  await writeFile(join(app, 'photograph.webp'), Buffer.from('distinct final alpha pixels'));
  const exported = await exportVault({ vault, checkpoint: 'test', roots: [
    { label: 'legacy', path: source, category: 'legacy' }, { label: 'app-private-media', path: app, category: 'application' },
  ] });
  const externalRoots: string[] = [];
  return { root, source, app, vault, manifestPath: exported.manifestPath, exported,
    async independentRestore() {
      const parent = await realpath(await mkdtemp('/Volumes/Projekty/jesie-vault-test-'));
      externalRoots.push(parent); const destination = join(parent, 'restore');
      await restoreVault(exported.manifestPath, destination); return destination;
    },
    async independentVault() {
      const parent = await realpath(await mkdtemp('/Volumes/Projekty/jesie-vault-test-'));
      externalRoots.push(parent); return join(parent, 'vault');
    },
    async cleanup() { for (const path of [root, ...externalRoots]) await rm(path, { recursive: true, force: true }); },
  };
}

test('each exact SHA exists once, with every original path and metadata proof retained', async () => {
  const f = await fixture();
  try {
    const checked = await verifyVault(f.manifestPath);
    assert.equal(checked.objectCount, 3); assert.equal(checked.manifest.entries.length, 5);
    assert.ok(f.exported.duplicateBytes > 0);
    const original = checked.manifest.entries.find(entry => entry.pathname === 'original.source')!;
    const final = checked.manifest.entries.find(entry => entry.pathname === 'final.webp')!;
    assert.notEqual(original.sha256, final.sha256);
    assert.notEqual((await lstat(join(f.source, 'original.source'))).ino, (await lstat(join(f.vault, vaultObjectRelativePath(original.sha256)))).ino);
    assert.equal((await lstat(join(f.vault, vaultObjectRelativePath(original.sha256)))).mode & 0o777, 0o400);
  } finally { await f.cleanup(); }
});

test('restore reconstructs all regular files independently, exact paths, hashes, and full source/final/proof bytes', async () => {
  const f = await fixture();
  try {
    const destination = join(f.root, 'restore');
    const receipt = await restoreVault(f.manifestPath, destination);
    assert.equal(receipt.verified, true); assert.equal(receipt.restoredFiles, 5);
    for (const name of ['original.source', 'duplicate.png', 'final.webp', 'proof.json']) {
      const restored = join(destination, 'local', 'legacy', name);
      assert.deepEqual(await readFile(restored), await readFile(join(f.source, name)));
      assert.equal((await lstat(restored)).isSymbolicLink(), false);
      assert.notEqual((await lstat(restored)).ino, (await lstat(join(f.source, name))).ino);
    }
    await assert.rejects(restoreVault(f.manifestPath, destination), /EMPTY_RESTORE_DESTINATION_REQUIRED/);
  } finally { await f.cleanup(); }
});

test('path traversal, ambiguous paths and invalid digests never become restore paths', () => {
  for (const path of ['../token', '/tmp/secret', 'ai/../source', 'ai\\foo', 'ai//foo', 'x:y', 'ai/./foo', 'ai/\0foo']) {
    assert.throws(() => safeRelativePath(path), /UNSAFE_RELATIVE_PATH/);
  }
  assert.throws(() => vaultObjectRelativePath('../' + '0'.repeat(64)), /INVALID_OBJECT_HASH/);
  assert.equal(safeRelativePath('ai/recipe/original-v1.webp'), 'ai/recipe/original-v1.webp');
});

test('corrupt or missing objects stop both verification and restore before anything is removed', async () => {
  const f = await fixture();
  try {
    const checked = await verifyVault(f.manifestPath);
    const object = join(f.vault, vaultObjectRelativePath(checked.manifest.objects[0].sha256));
    await chmod(object, 0o600); await writeFile(object, Buffer.alloc(checked.manifest.objects[0].bytes, 1));
    await assert.rejects(verifyVault(f.manifestPath), /VAULT_OBJECT_CORRUPT/);
    await assert.rejects(restoreVault(f.manifestPath, join(f.root, 'restore')), /VAULT_OBJECT_CORRUPT/);
    assert.equal((await lstat(join(f.source, 'original.source'))).isFile(), true);
  } finally { await f.cleanup(); }
});

test('manifest path and shared-hash size inconsistencies are rejected', async () => {
  const f = await fixture();
  try {
    const manifest = JSON.parse(await readFile(f.manifestPath, 'utf8'));
    manifest.entries[0].pathname = '../escape';
    assert.throws(() => parseVaultManifest(manifest), /UNSAFE_RELATIVE_PATH/);
    manifest.entries[0].pathname = 'okay'; manifest.entries[0].bytes += 1;
    assert.throws(() => parseVaultManifest(manifest), /INVALID_VAULT_ENTRY/);
  } finally { await f.cleanup(); }
});

test('dedup requires a full verified restore and a fresh unchanged source tree', async () => {
  const f = await fixture();
  try {
    const receiptPath = join(f.root, 'invalid-receipt.json');
    await writeFile(receiptPath, '{}');
    await assert.rejects(consolidateLegacy(f.manifestPath, f.source, receiptPath, receiptPath), /VERIFIED_FULL_RESTORE_RECEIPT_REQUIRED/);
    const destination = join(f.root, 'restore'); await restoreVault(f.manifestPath, destination);
    const independent = await f.independentRestore();
    await writeFile(join(f.source, 'proof.json'), 'changed');
    await assert.rejects(consolidateLegacy(f.manifestPath, f.source, join(destination, 'restore-receipt.private.json'), join(independent, 'restore-receipt.private.json')), /REGULAR_FILE_REQUIRED|LEGACY_SOURCE_CHANGED/);
    assert.equal((await lstat(join(f.source, 'original.source'))).isSymbolicLink(), false);
    assert.equal((await lstat(join(f.source, 'final.webp'))).isSymbolicLink(), false);
  } finally { await f.cleanup(); }
});

test('verified legacy consolidation keeps every name readable, preserves sources/finals/proofs, and never changes app files', async () => {
  const f = await fixture();
  try {
    const destination = join(f.root, 'restore'); await restoreVault(f.manifestPath, destination);
    const independent = await f.independentRestore();
    const result = await consolidateLegacy(f.manifestPath, f.source, join(destination, 'restore-receipt.private.json'), join(independent, 'restore-receipt.private.json'));
    assert.equal(result.consolidatedFiles, 4); assert.equal(result.applicationFilesChanged, 0); assert.equal(result.remoteFilesChanged, 0);
    for (const name of ['original.source', 'duplicate.png', 'final.webp', 'proof.json']) {
      assert.equal((await lstat(join(f.source, name))).isSymbolicLink(), true);
      assert.deepEqual(await readFile(join(f.source, name)), await readFile(join(destination, 'local', 'legacy', name)));
    }
    assert.equal((await lstat(join(f.app, 'photograph.webp'))).isSymbolicLink(), false);
    await assert.rejects(consolidateLegacy(f.manifestPath, f.app, join(destination, 'restore-receipt.private.json'), join(independent, 'restore-receipt.private.json')), /EXACT_LEGACY_BACKUP_ROOT_REQUIRED/);
    const resumed = await consolidateLegacy(f.manifestPath, f.source, join(destination, 'restore-receipt.private.json'), join(independent, 'restore-receipt.private.json'));
    assert.equal(resumed.consolidatedFiles, 4);
    const next = await exportVault({ vault: f.vault, checkpoint: 'next', roots: [{ label: 'legacy', path: f.source, category: 'legacy' }] });
    assert.equal((await verifyVault(next.manifestPath)).manifest.entries.length, 4);
  } finally { await f.cleanup(); }
});

test('two copies or restore receipts on the same physical volume cannot authorize consolidation', async () => {
  const f = await fixture();
  try {
    const first = join(f.root, 'restore-1'), second = join(f.root, 'restore-2');
    await restoreVault(f.manifestPath, first); await restoreVault(f.manifestPath, second);
    await assert.rejects(consolidateLegacy(f.manifestPath, f.source, join(first, 'restore-receipt.private.json'), join(second, 'restore-receipt.private.json')), /TWO_INDEPENDENT_RESTORE_VOLUMES_REQUIRED/);
    assert.equal((await lstat(join(f.source, 'original.source'))).isSymbolicLink(), false);
  } finally { await f.cleanup(); }
});

test('an existing checkpoint is immutable and cannot be replaced by a later export', async () => {
  const f = await fixture();
  try {
    await assert.rejects(exportVault({ vault: f.vault, checkpoint: 'test', roots: [] }), /IMMUTABLE_CHECKPOINT_ALREADY_EXISTS/);
  } finally { await f.cleanup(); }
});

test('mirror copies the same complete checkpoint to another volume without hardlinks or altered manifest bytes', async () => {
  const f = await fixture();
  try {
    const checked = await verifyVault(f.manifestPath), destination = await f.independentVault();
    const result = await mirrorVault(f.manifestPath, destination);
    assert.equal(result.manifestSha256, checked.manifestSha256); assert.equal(result.independentVolume, true);
    for (const entry of checked.manifest.objects) {
      const source = join(f.vault, vaultObjectRelativePath(entry.sha256)), copied = join(destination, vaultObjectRelativePath(entry.sha256));
      assert.notEqual((await lstat(source)).dev, (await lstat(copied)).dev);
      assert.deepEqual(await readFile(source), await readFile(copied));
    }
    await assert.rejects(mirrorVault(f.manifestPath, join(f.root, 'same-volume-vault')), /INDEPENDENT_MIRROR_VOLUME_REQUIRED/);
  } finally { await f.cleanup(); }
});

test('the database snapshot closure stops an export whose effective physical Blob object is absent', async () => {
  const f = await fixture();
  try {
    const references = join(f.root, 'references.json'); await writeFile(references, JSON.stringify({ requiredBlobPathnames: ['ai/missing/source.webp'] }));
    await assert.rejects(exportVault({ vault: f.vault, checkpoint: 'incomplete', roots: [], references }), /DATABASE_SNAPSHOT_BLOB_CLOSURE_INCOMPLETE/);
    await assert.rejects(lstat(join(f.vault, 'checkpoints', 'incomplete', 'manifest.private.json')), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('valid-looking accidental manifest edits fail against the separately stored manifest checksum', async () => {
  const f = await fixture();
  try {
    const value = JSON.parse(await readFile(f.manifestPath, 'utf8')); value.startedAt = 'changed';
    await chmod(f.manifestPath, 0o600); await writeFile(f.manifestPath, JSON.stringify(value));
    await assert.rejects(verifyVault(f.manifestPath), /MANIFEST_CHECKSUM_MISMATCH/);
  } finally { await f.cleanup(); }
});
