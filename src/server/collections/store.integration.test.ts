import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { eq } from 'drizzle-orm';
import { recipes } from '../../lib/recipes';
import type { EditorialActor } from '../../lib/editorial-types';
import { defaultCollectionPalette, resolveCollection, type CollectionRecord, type CollectionTheme } from '../../lib/collections';
import { toPublicRecipe } from '../../lib/recipe-presentation';
import { closeDb, getDb } from '../db';
import { restoreBundleSql } from '../media-backup/restore';
import { getPublishedRecipes } from '../editorial/store';
import { legacyCollections, seedLegacyCollections } from '../../../scripts/collection-migration-seed';
import { createCollection, getCollection, getPublishedCollectionDefinitions, listCollections, performCollectionAction, saveCollection, saveCollectionInTransaction } from './store';
import { CollectionError } from './errors';
import { collectionAssets } from './theme-schema';
import type { ThemeExecutionDependencies } from './theme-store';

// This suite owns a fresh Unix-socket PostgreSQL cluster. It never reads .env,
// inherits an application DSN, reaches a network interface or calls a provider.
const execute = promisify(execFile);
const binary = process.env.MEDIA_BACKUP_TEST_PG_BIN || '/opt/homebrew/opt/postgresql@18/bin';
const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC', NODE_ENV: 'test', PGPASSFILE: '/dev/null' };
const actor: EditorialActor = { id: 'collection-test-owner', name: 'Forged browser name', email: 'fixture@example.invalid', role: 'owner' };
let root: string, data: string, socket: string, client: Client;
let started = false;
const originalFetch = globalThis.fetch;
const previousDatabase = process.env.DATABASE_URL;
const previousSnapshot = process.env.PUBLIC_RECIPE_SNAPSHOT_ENABLED;

