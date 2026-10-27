import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { link, lstat, open, realpath, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

export const backupKeyService = 'jesie-backup-2026';
export const backupKeyAccount = 'aes256gcm-v1';
export const backupKeychainHelper = '/Users/master/Library/Application Support/jesie-backups/tools/backup-keychain';
const magic = Buffer.from('JESIEBKP', 'ascii');
const formatVersion = 1;
const nonceBytes = 12;
const tagBytes = 16;
const headerBytes = magic.length + 1 + nonceBytes;
const maximumPlaintextBytes = (2 ** 32 - 2) * 16;
type FileHandle = Awaited<ReturnType<typeof open>>;
export type BackupCryptoResult = {
  version: 1; algorithm: 'AES-256-GCM'; mode: 'encrypt' | 'decrypt';
  keyService: typeof backupKeyService; keyAccount: typeof backupKeyAccount;
  inputBytes: number; outputBytes: number; inputSha256: string; outputSha256: string;
  nonceHex: string; tagHex: string;
};
export class BackupCryptoError extends Error {
  constructor(public readonly code: string, public readonly status?: number) { super(code); this.name = 'BackupCryptoError'; }
}
function fail(code: string, status?: number): never { throw new BackupCryptoError(code, status); }
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

function checkedKey(key: Buffer) {
  if (!Buffer.isBuffer(key) || key.length !== 32) fail('BACKUP_KEY_LENGTH_INVALID');
}
async function sourceFile(input: string) {
  const path = resolve(input);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || !Number.isSafeInteger(metadata.size)) fail('REGULAR_BACKUP_FILE_REQUIRED');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const captured = await handle.stat();
    if (!captured.isFile() || captured.ino !== metadata.ino || captured.dev !== metadata.dev
      || captured.size !== metadata.size || captured.mtimeMs !== metadata.mtimeMs || captured.ctimeMs !== metadata.ctimeMs) fail('BACKUP_SOURCE_CHANGED');
    return { path, handle, captured };
  } catch (error) { await handle.close(); throw error; }
}
async function confirmUnchanged(source: Awaited<ReturnType<typeof sourceFile>>) {
  const after = await source.handle.stat();
  const pathAfter = await lstat(source.path);
  for (const entry of [after, pathAfter]) {
    if (!entry.isFile() || entry.isSymbolicLink() || entry.ino !== source.captured.ino || entry.dev !== source.captured.dev
      || entry.size !== source.captured.size || entry.mtimeMs !== source.captured.mtimeMs || entry.ctimeMs !== source.captured.ctimeMs) fail('BACKUP_SOURCE_CHANGED');
  }
}
async function outputFile(output: string, inputPath?: string) {
  const path = resolve(output);
  if (path === inputPath) fail('BACKUP_OUTPUT_EQUALS_INPUT');
  const parent = dirname(path);
  const directory = await lstat(parent);
  if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(parent) !== parent) fail('CANONICAL_BACKUP_DIRECTORY_REQUIRED');
  try { await lstat(path); fail('BACKUP_OUTPUT_EXISTS'); }
  catch (error) { if (!missing(error)) throw error; }
  const temporary = join(parent, `.jesie-backup-${randomUUID()}.pending`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.chmod(0o600); }
  catch (error) { await handle.close(); await unlink(temporary).catch(() => {}); throw error; }
  let closed = false;
  let published = false;
  return {
    handle,
    async commit() {
      await handle.sync(); await handle.close(); closed = true;
      try { await link(temporary, path); }
      catch (error) { if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') fail('BACKUP_OUTPUT_EXISTS'); throw error; }
      published = true; await unlink(temporary);
    },
    async cleanup() {
      if (!closed) await handle.close().catch(() => {});
      // The final name appears only after a completely authenticated operation.
      if (!published) await unlink(temporary).catch(() => {});
    },
  };
}
async function writeAt(handle: FileHandle, bytes: Buffer, position: number) {
  let written = 0;
  while (written < bytes.length) {
    const next = await handle.write(bytes, written, bytes.length - written, position + written);
    if (!next.bytesWritten) fail('BACKUP_WRITE_INCOMPLETE');
    written += next.bytesWritten;
  }
}
async function readAt(handle: FileHandle, bytes: number, position: number) {
  const buffer = Buffer.alloc(bytes); let count = 0;
  while (count < bytes) {
    const next = await handle.read(buffer, count, bytes - count, position + count);
    if (!next.bytesRead) fail('BACKUP_FILE_TRUNCATED');
    count += next.bytesRead;
  }
  return buffer;
}
function meter(hash: ReturnType<typeof createHash>, onBytes: (bytes: number) => void) {
  return new Transform({ transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); onBytes(chunk.length); callback(null, chunk); } });
}
function result(mode: BackupCryptoResult['mode'], inputBytes: number, outputBytes: number,
  inputHash: ReturnType<typeof createHash>, outputHash: ReturnType<typeof createHash>, nonce: Buffer, tag: Buffer): BackupCryptoResult {
  return { version: 1, algorithm: 'AES-256-GCM', mode, keyService: backupKeyService, keyAccount: backupKeyAccount,
    inputBytes, outputBytes, inputSha256: inputHash.digest('hex'), outputSha256: outputHash.digest('hex'),
    nonceHex: nonce.toString('hex'), tagHex: tag.toString('hex') };
}

