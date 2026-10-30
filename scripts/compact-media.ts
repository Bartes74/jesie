import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { config } from 'dotenv';
import { Client } from 'pg';
import { del, get, list, put } from '@vercel/blob';
import sharp from 'sharp';
import { deliveryQuality, lossyDeliveryPhoto, minimumDeliverySsim } from '../src/server/ai/compact-photo';

const option = (name: string) => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
const apply = process.argv.includes('--apply');
const purge = process.argv.includes('--purge-cache');
// Lossy mode re-encodes only delivery sources; lossless editing archives are never touched.
const lossy = process.argv.includes('--lossy');
const dryRun = process.argv.includes('--dry-run');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const maximum = 32 * 1024 * 1024;
const minimumFree = 64 * 1024 * 1024;
const storageLimit = 1_000_000_000;
const backup = option('--backup');
config({ path: option('--env') || '.env.local', quiet: true });
let maintenanceStage = 'configuration';
let failureDiagnostic: ReturnType<typeof safeDiagnostic> | undefined;
function safeDiagnostic(error: unknown) {
  const detail = error !== null && typeof error === 'object' ? error as Record<string, unknown> : {};
  const name = typeof detail.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(detail.name) ? detail.name : 'UnknownError';
  const code = typeof detail.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(detail.code) ? detail.code : null;
  const status = detail.statusCode ?? detail.status;
  return { stage: maintenanceStage, errorName: name, code, status: Number.isInteger(status) && Number(status) >= 100 && Number(status) <= 599 ? status : null };
}

function maintenanceConnectionString() {
  const configured = process.env.DATABASE_URL;
  if (!configured) throw new Error('DATABASE_AND_STORAGE_REQUIRED');
  const base = new URL(configured);
  const direct = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL_NON_POOLING;
  const connection = new URL(direct || configured);
  // Neon transaction pooling cannot retain session advisory locks. Prefer the
  // provisioned direct URL; its documented hostname differs only by -pooler.
  const endpoint = (url: URL) => url.hostname.endsWith('.neon.tech') ? url.hostname.replace(/-pooler(?=\.)/, '') : url.hostname;
  if (!['postgres:', 'postgresql:'].includes(connection.protocol)
    || endpoint(connection) !== endpoint(base) || connection.pathname !== base.pathname
    || connection.username !== base.username || connection.password !== base.password || connection.port !== base.port) {
    throw new Error('MAINTENANCE_DATABASE_SCOPE_MISMATCH');
  }
  if (connection.hostname.includes('-pooler.')) {
    if (direct || !/^ep-[a-z0-9-]+-pooler\.[a-z0-9.-]+\.neon\.tech$/.test(connection.hostname)) throw new Error('DIRECT_MAINTENANCE_DATABASE_REQUIRED');
    connection.hostname = endpoint(connection);
  }
  connection.searchParams.set('sslmode', 'verify-full');
  return connection.href;
}

