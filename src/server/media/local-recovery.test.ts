import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createLocalRecoveryReader, LocalMediaRecoveryError, type LocalRecoveryManifest } from './local-recovery';

const pathname = 'ai/00000000-0000-4000-8000-000000000000/web.webp';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const failure = (code: LocalMediaRecoveryError['code']) => (error: unknown) => error instanceof LocalMediaRecoveryError && error.code === code;

async function fixture(t: { after(fn: () => Promise<void>): void }, format: 'png' | 'webp' | 'jpeg' = 'webp') {
  const root = await mkdtemp(join(tmpdir(), 'jesie-local-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#ff000080' } }).toFormat(format).toBuffer();
  const sha256 = hash(bytes);
  const file = `${sha256}.${format}`;
  const manifest: LocalRecoveryManifest = { version: 1, entries: { [pathname]: { file, byteLength: bytes.length, sha256, contentType: `image/${format}` } } };
  await writeFile(join(root, file), bytes);
  const save = () => writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  await save();
  return { root, bytes, file, manifest, save };
}

test('reads exact bytes and strict content types, with no transformation', async t => {
  for (const format of ['png', 'webp', 'jpeg'] as const) {
    const f = await fixture(t, format);
    const recovered = await createLocalRecoveryReader({ rootDirectory: f.root })(pathname);
    assert.deepEqual(recovered, { bytes: f.bytes, contentType: `image/${format}` });
  }
});

test('absent root, absent manifest and absent entry return null', async t => {
  const f = await fixture(t);
  assert.equal(await createLocalRecoveryReader({ rootDirectory: join(f.root, 'missing') })(pathname), null);
  assert.equal(await createLocalRecoveryReader({ rootDirectory: f.root })('ai/other/web.webp'), null);
  await rm(join(f.root, 'manifest.json'));
  assert.equal(await createLocalRecoveryReader({ rootDirectory: f.root })(pathname), null);
});

test('multiple registered paths may share identical content-addressed bytes', async t => {
  const f = await fixture(t);
  const original = 'ai/00000000-0000-4000-8000-000000000000/original.png';
  f.manifest.entries[original] = { ...f.manifest.entries[pathname] };
  await f.save();
  const reader = createLocalRecoveryReader({ rootDirectory: f.root });
  assert.deepEqual((await reader(original))?.bytes, f.bytes);
  assert.deepEqual((await reader(pathname))?.bytes, f.bytes);
});

test('manifest is loaded lazily once while recovered bytes are revalidated', async t => {
  const f = await fixture(t);
  const reader = createLocalRecoveryReader({ rootDirectory: f.root });
  await reader(pathname);
  await writeFile(join(f.root, 'manifest.json'), 'invalid replacement');
  assert.deepEqual((await reader(pathname))?.bytes, f.bytes);
  const altered = Buffer.from(f.bytes);
  altered[altered.length - 1] ^= 1;
  await writeFile(join(f.root, f.file), altered);
  await assert.rejects(reader(pathname), failure('LOCAL_RECOVERY_FILE_INVALID'));
});

test('rejects malformed manifests, unknown metadata and unsupported types', async t => {
  const f = await fixture(t);
  for (const input of ['{', JSON.stringify({ ...f.manifest, version: 2 }), JSON.stringify({ ...f.manifest, extra: true }),
    JSON.stringify({ version: 1, entries: [] }), JSON.stringify({ version: 1, entries: { [pathname]: { ...f.manifest.entries[pathname], contentType: 'text/html' } } })]) {
    await writeFile(join(f.root, 'manifest.json'), input);
    await assert.rejects(createLocalRecoveryReader({ rootDirectory: f.root })(pathname), failure('LOCAL_RECOVERY_MANIFEST_INVALID'));
  }
});

