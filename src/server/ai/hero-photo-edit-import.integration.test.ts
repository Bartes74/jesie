import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from 'dotenv';
import { Pool } from 'pg';
import sharp from 'sharp';
import type { AiAsset } from '@/lib/ai-types';
import type { EditorialActor, EditorialContent } from '@/lib/editorial-types';
import { heroPresentationProfile } from '@/lib/hero-presentation';
import { recipes } from '@/lib/recipes';
import { closeDb, getDb } from '@/server/db';
import { approveRecipeContent, contentApprovalHash, isRecipeContentApproved } from '@/server/editorial/content-approval';
import { contentHash, createRecipe, getRecipe, saveRecipe } from '@/server/editorial/store';
import { AiError } from './errors';
import { heroPhotoEditModel, importHeroPhotoEdit, type HeroPhotoEditImport, type HeroPhotoEditImportStorage } from './hero-photo-edit-import';
import { approvedImageModel } from './image-actions';
import { registerFixturePhotos } from './recipe-photo-test-fixture';
import { aiAssets, aiJobs, aiPhotoBatches } from './schema';
import { applyJob } from './store';

// Real Postgres in a disposable schema. All pictures are synthetic fixtures;
// provider HTTP and real blob storage are forbidden throughout this suite.
const schema = `hero_edit_test_${randomUUID().replaceAll('-', '')}`;
const actor: EditorialActor = { id: 'owner', name: 'Client name', email: 'owner@example.invalid', role: 'owner' };
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
let admin: Pool, pool: Pool, directory: string, source: Buffer, corrected: Buffer, originalFetch: typeof fetch;

before(async () => {
  if (process.env.NODE_ENV === 'production') throw new Error('Tests require a development environment.');
  config({ path: '.env.local', quiet: true });
  const connection = process.env.AI_TEST_DATABASE_URL || process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL_NON_POOLING;
  if (!connection) throw new Error('A real development Postgres connection is required.');
  admin = new Pool({ connectionString: connection, max: 1, connectionTimeoutMillis: 20_000, query_timeout: 30_000 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(connection); url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  pool = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 20_000, query_timeout: 30_000 });
  await pool.query("CREATE TABLE auth_user(id text PRIMARY KEY,name text NOT NULL,email text NOT NULL UNIQUE,email_verified boolean NOT NULL DEFAULT false,image text,role text NOT NULL DEFAULT 'admin',disabled boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())");
  await pool.query("INSERT INTO auth_user(id,name,email,role) VALUES('owner','Stored owner','owner@example.invalid','owner'),('reader','Reader','reader@example.invalid','reader')");
  for (const migration of (await readdir('migrations')).filter(file => /^\d{4}-.*\.sql$/.test(file)).sort())
    await pool.query(await readFile(`migrations/${migration}`, 'utf8'));
  directory = await mkdtemp(join(tmpdir(), 'hero-edit-test-'));
  const pixels = Buffer.alloc(800 * 600 * 4);
  for (let y = 100; y < 500; y++) for (let x = 100; x < 700; x++) {
    const offset = (y * 800 + x) * 4;
    pixels[offset] = 180; pixels[offset + 1] = 90; pixels[offset + 2] = 30; pixels[offset + 3] = 255;
  }
  source = await sharp(pixels, { raw: { width: 800, height: 600, channels: 4 } }).png().toBuffer();
  corrected = await sharp(source).resize(960, 720).png().toBuffer();
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Provider HTTP is forbidden in this test.'); };
});

after(async () => {
  if (originalFetch) globalThis.fetch = originalFetch;
  await closeDb();
  if (pool) await pool.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
  if (directory) await rm(directory, { recursive: true, force: true });
});