/** Streaming, authenticated encryption. The injected key is for callers/tests; CLI reads Keychain only. */
export async function encryptBackup(options: { input: string; output: string; key: Buffer }): Promise<BackupCryptoResult> {
  checkedKey(options.key);
  const source = await sourceFile(options.input);
  let output: Awaited<ReturnType<typeof outputFile>> | undefined;
  try {
    if (source.captured.size > maximumPlaintextBytes) fail('BACKUP_TOO_LARGE_FOR_GCM');
    output = await outputFile(options.output, source.path);
    const nonce = randomBytes(nonceBytes);
    const header = Buffer.concat([magic, Buffer.from([formatVersion]), nonce]);
    const cipher = createCipheriv('aes-256-gcm', options.key, nonce, { authTagLength: tagBytes });
    cipher.setAAD(header);
    const inputHash = createHash('sha256'); const outputHash = createHash('sha256'); outputHash.update(header);
    let inputBytes = 0, ciphertextBytes = 0;
    await writeAt(output.handle, header, 0);
    await pipeline(createReadStream(source.path, { fd: source.handle.fd, autoClose: false, start: 0 }),
      meter(inputHash, bytes => { inputBytes += bytes; }), cipher,
      meter(outputHash, bytes => { ciphertextBytes += bytes; }),
      createWriteStream('', { fd: output.handle.fd, autoClose: false, start: header.length }));
    if (inputBytes !== source.captured.size || ciphertextBytes !== inputBytes) fail('BACKUP_SOURCE_CHANGED');
    await confirmUnchanged(source);
    const tag = cipher.getAuthTag(); outputHash.update(tag);
    await writeAt(output.handle, tag, header.length + ciphertextBytes);
    await output.commit();
    return result('encrypt', inputBytes, header.length + ciphertextBytes + tag.length, inputHash, outputHash, nonce, tag);
  } finally { await output?.cleanup(); await source.handle.close(); }
}

/** A plaintext final file is created only after GCM authentication has succeeded. */
export async function decryptBackup(options: { input: string; output: string; key: Buffer }): Promise<BackupCryptoResult> {
  checkedKey(options.key);
  const source = await sourceFile(options.input);
  let output: Awaited<ReturnType<typeof outputFile>> | undefined;
  try {
    if (source.captured.size < headerBytes + tagBytes) fail('BACKUP_FILE_TRUNCATED');
    const header = await readAt(source.handle, headerBytes, 0);
    if (!header.subarray(0, magic.length).equals(magic) || header[magic.length] !== formatVersion) fail('BACKUP_FORMAT_UNSUPPORTED');
    const nonce = header.subarray(magic.length + 1);
    const ciphertextBytes = source.captured.size - headerBytes - tagBytes;
    if (ciphertextBytes > maximumPlaintextBytes) fail('BACKUP_TOO_LARGE_FOR_GCM');
    const tag = await readAt(source.handle, tagBytes, source.captured.size - tagBytes);
    output = await outputFile(options.output, source.path);
    const decipher = createDecipheriv('aes-256-gcm', options.key, nonce, { authTagLength: tagBytes });
    decipher.setAAD(header); decipher.setAuthTag(tag);
    const inputHash = createHash('sha256'); inputHash.update(header);
    const outputHash = createHash('sha256'); let encryptedCount = 0, outputBytes = 0;
    const body = ciphertextBytes ? createReadStream(source.path, { fd: source.handle.fd, autoClose: false,
      start: headerBytes, end: source.captured.size - tagBytes - 1 }) : Readable.from([]);
    try {
      await pipeline(body, meter(inputHash, bytes => { encryptedCount += bytes; }), decipher,
        meter(outputHash, bytes => { outputBytes += bytes; }),
        createWriteStream('', { fd: output.handle.fd, autoClose: false, start: 0 }));
    } catch (error) {
      if (error instanceof Error && /^(Unsupported state or unable to authenticate data|Authentication failed)/.test(error.message)) fail('BACKUP_INTEGRITY_FAILED');
      throw error;
    }
    if (encryptedCount !== ciphertextBytes || outputBytes !== ciphertextBytes) fail('BACKUP_INTEGRITY_FAILED');
    inputHash.update(tag); await confirmUnchanged(source);
    await output.commit();
    return result('decrypt', source.captured.size, outputBytes, inputHash, outputHash, nonce, tag);
  } finally { await output?.cleanup(); await source.handle.close(); }
}

