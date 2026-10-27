import 'server-only';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { copyMediaBackupPage } from '@/server/media-backup/objects';
import { CloudBackupError, type BackupEncryption, type PrivateBackupBlobStore } from '@/server/media-backup/types';

const roots = [
  ['app-public/images', 'public/images'],
  ['app-private/provider-recovery', 'private-media/provider-recovery'],
  ['app-private/published-recovery', 'private-media/published-recovery'],
  ['app-private/quota-public-recovery', 'private-media/quota-public-recovery'],
] as const;
const maximumObjectBytes = 32 * 1024 * 1024;
const maximumManifestBytes = 1024 * 1024;
// A virtual source has no Blob upload time. OS mtimes differ between function
// instances; exact content identity is supplied by the SHA-256 ETag instead.
const virtualUploadedAt = '1970-01-01T00:00:00.000Z';
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const allowedFilename = (name: string) => name === 'manifest.json' || /^[a-zA-Z0-9_-]+\.(?:webp|png|jpe?g|gif|avif|svg|ico)$/.test(name);
type Entry = { pathname: string; file: string; size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number };

/** Explicit roots only; configuration, credentials and repository contents have no source pathname. */
export function createBundledMediaSource(options: { projectDirectory?: string } = {}) {
  const projectDirectory = options.projectDirectory ?? process.cwd();
  if (!isAbsolute(projectDirectory)) throw new CloudBackupError('BUNDLED_BACKUP_ROOT_INVALID');
  async function rootDirectory() {
    return realpath(/* turbopackIgnore: true */ projectDirectory);
  }
  async function inventory(): Promise<Entry[]> {
    const project = await rootDirectory();
    const files: Entry[] = [];
    let directories = 0;
    async function walk(directory: string, prefix: string, root: string, depth: number) {
      if (++directories > 500 || depth > 10) throw new CloudBackupError('BUNDLED_BACKUP_INVENTORY_LIMIT');
      const directoryStat = await lstat(/* turbopackIgnore: true */ directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || await realpath(/* turbopackIgnore: true */ directory) !== directory
        || directory !== root && !directory.startsWith(root + sep)) throw new CloudBackupError('BUNDLED_BACKUP_PATH_INVALID');
      for (const entry of await readdir(/* turbopackIgnore: true */ directory, { withFileTypes: true })) {
        // Hidden files (.env, .git, .DS_Store, etc.) are never read or backed up.
        if (entry.name.startsWith('.')) continue;
        const file = join(directory, entry.name);
        const metadata = await lstat(/* turbopackIgnore: true */ file);
        if (metadata.isSymbolicLink()) throw new CloudBackupError('BUNDLED_BACKUP_SYMLINK_REJECTED');
        if (metadata.isDirectory()) {
          if (!/^[a-zA-Z0-9_-]+$/.test(entry.name)) throw new CloudBackupError('BUNDLED_BACKUP_PATH_INVALID');
          await walk(file, `${prefix}/${entry.name}`, root, depth + 1);
        } else if (metadata.isFile() && allowedFilename(entry.name)) {
          if (metadata.size > maximumObjectBytes || files.length >= 10_000) throw new CloudBackupError('BUNDLED_BACKUP_INVENTORY_LIMIT');
          files.push({ pathname: `${prefix}/${entry.name}`, file, size: metadata.size, mtimeMs: metadata.mtimeMs, ctimeMs: metadata.ctimeMs, ino: metadata.ino, dev: metadata.dev });
        }
      }
    }
    for (const [prefix, directory] of roots) {
      const root = join(project, directory);
      await walk(root, prefix, root, 0);
    }
    return files.sort((a, b) => a.pathname.localeCompare(b.pathname));
  }
  async function readEntry(entry: Entry, maximumBytes: number) {
    if (entry.size > maximumBytes) throw new CloudBackupError('BUNDLED_BACKUP_FILE_TOO_LARGE');
    const project = await rootDirectory();
    const [prefix, directory] = roots.find(([prefix]) => entry.pathname.startsWith(prefix + '/')) ?? [];
    if (!prefix || !directory) throw new CloudBackupError('BUNDLED_BACKUP_PATH_INVALID');
    const root = join(project, directory);
    const rootStat = await lstat(/* turbopackIgnore: true */ root);
    const canonical = await realpath(/* turbopackIgnore: true */ entry.file);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || canonical !== entry.file || !canonical.startsWith(root + sep)
      || relative(root, canonical).startsWith('..')) throw new CloudBackupError('BUNDLED_BACKUP_PATH_INVALID');
    const handle = await open(/* turbopackIgnore: true */ entry.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size !== entry.size || before.ino !== entry.ino || before.dev !== entry.dev
        || before.mtimeMs !== entry.mtimeMs || before.ctimeMs !== entry.ctimeMs) throw new CloudBackupError('BUNDLED_BACKUP_FILE_CHANGED');
      const bytes = Buffer.alloc(entry.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const next = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!next.bytesRead) break;
        offset += next.bytesRead;
      }
      const after = await handle.stat();
      if (offset !== entry.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || await realpath(/* turbopackIgnore: true */ entry.file) !== entry.file) throw new CloudBackupError('BUNDLED_BACKUP_FILE_CHANGED');
      const content = bytes.subarray(0, offset);
      return { pathname: entry.pathname, size: content.length, etag: `"sha256:${digest(content)}"`, uploadedAt: virtualUploadedAt, bytes: content };
    } finally { await handle.close(); }
  }
  async function aliasBindings(entries: Entry[]) {
    const bindings = new Map<string, { sha256: string; size: number; aliases: string[] }>();
    const canonical = new Map<string, string>();
    const providerEntry = entries.find(entry => entry.pathname === 'app-private/provider-recovery/manifest.json');
    if (!providerEntry) throw new CloudBackupError('BUNDLED_RECOVERY_MANIFEST_MISSING');
    const providerManifest = await readEntry(providerEntry, maximumManifestBytes);
    let providerRows: unknown;
    try { providerRows = JSON.parse(providerManifest.bytes.toString('utf8')); } catch { throw new CloudBackupError('BUNDLED_ALIAS_MANIFEST_INVALID'); }
    if (!Array.isArray(providerRows) || providerRows.length > 100) throw new CloudBackupError('BUNDLED_ALIAS_MANIFEST_INVALID');
    for (const row of providerRows) {
      if (!row || typeof row !== 'object' || !/^[a-f0-9-]{36}$/.test(row.jobId) || !/^[A-Za-z0-9_-]{1,100}$/.test(row.requestId)
        || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > maximumObjectBytes) throw new CloudBackupError('BUNDLED_ALIAS_MANIFEST_INVALID');
      const sourcePath = `app-private/provider-recovery/${row.jobId}.webp`;
      if (!entries.some(entry => entry.pathname === sourcePath)) throw new CloudBackupError('BUNDLED_ALIAS_FILE_MISSING');
      const existing = bindings.get(sourcePath);
      if (existing && (existing.sha256 !== row.sha256 || existing.size !== row.bytes)) throw new CloudBackupError('BUNDLED_ALIAS_CONFLICT');
      bindings.set(sourcePath, { sha256: row.sha256, size: row.bytes, aliases: [] });
    }
    for (const name of ['published-recovery', 'quota-public-recovery']) {
      const entry = entries.find(entry => entry.pathname === `app-private/${name}/manifest.json`);
      if (!entry) throw new CloudBackupError('BUNDLED_RECOVERY_MANIFEST_MISSING');
      const manifest = await readEntry(entry, maximumManifestBytes);
      let parsed: unknown;
      try { parsed = JSON.parse(manifest.bytes.toString('utf8')); } catch { throw new CloudBackupError('BUNDLED_ALIAS_MANIFEST_INVALID'); }
      if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== 1 || !('entries' in parsed)
        || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) throw new CloudBackupError('BUNDLED_ALIAS_MANIFEST_INVALID');
      for (const [pathname, input] of Object.entries(parsed.entries)) {
        if (!/^ai\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:png|webp|jpe?g)$/.test(pathname)
          || !input || typeof input !== 'object') throw new CloudBackupError('BUNDLED_ALIAS_MANIFEST_INVALID');
        const value = input as Record<string, unknown>;
        if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
          || typeof value.file !== 'string' || !new RegExp(`^${value.sha256}\\.(?:webp|png|jpe?g)$`).test(value.file)
          || !Number.isSafeInteger(value.byteLength) || Number(value.byteLength) < 1 || Number(value.byteLength) > maximumObjectBytes) throw new CloudBackupError('BUNDLED_ALIAS_MANIFEST_INVALID');
        const sourcePath = `app-private/${name}/${value.file}`;
        if (!entries.some(entry => entry.pathname === sourcePath)) throw new CloudBackupError('BUNDLED_ALIAS_FILE_MISSING');
        const shared = bindings.get(sourcePath);
        if (shared && (shared.sha256 !== value.sha256 || shared.size !== value.byteLength)
          || canonical.has(pathname) && canonical.get(pathname) !== value.sha256) throw new CloudBackupError('BUNDLED_ALIAS_CONFLICT');
        canonical.set(pathname, value.sha256);
        if (shared) shared.aliases.push(pathname);
        else bindings.set(sourcePath, { sha256: value.sha256, size: Number(value.byteLength), aliases: [pathname] });
      }
    }
    return bindings;
  }
  async function sourceMetadata(entry: Entry, entries: Entry[], maximumBytes: number) {
    const file = await readEntry(entry, maximumBytes);
    const binding = (await aliasBindings(entries)).get(entry.pathname);
    if (binding && (binding.size !== file.size || file.etag !== `"sha256:${binding.sha256}"`)) throw new CloudBackupError('BUNDLED_ALIAS_INTEGRITY_FAILED');
    const project = await rootDirectory();
    return { ...file, sourceStoreId: 'applicationbundle', sourceFile: relative(project, entry.file).split(sep).join('/'), aliases: [...new Set(binding?.aliases ?? [])].sort() };
  }
  const source: PrivateBackupBlobStore = {
    storeId: 'applicationbundle',
    async list(cursor, limit = 5) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5) throw new CloudBackupError('BUNDLED_BACKUP_PAGE_LIMIT');
      const entries = await inventory();
      const version = process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_URL || 'local';
      const fingerprint = digest(JSON.stringify({ version, files: entries.map(({ pathname, size }) => ({ pathname, size })) }));
      let offset = 0;
      if (cursor) {
        try {
          if (cursor.length > 500 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
          const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
          if (parsed.version !== 1 || parsed.fingerprint !== fingerprint || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || parsed.offset > entries.length) throw new Error();
          offset = parsed.offset;
        } catch { throw new CloudBackupError('BUNDLED_BACKUP_CURSOR_INVALID_OR_DEPLOYMENT_CHANGED'); }
      }
      const blobs = [];
      for (const entry of entries.slice(offset, offset + limit)) {
        const file = await sourceMetadata(entry, entries, maximumObjectBytes);
        blobs.push({ pathname: file.pathname, size: file.size, etag: file.etag, uploadedAt: file.uploadedAt,
          sourceStoreId: file.sourceStoreId, sourceFile: file.sourceFile, aliases: file.aliases });
      }
      const next = offset + blobs.length, hasMore = next < entries.length;
      return { blobs, hasMore, ...(hasMore ? { cursor: Buffer.from(JSON.stringify({ version: 1, fingerprint, offset: next })).toString('base64url') } : {}) };
    },
    async get(pathname, maximumBytes) {
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > maximumObjectBytes) throw new CloudBackupError('BUNDLED_BACKUP_FILE_TOO_LARGE');
      const entries = await inventory();
      const entry = entries.find(entry => entry.pathname === pathname);
      return entry ? sourceMetadata(entry, entries, maximumBytes) : null;
    },
    async putImmutable() { throw new CloudBackupError('BUNDLED_BACKUP_SOURCE_READ_ONLY'); },
  };
  return source;
}

