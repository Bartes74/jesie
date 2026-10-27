import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BackupCryptoError, decryptBackup, encryptBackup } from './encrypt-backup';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const code = (expected: string) => (error: unknown) => error instanceof BackupCryptoError && error.code === expected;
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'jesie-encryption-test-')));
  const key = randomBytes(32);
  return { directory, key, path: (name: string) => join(directory, name), async cleanup() { key.fill(0); await rm(directory, { recursive: true, force: true }); } };
}

test('streaming AES-256-GCM restores a multi-chunk file exactly, keeps archives private and emits safe metadata only', async () => {
  const f = await fixture();
  try {
    const plaintext = Buffer.concat([Buffer.from('Synthetic private backup fixture, never a real credential.'), randomBytes(4 * 1024 * 1024 + 71)]);
    await writeFile(f.path('original.dump'), plaintext, { mode: 0o600 });
    const encrypted = await encryptBackup({ input: f.path('original.dump'), output: f.path('sealed.aesgcm'), key: f.key });
    const ciphertext = await readFile(f.path('sealed.aesgcm'));
    assert.equal(encrypted.inputSha256, digest(plaintext));
    assert.equal(encrypted.outputSha256, digest(ciphertext));
    assert.equal(encrypted.outputBytes, plaintext.length + 37);
    assert.equal(ciphertext.includes(plaintext.subarray(0, 40)), false);
    assert.equal(encrypted.nonceHex.length, 24); assert.equal(encrypted.tagHex.length, 32);
    const metadata = JSON.stringify(encrypted);
    assert.equal(metadata.includes(f.key.toString('hex')), false);
    assert.equal(metadata.includes(f.key.toString('base64')), false);
    assert.equal(metadata.includes('Synthetic private'), false);
    const decrypted = await decryptBackup({ input: f.path('sealed.aesgcm'), output: f.path('restored.dump'), key: f.key });
    assert.equal(digest(await readFile(f.path('restored.dump'))), digest(plaintext));
    assert.equal(decrypted.inputSha256, encrypted.outputSha256);
    assert.equal(decrypted.outputSha256, encrypted.inputSha256);
    assert.equal(decrypted.nonceHex, encrypted.nonceHex); assert.equal(decrypted.tagHex, encrypted.tagHex);
    for (const name of ['sealed.aesgcm', 'restored.dump']) assert.equal((await lstat(f.path(name))).mode & 0o777, 0o600);
    assert.equal(digest(await readFile(f.path('original.dump'))), digest(plaintext));
    assert.equal((await readdir(f.directory)).some(name => name.endsWith('.pending')), false);
  } finally { await f.cleanup(); }
});

test('empty files authenticate and each encryption receives a fresh nonce', async () => {
  const f = await fixture();
  try {
    await writeFile(f.path('empty'), Buffer.alloc(0));
    const first = await encryptBackup({ input: f.path('empty'), output: f.path('first'), key: f.key });
    const second = await encryptBackup({ input: f.path('empty'), output: f.path('second'), key: f.key });
    assert.equal(first.inputBytes, 0); assert.equal(first.outputBytes, 37);
    assert.notEqual(first.nonceHex, second.nonceHex); assert.notEqual(first.outputSha256, second.outputSha256);
    const decoded = await decryptBackup({ input: f.path('first'), output: f.path('restored'), key: f.key });
    assert.equal(decoded.outputBytes, 0); assert.equal((await readFile(f.path('restored'))).length, 0);
  } finally { await f.cleanup(); }
});