function content(id: string): EditorialContent {
  const recipe = structuredClone(recipes[0]);
  Object.assign(recipe, {
    id, title: { pl: 'Marchew na półmisku', en: 'Carrot on a platter' },
    slug: { pl: `marchew-${id}`, en: `carrot-${id}` }, image: '',
    imageAlt: { pl: 'Zatwierdzony opis zdjęcia marchewki', en: 'Approved carrot photograph description' }, diet: 'vegan',
    ingredients: [{ id: 'carrot', name: { pl: 'Marchew', en: 'Carrot' }, amount: { kind: 'exact', value: '100' }, unit: 'g', scaling: 'linear', group: { pl: 'Składniki', en: 'Ingredients' } }],
    steps: [{ id: 'prepare', title: { pl: 'Przygotuj', en: 'Prepare' }, text: { pl: 'Przygotuj {{carrot}} i podaj na półmisku.', en: 'Prepare {{carrot}} and serve on a platter.' } }],
    substitutions: [], dietaryTags: [],
    heroPresentation: { container: 'platter', finalAppearance: { pl: 'Pomarańczowa marchew na ceramicznym półmisku.', en: 'Orange carrot on a ceramic platter.' }, evidenceStepIds: ['prepare'], profileVersion: heroPresentationProfile },
  });
  recipe.provenance.kitchenTested = false;
  return { recipe, originalText: 'Niezmieniony pierwotny opis autora.', author: 'Original author', sources: [], photos: {
    ingredients: { carrot: { src: '/fixture-carrot.webp', columns: 1, rows: 1, index: 0, alt: { pl: 'Marchew', en: 'Carrot' } } },
    steps: { prepare: { src: '/fixture-step.webp', columns: 1, rows: 1, index: 0, alt: { pl: 'Podanie', en: 'Serving' } } },
  } };
}

async function fixture() {
  const draft = await createRecipe({ title: 'Hero edit fixture', originalText: 'Original' }, actor);
  const sourceId = randomUUID(), batchId = randomUUID();
  const proposal = await registerFixturePhotos(content(draft.id), actor, draft.revision);
  proposal.recipe.image = `/media/${sourceId}`;
  const asset: AiAsset = { id: sourceId, jobId: sourceId, recipeId: draft.id, kind: 'hero', targetId: null,
    src: proposal.recipe.image, width: 800, height: 600, model: approvedImageModel,
    alt: { pl: 'Dawny opis źródłowego zdjęcia', en: 'Old source photograph description' }, caption: { pl: '', en: '' },
    styleProfile: heroPresentationProfile, createdAt: new Date().toISOString() };
  await getDb().insert(aiPhotoBatches).values({ id: batchId, recipeId: draft.id, baseRevision: draft.revision,
    input: proposal, inputHash: contentHash(proposal),
    slots: [{ kind: 'hero', targetId: null, label: 'Finished dish', jobId: sourceId }], status: 'applied',
    requestKey: randomUUID(), createdBy: actor.id, createdByName: 'Stored owner', reservedUsd: '0', remainingReservedUsd: '0', appliedRevision: draft.revision + 1 });
  await getDb().insert(aiJobs).values({ id: sourceId, photoBatchId: batchId, recipeId: draft.id, baseRevision: draft.revision,
    kind: 'hero', targetId: null, status: 'applied', provider: 'fal', model: approvedImageModel,
    brief: 'Synthetic source photograph', requestKey: randomUUID(), inputHash: contentHash(proposal), input: proposal,
    createdBy: actor.id, createdByName: 'Stored owner', providerRequestId: `fixture-${sourceId}`, reservedUsd: '0', chargedUsd: '0', costBasis: 'usage',
    providerFinishedAt: new Date(), result: { content: null, asset, notes: [] }, appliedRevision: draft.revision + 1 });
  await getDb().insert(aiAssets).values({ id: sourceId, jobId: sourceId, recipeId: draft.id, kind: 'hero', targetId: null,
    blobPathname: `fixture/${sourceId}.png`, originalBlobPathname: `fixture/${sourceId}.png`, width: 800, height: 600,
    contentType: 'image/png', alt: asset.alt, caption: asset.caption, model: approvedImageModel });
  const saved = await saveRecipe(draft.id, { expectedRevision: draft.revision, content: proposal }, actor);
  await approveRecipeContent(saved.id, saved.revision, actor);
  const localPath = join(directory, `${sourceId}.png`);
  await writeFile(localPath, corrected);
  const input: HeroPhotoEditImport = { recipeId: saved.id, expectedRevision: saved.revision, sourceJobId: sourceId,
    sourceAssetId: sourceId, sourceSha256: digest(source), localPath, sha256: digest(corrected), requestKey: randomUUID(),
    reviewNote: 'Reviewed synthetic background correction; retain the approved dish and platter.' };
  let reads = 0, uploads = 0;
  const storage: HeroPhotoEditImportStorage = {
    async read(pathname) { reads++; assert.equal(pathname, `fixture/${sourceId}.png`); return source; },
    async ensure(pathname, bytes, sha256) {
      uploads++; assert.deepEqual(bytes, corrected); assert.equal(sha256, digest(bytes));
      assert(pathname.startsWith(`ai/hero-photo-edit/${saved.id}/`)); return pathname;
    },
  };
  return { saved, sourceId, batchId, input, storage, calls: () => ({ reads, uploads }) };
}

