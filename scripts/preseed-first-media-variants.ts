/** One explicit bootstrap; routine backups run entirely in the cloud workflow. */
import { readFile, mkdir, chmod, writeFile } from 'node:fs/promises';
import { writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'dotenv';
import { list } from '@vercel/blob';
import { cloudBackupConfiguration } from '../src/server/media-backup/config';
import { createPrivateBackupBlobStore } from '../src/server/media-backup/blob';
import { copyMaintenancePage } from '../src/server/media-maintenance/copy-page';
import { getMaintenanceRun, maintenancePool } from '../src/server/media-maintenance/store';
import { maintenanceErrorCode } from '../src/server/media-maintenance/policy';
import { closeDb } from '../src/server/db';

const runId = '749996ed-7e1f-4fdb-96cf-bf5d6c58d958';
const generation = 5;
const deadline = Date.parse('2026-10-17T01:23:10Z');
const started = Date.now();
const output = resolve('output/media-maintenance-2026-10-17/preseed-variants.json');
const summary = {
  format: 1, runId, generation, startedAt: new Date(started).toISOString(), deadlineAt: new Date(deadline).toISOString(),
  status: 'running', stopReason: null as string | null, finishedAt: null as string | null,
  pagesCompleted: 0, objectsProcessed: 0, plaintextBytesProcessed: 0, proofsBefore: 0, proofsAfter: 0,
  scope: 'Existing live Blob media-variants/ only; immutable encrypted independent-store backups and their existing ledger.',
};
async function save() { await writeFile(output, JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 }); await chmod(output, 0o600); }

async function main() {
  if (deadline <= started || deadline - started > 300_000) throw new Error('BACKUP_BOOTSTRAP_WINDOW_INVALID');
  await mkdir(dirname(output), { recursive: true });
  const env = parse(await readFile('/Users/master/Library/Application Support/jesie-backups/cloud/maintenance.env'));
  Object.assign(process.env, env);
  if (!process.env.DATABASE_URL) throw new Error('BACKUP_DATABASE_CONFIGURATION');
  const url = new URL(process.env.DATABASE_URL); url.searchParams.set('sslmode', 'verify-full'); process.env.DATABASE_URL = url.href;
  const config = cloudBackupConfiguration(); if (!config) throw new Error('BACKUP_DISABLED');
  const source = createPrivateBackupBlobStore(config.source), destination = createPrivateBackupBlobStore(config.destination);
  const count = async () => Number((await maintenancePool().query("SELECT count(*)::int AS count FROM media_backup_object WHERE last_seen_run_id=$1 AND source_store_id=$2 AND source_path LIKE 'media-variants/%'", [runId, config.source.storeId])).rows[0].count);
  summary.proofsBefore = await count(); summary.proofsAfter = summary.proofsBefore;
  await save();
  const hardStop = setTimeout(() => {
    summary.status = 'stopped'; summary.stopReason = 'FIVE_MINUTE_DEADLINE'; summary.finishedAt = new Date().toISOString();
    writeFileSync(output, JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 }); chmodSync(output, 0o600);
    console.log(JSON.stringify(summary)); process.exit(0);
  }, Math.max(1, deadline - Date.now()));
  try {
    let cursor: string | undefined;
    outer: do {
      if (Date.now() >= deadline - 15_000) { summary.stopReason = 'DEADLINE_HEADROOM'; break; }
      const page = await list({ ...config.source, prefix: 'media-variants/', limit: 100, ...(cursor ? { cursor } : {}), abortSignal: AbortSignal.timeout(Math.min(20_000, deadline - Date.now())) });
      for (let offset = 0; offset < page.blobs.length; offset += 4) {
        if (Date.now() >= deadline - 15_000) { summary.stopReason = 'DEADLINE_HEADROOM'; break outer; }
        const run = await getMaintenanceRun(runId, generation);
        if (!run || run.status !== 'running' || run.phase !== 'media') { summary.stopReason = 'CLOUD_PHASE_OR_GENERATION_CHANGED'; break outer; }
        const blobs = page.blobs.slice(offset, offset + 4).map(blob => ({ pathname: blob.pathname, size: blob.size, etag: blob.etag, uploadedAt: blob.uploadedAt.toISOString() }));
        if (blobs.some(blob => !blob.pathname.startsWith('media-variants/') || blob.pathname.startsWith('ai/'))) throw new Error('BACKUP_BOOTSTRAP_SCOPE_INVALID');
        await copyMaintenancePage({ id: runId, generation, blobs, source, destination, encryption: config.encryption, maximumObjectBytes: config.maximumObjectBytes });
        summary.pagesCompleted++; summary.objectsProcessed += blobs.length;
        summary.plaintextBytesProcessed += blobs.reduce((sum, blob) => sum + blob.size, 0);
        summary.proofsAfter = await count(); await save();
      }
      if (page.hasMore && (!page.cursor || page.cursor === cursor)) throw new Error('BACKUP_INVENTORY_CURSOR_INVALID');
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    summary.stopReason ??= 'VARIANTS_PREFIX_COMPLETED';
    summary.status = 'stopped'; summary.proofsAfter = await count();
  } finally { clearTimeout(hardStop); }
}

void main().catch(error => {
  summary.status = 'failed'; summary.stopReason = maintenanceErrorCode(error);
}).finally(async () => {
  summary.finishedAt = new Date().toISOString();
  await save().catch(() => {});
  await closeDb().catch(() => {});
  console.log(JSON.stringify(summary));
});
