import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { Client } from 'pg';
import { restoreBundleSql } from '../src/server/media-backup/restore';

const execute = promisify(execFile);

test('0027 fences old automatic workers while preserving manual decisions, receipts, history and restore', { timeout: 90_000 }, async t => {
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') throw new Error('LOCAL_SCHEMA_TEST_ONLY');
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC', PGPASSFILE: '/dev/null', NODE_ENV: 'test' };
  const bin = resolve(process.env.MEDIA_BACKUP_TEST_PG_BIN || '/opt/homebrew/opt/postgresql@18/bin');
  for (const tool of ['initdb', 'pg_ctl', 'postgres']) assert.match((await execute(join(bin, tool), ['--version'], { env })).stdout, /\(PostgreSQL\)\s+18(?:\.|\s|$)/);
  const root = await mkdtemp(join(tmpdir(), 'jesie-manual-policy-')); await chmod(root, 0o700);
  const data = join(root, 'data'), socket = join(root, 'socket'); await mkdir(socket, { mode: 0o700 });
  let started = false; let client: Client | undefined;
  const hash = 'a'.repeat(64), differentHash = 'b'.repeat(64);
  try {
    await execute(join(bin, 'initdb'), ['-D', data, '-U', 'policy_fixture_owner', '--encoding=UTF8', '--locale=C', '--auth-local=trust', '--auth-host=reject'], { env });
    await execute(join(bin, 'pg_ctl'), ['-D', data, '-l', join(root, 'postgres.log'), '-w', '-t', '20', '-o', `-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -p 55489 -c ssl=off -c shared_buffers=16MB`, 'start'], { env }); started = true;
    client = new Client({ host: socket, port: 55489, user: 'policy_fixture_owner', database: 'postgres', ssl: false }); await client.connect();
    const identity = (await client.query("SELECT current_setting('data_directory') data,inet_server_addr() address")).rows[0]; assert.equal(await realpath(identity.data), await realpath(data)); assert.equal(identity.address, null);
    const q = (sql: string, values: unknown[] = []) => client!.query(sql, values);
    await q(restoreBundleSql(await readFile('src/server/media-backup/schema/pre-data.sql', 'utf8')));
    await q('SET search_path=public');
    // Simulate a pre-0027 snapshot: historical automatic decisions are inserted
    // between pre-data and post-data, exactly as a real database restore does.
    await q("INSERT INTO auth_user(id,name,email,role) VALUES('fixture-owner','Owner','owner@fixture.invalid','owner'),('fixture-admin','Admin','admin@fixture.invalid','admin')");
    await q("INSERT INTO editorial_recipe(id,content,content_hash,checks,created_by,updated_by,updated_by_name) VALUES('fixture-recipe','{}',$1,'{}','jesie-trend-worker','jesie-trend-worker','Worker')", [hash]);
    await q("INSERT INTO editorial_content_approval(recipe_id,content_hash,origin,revision,actor_id,actor_name) VALUES('fixture-recipe',$1,'automated',1,'jesie-trend-worker','Worker')", [hash]);
    await q("INSERT INTO editorial_publication(id,recipe_id,revision,snapshot,content_hash,checks,approval_origin,published_by,published_by_name) VALUES('historic-automatic','fixture-recipe',2,'{}',$1,'{}','automated','jesie-trend-worker','Worker')", [hash]);
    await q(restoreBundleSql(await readFile('src/server/media-backup/schema/post-data.sql', 'utf8')));
    await q('SET search_path=public');
    // Test the actual migration against the 0026 state even after the checked-in
    // restore bundle already contains 0027. Only this private fixture is altered.
    await q("DROP TRIGGER IF EXISTS ai_job_manual_photo_decision ON ai_job; DROP FUNCTION IF EXISTS protect_manual_photo_decision(); ALTER TABLE ai_job DROP COLUMN IF EXISTS manual_content_approval_hash; ALTER TABLE editorial_publication DROP CONSTRAINT IF EXISTS editorial_publication_manual_release_required; ALTER TABLE editorial_content_approval DROP CONSTRAINT IF EXISTS editorial_content_approval_manual_review_required");
    await q("INSERT INTO trend_run(id,date,mode,status,recipe_id,expected_revision,sources) VALUES('fixture-run','2026-10-20','daily','generating','fixture-recipe',1,'{}')");
    const job = (id: string, kind = 'step', actor = 'jesie-trend-worker', receipt: string | null = null, manualHash?: string) => q(`INSERT INTO ai_job(id,recipe_id,base_revision,kind,target_id,status,provider,model,brief,request_key,input_hash,input,created_by,created_by_name,trend_run_id,provider_request_id${manualHash === undefined ? '' : ',manual_content_approval_hash'}) VALUES($1,'fixture-recipe',1,$2,$3,$4,'fal','fixture/photo','Fixture',$1,$1,'{}',$5,'Fixture',$6,$7${manualHash === undefined ? '' : ',$8'})`, [id, kind, kind === 'step' ? 'step-1' : null, receipt ? 'generating' : 'queued', actor, actor === 'jesie-trend-worker' ? 'fixture-run' : null, receipt, ...(manualHash === undefined ? [] : [manualHash])]);
    await job('accepted-old', 'step', 'jesie-trend-worker', 'existing-receipt'); await job('queued-old');
    const before = (await q("SELECT (SELECT md5(string_agg(row_to_json(p)::text,'' ORDER BY id)) FROM editorial_publication p) publications,(SELECT md5(string_agg(row_to_json(a)::text,'' ORDER BY recipe_id,origin)) FROM editorial_content_approval a) approvals")).rows[0];
    await q(await readFile('migrations/0027-manual-review-workflow.sql', 'utf8'));
    await t.test('the migration preserves historical automatic approval and publication rows', async () => {
      const after = (await q("SELECT (SELECT md5(string_agg(row_to_json(p)::text,'' ORDER BY id)) FROM editorial_publication p) publications,(SELECT md5(string_agg(row_to_json(a)::text,'' ORDER BY recipe_id,origin)) FROM editorial_content_approval a) approvals")).rows[0]; assert.deepEqual(after, before);
      assert.equal((await q("SELECT count(*)::int n FROM pg_constraint WHERE conname IN ('editorial_publication_manual_release_required','editorial_content_approval_manual_review_required') AND NOT convalidated")).rows[0].n, 2);
    });
    const denied = async (promise: Promise<unknown>, message: RegExp) => assert.rejects(promise, (error: unknown) => error instanceof Error && message.test(error.message));
    await t.test('new automated cooking approvals are rejected', () => denied(q("INSERT INTO editorial_content_approval(recipe_id,content_hash,origin,revision,actor_id,actor_name) VALUES('fixture-recipe',$1,'automated',1,'jesie-trend-worker','Worker')", [differentHash]), /editorial_content_approval_manual_review_required/));
    await t.test('both automatic and scheduled publication origins are rejected by the new independent fence', async () => {
      await q('ALTER TABLE editorial_publication DISABLE TRIGGER USER');
      try { for (const origin of ['automated','manual_scheduled']) await denied(q("INSERT INTO editorial_publication(id,recipe_id,revision,snapshot,content_hash,checks,approval_origin,published_by,published_by_name,reviewed_by,reviewed_by_name,reviewed_revision) VALUES($1,'fixture-recipe',3,'{}',$2,'{}',$3,'jesie-trend-worker','Worker','fixture-owner','Owner',2)", [origin, hash, origin]), /editorial_publication_(?:manual_release_required|no_new_manual_scheduled)/); }
      finally { await q('ALTER TABLE editorial_publication ENABLE TRIGGER USER'); }
    });
    await t.test('research text jobs remain allowed without a photograph decision', async () => { await job('new-text', 'recipe'); });
    await t.test('old and new unapproved worker photographs cannot be submitted', async () => {
      await denied(job('unapproved-photo'), /MANUAL_PHOTO_DECISION_REQUIRED/);
      await denied(q("UPDATE ai_job SET status='submitting' WHERE id='queued-old'"), /MANUAL_PHOTO_DECISION_REQUIRED/);
    });
    await t.test('accepted historical photographs can finish, apply and settle real costs', async () => {
      await q("UPDATE ai_job SET status='ready',provider_finished_at=now(),charged_usd=0.12,cost_basis='usage',result='{}' WHERE id='accepted-old'");
      await q("INSERT INTO ai_cost_ledger(id,job_id,entry,amount_usd,basis) VALUES('settled-old','accepted-old','settle',0.12,'usage')");
      await q("UPDATE ai_job SET status='applied',applied_revision=2 WHERE id='accepted-old'");
      assert.equal((await q("SELECT charged_usd::text cost FROM ai_job WHERE id='accepted-old'")).rows[0].cost, '0.12000000');
      await denied(q("UPDATE ai_job SET manual_content_approval_hash=$1 WHERE id='accepted-old'", [hash]), /AI_MANUAL_APPROVAL_CAPTURE_IMMUTABLE/);
    });
    await t.test('manual review and manual publication remain possible', async () => {
      await q("INSERT INTO editorial_content_approval(recipe_id,content_hash,origin,revision,actor_id,actor_name) VALUES('fixture-recipe',$1,'manual',1,'fixture-admin','Admin')", [hash]);
      await q("INSERT INTO editorial_publication(id,recipe_id,revision,snapshot,content_hash,checks,approval_origin,published_by,published_by_name) VALUES('manual-publication','fixture-recipe',4,'{}',$1,'{}','manual','fixture-owner','Owner')", [hash]);
    });
    const preparation = async (generation: number, approvedContentHash: string, requestedBy = 'fixture-owner') => q("UPDATE trend_run SET search_diagnostics=$1 WHERE id='fixture-run'", [{ preparation: { generation, approvedContentHash, requestedBy, requestKey: 'explicit-owner-request', expectedRevision: 1, startedAt: new Date().toISOString() } }]);
    await t.test('a manual approval alone never starts worker photographs', () => denied(job('approval-without-decision', 'step', 'jesie-trend-worker', null, hash), /MANUAL_PHOTO_DECISION_REQUIRED/));
    await t.test('stale generation and a mismatched approval hash are rejected', async () => {
      await preparation(2, hash); await denied(job('stale-generation', 'step', 'jesie-trend-worker', null, hash), /MANUAL_PHOTO_DECISION_REQUIRED/);
      await preparation(1, differentHash); await denied(job('wrong-captured-hash', 'step', 'jesie-trend-worker', null, hash), /MANUAL_PHOTO_DECISION_REQUIRED/);
    });
    await t.test('explicit current owner preparation admits photographs and preserves its immutable approval', async () => {
      await preparation(1, hash); await job('approved-photo', 'step', 'jesie-trend-worker', null, hash); await q("UPDATE ai_job SET status='submitting' WHERE id='approved-photo'");
      await denied(q("UPDATE ai_job SET manual_content_approval_hash=$1 WHERE id='approved-photo'", [differentHash]), /AI_MANUAL_APPROVAL_CAPTURE_IMMUTABLE/);
    });
    await t.test('an admin reviewer needs an explicit owner photograph decision', async () => {
      await preparation(1, hash, 'fixture-admin');
      await denied(job('admin-photo-decision', 'step', 'jesie-trend-worker', null, hash), /MANUAL_PHOTO_DECISION_REQUIRED/);
      await preparation(1, hash);
    });
    await t.test('disabled owners cannot authorize new worker photographs', async () => {
      await q("UPDATE auth_user SET disabled=true WHERE id='fixture-owner'");
      try { await denied(job('disabled-owner-photo', 'step', 'jesie-trend-worker', null, hash), /MANUAL_PHOTO_DECISION_REQUIRED/); }
      finally { await q("UPDATE auth_user SET disabled=false WHERE id='fixture-owner'"); }
    });
    await t.test('explicit Studio photographs and photo batches remain allowed', async () => {
      await job('studio-photo', 'step', 'fixture-owner');
      await q("INSERT INTO ai_photo_batch(id,recipe_id,base_revision,input,input_hash,slots,request_key,created_by,created_by_name) VALUES('manual-batch','fixture-recipe',1,'{}','manual-batch-input','[]','manual-batch-request','fixture-owner','Owner')");
      assert.equal((await q("SELECT count(*)::int n FROM ai_photo_batch WHERE id='manual-batch'")).rows[0].n, 1);
    });
  } finally {
    await client?.end().catch(() => {});
    if (started) await execute(join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', '-t', '20', 'stop'], { env });
    await rm(root, { recursive: true, force: true });
  }
});