async function retainedRows(recipeId: string) {
  const statements = [
    'SELECT * FROM ai_job WHERE recipe_id=$1 AND model <> $2 ORDER BY id',
    'SELECT * FROM ai_asset WHERE recipe_id=$1 AND model <> $2 ORDER BY id',
    'SELECT * FROM ai_photo_batch WHERE recipe_id=$1 ORDER BY id',
    'SELECT * FROM editorial_content_approval WHERE recipe_id=$1 ORDER BY content_hash,origin',
    'SELECT * FROM editorial_publication WHERE recipe_id=$1 ORDER BY id',
  ];
  return Promise.all(statements.map((statement, index) => pool.query(statement, index < 2 ? [recipeId, heroPhotoEditModel] : [recipeId]).then(result => result.rows)));
}

function aiCode(code: string) { return (error: unknown) => error instanceof AiError && error.code === code; }

test('reviewed edit imports once without provider charges and ordinary apply replaces only the approved hero', async () => {
  const fixtureData = await fixture();
  const { saved, input, storage } = fixtureData;
  const before = await getRecipe(saved.id), retained = await retainedRows(saved.id);
  const imported = await importHeroPhotoEdit(input, actor, storage);
  assert.equal(imported.status, 'ready'); assert.equal(imported.model, heroPhotoEditModel);
  assert.equal(imported.provider, 'openai'); assert.equal(imported.providerRequestId, null);
  assert.equal(Number(imported.reservedUsd), 0); assert.equal(Number(imported.chargedUsd), 0);
  assert.deepEqual(imported.result?.derivation, { method: 'builtin_hero_background_edit', sourceJobId: input.sourceJobId,
    sourceAssetId: input.sourceAssetId, sha256: input.sha256, sourceSha256: input.sourceSha256 });
  assert.equal(imported.result?.asset?.width, 960); assert.equal(imported.result?.asset?.height, 720);
  assert.deepEqual(await getRecipe(saved.id), before, 'Import alone must leave the draft untouched.');
  assert.equal((await importHeroPhotoEdit(input, actor, storage)).id, imported.id);
  assert.deepEqual(fixtureData.calls(), { reads: 1, uploads: 1 });
  const execution = (await pool.query('SELECT photo_batch_id,trend_run_id,created_by_name FROM ai_job WHERE id=$1', [imported.id])).rows[0];
  assert.deepEqual(execution, { photo_batch_id: null, trend_run_id: null, created_by_name: 'Stored owner' });
  const ledger = (await pool.query('SELECT entry,amount_usd,basis FROM ai_cost_ledger WHERE job_id=$1 ORDER BY entry', [imported.id])).rows;
  assert.deepEqual(ledger.map(row => ({ ...row, amount_usd: Number(row.amount_usd) })), [
    { entry: 'reserve', amount_usd: 0, basis: 'not_charged' }, { entry: 'settle', amount_usd: 0, basis: 'not_charged' },
  ]);
  const applied = await applyJob(imported.id, { expectedRevision: before.revision, acknowledgeStale: false }, actor);
  const expected = structuredClone(before.content); expected.recipe.image = imported.result!.asset!.src;
  assert.deepEqual(applied.recipe.content, expected, 'Only the hero URL changes, including preservation of the current edited alt text.');
  assert.equal(applied.recipe.revision, before.revision + 1); assert.equal(applied.job.status, 'applied');
  assert.equal(applied.recipe.publicationStatus, 'never_published'); assert.equal(applied.recipe.editorialStatus, 'draft');
  assert.equal(contentApprovalHash(applied.recipe.content), contentApprovalHash(before.content));
  assert.equal(await isRecipeContentApproved(applied.recipe), true);
  assert.deepEqual(await retainedRows(saved.id), retained, 'Sources, other photos, the prior package, approval and publications stay unchanged.');
  assert.equal((await importHeroPhotoEdit(input, actor, storage)).id, imported.id, 'The same request remains retryable after apply.');
  assert.deepEqual(fixtureData.calls(), { reads: 1, uploads: 1 });
  assert.equal((await pool.query('SELECT count(*)::int n FROM ai_job WHERE recipe_id=$1 AND model=$2', [saved.id, heroPhotoEditModel])).rows[0].n, 1);
});