test('rejects traversal, absolute and arbitrary filenames and non-content-addressed files', async t => {
  const f = await fixture(t);
  for (const file of ['../outside.webp', '/tmp/outside.webp', `nested/${f.file}`, 'web.webp', `${'0'.repeat(64)}.webp`]) {
    f.manifest.entries[pathname].file = file;
    await f.save();
    await assert.rejects(createLocalRecoveryReader({ rootDirectory: f.root })(pathname), failure('LOCAL_RECOVERY_MANIFEST_INVALID'));
  }
  await f.save();
  const reader = createLocalRecoveryReader({ rootDirectory: f.root });
  for (const value of ['../manifest.json', '/ai/example/web.webp', 'ai/../secret.webp', 'ai/%2e%2e/secret.webp', 'ai\\example\\web.webp', 'seo/delivery/id/v1.webp']) assert.equal(await reader(value), null);
});

test('rejects symlinks for root directory, manifest and image', async t => {
  const f = await fixture(t);
  const rootLink = join(f.root, 'root-link');
  await symlink(f.root, rootLink);
  await assert.rejects(createLocalRecoveryReader({ rootDirectory: rootLink })(pathname), failure('LOCAL_RECOVERY_MANIFEST_INVALID'));
  const manifestBytes = await readFile(join(f.root, 'manifest.json'));
  await writeFile(join(f.root, 'manifest-real.json'), manifestBytes);
  await rm(join(f.root, 'manifest.json'));
  await symlink(join(f.root, 'manifest-real.json'), join(f.root, 'manifest.json'));
  await assert.rejects(createLocalRecoveryReader({ rootDirectory: f.root })(pathname), failure('LOCAL_RECOVERY_MANIFEST_INVALID'));
  await rm(join(f.root, 'manifest.json'));
  await f.save();
  await writeFile(join(f.root, 'outside.webp'), f.bytes);
  await rm(join(f.root, f.file));
  await symlink(join(f.root, 'outside.webp'), join(f.root, f.file));
  await assert.rejects(createLocalRecoveryReader({ rootDirectory: f.root })(pathname), failure('LOCAL_RECOVERY_FILE_INVALID'));
});

test('present missing, truncated, oversized or non-regular files fail rather than falling through', async t => {
  const f = await fixture(t);
  await rm(join(f.root, f.file));
  await assert.rejects(createLocalRecoveryReader({ rootDirectory: f.root })(pathname), failure('LOCAL_RECOVERY_FILE_INVALID'));
  await writeFile(join(f.root, f.file), f.bytes.subarray(0, -1));
  await assert.rejects(createLocalRecoveryReader({ rootDirectory: f.root })(pathname), failure('LOCAL_RECOVERY_FILE_INVALID'));
  await writeFile(join(f.root, f.file), Buffer.concat([f.bytes, Buffer.from([0])]));
  await assert.rejects(createLocalRecoveryReader({ rootDirectory: f.root })(pathname), failure('LOCAL_RECOVERY_FILE_INVALID'));
  await rm(join(f.root, f.file));
  await mkdir(join(f.root, f.file));
  await assert.rejects(createLocalRecoveryReader({ rootDirectory: f.root })(pathname), failure('LOCAL_RECOVERY_FILE_INVALID'));
  f.manifest.entries[pathname].byteLength = 32 * 1024 * 1024 + 1;
  await f.save();
  await assert.rejects(createLocalRecoveryReader({ rootDirectory: f.root })(pathname), failure('LOCAL_RECOVERY_MANIFEST_INVALID'));
});

test('valid hash cannot disguise bytes with the wrong image content type', async t => {
  const f = await fixture(t, 'png');
  const renamed = `${hash(f.bytes)}.webp`;
  await writeFile(join(f.root, renamed), f.bytes);
  f.manifest.entries[pathname] = { ...f.manifest.entries[pathname], file: renamed, contentType: 'image/webp' };
  await f.save();
  await assert.rejects(createLocalRecoveryReader({ rootDirectory: f.root })(pathname), failure('LOCAL_RECOVERY_FILE_INVALID'));
});

test('a cached manifest does not allow its root to be replaced by a symlink', async t => {
  const f = await fixture(t);
  const reader = createLocalRecoveryReader({ rootDirectory: f.root });
  await reader(pathname);
  const moved = `${f.root}-moved`;
  t.after(() => rm(moved, { recursive: true, force: true }));
  await rename(f.root, moved);
  await symlink(moved, f.root);
  await assert.rejects(reader(pathname), failure('LOCAL_RECOVERY_FILE_INVALID'));
});
