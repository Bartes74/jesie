import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { backupDigest } from '../src/server/media-backup/crypto';
import { collectDatabaseProof } from '../src/server/media-backup/database-proof';
import { newRestoreScope, restoreBundleSql, validateRestoreBundle, verifyIsolatedDatabaseRestore, type RestoreSchemaBundle } from '../src/server/media-backup/restore';
import { captureDatabaseSnapshot, snapshotSchemaFingerprint } from '../src/server/media-backup/snapshot';
import { parseUsageEvent, usageEventNames } from '../src/lib/usage-metrics';
import { collectionPublicDefinition, defaultCollectionPalette, newCollectionContent, type CollectionTheme } from '../src/lib/collections';
import { seedLegacyCollections } from './collection-migration-seed';

// This tool has no application DSN, dotenv, cloud store or provider access. It
// reconstructs DDL from the checked-in bundle inside its own Unix-socket cluster.
const execute = promisify(execFile);
let phase = 'configuration';

async function postgres18Bin(env: NodeJS.ProcessEnv): Promise<string> {
  const override = process.env.MEDIA_BACKUP_TEST_PG_BIN;
  const candidates = override ? [resolve(override)] : [...new Set((env.PATH ?? '').split(delimiter).filter(Boolean).map(path => resolve(path)))];
  for (const directory of candidates) {
    let complete = true;
    for (const name of ['initdb', 'pg_ctl', 'pg_dump', 'postgres']) {
      try {
        const version = await execute(join(directory, name), ['--version'], { env, timeout: 5000 });
        if (!/\(PostgreSQL\)\s+18(?:\.|\s|$)/.test(version.stdout)) { complete = false; break; }
      } catch { complete = false; break; }
    }
    if (complete) return directory;
  }
  throw Object.assign(new Error('PostgreSQL 18 tools are required in PATH or MEDIA_BACKUP_TEST_PG_BIN.'), { code: 'PG18_TOOLS_REQUIRED' });
}

