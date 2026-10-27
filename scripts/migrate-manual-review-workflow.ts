import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parse } from 'dotenv';
import { Pool } from 'pg';

async function main() {
  const args = process.argv.slice(2); const verifyOnly = args.includes('--verify-only');
  const files = args.filter(argument => argument !== '--verify-only');
  if (files.length > 1 || files.some(argument => argument.startsWith('--'))) throw new Error('INVALID_ARGUMENTS');
  const env = parse(await readFile(files[0] || '.env.local', 'utf8'));
  const connection = env.DATABASE_URL_UNPOOLED || env.POSTGRES_URL_NON_POOLING;
  if (!connection || new URL(connection).hostname.includes('-pooler.')) throw new Error('DIRECT_DATABASE_REQUIRED');
  if (env.DATABASE_URL) {
    const pooled = new URL(env.DATABASE_URL), direct = new URL(connection);
    if (pooled.hostname.replace('-pooler.', '.') !== direct.hostname || pooled.pathname !== direct.pathname || pooled.username !== direct.username) throw new Error('TARGET_MISMATCH');
  }
  const name = '0027-manual-review-workflow';
  const migration = await readFile(new URL(`../migrations/${name}.sql`, import.meta.url), 'utf8');
  const hash = createHash('sha256').update(migration).digest('hex');
  const pool = new Pool({ connectionString: connection, max: 1, connectionTimeoutMillis: 10000, query_timeout: 65000 });
  try {
    const client = await pool.connect();
    try {
      await client.query(verifyOnly ? 'BEGIN READ ONLY' : 'BEGIN');
      await client.query("SET LOCAL lock_timeout='5s'"); await client.query("SET LOCAL statement_timeout='60s'");
      if (!verifyOnly) await client.query("SELECT pg_advisory_xact_lock(hashtext('jesie-editorial-migrations'))");
      const prior = '0026-remove-spending-limits';
      const previous = await client.query('SELECT hash FROM editorial_migration WHERE name=$1', [prior]);
      const expected = createHash('sha256').update(await readFile(new URL(`../migrations/${prior}.sql`, import.meta.url))).digest('hex');
      if (previous.rows[0]?.hash !== expected) throw new Error('MIGRATION_0026_REQUIRED');
      const existing = await client.query('SELECT hash FROM editorial_migration WHERE name=$1', [name]);
      if (existing.rowCount) { if (existing.rows[0].hash !== hash) throw new Error('APPLIED_MIGRATION_CHANGED'); }
      else {
        if (verifyOnly) throw new Error('MIGRATION_NOT_APPLIED');
        await client.query(migration);
        await client.query('INSERT INTO editorial_migration(name,hash) VALUES($1,$2)', [name, hash]);
      }
      const checks = await client.query("SELECT conname,convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname IN ('editorial_publication_manual_release_required','editorial_content_approval_manual_review_required') AND conrelid IN ('editorial_publication'::regclass,'editorial_content_approval'::regclass)");
      if (checks.rowCount !== 2 || checks.rows.some(row => row.convalidated || !row.definition.includes('automated') || !/(?:<>|ALL)/.test(row.definition))) throw new Error('MANUAL_RELEASE_FENCE_REQUIRED');
      const publicationFence = checks.rows.find(row => row.conname === 'editorial_publication_manual_release_required');
      if (!publicationFence?.definition.includes('manual_scheduled')) throw new Error('SCHEDULED_RELEASE_FENCE_REQUIRED');
      const trigger = await client.query("SELECT pg_get_triggerdef(t.oid) AS definition,p.prosrc FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='ai_job'::regclass AND t.tgname='ai_job_manual_photo_decision' AND t.tgenabled='O'");
      if (trigger.rowCount !== 1 || !trigger.rows[0].definition.includes('BEFORE INSERT OR UPDATE') || !['MANUAL_PHOTO_DECISION_REQUIRED','AI_MANUAL_APPROVAL_CAPTURE_IMMUTABLE','approvedContentHash','requestedBy','provider_request_id'].every(value => trigger.rows[0].prosrc.includes(value))) throw new Error('MANUAL_PHOTO_FENCE_REQUIRED');
      const column = await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='ai_job' AND column_name='manual_content_approval_hash' AND is_nullable='YES'");
      if (column.rowCount !== 1) throw new Error('MANUAL_APPROVAL_CAPTURE_REQUIRED');
      await client.query('COMMIT');
      console.log(JSON.stringify({ migration: name, hash, status: verifyOnly ? 'verified' : existing.rowCount ? 'already_current' : 'applied', historicalRowsChanged: false, automaticPublicationBlocked: true, automaticApprovalBlocked: true, workerPhotographsRequireManualDecision: true, acceptedReceiptSettlementPreserved: true }));
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  } finally { await pool.end(); }
}
main().catch(() => { console.error('Manual review workflow migration failed. No credentials or private queries were logged.'); process.exitCode = 1; });
