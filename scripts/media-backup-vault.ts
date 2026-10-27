import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { get, list, type ListBlobResultBlob } from '@vercel/blob';
import { config } from 'dotenv';

/** A read-only Blob exporter. This file intentionally imports no remote put/del. */
export type VaultRoot = { label: string; path: string; category: 'application' | 'legacy'; device: number };
export type VaultEntry = {
  source: 'blob' | 'local'; root?: string; pathname: string;
  sha256: string; bytes: number; mode?: number; modifiedAt?: string;
  uploadedAt?: string; contentType?: string; etag?: string;
};
export type VaultManifest = {
  version: 1; checkpoint: string; startedAt: string; completedAt: string;
  roots: VaultRoot[]; entries: VaultEntry[];
  blobInventory: { stable: boolean; passes: number; count: number; bytes: number; checkedAt: string; digest: string };
  objects: { sha256: string; bytes: number }[];
  references?: { sha256: string; bytes: number; originalFile: string; requiredBlobCount?: number; closureVerified?: true };
  statistics: { logicalBytes: number; uniqueBytes: number; duplicateBytes: number; localFiles: number; blobFiles: number };
};
type RestoreReceipt = {
  version: 1; manifestSha256: string; verified: true; checkedAt: string;
  destination: string; destinationDevice: number; restoredFiles: number; restoredBytes: number;
};
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validLabel = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const validBytes = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const missing = (error: unknown) => object(error) && error.code === 'ENOENT';
function fail(code: string): never { throw new Error(code); }

