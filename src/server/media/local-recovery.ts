import 'server-only';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export type LocalRecoveredContentType = 'image/png' | 'image/webp' | 'image/jpeg';
export type LocalRecoveryEntry = {
  file: string;
  byteLength: number;
  sha256: string;
  contentType: LocalRecoveredContentType;
};
export type LocalRecoveryManifest = { version: 1; entries: Record<string, LocalRecoveryEntry> };
export type LocalRecoveredMedia = { bytes: Buffer; contentType: LocalRecoveredContentType };

export class LocalMediaRecoveryError extends Error {
  constructor(public readonly code: 'LOCAL_RECOVERY_MANIFEST_INVALID' | 'LOCAL_RECOVERY_FILE_INVALID') {
    super(code);
    this.name = 'LocalMediaRecoveryError';
  }
}

const maximumBytes = 32 * 1024 * 1024;
const maximumManifestBytes = 1024 * 1024;
const validPathname = (value: string) => value.length <= 2000
  && /^ai\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:png|webp|jpe?g)$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value)
  && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const missing = (error: unknown) => object(error) && error.code === 'ENOENT';

function parseManifest(value: unknown): LocalRecoveryManifest {
  const invalid = () => new LocalMediaRecoveryError('LOCAL_RECOVERY_MANIFEST_INVALID');
  if (!object(value) || !exactKeys(value, ['version', 'entries']) || value.version !== 1 || !object(value.entries)) throw invalid();
  const entries: Record<string, LocalRecoveryEntry> = Object.create(null);
  const files = new Map<string, LocalRecoveryEntry>();
  for (const [pathname, input] of Object.entries(value.entries)) {
    if (!validPathname(pathname) || !object(input) || !exactKeys(input, ['file', 'byteLength', 'sha256', 'contentType'])
      || typeof input.file !== 'string' || typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256)
      || typeof input.byteLength !== 'number' || !Number.isSafeInteger(input.byteLength) || input.byteLength < 1 || input.byteLength > maximumBytes
      || !['image/png', 'image/webp', 'image/jpeg'].includes(String(input.contentType))) throw invalid();
    const extension = input.contentType === 'image/png' ? 'png' : input.contentType === 'image/webp' ? 'webp' : 'jpe?g';
    if (!new RegExp(`^${input.sha256}\\.(?:${extension})$`).test(input.file)) throw invalid();
    const entry = input as LocalRecoveryEntry;
    const shared = files.get(entry.file);
    if (shared && (shared.byteLength !== entry.byteLength || shared.contentType !== entry.contentType)) throw invalid();
    files.set(entry.file, entry);
    entries[pathname] = entry;
  }
  return { version: 1, entries };
}

function correctImageType(bytes: Buffer, contentType: LocalRecoveredContentType) {
  if (contentType === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (contentType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
}

/** Reads a bounded regular file and never follows a manifest or image symlink. */
async function readRegularFile(path: string, limit: number, code: LocalMediaRecoveryError['code']) {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // The recovery bundle is included explicitly in next.config.ts. Dynamic
    // filesystem tracing must not capture the surrounding project or secrets.
    const metadata = await lstat(/* turbopackIgnore: true */ path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > limit) throw new LocalMediaRecoveryError(code);
    handle = await open(/* turbopackIgnore: true */ path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const captured = await handle.stat();
    if (!captured.isFile() || captured.size !== metadata.size) throw new LocalMediaRecoveryError(code);
    // Reading one extra byte detects growth without allocating an unbounded file.
    const bytes = Buffer.alloc(captured.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const next = await handle.read(bytes, count, bytes.length - count, count);
      if (!next.bytesRead) break;
      count += next.bytesRead;
    }
    if (count !== captured.size || (await handle.stat()).size !== captured.size) throw new LocalMediaRecoveryError(code);
    return bytes.subarray(0, count);
  } finally {
    await handle?.close();
  }
}

/** Private fallback bytes still pass through the caller's existing authorization. */
export function createLocalRecoveryReader(options: { rootDirectory?: string } = {}) {
  const root = options.rootDirectory ?? join(process.cwd(), 'private-media', 'published-recovery');
  if (!isAbsolute(root)) throw new LocalMediaRecoveryError('LOCAL_RECOVERY_MANIFEST_INVALID');
  let captured: Promise<{ root: string; manifest: LocalRecoveryManifest } | null> | undefined;
  async function load() {
    try {
      const directory = await lstat(/* turbopackIgnore: true */ root);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new LocalMediaRecoveryError('LOCAL_RECOVERY_MANIFEST_INVALID');
      const canonicalRoot = await realpath(/* turbopackIgnore: true */ root);
      const bytes = await readRegularFile(join(canonicalRoot, 'manifest.json'), maximumManifestBytes, 'LOCAL_RECOVERY_MANIFEST_INVALID');
      return { root: canonicalRoot, manifest: parseManifest(JSON.parse(bytes.toString('utf8'))) };
    } catch (error) {
      if (missing(error)) return null;
      if (error instanceof LocalMediaRecoveryError) throw error;
      throw new LocalMediaRecoveryError('LOCAL_RECOVERY_MANIFEST_INVALID');
    }
  }
  return async (pathname: string): Promise<LocalRecoveredMedia | null> => {
    if (!validPathname(pathname)) return null;
    const stored = await (captured ??= load());
    const entry = stored?.manifest.entries[pathname];
    if (!stored || !entry) return null;
    try {
      const directory = await lstat(/* turbopackIgnore: true */ stored.root);
      if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(/* turbopackIgnore: true */ stored.root) !== stored.root) {
        throw new LocalMediaRecoveryError('LOCAL_RECOVERY_FILE_INVALID');
      }
      const file = resolve(stored.root, entry.file);
      if (file !== join(stored.root, entry.file)) throw new LocalMediaRecoveryError('LOCAL_RECOVERY_FILE_INVALID');
      const bytes = await readRegularFile(file, entry.byteLength, 'LOCAL_RECOVERY_FILE_INVALID');
      if (bytes.length !== entry.byteLength || createHash('sha256').update(bytes).digest('hex') !== entry.sha256
        || !correctImageType(bytes, entry.contentType)) throw new LocalMediaRecoveryError('LOCAL_RECOVERY_FILE_INVALID');
      return { bytes, contentType: entry.contentType };
    } catch (error) {
      if (error instanceof LocalMediaRecoveryError) throw error;
      throw new LocalMediaRecoveryError('LOCAL_RECOVERY_FILE_INVALID');
    }
  };
}

export const readLocalRecoveredMedia = createLocalRecoveryReader();