async function main() {
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') throw new Error('LOCAL_SCHEMA_TEST_ONLY');
  const verifyOnly = process.argv.includes('--verify-only');
  if (process.argv.slice(2).some(argument => argument !== '--verify-only')) throw new Error('UNSUPPORTED_ARGUMENT');
  const bundleRoot = resolve('src/server/media-backup/schema');
  const [preData, postData, manifestText] = await Promise.all(['pre-data.sql', 'post-data.sql', 'manifest.json'].map(name => readFile(join(bundleRoot, name), 'utf8')));
  const original: RestoreSchemaBundle = { preData, postData, manifest: JSON.parse(manifestText) };
  assert.equal(backupDigest(Buffer.from(preData)), original.manifest.preDataSha256);
  assert.equal(backupDigest(Buffer.from(postData)), original.manifest.postDataSha256);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC', PGPASSFILE: '/dev/null', NODE_ENV: 'test' };
  phase = 'postgresql-18-tools';
  const bin = await postgres18Bin(env);
  const root = await mkdtemp(join(tmpdir(), 'jesie-schema-'));
  await chmod(root, 0o700);
  const data = join(root, 'data'), socket = join(root, 'socket');
  await mkdir(socket, { mode: 0o700 });
  const role = 'schema_fixture_owner', port = 55487, sourceDatabase = 'schema_fixture';
  const clients = new Set<Client>();
  let started = false;
  const connect = async (database: string) => {
    const client = new Client({ host: socket, port, user: role, database, ssl: false, connectionTimeoutMillis: 5000 });
    client.on('error', () => {});
    await client.connect(); clients.add(client); return client;
  };
  try {
    await execute(join(bin, 'initdb'), ['-D', data, '-U', role, '--encoding=UTF8', '--locale=C', '--auth-local=trust', '--auth-host=reject'], { env });
    await execute(join(bin, 'pg_ctl'), ['-D', data, '-l', join(root, 'postgres.log'), '-w', '-t', '20', '-o', `-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -p ${port} -c ssl=off -c shared_buffers=16MB`, 'start'], { env });
    started = true;
    const admin = await connect('postgres');
    const identity = (await admin.query("SELECT current_setting('data_directory') AS data,inet_server_addr() AS address")).rows[0];
    assert.equal(await realpath(String(identity.data)), await realpath(data)); assert.equal(identity.address, null);
    await admin.query(`CREATE DATABASE ${sourceDatabase} TEMPLATE template0`);
    const source = await connect(sourceDatabase);
    await source.query(restoreBundleSql(preData));
    await source.query(restoreBundleSql(postData));
    await source.query('SET search_path = public');
    phase = 'baseline-fingerprint';
    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    let baselineFingerprint: string;
    try { baselineFingerprint = snapshotSchemaFingerprint(await collectDatabaseProof(source)); }
    finally { await source.query('ROLLBACK'); }
    assert.equal(baselineFingerprint, original.manifest.schemaFingerprint, 'The old checked-in DDL must exactly match its manifest before migration.');
    const hasKitchenSchema = (await source.query("SELECT to_regclass('public.reader_feedback') IS NOT NULL AS present")).rows[0].present === true;
    const metricConstraints = (await source.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.seo_usage_daily'::regclass AND conname IN ('seo_usage_daily_path_check','seo_usage_daily_check')")).rows;
    const hasPlanMetrics = metricConstraints.length === 2 && metricConstraints.every(row => String(row.definition).includes('plan'));
    const costConstraint = (await source.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.ai_job'::regclass AND conname='ai_job_reserved_usd_check'")).rows[0]?.definition ?? '';
    const ingredientIndex = (await source.query("SELECT pg_get_indexdef('public.ai_ingredient_producer_unique'::regclass) AS definition")).rows[0]?.definition ?? '';
    const hasCostOnly = !costConstraint.includes('kind') && !costConstraint.includes('model') && !ingredientIndex.includes('reserved_usd');
    if (verifyOnly) assert.equal(hasCostOnly, true, 'The deployment restore bundle must include migration 0026.');
    if (verifyOnly) assert.equal(hasKitchenSchema, true, 'The deployment restore bundle must include migration 0024.');
    if (verifyOnly) assert.equal(hasPlanMetrics, true, 'The deployment restore bundle must include migration 0025.');
    const manualReviewGuards = (await source.query("SELECT count(*)::int AS count FROM pg_constraint WHERE conname IN ('editorial_publication_manual_release_required','editorial_content_approval_manual_review_required') AND conrelid IN ('public.editorial_publication'::regclass,'public.editorial_content_approval'::regclass)")).rows[0].count;
    const manualPhotoGuard = (await source.query("SELECT count(*)::int AS count FROM pg_trigger WHERE tgrelid='public.ai_job'::regclass AND tgname='ai_job_manual_photo_decision' AND tgenabled='O'")).rows[0].count;
    const manualReviewSql = await readFile('migrations/0027-manual-review-workflow.sql', 'utf8');
    const manualPhotoFunction = manualReviewSql.match(/CREATE FUNCTION protect_manual_photo_decision\(\) RETURNS trigger LANGUAGE plpgsql AS \$\$[\s\S]*?\$\$;/)?.[0];
    assert.ok(manualPhotoFunction, 'The canonical manual photograph guard must be present.');
    const expectedFunctionBody = manualPhotoFunction.split('$$')[1].trim();
    const actualFunctionBody = (await source.query("SELECT prosrc FROM pg_proc WHERE oid=to_regprocedure('public.protect_manual_photo_decision()')")).rows[0]?.prosrc?.trim();
    const hasManualReviewObjects = manualReviewGuards === 2 && manualPhotoGuard === 1;
    const hasManualReview = hasManualReviewObjects && actualFunctionBody === expectedFunctionBody;
    if (verifyOnly) assert.equal(hasManualReview, true, 'The deployment restore bundle must include migration 0027.');
    const hasIngredientDictionary = (await source.query("SELECT to_regclass('public.ai_ingredient_verification') IS NOT NULL AND to_regclass('public.ai_verified_ingredient_alias') IS NOT NULL AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='ai_ingredient_verification_identity_immutable' AND tgenabled='O') AS present")).rows[0].present === true;
    if (verifyOnly) assert.equal(hasIngredientDictionary, true, 'The deployment restore bundle must include migration 0028.');
    const hasIngredientEvidenceRecheck = (await source.query("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='ai_ingredient_verification' AND column_name='eligibility_policy_version') AS present")).rows[0].present === true;
    if (verifyOnly) assert.equal(hasIngredientEvidenceRecheck, true, 'The deployment restore bundle must include migration 0029.');
    const hasCollections = (await source.query("SELECT to_regclass('public.event_collection') IS NOT NULL AND to_regclass('public.event_collection_publication') IS NOT NULL AS present")).rows[0].present === true;
    const hasCollectionThemes = (await source.query("SELECT to_regclass('public.collection_theme_generation') IS NOT NULL AND to_regclass('public.collection_theme_job') IS NOT NULL AND to_regclass('public.collection_asset') IS NOT NULL AND to_regclass('public.collection_theme_cost') IS NOT NULL AS present")).rows[0].present === true;
    const collectionThemeSql = await readFile('migrations/0031-collection-themes.sql', 'utf8');
    const themeFunctions = [...collectionThemeSql.matchAll(/CREATE FUNCTION ([a-z_]+)\(\) RETURNS trigger LANGUAGE plpgsql AS \$\$([\s\S]*?)\$\$;/g)];
    const themeTriggers = [...collectionThemeSql.matchAll(/CREATE TRIGGER ([a-z_]+) BEFORE (UPDATE OR DELETE|UPDATE|DELETE) ON ([a-z_]+) FOR EACH ROW EXECUTE FUNCTION ([a-z_]+)\(\);/g)];
    let hasCollectionThemeGuards = hasCollectionThemes;
    if (hasCollectionThemes) {
      for (const match of themeFunctions) {
        const actual = (await source.query('SELECT prosrc FROM pg_proc WHERE oid=to_regprocedure($1)', [`public.${match[1]}()`])).rows[0]?.prosrc;
        if (String(actual ?? '').trim() !== match[2].trim()) hasCollectionThemeGuards = false;
      }
      for (const match of themeTriggers) {
        const actual = (await source.query('SELECT t.tgtype,t.tgenabled,p.proname FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid=to_regclass($1) AND t.tgname=$2', [`public.${match[3]}`, match[1]])).rows[0];
        const expectedType = 3 + (match[2].includes('UPDATE') ? 16 : 0) + (match[2].includes('DELETE') ? 8 : 0);
        if (!actual || actual.tgtype !== expectedType || actual.tgenabled !== 'O' || actual.proname !== match[4]) hasCollectionThemeGuards = false;
      }
      const secured = (await source.query("SELECT count(*)::int AS count FROM pg_class WHERE oid IN ('public.collection_theme_generation'::regclass,'public.collection_theme_job'::regclass,'public.collection_asset'::regclass,'public.collection_theme_cost'::regclass,'public.collection_discovery_event'::regclass) AND relrowsecurity")).rows[0].count;
      if (secured !== 5) hasCollectionThemeGuards = false;
    }
    if (verifyOnly) assert.equal(hasCollections, true, 'The deployment restore bundle must include migration 0030.');
    if (verifyOnly) assert.equal(hasCollectionThemes, true, 'The deployment restore bundle must include migration 0031.');
    if (verifyOnly) assert.equal(hasCollectionThemeGuards, true, 'The deployment restore bundle must include the canonical collection security and receipt guards.');
    const hasCollectionAccents = (await source.query("SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='collection_asset_kind_check' AND pg_get_constraintdef(oid) LIKE '%garland%') AS present")).rows[0].present === true;
    if (verifyOnly) assert.equal(hasCollectionAccents, true, 'The deployment restore bundle must include migration 0032.');
    const hasSitePages = (await source.query("SELECT to_regclass('public.site_page') IS NOT NULL AS present")).rows[0].present === true;
    if (verifyOnly) assert.equal(hasSitePages, true, 'The deployment restore bundle must include migration 0033.');
    const schemaChanged = !hasKitchenSchema || !hasPlanMetrics || !hasCostOnly || !hasManualReview || !hasIngredientDictionary || !hasIngredientEvidenceRecheck || !hasCollections || !hasCollectionThemes || !hasCollectionThemeGuards || !hasCollectionAccents || !hasSitePages;
    phase = 'local-migration';
    if (!hasKitchenSchema) await source.query(await readFile('migrations/0024-kitchen-experience.sql', 'utf8'));
    if (!hasPlanMetrics) await source.query(await readFile('migrations/0025-plan-metrics.sql', 'utf8'));

    if (!hasCostOnly) await source.query(await readFile('migrations/0026-remove-spending-limits.sql', 'utf8'));
    if (!hasManualReview) {
      if (!hasManualReviewObjects) await source.query(manualReviewSql);
      else await source.query(manualPhotoFunction.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'));
    }
    if (!hasIngredientDictionary) await source.query(await readFile('migrations/0028-ingredient-dictionary.sql', 'utf8'));
    if (!hasIngredientEvidenceRecheck) await source.query(await readFile('migrations/0029-ingredient-evidence-recheck.sql', 'utf8'));
    if (!hasCollections) await source.query(await readFile('migrations/0030-collections.sql', 'utf8'));
    if (!hasCollectionThemes) await source.query(collectionThemeSql);
    else if (!hasCollectionThemeGuards) {
      // Earlier local bundle drafts may predate the final guards. This only
      // repairs the disposable reconstruction before producing a verified dump.
      for (const match of themeFunctions) await source.query(match[0].replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'));
      for (const match of themeTriggers) {
        await source.query(`DROP TRIGGER IF EXISTS ${match[1]} ON ${match[3]}`);
        await source.query(match[0]);
      }
      const securityStart = collectionThemeSql.indexOf('ALTER TABLE collection_theme_generation ENABLE ROW LEVEL SECURITY;');
      const securityEnd = collectionThemeSql.indexOf('-- Catalogue interactions');
      assert.ok(securityStart > 0 && securityEnd > securityStart);
      await source.query(collectionThemeSql.slice(securityStart, securityEnd));
    }
    if (!hasCollectionAccents) await source.query(await readFile('migrations/0032-collection-accents.sql', 'utf8'));
    if (!hasSitePages) await source.query(await readFile('migrations/0033-site-pages.sql', 'utf8'));

    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    phase = 'local-schema-dump';
    let bundle: RestoreSchemaBundle;
    try {
      const snapshotId = (await source.query('SELECT pg_export_snapshot() AS id')).rows[0].id as string;
      const proof = await collectDatabaseProof(source);
      const fingerprint = snapshotSchemaFingerprint(proof);
      const serverMajor = Math.floor(Number((await source.query('SHOW server_version_num')).rows[0].server_version_num) / 10000);
      assert.equal(serverMajor, original.manifest.serverMajor);
      if (!schemaChanged) bundle = original;
      else {
        const dumpEnv = { ...env, PGHOST: socket, PGPORT: String(port), PGUSER: role, PGDATABASE: sourceDatabase, PGSSLMODE: 'disable' };
        const dump = async (section: string) => (await execute(join(bin, 'pg_dump'), ['--schema-only', `--section=${section}`, '--no-owner', '--no-acl', '--no-password', `--snapshot=${snapshotId}`], { env: dumpEnv, maxBuffer: 16 * 1024 * 1024 })).stdout;
        const nextPreData = await dump('pre-data'), nextPostData = await dump('post-data');
        bundle = { preData: nextPreData, postData: nextPostData, manifest: { format: 1, serverMajor, preDataSha256: backupDigest(Buffer.from(nextPreData)), postDataSha256: backupDigest(Buffer.from(nextPostData)), schemaFingerprint: fingerprint } };
      }
      assert.equal(bundle.manifest.schemaFingerprint, fingerprint);
    } finally { await source.query('ROLLBACK'); }

    // Synthetic rows exercise the new table/FK and event constraints during an
    // actual restore; they are never written into the checked-in schema files.
    phase = 'synthetic-fixtures';
    await source.query(`INSERT INTO public.editorial_recipe(id,content,content_hash,checks,created_by,updated_by,updated_by_name)
      VALUES('backup-schema-fixture','{"recipe":{"title":{"pl":"Fixture"},"steps":[{"id":"old-step"}]}}'::jsonb,'fixture-hash','{}'::jsonb,'fixture-owner','fixture-owner','Fixture owner')`);
    await source.query(`INSERT INTO public.reader_feedback(id,request_key,recipe_id,publication_revision,kind,step_id,message)
      VALUES('c97bd342-d753-45e4-a466-fae91ca4490e','bd59ea12-7209-4608-bb9d-f6e33993e36e','backup-schema-fixture',1,'problem','old-step','Synthetic restore fixture')`);
    const dictionaryKey = '8'.repeat(64);
    await source.query(`INSERT INTO public.ai_ingredient_verification(verification_key,input,model,origin_recipe_id,status,claim_token,claim_expires_at,provider_request_id,result,learned,charged_usd,cost_basis)
      VALUES($1,'{"name":{"pl":"Fixture food","en":"Fixture food"}}','fixture-model','backup-schema-fixture','complete','fixture-claim',now(),'resp_backup_fixture','{"decision":"verified","autoLearnEligible":true}',true,0.01,'usage')`, [dictionaryKey]);
    await source.query("INSERT INTO public.ai_verified_ingredient_alias(normalized_alias,verification_key,diet) VALUES('fixture food',$1,'vegan')", [dictionaryKey]);
    const seededCollections = await seedLegacyCollections(source);
    const eventId = 'backup-event-fixture', generationId = 'a97bd342-d753-45e4-a466-fae91ca4490e', assetId = 'b97bd342-d753-45e4-a466-fae91ca4490e', jobId = 'd97bd342-d753-45e4-a466-fae91ca4490e';
    const theme: CollectionTheme = { version: 1, palette: { ...defaultCollectionPalette }, hero: { assetId, src: `/media/collections/${assetId}`, width: 2048, height: 1536, alt: { pl: 'Ilustracja testowa', en: 'Fixture illustration' } }, atmosphere: null, decorationOpacity: .12 };
    const eventContent = { ...newCollectionContent('Kolekcja testowa'), title: { pl: 'Kolekcja testowa', en: 'Fixture collection' }, description: { pl: 'Opis testowy', en: 'Fixture description' }, slug: { pl: 'kolekcja-testowa', en: 'fixture-collection' }, theme, themeGenerationId: generationId };
    await source.query("INSERT INTO public.event_collection(id,content,content_hash,created_by,updated_by,updated_by_name) VALUES($1,$2,'fixture','fixture-owner','fixture-owner','Fixture owner')", [eventId, JSON.stringify(eventContent)]);
    await source.query(`INSERT INTO public.collection_theme_generation(id,collection_id,base_revision,part,brief,input,theme,status,request_key,input_hash,created_by,applied_revision)
      VALUES($1,$2,1,'all','Synthetic restore theme','{}',$3,'ready','restore-fixture','fixture','fixture-owner',1)`, [generationId, eventId, JSON.stringify(theme)]);
    await source.query(`INSERT INTO public.collection_theme_job(id,generation_id,kind,model,status,provider_request_id,provider_finished_at,charged_usd,result)
      VALUES($1,$2,'spec','fixture-model','ready','resp_collection_restore_fixture',now(),0.03,'{}')`, [jobId, generationId]);
    await source.query(`INSERT INTO public.collection_asset(id,collection_id,generation_id,kind,blob_pathname,sha256,width,height,content_type)
      VALUES($1,$2,$3,'hero',$4,$5,2048,1536,'image/webp')`, [assetId, eventId, generationId, `media/collections/${assetId}.webp`, 'a'.repeat(64)]);
    await source.query('INSERT INTO public.collection_theme_cost(job_id,amount_usd) VALUES($1,0.03)', [jobId]);
    const eventPublication = 'e97bd342-d753-45e4-a466-fae91ca4490e';
    await source.query(`INSERT INTO public.event_collection_publication(id,collection_id,revision,snapshot,published_by,published_by_name)
      VALUES($1,$2,1,$3,'fixture-owner','Fixture owner')`, [eventPublication, eventId, JSON.stringify(collectionPublicDefinition(eventId, eventContent))]);
    await source.query("UPDATE public.event_collection SET publication_status='published',published_id=$2,published_revision=1,first_published_at=now() WHERE id=$1", [eventId, eventPublication]);
    await source.query("INSERT INTO public.site_page(id,content,updated_by,updated_by_name) VALUES('about','{\"pl\":{},\"en\":{}}','fixture-owner','Fixture owner')");
    let acceptedMetricRows = 0;
    // Exercise the full pre-0025 path families as well as both new plan routes.
    for (const locale of ['pl', 'en']) for (const suffix of ['', '/o-serwisie', '/kolekcje', '/poradniki', '/recipes/fixture', '/kolekcje/fixture', '/poradniki/fixture', '/plan']) {
      const path = `/${locale}${suffix}`;
      for (const name of usageEventNames) if (parseUsageEvent({ name, path, source: 'direct' })) {
        await source.query('INSERT INTO public.seo_usage_daily(day,event,path,source) VALUES($1,$2,$3,$4)', ['2026-10-19', name, path, 'direct']);
        acceptedMetricRows++;
      }
    }
    const rejectedMetrics = [['page_view', '/admin'], ['page_view', '/pl/preview/fixture'], ['page_view', '/pl/plan/private'], ['page_view', '/en/plan?email=private'], ['servings_change', '/pl/plan'], ['recipe_save', '/en/plan'], ['plan_add', '/pl/plan']];
    for (const [name, path] of rejectedMetrics) await assert.rejects(source.query('INSERT INTO public.seo_usage_daily(day,event,path,source) VALUES($1,$2,$3,$4)', ['2026-10-19', name, path, 'direct']), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23514'));
    phase = 'snapshot-proof';
    const snapshot = await captureDatabaseSnapshot(source, 'schema-migration-0031', { maximumSnapshotBytes: 16 * 1024 * 1024, maximumSnapshotRows: 1000, maximumSnapshotDurationMs: 30_000 });
    assert.ok(snapshot.mediaReferences.requiredPaths.includes(`media/collections/${assetId}.webp`), 'Collection artwork must be required by a recoverable snapshot.');
    assert.deepEqual(snapshot.mediaReferences.missingAssetIds, []);
    validateRestoreBundle(snapshot, bundle);
    phase = 'real-restore';
    const restored = await verifyIsolatedDatabaseRestore({ snapshot, bundle, scope: newRestoreScope(snapshot.runId), admin: source, connectTarget: connect, maximumDurationMs: 30_000 });
    assert.equal(restored.verified, true, JSON.stringify(restored));
    assert.equal(restored.cleanupConfirmed, true);
    assert.equal(restored.structuralCatalogMatches, true);
    assert.equal(restored.tableHashesMatch, true);
    if (!verifyOnly && schemaChanged) {
      phase = 'write-verified-bundle';
      // Refuse a concurrent bundle change. DDL files are replaced first and the
      // manifest last, so an interrupted update fails closed on hash validation.
      assert.equal(await readFile(join(bundleRoot, 'manifest.json'), 'utf8'), manifestText);
      for (const [name, bytes] of [['pre-data.sql', bundle.preData], ['post-data.sql', bundle.postData], ['manifest.json', JSON.stringify(bundle.manifest, null, 2) + '\n']]) {
        const staged = join(bundleRoot, `${name}.next`);
        await writeFile(staged, bytes);
        await rename(staged, join(bundleRoot, name));
      }
    }
    console.log(JSON.stringify({ ok: true, updated: !verifyOnly && schemaChanged, baselineFingerprintMatched: true,
      previousFingerprint: baselineFingerprint, schemaFingerprint: bundle.manifest.schemaFingerprint,
      restoreVerified: restored.verified, cleanupConfirmed: restored.cleanupConfirmed, tableCount: restored.tableCount,
      rowCount: restored.rowCount, acceptedMetricRows, rejectedMetricRows: rejectedMetrics.length, seededCollections, collectionArtworkRequired: true, collectionGuardsMatched: true, productionConnections: false }));
  } finally {
    for (const client of clients) await client.end().catch(() => {});
    if (started) {
      phase = 'local-cluster-cleanup';
      await execute(join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', '-t', '20', 'stop'], { env });
    }
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const detailCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN';
  console.error(JSON.stringify({ code: 'LOCAL_BACKUP_SCHEMA_UPDATE_FAILED', phase, detailCode, productionConnections: false,
    ...(detailCode === 'PG18_TOOLS_REQUIRED' ? { hint: 'Install PostgreSQL 18 tools (initdb, pg_ctl, pg_dump, postgres) in PATH or set MEDIA_BACKUP_TEST_PG_BIN to their bin directory. No running server is required; this integration test creates a private local cluster.' } : {}) }));
  process.exitCode = 1;
});