export function safeRelativePath(pathname: unknown): string {
  if (typeof pathname !== 'string' || !pathname || pathname.length > 4000 || pathname.includes('\\') || pathname.includes('\0')
    || pathname.startsWith('/') || pathname.includes(':') || pathname.split('/').some(part => !part || part === '.' || part === '..')) fail('UNSAFE_RELATIVE_PATH');
  return pathname;
}
export function vaultObjectRelativePath(hash: string): string {
  if (!validHash(hash)) fail('INVALID_OBJECT_HASH');
  return `objects/sha256/${hash.slice(0, 2)}/${hash}`;
}
async function assertRegular(path: string, expectedBytes?: number) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (expectedBytes !== undefined && info.size !== expectedBytes)) fail('REGULAR_FILE_REQUIRED');
  return info;
}
async function regularDigest(path: string, expectedBytes?: number) {
  const before = await assertRegular(path, expectedBytes);
  const hash = createHash('sha256'); let bytes = 0;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const captured = await handle.stat();
    if (captured.ino !== before.ino || captured.dev !== before.dev || captured.size !== before.size) fail('SOURCE_CHANGED_DURING_OPEN');
    for await (const chunk of handle.createReadStream()) { bytes += chunk.length; hash.update(chunk); }
  } finally { await handle.close(); }
  const after = await assertRegular(path, expectedBytes);
  if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) fail('SOURCE_CHANGED_DURING_READ');
  return { sha256: hash.digest('hex'), bytes, info: before };
}
async function privateDirectory(path: string) {
  if (!isAbsolute(path)) fail('ABSOLUTE_PRIVATE_DIRECTORY_REQUIRED');
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== resolve(path)) fail('CANONICAL_DIRECTORY_REQUIRED');
  await chmod(path, 0o700);
}
async function jsonWrite(path: string, value: unknown) {
  await privateDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.pending`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}
async function objectExists(vault: string, hash: string, bytes: number) {
  const path = join(vault, vaultObjectRelativePath(hash));
  try {
    if ((await regularDigest(path, bytes)).sha256 !== hash) fail('VAULT_OBJECT_CORRUPT');
    return true;
  } catch (error) { if (missing(error)) return false; throw error; }
}
async function saveBytes(vault: string, bytes: Buffer) {
  const hash = digest(bytes); const path = join(vault, vaultObjectRelativePath(hash));
  if (await objectExists(vault, hash, bytes.length)) return { sha256: hash, bytes: bytes.length };
  await privateDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.pending`;
  await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
  if ((await regularDigest(temporary, bytes.length)).sha256 !== hash) fail('VAULT_WRITE_VERIFICATION_FAILED');
  await rename(temporary, path); await chmod(path, 0o400);
  return { sha256: hash, bytes: bytes.length };
}
async function legacyLinkTarget(vault: string, path: string) {
  const target = await realpath(path);
  const logical = relative(vault, target).split(sep).join('/');
  const matched = /^objects\/sha256\/([a-f0-9]{2})\/([a-f0-9]{64})$/.exec(logical);
  if (!matched || matched[1] !== matched[2].slice(0, 2) || !await objectExists(vault, matched[2], (await stat(target)).size)) fail('LEGACY_LINK_TARGET_INVALID');
  return target;
}
async function saveLocal(vault: string, path: string, allowLegacyVaultLink = false) {
  const metadata = await lstat(path);
  const sourcePath = metadata.isSymbolicLink() && allowLegacyVaultLink ? await legacyLinkTarget(vault, path) : path;
  const source = await regularDigest(sourcePath); const target = join(vault, vaultObjectRelativePath(source.sha256));
  if (!await objectExists(vault, source.sha256, source.bytes)) {
    await privateDirectory(dirname(target));
    const temporary = `${target}.${randomUUID()}.pending`;
    await copyFile(sourcePath, temporary, constants.COPYFILE_EXCL);
    if ((await regularDigest(temporary, source.bytes)).sha256 !== source.sha256) fail('LOCAL_COPY_VERIFICATION_FAILED');
    await rename(temporary, target); await chmod(target, 0o400);
  }
  return source;
}
async function localFiles(root: string, allowLegacyVaultLinks = false): Promise<string[]> {
  const result: string[] = [];
  async function walk(directory: string) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (!allowLegacyVaultLinks) fail('SOURCE_SYMLINK_REQUIRES_REHYDRATION');
        result.push(path);
      } else if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) result.push(path);
      else fail('NON_REGULAR_SOURCE_ENTRY');
    }
  }
  await walk(root); return result;
}
export function parseVaultManifest(value: unknown): VaultManifest {
  if (!object(value) || value.version !== 1 || !validLabel(value.checkpoint) || !Array.isArray(value.roots)
    || !Array.isArray(value.entries) || !Array.isArray(value.objects) || !object(value.blobInventory)
    || value.blobInventory.stable !== true || !object(value.statistics)) fail('INVALID_VAULT_MANIFEST');
  const labels = new Set<string>(); const hashes = new Map<string, number>(); const paths = new Set<string>();
  for (const root of value.roots) {
    if (!object(root) || !validLabel(root.label) || labels.has(root.label) || typeof root.path !== 'string' || !isAbsolute(root.path)
      || !['application', 'legacy'].includes(String(root.category)) || !validBytes(root.device)) fail('INVALID_VAULT_ROOT');
    labels.add(root.label);
  }
  for (const stored of value.objects) {
    if (!object(stored) || !validHash(stored.sha256) || !validBytes(stored.bytes) || hashes.has(stored.sha256)) fail('INVALID_VAULT_OBJECT');
    hashes.set(stored.sha256, stored.bytes);
  }
  for (const entry of value.entries) {
    if (!object(entry) || !['local', 'blob'].includes(String(entry.source)) || !validHash(entry.sha256) || !validBytes(entry.bytes)
      || hashes.get(entry.sha256) !== entry.bytes || (entry.source === 'local' && (!validLabel(entry.root) || !labels.has(entry.root)))
      || (entry.source === 'blob' && entry.root !== undefined)) fail('INVALID_VAULT_ENTRY');
    safeRelativePath(entry.pathname);
    const key = `${entry.source}:${entry.root ?? ''}:${entry.pathname}`;
    if (paths.has(key)) fail('DUPLICATE_MANIFEST_PATH'); paths.add(key);
  }
  if (value.references !== undefined && (!object(value.references) || !validHash(value.references.sha256)
    || !validBytes(value.references.bytes) || hashes.get(value.references.sha256) !== value.references.bytes)) fail('INVALID_VAULT_REFERENCES');
  return value as VaultManifest;
}
async function manifestRead(manifestPath: string) {
  await assertRegular(manifestPath);
  const bytes = await readFile(manifestPath);
  const manifest = parseVaultManifest(JSON.parse(bytes.toString('utf8')));
  const vault = resolve(dirname(manifestPath), '..', '..');
  if (manifestPath !== join(vault, 'checkpoints', manifest.checkpoint, 'manifest.private.json')) fail('MANIFEST_LOCATION_INVALID');
  const checksumPath = join(dirname(manifestPath), 'manifest.sha256');
  await assertRegular(checksumPath);
  const checksum = /^([a-f0-9]{64})  manifest\.private\.json\n?$/.exec(await readFile(checksumPath, 'utf8'));
  if (!checksum || checksum[1] !== digest(bytes)) fail('MANIFEST_CHECKSUM_MISMATCH');
  const directory = await lstat(vault);
  if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(vault) !== vault) fail('VAULT_DIRECTORY_INVALID');
  return { manifest, vault, manifestSha256: digest(bytes) };
}
export async function verifyVault(manifestPath: string) {
  const loaded = await manifestRead(manifestPath); let bytes = 0;
  for (const stored of loaded.manifest.objects) {
    if (!await objectExists(loaded.vault, stored.sha256, stored.bytes)) fail('VAULT_OBJECT_MISSING');
    bytes += stored.bytes;
  }
  return { ...loaded, objectCount: loaded.manifest.objects.length, verifiedBytes: bytes };
}
export async function mirrorVault(manifestPath: string, destinationVault: string) {
  const checked = await verifyVault(manifestPath);
  await privateDirectory(destinationVault);
  if ((await stat(destinationVault)).dev === (await stat(checked.vault)).dev) fail('INDEPENDENT_MIRROR_VOLUME_REQUIRED');
  for (const stored of checked.manifest.objects) {
    const source = join(checked.vault, vaultObjectRelativePath(stored.sha256));
    const target = join(destinationVault, vaultObjectRelativePath(stored.sha256));
    if (!await objectExists(destinationVault, stored.sha256, stored.bytes)) {
      await privateDirectory(dirname(target));
      await copyFile(source, target, constants.COPYFILE_EXCL); await chmod(target, 0o400);
      if ((await regularDigest(target, stored.bytes)).sha256 !== stored.sha256) fail('MIRROR_OBJECT_HASH_MISMATCH');
    }
  }
  const targetManifest = join(destinationVault, 'checkpoints', checked.manifest.checkpoint, 'manifest.private.json');
  await privateDirectory(dirname(targetManifest));
  try {
    if (digest(await readFile(targetManifest)) !== checked.manifestSha256) fail('MIRROR_CHECKPOINT_ALREADY_DIFFERS');
  } catch (error) {
    if (!missing(error)) throw error;
    await copyFile(manifestPath, targetManifest, constants.COPYFILE_EXCL); await chmod(targetManifest, 0o400);
    await writeFile(join(dirname(targetManifest), 'manifest.sha256'), checked.manifestSha256 + '  manifest.private.json\n', { mode: 0o400, flag: 'wx' });
  }
  const mirrored = await verifyVault(targetManifest);
  if (mirrored.manifestSha256 !== checked.manifestSha256) fail('MIRROR_MANIFEST_HASH_MISMATCH');
  await jsonWrite(join(dirname(targetManifest), 'independent-copy.private.json'), {
    version: 1, checkedAt: new Date().toISOString(), sourceVault: checked.vault, sourceDevice: (await stat(checked.vault)).dev,
    destinationVault, destinationDevice: (await stat(destinationVault)).dev, manifestSha256: checked.manifestSha256,
    objects: mirrored.objectCount, bytes: mirrored.verifiedBytes, ordinaryCopiedFiles: true, hardlinksUsed: false,
  });
  return { manifestPath: targetManifest, manifestSha256: mirrored.manifestSha256, objects: mirrored.objectCount, bytes: mirrored.verifiedBytes, independentVolume: true };
}
export async function restoreVault(manifestPath: string, destination: string) {
  const checked = await verifyVault(manifestPath);
  if (!isAbsolute(destination) || destination === checked.vault || destination.startsWith(checked.vault + sep)) fail('INDEPENDENT_RESTORE_DESTINATION_REQUIRED');
  try { if ((await readdir(destination)).length) fail('EMPTY_RESTORE_DESTINATION_REQUIRED'); }
  catch (error) { if (!missing(error)) throw error; }
  await privateDirectory(destination); let restoredBytes = 0;
  for (const root of checked.manifest.roots) await privateDirectory(join(destination, 'local', root.label));
  for (const entry of checked.manifest.entries) {
    const target = join(destination, entry.source === 'blob' ? 'blob' : `local/${entry.root}`, safeRelativePath(entry.pathname));
    await privateDirectory(dirname(target));
    await copyFile(join(checked.vault, vaultObjectRelativePath(entry.sha256)), target, constants.COPYFILE_EXCL);
    await chmod(target, 0o600);
    if ((await regularDigest(target, entry.bytes)).sha256 !== entry.sha256) fail('RESTORED_FILE_HASH_MISMATCH');
    if (entry.modifiedAt && Number.isFinite(Date.parse(entry.modifiedAt))) await utimes(target, new Date(entry.modifiedAt), new Date(entry.modifiedAt));
    restoredBytes += entry.bytes;
  }
  if (checked.manifest.references) {
    const reference = checked.manifest.references;
    const target = join(destination, 'metadata', 'db-media-references.private.json');
    await privateDirectory(dirname(target));
    await copyFile(join(checked.vault, vaultObjectRelativePath(reference.sha256)), target, constants.COPYFILE_EXCL);
    await chmod(target, 0o600);
    if ((await regularDigest(target, reference.bytes)).sha256 !== reference.sha256) fail('RESTORED_REFERENCE_HASH_MISMATCH');
    restoredBytes += reference.bytes;
  }
  const receipt: RestoreReceipt = { version: 1, manifestSha256: checked.manifestSha256, verified: true, checkedAt: new Date().toISOString(),
    destination, destinationDevice: (await stat(destination)).dev, restoredFiles: checked.manifest.entries.length, restoredBytes };
  await jsonWrite(join(destination, 'restore-receipt.private.json'), receipt);
  await jsonWrite(join(dirname(manifestPath), 'restore-receipt.private.json'), receipt);
  return receipt;
}
async function inventory(token: string) {
  const blobs: ListBlobResultBlob[] = []; let cursor: string | undefined;
  do {
    const page = await list({ token, limit: 1000, ...(cursor ? { cursor } : {}) });
    blobs.push(...page.blobs); cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  blobs.sort((a, b) => a.pathname.localeCompare(b.pathname));
  return { blobs, digest: digest(Buffer.from(JSON.stringify(blobs.map(item => [item.pathname, item.size, item.uploadedAt.toISOString()])))) };
}
export async function exportVault(options: { vault: string; checkpoint: string; roots: Omit<VaultRoot, 'device'>[]; token?: string; references?: string; concurrency?: number }) {
  if (!validLabel(options.checkpoint)) fail('INVALID_CHECKPOINT_LABEL');
  await privateDirectory(options.vault);
  const checkpointDirectory = join(options.vault, 'checkpoints', options.checkpoint);
  await privateDirectory(checkpointDirectory);
  const manifestPath = join(checkpointDirectory, 'manifest.private.json');
  try { await lstat(manifestPath); fail('IMMUTABLE_CHECKPOINT_ALREADY_EXISTS'); } catch (error) { if (!missing(error)) throw error; }
  const startedAt = new Date().toISOString(); const entries: VaultEntry[] = []; const roots: VaultRoot[] = [];
  for (const root of options.roots) {
    if (!validLabel(root.label) || !isAbsolute(root.path) || roots.some(value => value.label === root.label)
      || options.vault === root.path || options.vault.startsWith(root.path + sep)) fail('INVALID_LOCAL_SOURCE_ROOT');
    const canonical = await realpath(root.path);
    if (canonical !== resolve(root.path) || !(await lstat(root.path)).isDirectory()) fail('LOCAL_SOURCE_ROOT_INVALID');
    roots.push({ ...root, device: (await stat(root.path)).dev });
    for (const path of await localFiles(root.path, root.category === 'legacy')) {
      const stored = await saveLocal(options.vault, path, root.category === 'legacy');
      entries.push({ source: 'local', root: root.label, pathname: relative(root.path, path).split(sep).join('/'),
        sha256: stored.sha256, bytes: stored.bytes, mode: stored.info.mode & 0o777, modifiedAt: stored.info.mtime.toISOString() });
    }
    console.log(JSON.stringify({ stage: 'local_root_exported', label: root.label, files: entries.filter(entry => entry.root === root.label).length }));
  }
  const blobEntries = new Map<string, VaultEntry>(); let checkedAt = new Date().toISOString(); let passes = 0; let stable = !options.token;
  let previous = options.token ? await inventory(options.token) : { blobs: [], digest: digest(Buffer.from('[]')) };
  const progressPath = join(checkpointDirectory, 'progress.private.json');
  try {
    const old: unknown = JSON.parse(await readFile(progressPath, 'utf8'));
    if (!object(old) || !Array.isArray(old.blobEntries)) fail('INVALID_EXPORT_PROGRESS');
    const live = new Map(previous.blobs.map(blob => [blob.pathname, blob]));
    for (const entry of old.blobEntries) {
      if (!object(entry) || entry.source !== 'blob' || typeof entry.pathname !== 'string' || !validHash(entry.sha256) || !validBytes(entry.bytes)) fail('INVALID_EXPORT_PROGRESS_ENTRY');
      const current = live.get(entry.pathname);
      if (current && current.size === entry.bytes && current.uploadedAt.toISOString() === entry.uploadedAt
        && await objectExists(options.vault, entry.sha256, entry.bytes)) blobEntries.set(entry.pathname, entry as VaultEntry);
    }
  } catch (error) { if (!missing(error)) throw error; }
  // A consistent dump plus complete immutable object closure matters more than an
  // exact timestamp shared with an actively generating worker. Re-list until stable.
  while (options.token && passes < 4) {
    passes += 1; let next = 0; const errors: unknown[] = [];
    const candidates = previous.blobs.filter(blob => !blobEntries.has(blob.pathname));
    await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 3, Math.max(1, candidates.length)) }, async () => {
      while (next < candidates.length) {
        const candidate = candidates[next++];
        try {
          safeRelativePath(candidate.pathname);
          const response = await get(candidate.pathname, { token: options.token, access: 'private', useCache: false });
          if (!response || response.statusCode !== 200 || response.blob.pathname !== candidate.pathname || response.blob.size !== candidate.size) fail('BLOB_INVENTORY_READ_MISMATCH');
          const bytes = Buffer.from(await new Response(response.stream).arrayBuffer());
          if (bytes.length !== candidate.size) fail('BLOB_BYTE_COUNT_MISMATCH');
          const stored = await saveBytes(options.vault, bytes);
          blobEntries.set(candidate.pathname, { source: 'blob', pathname: candidate.pathname, ...stored,
            uploadedAt: response.blob.uploadedAt.toISOString(), contentType: response.blob.contentType, etag: response.blob.etag });
          if (blobEntries.size % 25 === 0) {
            await jsonWrite(progressPath, { startedAt, passes, blobEntries: [...blobEntries.values()] });
            console.log(JSON.stringify({ stage: 'blob_export', objects: blobEntries.size, inventoried: previous.blobs.length }));
          }
        } catch (error) { errors.push(error); break; }
      }
    }));
    await jsonWrite(progressPath, { startedAt, passes, blobEntries: [...blobEntries.values()] });
    if (errors.length) throw errors[0];
    const latest = await inventory(options.token); checkedAt = new Date().toISOString();
    stable = latest.digest === previous.digest;
    if (stable) break;
    // In-place object modification is never accepted as a stale checkpoint.
    for (const blob of latest.blobs) {
      const saved = blobEntries.get(blob.pathname);
      if (saved && (saved.bytes !== blob.size || saved.uploadedAt !== blob.uploadedAt.toISOString())) blobEntries.delete(blob.pathname);
    }
    previous = latest;
  }
  if (!stable) fail('BLOB_INVENTORY_STILL_CHANGING_RETRY_WITH_NEW_CHECKPOINT');
  // Retain downloaded objects that disappeared during capture as historical bytes,
  // but the current inventory count describes only the final live listing.
  entries.push(...[...blobEntries.values()].sort((a, b) => a.pathname.localeCompare(b.pathname)));
  const objects = new Map(entries.map(entry => [entry.sha256, { sha256: entry.sha256, bytes: entry.bytes }]));
  let references: VaultManifest['references'];
  if (options.references) {
    const stored = await saveLocal(options.vault, options.references);
    objects.set(stored.sha256, { sha256: stored.sha256, bytes: stored.bytes });
    references = { sha256: stored.sha256, bytes: stored.bytes, originalFile: options.references };
    const referenceBytes = await readFile(options.references);
    if (digest(referenceBytes) !== stored.sha256) fail('REFERENCE_FILE_CHANGED_DURING_CAPTURE');
    const document: unknown = JSON.parse(referenceBytes.toString('utf8'));
    if (object(document) && document.requiredBlobPathnames !== undefined) {
      if (!Array.isArray(document.requiredBlobPathnames)) fail('REFERENCE_PATHNAMES_ARRAY_REQUIRED');
      const required = new Set(document.requiredBlobPathnames.map(safeRelativePath));
      for (const pathname of required) if (!blobEntries.has(pathname)) fail('DATABASE_SNAPSHOT_BLOB_CLOSURE_INCOMPLETE');
      references.requiredBlobCount = required.size; references.closureVerified = true;
    }
  }
  const logicalBytes = entries.reduce((sum, entry) => sum + entry.bytes, references?.bytes ?? 0);
  const uniqueBytes = [...objects.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  const manifest: VaultManifest = { version: 1, checkpoint: options.checkpoint, startedAt, completedAt: new Date().toISOString(), roots, entries,
    blobInventory: { stable, passes, count: previous.blobs.length, bytes: previous.blobs.reduce((sum, blob) => sum + blob.size, 0), checkedAt, digest: previous.digest },
    objects: [...objects.values()].sort((a, b) => a.sha256.localeCompare(b.sha256)), ...(references ? { references } : {}),
    statistics: { logicalBytes, uniqueBytes, duplicateBytes: logicalBytes - uniqueBytes, localFiles: entries.filter(entry => entry.source === 'local').length, blobFiles: blobEntries.size } };
  await jsonWrite(manifestPath, manifest); await chmod(manifestPath, 0o400);
  await writeFile(join(checkpointDirectory, 'manifest.sha256'), digest(await readFile(manifestPath)) + '  manifest.private.json\n', { mode: 0o400, flag: 'wx' });
  await verifyVault(manifestPath);
  return { manifestPath, ...manifest.statistics, blobInventory: manifest.blobInventory };
}
export async function consolidationPlan(manifestPath: string, legacyRoot: string) {
  const checked = await verifyVault(manifestPath);
  const root = checked.manifest.roots.find(value => value.category === 'legacy' && value.path === legacyRoot);
  if (!root || legacyRoot === checked.vault || checked.vault.startsWith(legacyRoot + sep)) fail('EXACT_LEGACY_BACKUP_ROOT_REQUIRED');
  if (legacyRoot === process.cwd() || legacyRoot.startsWith(resolve(process.cwd()) + sep)) fail('APPLICATION_ROOT_CONSOLIDATION_FORBIDDEN');
  if (await realpath(legacyRoot) !== legacyRoot) fail('CANONICAL_LEGACY_ROOT_REQUIRED');
  const candidates = checked.manifest.entries.filter(entry => entry.source === 'local' && entry.root === root.label);
  return { checked, root, candidates, reclaimableBytes: candidates.reduce((sum, entry) => sum + entry.bytes, 0) };
}
async function restoredReceipt(path: string, checked: Awaited<ReturnType<typeof verifyVault>>) {
  await assertRegular(path);
  const receipt: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!object(receipt) || receipt.version !== 1 || receipt.verified !== true || receipt.manifestSha256 !== checked.manifestSha256
    || receipt.restoredFiles !== checked.manifest.entries.length || typeof receipt.destination !== 'string' || !isAbsolute(receipt.destination)
    || !validBytes(receipt.destinationDevice)) fail('VERIFIED_FULL_RESTORE_RECEIPT_REQUIRED');
  if (await realpath(receipt.destination) !== receipt.destination || (await lstat(receipt.destination)).isSymbolicLink()
    || (await stat(receipt.destination)).dev !== receipt.destinationDevice) fail('RESTORE_RECEIPT_DESTINATION_CHANGED');
  return receipt as RestoreReceipt;
}
async function legacySourceMatches(source: string, target: string, entry: VaultEntry) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    if (await realpath(source) !== target || (await regularDigest(target, entry.bytes)).sha256 !== entry.sha256) fail('LEGACY_LINK_TARGET_INVALID');
    return 'already-consolidated' as const;
  }
  if ((await regularDigest(source, entry.bytes)).sha256 !== entry.sha256) fail('LEGACY_SOURCE_CHANGED');
  return 'regular-source' as const;
}
export async function consolidateLegacy(manifestPath: string, legacyRoot: string, restoreReceiptPath: string, secondReceiptPath: string) {
  const plan = await consolidationPlan(manifestPath, legacyRoot);
  const receipt = await restoredReceipt(restoreReceiptPath, plan.checked);
  const secondReceipt = await restoredReceipt(secondReceiptPath, plan.checked);
  if (receipt.destinationDevice === secondReceipt.destinationDevice) fail('TWO_INDEPENDENT_RESTORE_VOLUMES_REQUIRED');
  // The receipt alone is insufficient: all reconstructed legacy files are checked
  // again immediately before original backup paths become transparent symlinks.
  const journalPath = join(dirname(manifestPath), 'legacy-consolidation.private.json');
  const journal: { path: string; sha256: string; bytes: number; status: string }[] = [];
  // Preflight the complete legacy tree before replacing the first duplicate.
  for (const entry of plan.candidates) {
    for (const copy of [receipt, secondReceipt]) {
      const restored = join(copy.destination, 'local', plan.root.label, safeRelativePath(entry.pathname));
      if ((await regularDigest(restored, entry.bytes)).sha256 !== entry.sha256) fail('RESTORED_LEGACY_HASH_MISMATCH');
    }
    const source = join(legacyRoot, safeRelativePath(entry.pathname));
    await legacySourceMatches(source, join(plan.checked.vault, vaultObjectRelativePath(entry.sha256)), entry);
  }
  for (const entry of plan.candidates) {
    const restored = join(receipt.destination, 'local', plan.root.label, safeRelativePath(entry.pathname));
    if ((await regularDigest(restored, entry.bytes)).sha256 !== entry.sha256) fail('RESTORED_LEGACY_HASH_MISMATCH');
    const source = join(legacyRoot, safeRelativePath(entry.pathname));
    const target = join(plan.checked.vault, vaultObjectRelativePath(entry.sha256));
    if (await legacySourceMatches(source, target, entry) === 'already-consolidated') {
      journal.push({ path: source, sha256: entry.sha256, bytes: entry.bytes, status: 'already-consolidated' }); continue;
    }
    const temporary = `${source}.${randomUUID()}.vault-link`;
    await symlink(relative(dirname(source), target), temporary);
    if (digest(await readFile(temporary)) !== entry.sha256) { await unlink(temporary); fail('LEGACY_LINK_VERIFICATION_FAILED'); }
    // Do not unlink an original that changed while its replacement was prepared.
    if (await legacySourceMatches(source, target, entry) !== 'regular-source') { await unlink(temporary); fail('LEGACY_SOURCE_CHANGED_DURING_LINK_PREPARATION'); }
    // rename atomically swaps the verified duplicate for its verified immutable
    // canonical object. Application/recovery bundle files are never changed.
    await rename(temporary, source);
    if (await realpath(source) !== target || digest(await readFile(source)) !== entry.sha256) fail('CONSOLIDATED_PATH_HASH_MISMATCH');
    journal.push({ path: source, sha256: entry.sha256, bytes: entry.bytes, status: 'replaced-with-verified-vault-link' });
    if (journal.length % 25 === 0) await jsonWrite(journalPath, { version: 1, manifestSha256: plan.checked.manifestSha256, checkedAt: new Date().toISOString(), entries: journal });
  }
  await jsonWrite(journalPath, { version: 1, manifestSha256: plan.checked.manifestSha256, completedAt: new Date().toISOString(), entries: journal });
  const removed = journal.filter(entry => entry.status === 'replaced-with-verified-vault-link');
  return { consolidatedFiles: journal.length, newlyConsolidatedFiles: removed.length,
    logicalBytesRemoved: removed.reduce((sum, entry) => sum + entry.bytes, 0), applicationFilesChanged: 0, remoteFilesChanged: 0 };
}
const option = (name: string) => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
async function main() {
  const mode = process.argv[2];
  if (mode === 'export') {
    config({ path: option('--env') ?? '.env.production.local', quiet: true });
    const vault = option('--vault'), checkpoint = option('--checkpoint');
    if (!vault || !checkpoint || !isAbsolute(vault)) fail('ABSOLUTE_VAULT_AND_CHECKPOINT_REQUIRED');
    const local = process.argv.filter(arg => arg.startsWith('--local=')).map(arg => {
      const match = /^--local=([A-Za-z0-9_-]+):(.*)$/.exec(arg); if (!match) fail('INVALID_LOCAL_ARGUMENT');
      return { label: match[1], path: resolve(match[2]), category: 'application' as const };
    });
    const roots: Omit<VaultRoot, 'device'>[] = local.length ? local : [
      { label: 'app-public', path: resolve('public'), category: 'application' },
      { label: 'app-private-media', path: resolve('private-media'), category: 'application' },
      { label: 'legacy-media-backup', path: option('--legacy-root') ?? '/Volumes/Projekty/jesie-private-media-backup', category: 'legacy' },
    ];
    const token = process.argv.includes('--local-only') ? undefined : process.env.BLOB_READ_WRITE_TOKEN;
    if (!token && !process.argv.includes('--local-only')) fail('BLOB_TOKEN_REQUIRED');
    console.log(JSON.stringify(await exportVault({ vault, checkpoint, roots, token, references: option('--references') }), null, 2));
  } else {
    const manifest = option('--manifest'); if (!manifest || !isAbsolute(manifest)) fail('ABSOLUTE_MANIFEST_REQUIRED');
    if (mode === 'verify') {
      const result = await verifyVault(manifest);
      console.log(JSON.stringify({ verified: true, manifestSha256: result.manifestSha256, objects: result.objectCount, bytes: result.verifiedBytes, entries: result.manifest.entries.length }));
    } else if (mode === 'mirror') {
      const destination = option('--destination-vault'); if (!destination || !isAbsolute(destination)) fail('ABSOLUTE_DESTINATION_VAULT_REQUIRED');
      console.log(JSON.stringify(await mirrorVault(manifest, destination)));
    } else if (mode === 'restore') {
      const destination = option('--destination'); if (!destination) fail('RESTORE_DESTINATION_REQUIRED');
      console.log(JSON.stringify(await restoreVault(manifest, destination)));
    } else if (mode === 'dedup-plan' || mode === 'dedup-apply') {
      const legacyRoot = option('--legacy-root'); if (!legacyRoot || !isAbsolute(legacyRoot)) fail('EXACT_LEGACY_BACKUP_ROOT_REQUIRED');
      if (mode === 'dedup-plan') {
        const plan = await consolidationPlan(manifest, legacyRoot);
        console.log(JSON.stringify({ eligibleFiles: plan.candidates.length, logicalBytesReclaimed: plan.reclaimableBytes, verifiedRestoreRequired: true, remoteMutation: false, applicationMutation: false }));
      } else {
        const receipt = option('--restore-receipt'), secondReceipt = option('--second-restore-receipt');
        if (!receipt || !secondReceipt) fail('TWO_VERIFIED_RESTORE_RECEIPTS_REQUIRED');
        console.log(JSON.stringify(await consolidateLegacy(manifest, legacyRoot, receipt, secondReceipt)));
      }
    } else fail('MODE_EXPORT_VERIFY_MIRROR_RESTORE_DEDUP_PLAN_OR_DEDUP_APPLY_REQUIRED');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    const code = error instanceof Error && /^[A-Z0-9_]{1,120}$/.test(error.message) ? error.message : 'PRIVATE_BACKUP_OPERATION_FAILED';
    console.error(JSON.stringify({ ok: false, code })); process.exitCode = 1;
  });
}