/** Only bounded, byte-verified aliases. Root may accumulate these from the ordinary backup pages. */
export async function readBundledMediaAliasPage(options: { cursor?: string; pageSize?: number; projectDirectory?: string } = {}) {
  const source = createBundledMediaSource({ projectDirectory: options.projectDirectory });
  return source.list(options.cursor, options.pageSize ?? 5);
}

export async function copyBundledMediaPage(options: { cursor?: string; pageSize?: number; projectDirectory?: string; destination: PrivateBackupBlobStore; encryption: BackupEncryption; now?: () => Date }) {
  return copyMediaBackupPage(options.cursor, options.pageSize ?? 5, {
    source: createBundledMediaSource({ projectDirectory: options.projectDirectory }), destination: options.destination,
    encryption: options.encryption, maximumObjectBytes, now: options.now,
  });
}

/** Three fixed manifests only, consumed inside the encrypted snapshot step, never as a workflow event. */
export async function readBundledRecoveryRegistry(projectDirectory?: string): Promise<unknown[]> {
  const source = createBundledMediaSource({ projectDirectory });
  const registry: unknown[] = [];
  for (const name of ['provider-recovery', 'published-recovery', 'quota-public-recovery']) {
    const manifest = await source.get(`app-private/${name}/manifest.json`, maximumManifestBytes);
    if (!manifest) throw new CloudBackupError('BUNDLED_RECOVERY_MANIFEST_MISSING');
    try { registry.push(JSON.parse(manifest.bytes.toString('utf8'))); }
    catch { throw new CloudBackupError('BUNDLED_RECOVERY_MANIFEST_INVALID'); }
  }
  return registry;
}