function keychainCall(mode: 'create' | 'read', key?: Buffer): Promise<Buffer> {
  return new Promise((resolveCall, reject) => {
    // Key bytes use stdin/stdout pipes, never command arguments or tool output.
    const child = spawn(backupKeychainHelper, [mode], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [], stderr: Buffer[] = []; let bytes = 0;
    const timer = setTimeout(() => { child.kill(); reject(new BackupCryptoError('BACKUP_KEYCHAIN_TIMEOUT')); }, 15_000);
    child.stdout.on('data', (value: Buffer) => { bytes += value.length; if (bytes <= 4096) stdout.push(value); else child.kill(); });
    child.stderr.on('data', (value: Buffer) => { if (stderr.reduce((sum, part) => sum + part.length, 0) + value.length <= 4096) stderr.push(value); });
    child.on('error', () => { clearTimeout(timer); reject(new BackupCryptoError('BACKUP_KEYCHAIN_HELPER_UNAVAILABLE')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || bytes > 4096) {
        let status: number | undefined;
        try { const safe = JSON.parse(Buffer.concat(stderr).toString('utf8')); if (Number.isInteger(safe.status)) status = safe.status; } catch { /* Never forward arbitrary stderr or messages. */ }
        reject(new BackupCryptoError('BACKUP_KEYCHAIN_UNAVAILABLE', status));
      } else {
        const captured = Buffer.concat(stdout);
        for (const part of stdout) part.fill(0);
        resolveCall(captured);
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(key);
  });
}
export async function readBackupKey(): Promise<Buffer> {
  const key = await keychainCall('read'); checkedKey(key); return key;
}
export async function ensureBackupKey(): Promise<{ created: boolean; keyService: string; keyAccount: string }> {
  const candidate = randomBytes(32); let key: Buffer | undefined;
  try {
    const response = JSON.parse((await keychainCall('create', candidate)).toString('utf8')) as { created?: unknown; keyService?: unknown; keyAccount?: unknown };
    if (typeof response.created !== 'boolean' || response.keyService !== backupKeyService || response.keyAccount !== backupKeyAccount) fail('BACKUP_KEYCHAIN_RESPONSE_INVALID');
    key = await readBackupKey();
    if (response.created && !timingSafeEqual(candidate, key)) fail('BACKUP_KEYCHAIN_VERIFICATION_FAILED');
    const second = await readBackupKey();
    try { if (!timingSafeEqual(key, second)) fail('BACKUP_KEYCHAIN_VERIFICATION_FAILED'); }
    finally { second.fill(0); }
    return { created: response.created, keyService: backupKeyService, keyAccount: backupKeyAccount };
  } finally { candidate.fill(0); key?.fill(0); }
}

async function exportKey(outputPath: string) {
  const key = await readBackupKey(); let output: Awaited<ReturnType<typeof outputFile>> | undefined;
  try { output = await outputFile(outputPath); await writeAt(output.handle, key, 0); await output.commit(); }
  finally { key.fill(0); await output?.cleanup(); }
  // Export is deliberately opt-in. No key bytes, hex, base64 or key digest are logged.
  return { version: 1, exportedBytes: 32, keyService: backupKeyService, keyAccount: backupKeyAccount };
}
const option = (name: string) => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
async function main() {
  const mode = process.argv[2];
  if (mode === 'ensure-key') { console.log(JSON.stringify({ ok: true, ...await ensureBackupKey() })); return; }
  const output = option('--output');
  if (!output) fail('EXPLICIT_BACKUP_OUTPUT_REQUIRED');
  if (mode === 'export-key') { console.log(JSON.stringify({ ok: true, ...await exportKey(output) })); return; }
  const input = option('--input');
  if (!input || !['encrypt', 'decrypt'].includes(mode)) fail('BACKUP_MODE_AND_INPUT_REQUIRED');
  const key = await readBackupKey();
  try { console.log(JSON.stringify({ ok: true, ...await (mode === 'encrypt' ? encryptBackup : decryptBackup)({ input, output, key }) })); }
  finally { key.fill(0); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    const safe = error instanceof BackupCryptoError ? error : new BackupCryptoError('BACKUP_CRYPTO_FAILED');
    console.error(JSON.stringify({ ok: false, code: safe.code, ...(safe.status !== undefined ? { status: safe.status } : {}), keyService: backupKeyService }));
    process.exitCode = 1;
  });
}