before(async () => {
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') throw new Error('LOCAL_COLLECTION_TEST_ONLY');
  globalThis.fetch = async () => { throw new Error('Collection integration test forbids network access.'); };
  const version = await execute(join(binary, 'initdb'), ['--version'], { env: environment });
  assert.match(version.stdout, /PostgreSQL\) 18\./);
  root = await mkdtemp(join(tmpdir(), 'jesie-collections-')); await chmod(root, 0o700);
  data = join(root, 'data'); socket = join(root, 'socket'); await mkdir(socket, { mode: 0o700 });
  await execute(join(binary, 'initdb'), ['-D', data, '-U', 'collection_fixture_owner', '--encoding=UTF8', '--locale=C', '--auth-local=trust', '--auth-host=reject'], { env: environment });
  await execute(join(binary, 'pg_ctl'), ['-D', data, '-l', join(root, 'postgres.log'), '-w', '-t', '20', '-o', `-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -p 55489 -c ssl=off -c shared_buffers=16MB`, 'start'], { env: environment });
  started = true;
  client = new Client({ host: socket, port: 55489, user: 'collection_fixture_owner', database: 'postgres', ssl: false });
  await client.connect();
  const identity = (await client.query("SELECT current_setting('data_directory') AS data,inet_server_addr() AS address")).rows[0];
  assert.equal(await realpath(identity.data), await realpath(data)); assert.equal(identity.address, null);
  for (const name of ['pre-data.sql', 'post-data.sql']) await client.query(restoreBundleSql(await readFile(join('src/server/media-backup/schema', name), 'utf8')));
  await client.query('SET search_path = public');
  if (!(await client.query("SELECT to_regclass('public.event_collection') IS NOT NULL AS present")).rows[0].present) await client.query(await readFile('migrations/0030-collections.sql', 'utf8'));
  if (!(await client.query("SELECT to_regclass('public.collection_theme_generation') IS NOT NULL AS present")).rows[0].present) await client.query(await readFile('migrations/0031-collection-themes.sql', 'utf8'));
  await client.query("INSERT INTO auth_user(id,name,email,role) VALUES('collection-test-owner','Stored collection owner','fixture@example.invalid','owner')");
  await client.query("INSERT INTO ai_budget_settings(id,daily_limit_usd,monthly_limit_usd,pilot_limit_usd) VALUES('studio',NULL,NULL,NULL)");
  for (let index = 0; index < 6; index++) {
    const recipe = { ...structuredClone(recipes[0]), id: `collection-recipe-${index}`, slug: { pl: `przepis-kolekcji-${index}`, en: `collection-recipe-${index}` }, times: { active: 10, cooking: 10, rest: 0, total: 20 }, seo: { ...recipes[0].seo, collectionIds: ['one-pot', 'pantry', 'seasonal'] } };
    const content = { recipe, originalText: '', author: 'Fixture', sources: [], photos: { ingredients: {}, steps: {} } };
    await client.query("INSERT INTO editorial_recipe(id,content,content_hash,checks,created_by,updated_by,updated_by_name) VALUES($1,$2,'fixture','{}','fixture','fixture','Fixture')", [recipe.id, JSON.stringify(content)]);
    if (index < 5) {
      const publicationId = randomUUID();
      await client.query("INSERT INTO editorial_publication(id,recipe_id,revision,snapshot,content_hash,checks,approval_origin,published_by,published_by_name) VALUES($1,$2,1,$3,'fixture','{}','legacy_demo_import','fixture','Fixture')", [publicationId, recipe.id, JSON.stringify(content)]);
      await client.query("UPDATE editorial_recipe SET publication_status='published',published_id=$2,published_revision=1 WHERE id=$1", [recipe.id, publicationId]);
    }
  }
  await seedLegacyCollections(client);
  const migrationHash = createHash('sha256').update(await readFile('migrations/0030-collections.sql', 'utf8')).update(JSON.stringify(legacyCollections)).digest('hex');
  await client.query('CREATE TABLE IF NOT EXISTS editorial_migration(name text PRIMARY KEY,hash text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
  await client.query("INSERT INTO editorial_migration(name,hash) VALUES('0030-collections',$1)", [migrationHash]);
  const url = new URL('postgresql://collection_fixture_owner@localhost:55489/postgres'); url.searchParams.set('host', socket);
  process.env.DATABASE_URL = url.toString(); process.env.PUBLIC_RECIPE_SNAPSHOT_ENABLED = 'false';
  await closeDb();
}, { timeout: 40_000 });
after(async () => {
  globalThis.fetch = originalFetch;
  await closeDb();
  if (client) await client.end();
  if (started) await execute(join(binary, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', '-t', '20', 'stop'], { env: environment });
  if (root) await rm(root, { recursive: true, force: true });
  if (previousDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDatabase;
  if (previousSnapshot === undefined) delete process.env.PUBLIC_RECIPE_SNAPSHOT_ENABLED; else process.env.PUBLIC_RECIPE_SNAPSHOT_ENABLED = previousSnapshot;
}, { timeout: 30_000 });

async function readyCollection(label: string, promotion: CollectionRecord['content']['promotion'] = null) {
  let record = await createCollection({ title: label }, actor);
  record = await saveCollection(record.id, { expectedRevision: record.revision, content: { ...record.content,
    title: { pl: label, en: `${label} EN` }, description: { pl: 'Opis kolekcji', en: 'Collection description' }, slug: { ...record.content.slug, en: `${record.content.slug.pl}-en` }, recipeIds: ['collection-recipe-0'], promotion } }, actor);
  const generationId = randomUUID(), assetId = randomUUID();
  const theme: CollectionTheme = { version: 1, palette: { ...defaultCollectionPalette }, hero: { assetId, src: `/media/collections/${assetId}`, width: 2048, height: 1536, alt: { pl: 'Ilustracja kolekcji', en: 'Collection illustration' } }, atmosphere: null, decorationOpacity: .12 };
  await client.query(`INSERT INTO collection_theme_generation(id,collection_id,base_revision,part,brief,input,theme,status,request_key,input_hash,created_by,applied_revision)
    VALUES($1,$2,$3,'all','Synthetic test theme','{}',$4,'ready',$5,'fixture','collection-test-owner',$6)`, [generationId, record.id, record.revision, JSON.stringify(theme), randomUUID(), record.revision + 1]);
  await client.query(`INSERT INTO collection_asset(id,collection_id,generation_id,kind,blob_pathname,sha256,width,height,content_type)
    VALUES($1,$2,$3,'hero',$4,$5,2048,1536,'image/webp')`, [assetId, record.id, generationId, `media/collections/${assetId}.webp`, 'b'.repeat(64)]);
  return getDb().transaction(tx => saveCollectionInTransaction(tx, record.id, { expectedRevision: record.revision, content: { ...record.content, theme, themeGenerationId: generationId } }, actor, { allowThemeChange: true }));
}
function errorCode(code: string) { return (error: unknown) => error instanceof CollectionError && error.code === code; }

test('migration preserves four IDs/slugs and initial published-only manual membership', async () => {
  const records = await listCollections();
  for (const id of ['quick-dinners', 'one-pot', 'pantry', 'seasonal']) {
    const record = records.find(item => item.id === id)!;
    assert.ok(record); assert.equal(record.publicationStatus, 'published'); assert.equal(record.content.minimumRecipes, 5);
    assert.equal(record.hasUnpublishedChanges, false);
    if (id === 'quick-dinners') assert.equal(record.content.selectionMode, 'quick-dinners');
    else { assert.equal(record.content.recipeIds.length, 5); assert.equal(record.content.recipeIds.includes('collection-recipe-5'), false); }
  }
  assert.equal((await getCollection('seasonal')).content.slug.pl, 'sezonowe-obiady-i-zupy');
});
test('the explicit migration runner replays a completed migration without duplicating legacy collections', { timeout: 30_000 }, async () => {
  const environmentFile = join(root, 'fixture.env');
  await writeFile(environmentFile, `DATABASE_URL=${process.env.DATABASE_URL}\n`, { mode: 0o600 });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await execute(process.execPath, ['--import', 'tsx', 'scripts/migrate-collections.ts', environmentFile], { env: environment, timeout: 12_000 });
    assert.match(result.stdout, /already current/);
  }
  assert.equal((await listCollections()).length, 4);
});
test('publication requires PL/EN and one currently published recipe plus reviewed graphics', async () => {
  const incomplete = await createCollection({ title: 'Niepełna kolekcja' }, actor);
  await assert.rejects(performCollectionAction(incomplete.id, { expectedRevision: incomplete.revision, action: 'publish' }, actor), errorCode('PUBLICATION_BLOCKED'));
  const ready = await readyCollection('Kolekcja jednego przepisu');
  const published = await performCollectionAction(ready.id, { expectedRevision: ready.revision, action: 'publish' }, actor);
  assert.equal(published.publicationStatus, 'published'); assert.equal(published.content.minimumRecipes, 1);
  assert.equal(published.updatedBy, 'Stored collection owner');
});
test('saving changes leaves the immutable public snapshot unchanged and conflicts reject stale revisions', async () => {
  let record = await readyCollection('Snapshot kolekcji');
  record = await performCollectionAction(record.id, { expectedRevision: record.revision, action: 'publish' }, actor);
  const saved = await saveCollection(record.id, { expectedRevision: record.revision, content: { ...record.content, title: { ...record.content.title, pl: 'Nowy tytuł szkicu' } } }, actor);
  assert.equal(saved.hasUnpublishedChanges, true);
  assert.equal((await getPublishedCollectionDefinitions()).find(item => item.id === record.id)?.title.pl, 'Snapshot kolekcji');
  await assert.rejects(saveCollection(record.id, { expectedRevision: record.revision, content: saved.content }, actor), errorCode('REVISION_CONFLICT'));
  await assert.rejects(client.query("UPDATE event_collection_publication SET snapshot='{}' WHERE collection_id=$1", [record.id]), /immutable/);
});
test('addresses stay locked and reserved after unpublishing; drafts cannot hijack accepted themes', async () => {
  let record = await readyCollection('Adres zarezerwowany');
  record = await performCollectionAction(record.id, { expectedRevision: record.revision, action: 'publish' }, actor);
  record = await performCollectionAction(record.id, { expectedRevision: record.revision, action: 'unpublish' }, actor);
  await assert.rejects(createCollection({ title: 'Adres zarezerwowany' }, actor), errorCode('SLUG_TAKEN'));
  await assert.rejects(saveCollection(record.id, { expectedRevision: record.revision, content: { ...record.content, slug: { pl: 'zmieniony-adres', en: record.content.slug.en } } }, actor), errorCode('SLUG_LOCKED'));
  await assert.rejects(saveCollection(record.id, { expectedRevision: record.revision, content: { ...record.content, theme: null } }, actor), errorCode('THEME_REVIEW_REQUIRED'));
  await assert.rejects(client.query("UPDATE event_collection SET content=jsonb_set(content,'{slug,pl}','\"direct-hijack\"') WHERE id=$1", [record.id]), /COLLECTION_PUBLISHED_SLUG_IMMUTABLE/);
});
test('concurrent overlapping promotions publish only one collection', async () => {
  const first = await readyCollection('Nakładanie pierwsze', { from: '2026-12-01', to: '2026-12-26' });
  const second = await readyCollection('Nakładanie drugie', { from: '2026-12-26', to: '2027-01-01' });
  const results = await Promise.allSettled([first, second].map(record => performCollectionAction(record.id, { expectedRevision: record.revision, action: 'publish' }, actor)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal(errorCode('PROMOTION_OVERLAP')(rejected.reason), true);
});
test('live disabled roles cannot create collections even with a forged owner DTO', async () => {
  await client.query("INSERT INTO auth_user(id,name,email,role,disabled) VALUES('disabled-collection-owner','Disabled','disabled@example.invalid','admin',true)");
  await assert.rejects(createCollection({ title: 'Denied fixture' }, { ...actor, id: 'disabled-collection-owner' }), errorCode('FORBIDDEN'));
});
test('generated theme receipts replay safely, apply privately, publish separately and preserve the background on a hero-only change', { timeout: 120_000 }, async () => {
  const serviceKeys = ['OPENAI_API_KEY', 'FAL_KEY', 'BLOB_READ_WRITE_TOKEN'] as const;
  const previous = Object.fromEntries(serviceKeys.map(key => [key, process.env[key]]));
  for (const key of serviceKeys) process.env[key] = 'offline-collection-fixture';
  try {
    const { createThemeGeneration, claimThemeDispatch, advanceThemeGeneration, getThemeGeneration, applyThemeGeneration, stopThemeGeneration, resumeThemeGeneration } = await import('./theme-store');
    let record = await createCollection({ title: 'Pełna generacja testowa' }, actor);
    record = await saveCollection(record.id, { expectedRevision: record.revision, content: { ...record.content, title: { pl: 'Pełna generacja testowa', en: 'Full generation fixture' },
      description: { pl: 'Opis', en: 'Description' }, slug: { pl: 'pelna-generacja-testowa', en: 'full-generation-fixture' }, recipeIds: ['collection-recipe-0'] } }, actor);
    const submitCounts = { spec: 0, image: 0 }, polls = new Map<string, number>(), parts = new Map<string, string>(), imageReferences: string[][] = [];
    const proposal = { palette: { ...defaultCollectionPalette }, decorationOpacity: .12, heroPrompt: 'Create a dedicated collection illustration with clear space around its subject.', atmospherePrompt: 'Create a subtle collection background with ornamental edges and a quiet centre.', heroAlt: { pl: 'Ilustracja testowa', en: 'Fixture illustration' }, atmosphereAlt: { pl: 'Tło testowe', en: 'Fixture background' } };
    const execution: Partial<ThemeExecutionDependencies> = {
      ensureStorage: async () => {},
      readAsset: async (collectionId, assetId, kind) => {
        const [row] = await getDb().select().from(collectionAssets).where(eq(collectionAssets.id, assetId));
        return row && row.collectionId === collectionId && (!kind || row.kind === kind) ? { row, bytes: Buffer.from('offline-image') } : null;
      },
      saveAsset: async input => {
        const [row] = await getDb().insert(collectionAssets).values({ id: input.id!, collectionId: input.collectionId, generationId: input.generationId!, kind: input.kind,
          blobPathname: `media/collections/${input.id}.webp`, sha256: 'c'.repeat(64), width: 1800, height: input.kind === 'hero' ? 1800 : 1013, contentType: 'image/webp' }).returning();
        return row;
      },
      submitSpec: async (jobId, _model, input) => { submitCounts.spec++; const receipt = `resp_offline_${jobId}`; parts.set(receipt, input.part); return receipt; },
      pollSpec: async (_model, receipt) => {
        const reads = (polls.get(receipt) ?? 0) + 1; polls.set(receipt, reads);
        if (reads === 1) return { done: false as const };
        return { done: true as const, proposal: parts.get(receipt) === 'hero' ? { ...proposal, palette: { ...proposal.palette, accent: '#8a3027', accentText: '#ffffff' } } : proposal, chargedUsd: '0.01000000' };
      },
      uploadReference: async () => 'https://fal.media/offline-reference.webp',
      submitImage: async (model, _kind, _proposal, references) => { submitCounts.image++; imageReferences.push(references); return { model: references.length ? model.replace('/text-to-image', '/edit') : model, requestId: `offline-image-${submitCounts.image}` }; },
      pollImage: async (_model, receipt) => {
        const reads = (polls.get(receipt) ?? 0) + 1; polls.set(receipt, reads);
        return reads === 1 ? { done: false as const } : { done: true as const, bytes: Buffer.from('offline-generated-image'), chargedUsd: '0.03000000' };
      },
    };
    const input = { expectedRevision: record.revision, brief: 'Świąteczny klimat w kolorach serwisu, ilustracje i spokojne tło.', part: 'all' as const, inspirationAssetId: null, requestKey: randomUUID() };
    const generation = await createThemeGeneration(record.id, input, actor);
    assert.equal((await createThemeGeneration(record.id, input, actor)).id, generation.id);
    assert.equal((await createThemeGeneration(record.id, { ...input, requestKey: randomUUID() }, actor)).id, generation.id);
    const foreign = await createCollection({ title: 'Obca kolekcja wznowienia' }, actor);
    await assert.rejects(resumeThemeGeneration(foreign.id, generation.id, foreign.revision, actor), errorCode('GENERATION_NOT_FOUND'));
    const staleToken = await claimThemeDispatch(generation.id); assert.ok(staleToken);
    const token = randomUUID();
    await client.query('UPDATE collection_theme_generation SET dispatch_token=$2 WHERE id=$1', [generation.id, token]);
    await stopThemeGeneration(generation.id, 'Stary worker nie może zatrzymać nowego.', staleToken);
    assert.equal((await getThemeGeneration(record.id, generation.id))?.status, 'queued');
    assert.equal(await advanceThemeGeneration(generation.id, staleToken, execution), true);
    assert.deepEqual(submitCounts, { spec: 0, image: 0 });
    assert.equal((await getThemeGeneration(record.id, generation.id))?.status, 'queued');
    for (let iteration = 0; iteration < 20; iteration++) if (await advanceThemeGeneration(generation.id, token, execution)) break;
    const ready = await getThemeGeneration(record.id, generation.id); assert.equal(ready?.status, 'ready'); assert.equal(ready.chargedUsd, '0.07000000');
    await stopThemeGeneration(generation.id, 'Spóźniony błąd workera nie może nadpisać gotowego wyniku.', token);
    assert.equal((await getThemeGeneration(record.id, generation.id))?.status, 'ready');
    assert.deepEqual(submitCounts, { spec: 1, image: 2 });
    await advanceThemeGeneration(generation.id, token, execution); assert.deepEqual(submitCounts, { spec: 1, image: 2 });
    assert.equal((await getPublishedCollectionDefinitions()).some(item => item.id === record.id), false);
    record = await applyThemeGeneration(record.id, generation.id, record.revision, actor);
    assert.ok(record.content.theme?.atmosphere);
    record = await performCollectionAction(record.id, { expectedRevision: record.revision, action: 'publish' }, actor);
    const oldTheme = structuredClone(record.content.theme!);
    const heroChange = await createThemeGeneration(record.id, { ...input, expectedRevision: record.revision, part: 'hero', requestKey: randomUUID() }, actor);
    const heroToken = await claimThemeDispatch(heroChange.id); assert.ok(heroToken);
    for (let iteration = 0; iteration < 15; iteration++) if (await advanceThemeGeneration(heroChange.id, heroToken, execution)) break;
    const heroReady = await getThemeGeneration(record.id, heroChange.id); assert.equal(heroReady?.status, 'ready');
    assert.deepEqual(heroReady.theme!.palette, oldTheme.palette); assert.deepEqual(heroReady.theme!.atmosphere, oldTheme.atmosphere);
    assert.notEqual(heroReady.theme!.hero.assetId, oldTheme.hero.assetId);
    assert.equal(imageReferences.at(-1)!.length, 1, 'A hero-only update uses the current artwork as a reference.');
    record = await applyThemeGeneration(record.id, heroChange.id, record.revision, actor);
    assert.equal((await getPublishedCollectionDefinitions()).find(item => item.id === record.id)!.theme!.hero.assetId, oldTheme.hero.assetId);
    record = await performCollectionAction(record.id, { expectedRevision: record.revision, action: 'publish' }, actor);
    assert.equal((await getPublishedCollectionDefinitions()).find(item => item.id === record.id)!.theme!.hero.assetId, record.content.theme!.hero.assetId);
    assert.deepEqual(submitCounts, { spec: 2, image: 3 });
  } finally {
    for (const key of serviceKeys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
});
test('withdrawing the final recipe retains the published collection identity and removes its discoverable membership', async () => {
  let record = await readyCollection('Wycofany ostatni przepis');
  record = await performCollectionAction(record.id, { expectedRevision: record.revision, action: 'publish' }, actor);
  await client.query("UPDATE editorial_recipe SET publication_status='unpublished' WHERE id='collection-recipe-0'");
  const definition = (await getPublishedCollectionDefinitions()).find(item => item.id === record.id)!;
  const available = (await getPublishedRecipes()).map(toPublicRecipe);
  assert.ok(definition); assert.deepEqual(resolveCollection(definition, available, 'pl').recipes, []);
  const invalid = await readyCollection('Nieopublikowany członek');
  await assert.rejects(performCollectionAction(invalid.id, { expectedRevision: invalid.revision, action: 'publish' }, actor), errorCode('PUBLICATION_BLOCKED'));
});