test('stale revision, forged actor, changed source and mismatched hashes fail before any upload', async () => {
  const data = await fixture();
  const { saved, input, storage } = data;
  await assert.rejects(importHeroPhotoEdit({ ...input, expectedRevision: saved.revision - 1 }, actor, storage), aiCode('REVISION_CONFLICT'));
  await assert.rejects(importHeroPhotoEdit(input, { ...actor, id: 'reader' }, storage), aiCode('FORBIDDEN'));
  assert.deepEqual(data.calls(), { reads: 0, uploads: 0 });
  await assert.rejects(importHeroPhotoEdit({ ...input, sourceSha256: '0'.repeat(64) }, actor, storage), aiCode('PHOTO_SOURCE_INVALID'));
  await assert.rejects(importHeroPhotoEdit({ ...input, sha256: '0'.repeat(64) }, actor, storage), aiCode('IMPORTED_IMAGE_INVALID'));
  assert.equal(data.calls().uploads, 0);
  const changed = structuredClone(saved.content); changed.recipe.image = '';
  const current = await saveRecipe(saved.id, { expectedRevision: saved.revision, content: changed }, actor);
  const calls = data.calls();
  await assert.rejects(importHeroPhotoEdit({ ...input, expectedRevision: current.revision }, actor, storage), aiCode('PHOTO_REPLACEMENT_CONFLICT'));
  assert.deepEqual(data.calls(), calls, 'A changed displayed source is rejected before touching storage.');
  assert.equal((await pool.query('SELECT count(*)::int n FROM ai_job WHERE recipe_id=$1 AND model=$2', [saved.id, heroPhotoEditModel])).rows[0].n, 0);
});

test('a concurrent draft change during upload cannot commit the reviewed correction or overwrite the newer draft', async () => {
  const data = await fixture();
  let changedRevision = 0;
  const storage: HeroPhotoEditImportStorage = { ...data.storage,
    async ensure(pathname, bytes, sha256) {
      await data.storage.ensure(pathname, bytes, sha256);
      const next = structuredClone(data.saved.content); next.author = 'New manual author';
      changedRevision = (await saveRecipe(data.saved.id, { expectedRevision: data.saved.revision, content: next }, actor)).revision;
      return pathname;
    },
  };
  await assert.rejects(importHeroPhotoEdit(data.input, actor, storage), aiCode('REVISION_CONFLICT'));
  const current = await getRecipe(data.saved.id);
  assert.equal(current.revision, changedRevision); assert.equal(current.content.author, 'New manual author');
  assert.equal(current.content.recipe.image, data.saved.content.recipe.image);
  assert.equal((await pool.query('SELECT count(*)::int n FROM ai_job WHERE recipe_id=$1 AND model=$2', [data.saved.id, heroPhotoEditModel])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM ai_cost_ledger l JOIN ai_job j ON j.id=l.job_id WHERE j.recipe_id=$1', [data.saved.id])).rows[0].n, 0);
});