test('wrong keys, nonce/body/tag corruption and truncation never release plaintext or pending files', async () => {
  const f = await fixture();
  try {
    await writeFile(f.path('source'), randomBytes(257 * 1024 + 3));
    await encryptBackup({ input: f.path('source'), output: f.path('encrypted'), key: f.key });
    const original = await readFile(f.path('encrypted'));
    const changed = (offset: number) => { const value = Buffer.from(original); value[offset] ^= 1; return value; };
    const examples = [changed(9), changed(21 + 97), changed(original.length - 1), original.subarray(0, original.length - 7), Buffer.concat([original, Buffer.from([1])])];
    for (let index = 0; index < examples.length; index++) {
      await writeFile(f.path(`tampered-${index}`), examples[index]);
      await assert.rejects(decryptBackup({ input: f.path(`tampered-${index}`), output: f.path(`unreleased-${index}`), key: f.key }), code('BACKUP_INTEGRITY_FAILED'));
      await assert.rejects(lstat(f.path(`unreleased-${index}`)), { code: 'ENOENT' });
    }
    const wrongKey = randomBytes(32);
    try { await assert.rejects(decryptBackup({ input: f.path('encrypted'), output: f.path('wrong-key'), key: wrongKey }), code('BACKUP_INTEGRITY_FAILED')); }
    finally { wrongKey.fill(0); }
    assert.equal((await readdir(f.directory)).some(name => name.endsWith('.pending')), false);
    await assert.rejects(lstat(f.path('wrong-key')), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('header magic/version and tiny malformed files are rejected before plaintext output creation', async () => {
  const f = await fixture();
  try {
    await writeFile(f.path('source'), Buffer.from('fixture'));
    await encryptBackup({ input: f.path('source'), output: f.path('encrypted'), key: f.key });
    const original = await readFile(f.path('encrypted'));
    for (const [index, offset] of [0, 8].entries()) {
      const tampered = Buffer.from(original); tampered[offset] ^= 3;
      await writeFile(f.path(`header-${index}`), tampered);
      await assert.rejects(decryptBackup({ input: f.path(`header-${index}`), output: f.path(`output-${index}`), key: f.key }), code('BACKUP_FORMAT_UNSUPPORTED'));
      await assert.rejects(lstat(f.path(`output-${index}`)), { code: 'ENOENT' });
    }
    await writeFile(f.path('truncated'), original.subarray(0, 36));
    await assert.rejects(decryptBackup({ input: f.path('truncated'), output: f.path('short-output'), key: f.key }), code('BACKUP_FILE_TRUNCATED'));
  } finally { await f.cleanup(); }
});

test('encryption/decryption and same-file attempts cannot overwrite an existing file', async () => {
  const f = await fixture();
  try {
    const sentinel = Buffer.from('existing destination is retained');
    await writeFile(f.path('source'), Buffer.from('source fixture'));
    await writeFile(f.path('exists'), sentinel);
    await assert.rejects(encryptBackup({ input: f.path('source'), output: f.path('exists'), key: f.key }), code('BACKUP_OUTPUT_EXISTS'));
    await assert.rejects(encryptBackup({ input: f.path('source'), output: f.path('source'), key: f.key }), code('BACKUP_OUTPUT_EQUALS_INPUT'));
    await encryptBackup({ input: f.path('source'), output: f.path('encrypted'), key: f.key });
    await assert.rejects(decryptBackup({ input: f.path('encrypted'), output: f.path('exists'), key: f.key }), code('BACKUP_OUTPUT_EXISTS'));
    assert.equal(digest(await readFile(f.path('exists'))), digest(sentinel));
    assert.equal((await readdir(f.directory)).some(name => name.endsWith('.pending')), false);
  } finally { await f.cleanup(); }
});

test('only 32-byte keys and regular non-symlink inputs/output parents are accepted', async () => {
  const f = await fixture();
  try {
    await writeFile(f.path('source'), Buffer.from('source fixture'));
    await symlink(f.path('source'), f.path('source-link'));
    await symlink(f.directory, f.path('directory-link'));
    await assert.rejects(encryptBackup({ input: f.path('source'), output: f.path('invalid-key'), key: Buffer.alloc(31) }), code('BACKUP_KEY_LENGTH_INVALID'));
    await assert.rejects(encryptBackup({ input: f.path('source-link'), output: f.path('symlink-input'), key: f.key }), code('REGULAR_BACKUP_FILE_REQUIRED'));
    await assert.rejects(encryptBackup({ input: f.path('source'), output: join(f.path('directory-link'), 'unsafe-output'), key: f.key }), code('CANONICAL_BACKUP_DIRECTORY_REQUIRED'));
  } finally { await f.cleanup(); }
});