async function pixels(bytes: Buffer) {
  const decoded = await sharp(bytes, { limitInputPixels: 8_500_000, failOn: 'error' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: decoded.info.width, height: decoded.info.height, hash: sha(decoded.data) };
}

async function main() {
  if (!process.env.DATABASE_URL || !process.env.BLOB_READ_WRITE_TOKEN) throw new Error('DATABASE_AND_STORAGE_REQUIRED');
  if (apply && !purge && (!backup || !isAbsolute(backup))) throw new Error('ABSOLUTE_PRIVATE_BACKUP_REQUIRED');
  if (apply && dryRun) throw new Error('DRY_RUN_CANNOT_APPLY');
  if (dryRun && !lossy) throw new Error('DRY_RUN_REQUIRES_LOSSY');
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const db = new Client({ connectionString: maintenanceConnectionString(), connectionTimeoutMillis: 10_000, application_name: 'jesie-media-compaction-direct' });
  maintenanceStage = 'database_connect';
  await db.connect();
  let locked = false;
  try {
    if (apply) {
      maintenanceStage = 'compaction_lock';
      const lock = await db.query("SELECT pg_try_advisory_lock(hashtext('jesie-media-compaction')) AS acquired");
      if (!lock.rows[0]?.acquired) throw new Error('MEDIA_COMPACTION_ALREADY_RUNNING');
      locked = true;
    }
    const inventory: Awaited<ReturnType<typeof list>>['blobs'] = [];
    let cursor: string | undefined;
    do {
      maintenanceStage = 'blob_inventory';
      const page = await list({ token, limit: 1000, ...(cursor ? { cursor } : {}) });
      inventory.push(...page.blobs); cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    const byPath = new Map(inventory.map(blob => [blob.pathname, blob]));
    let usedBytes = inventory.reduce((sum, blob) => sum + blob.size, 0);
    maintenanceStage = 'registered_asset_inventory';
    const assets = (await db.query('SELECT blob_pathname, original_blob_pathname FROM ai_asset')).rows;
    const registered = new Set<string>(assets.flatMap(row => [row.blob_pathname, row.original_blob_pathname]).filter(Boolean));
    if (purge) {
      // This audited manifest only includes reproducible derivatives with retained sources.
      const manifest = JSON.parse(await readFile(resolve('output/editorial/week-2026-10-13/blob-cleanup-proposal.private.json'), 'utf8'));
      const caches = manifest.rebuildableSeoCache.filter((entry: { pathname: string; sourcePath: string; reconstructibleByExistingCode: boolean }) =>
        /^seo\/(?:delivery\/|recipes\/)/.test(entry.pathname) && entry.reconstructibleByExistingCode
        && byPath.has(entry.pathname) && !registered.has(entry.pathname)
        && (byPath.has(entry.sourcePath) || entry.sourcePath.startsWith('public/images/')));
      maintenanceStage = 'remove_reproducible_cache';
      for (const cache of caches) if (apply) await del(cache.pathname, { token });
      const removedBytes = caches.reduce((sum: number, entry: { pathname: string }) => sum + byPath.get(entry.pathname)!.size, 0);
      console.log(JSON.stringify({ mode: apply ? 'purged-reproducible-cache' : 'cache-plan', files: caches.length, bytes: removedBytes, sourcePhotographsDeleted: 0, bytesAfter: apply ? usedBytes - removedBytes : usedBytes }));
      return;
    }
    maintenanceStage = 'compaction_mapping_inventory';
    const tableExists = await db.query("SELECT to_regclass('media_compaction') AS name");
    if (!tableExists.rows[0].name) throw new Error('MEDIA_MIGRATION_REQUIRED');
    const mappings = (await db.query('SELECT * FROM media_compaction')).rows;
    const mapped = new Map(mappings.map(row => [row.source_pathname, row]));
    const download = async (pathname: string) => {
      const blob = await get(pathname, { access: 'private', useCache: false, token });
      if (!blob || blob.statusCode !== 200 || blob.blob.size > maximum) throw new Error('SOURCE_READ_UNAVAILABLE');
      const bytes = Buffer.from(await new Response(blob.stream).arrayBuffer());
      if (bytes.length > maximum) throw new Error('SOURCE_TOO_LARGE');
      return bytes;
    };
    if (lossy) {
      // Only a separate delivery source qualifies: an asset whose blob is also an
      // editing archive (its own or another asset's) keeps its lossless bytes.
      const archives = new Set<string>(assets.map(row => row.original_blob_pathname).filter(Boolean));
      const sources = new Set<string>(assets.filter(row => row.original_blob_pathname && row.blob_pathname !== row.original_blob_pathname).map(row => row.blob_pathname));
      const deliveries = inventory.filter(blob => sources.has(blob.pathname) && !archives.has(blob.pathname)
        && blob.pathname.startsWith('ai/') && !blob.pathname.startsWith('ai/compact/')).sort((a, b) => b.size - a.size);
      console.log(JSON.stringify({ mode: apply ? 'quality-gated-lossy-compaction' : dryRun ? 'lossy-dry-run' : 'lossy-plan', candidates: deliveries.length, bytes: usedBytes, minimumSsim: minimumDeliverySsim, editingArchivesChanged: false }));
      if (!apply && !dryRun) return;
      if (apply) { maintenanceStage = 'private_backup_directory'; await mkdir(backup!, { recursive: true, mode: 0o700 }); }
      let files = 0, rejected = 0, unchanged = 0, sourceBytes = 0, targetBytes = 0, worstSsim = 1;
      for (const candidate of deliveries) {
        maintenanceStage = 'read_source';
        const original = await download(candidate.pathname);
        if (original.length !== candidate.size) throw new Error('SOURCE_SIZE_CHANGED');
        const mapping = mapped.get(candidate.pathname);
        if (mapping) {
          // Resume after a crash between the redirect and the source removal.
          if (!apply) continue;
          maintenanceStage = 'verify_existing_lossy_mapping';
          const replacement = await download(mapping.target_pathname);
          const retained = await readFile(resolve(backup!, mapping.source_sha256 + '.source'));
          if (sha(original) !== mapping.source_sha256 || sha(retained) !== mapping.source_sha256 || sha(replacement) !== mapping.target_sha256) throw new Error('EXISTING_COMPACTION_PROOF_MISMATCH');
          const quality = await deliveryQuality(original, replacement);
          if (!quality.sameSize || !quality.alphaExact || quality.ssim < minimumDeliverySsim) throw new Error('EXISTING_COMPACTION_QUALITY_MISMATCH');
          maintenanceStage = 'remove_verified_mapped_source';
          await del(candidate.pathname, { token }); usedBytes -= candidate.size;
          continue;
        }
        maintenanceStage = 'decode_source_metadata';
        const metadata = await sharp(original, { limitInputPixels: 8_500_000, failOn: 'error' }).metadata();
        if ((metadata.pages ?? 1) !== 1 || (metadata.orientation ?? 1) !== 1 || metadata.depth !== 'uchar') { unchanged++; continue; }
        maintenanceStage = 'lossy_webp_encoding';
        const encoded = await lossyDeliveryPhoto(original);
        if (encoded.length + 1024 >= original.length) { unchanged++; continue; }
        maintenanceStage = 'verify_delivery_quality';
        const quality = await deliveryQuality(original, encoded);
        // A file that misses the gate keeps its current bytes.
        if (!quality.sameSize || !quality.alphaExact || quality.ssim < minimumDeliverySsim) { rejected++; continue; }
        worstSsim = Math.min(worstSsim, quality.ssim);
        sourceBytes += original.length; targetBytes += encoded.length; files++;
        if (!apply) continue;
        const sourceHash = sha(original), targetHash = sha(encoded);
        const target = 'ai/compact/v1/' + targetHash + '.webp';
        const existing = byPath.get(target);
        if (!existing && usedBytes + encoded.length > storageLimit - 1024 * 1024) throw new Error('INSUFFICIENT_TEMPORARY_CAPACITY');
        const after = await pixels(encoded);
        maintenanceStage = 'write_private_backups';
        await writeFile(resolve(backup!, sourceHash + '.source'), original, { mode: 0o600 });
        await writeFile(resolve(backup!, targetHash + '.webp'), encoded, { mode: 0o600 });
        if (sha(await readFile(resolve(backup!, sourceHash + '.source'))) !== sourceHash) throw new Error('LOCAL_BACKUP_VERIFICATION_FAILED');
        if (!existing) {
          maintenanceStage = 'upload_lossy_target';
          await put(target, encoded, { token, access: 'private', contentType: 'image/webp', addRandomSuffix: false, allowOverwrite: false });
          usedBytes += encoded.length;
          byPath.set(target, { ...candidate, pathname: target, size: encoded.length });
        }
        maintenanceStage = 'verify_uploaded_target';
        if (sha(await download(target)) !== targetHash) throw new Error('UPLOADED_COPY_VERIFICATION_FAILED');
        // pixel_sha256 records the decoded replacement; the SSIM proof is kept beside the backup.
        const proof = { source: candidate.pathname, target, sourceHash, targetHash, pixelHash: after.hash, ssim: quality.ssim, alphaExact: true, width: after.width, height: after.height, sourceBytes: original.length, targetBytes: encoded.length };
        maintenanceStage = 'write_private_recovery_manifest';
        await writeFile(resolve(backup!, sha(Buffer.from(candidate.pathname)) + '.json'), JSON.stringify(proof, null, 2), { mode: 0o600 });
        maintenanceStage = 'commit_compaction_mapping';
        await db.query('INSERT INTO media_compaction(source_pathname,target_pathname,source_sha256,target_sha256,pixel_sha256,source_bytes,target_bytes,width,height) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [candidate.pathname, target, sourceHash, targetHash, after.hash, original.length, encoded.length, after.width, after.height]);
        maintenanceStage = 'remove_verified_source';
        await del(candidate.pathname, { token });
        usedBytes -= candidate.size;
        console.log(JSON.stringify({ files, ssim: +quality.ssim.toFixed(4), pathname: candidate.pathname }));
      }
      console.log(JSON.stringify({ finished: true, dryRun, files, rejectedByQuality: rejected, unchanged, sourceBytes, targetBytes, savedBytes: sourceBytes - targetBytes, worstSsim: +worstSsim.toFixed(4), usedBytes }));
      return;
    }
    const candidates = inventory.filter(blob => blob.pathname.startsWith('ai/') && !blob.pathname.startsWith('ai/compact/')
      && (registered.has(blob.pathname) || /\/recovered-original\.(?:png|webp)$/.test(blob.pathname)))
      .sort((a, b) => b.size - a.size);
    console.log(JSON.stringify({ mode: apply ? 'verified-lossless-compaction' : 'compaction-plan', candidates: candidates.length, bytes: usedBytes, sourceBackupsRequired: true, immutableAssetRecordsChanged: false }));
    if (!apply) return;
    maintenanceStage = 'private_backup_directory';
    await mkdir(backup!, { recursive: true, mode: 0o700 });
    let savedBytes = 0, files = 0;
    for (const candidate of candidates) {
      if (mapped.has(candidate.pathname)) {
        // A crash after registering a redirect but before deletion is harmless.
        const mapping = mapped.get(candidate.pathname)!;
        maintenanceStage = 'read_previously_mapped_source';
        const original = await download(candidate.pathname);
        maintenanceStage = 'read_previously_mapped_target';
        const replacement = await download(mapping.target_pathname);
        maintenanceStage = 'read_existing_private_backup';
        const retained = await readFile(resolve(backup!, mapping.source_sha256 + '.source'));
        if (sha(original) !== mapping.source_sha256 || sha(retained) !== mapping.source_sha256 || sha(replacement) !== mapping.target_sha256) throw new Error('EXISTING_COMPACTION_PROOF_MISMATCH');
        maintenanceStage = 'verify_existing_mapping_pixels';
        if ((await pixels(original)).hash !== (await pixels(replacement)).hash) throw new Error('EXISTING_COMPACTION_PIXELS_MISMATCH');
        maintenanceStage = 'remove_verified_mapped_source';
        await del(candidate.pathname, { token }); usedBytes -= candidate.size; savedBytes += candidate.size; files++;
        continue;
      }
      maintenanceStage = 'read_source';
      const original = await download(candidate.pathname);
      if (original.length !== candidate.size) throw new Error('SOURCE_SIZE_CHANGED');
      maintenanceStage = 'decode_source_metadata';
      const metadata = await sharp(original, { limitInputPixels: 8_500_000, failOn: 'error' }).metadata();
      if ((metadata.pages ?? 1) !== 1 || (metadata.orientation ?? 1) !== 1 || metadata.depth !== 'uchar') continue;
      maintenanceStage = 'lossless_webp_encoding';
      const encoded = await sharp(original, { limitInputPixels: 8_500_000, failOn: 'error' })
        .webp({ lossless: true, exact: true, effort: 6 }).toBuffer();
      const sourceHash = sha(original), targetHash = sha(encoded);
      const target = 'ai/compact/v1/' + targetHash + '.webp';
      const existing = byPath.get(target);
      // Never grow the store for a conversion that does not produce useful savings.
      if (!existing && encoded.length + 1024 >= original.length) continue;
      if (!existing && usedBytes + encoded.length > storageLimit - 1024 * 1024) throw new Error('INSUFFICIENT_TEMPORARY_CAPACITY');
      maintenanceStage = 'verify_all_decoded_pixels';
      const [before, after] = await Promise.all([pixels(original), pixels(encoded)]);
      if (before.width !== after.width || before.height !== after.height || before.hash !== after.hash) throw new Error('LOSSLESS_PIXEL_PROOF_FAILED');
      maintenanceStage = 'write_private_backups';
      await writeFile(resolve(backup!, sourceHash + '.source'), original, { mode: 0o600 });
      await writeFile(resolve(backup!, targetHash + '.webp'), encoded, { mode: 0o600 });
      if (sha(await readFile(resolve(backup!, sourceHash + '.source'))) !== sourceHash) throw new Error('LOCAL_BACKUP_VERIFICATION_FAILED');
      if (!existing) {
        maintenanceStage = 'upload_lossless_target';
        await put(target, encoded, { token, access: 'private', contentType: 'image/webp', addRandomSuffix: false, allowOverwrite: false });
        usedBytes += encoded.length;
        byPath.set(target, { ...candidate, pathname: target, size: encoded.length });
      }
      maintenanceStage = 'verify_uploaded_target';
      if (sha(await download(target)) !== targetHash) throw new Error('UPLOADED_COPY_VERIFICATION_FAILED');
      const proof = { source: candidate.pathname, target, sourceHash, targetHash, pixelHash: before.hash, width: before.width, height: before.height, sourceBytes: original.length, targetBytes: encoded.length };
      // Save the recovery instructions locally before changing delivery or deleting a source.
      maintenanceStage = 'write_private_recovery_manifest';
      await writeFile(resolve(backup!, sha(Buffer.from(candidate.pathname)) + '.json'), JSON.stringify(proof, null, 2), { mode: 0o600 });
      maintenanceStage = 'commit_compaction_mapping';
      await db.query('INSERT INTO media_compaction(source_pathname,target_pathname,source_sha256,target_sha256,pixel_sha256,source_bytes,target_bytes,width,height) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [candidate.pathname, target, sourceHash, targetHash, before.hash, original.length, encoded.length, before.width, before.height]);
      maintenanceStage = 'remove_verified_source';
      await del(candidate.pathname, { token });
      usedBytes -= candidate.size; savedBytes += candidate.size - (existing ? 0 : encoded.length); files++;
      console.log(JSON.stringify({ files, savedBytes, usedBytes, pathname: candidate.pathname }));
      if (usedBytes < storageLimit - Math.max(minimumFree, 350_000_000) && process.argv.includes('--reserve-week')) break;
    }
    console.log(JSON.stringify({ finished: true, files, savedBytes, usedBytes, safeHeadroom: usedBytes + minimumFree <= storageLimit }));
  } catch (error) {
    failureDiagnostic = safeDiagnostic(error);
    throw error;
  } finally {
    maintenanceStage = 'release_compaction_lock';
    try {
      if (locked) await db.query("SELECT pg_advisory_unlock(hashtext('jesie-media-compaction'))");
    } finally { await db.end(); }
  }
}
main().catch(error => {
  console.error('Media maintenance stopped:', error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'SERVICE_UNAVAILABLE');
  console.error(JSON.stringify({ diagnostic: failureDiagnostic ?? safeDiagnostic(error) }));
  process.exitCode = 1;
});

