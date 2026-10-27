import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Pool } from 'pg';
import type { EditorialActor, EditorialContent, EditorialRecord } from '../../lib/editorial-types';
import { recipes } from '../../lib/recipes';
import { resolveHeroPresentation } from '../../lib/hero-presentation';
import { getIngredientImage, getStepImage } from '../../lib/recipe-media';
import { closeDb, getDb } from '../db';
import { applyAiProposalInTransaction, contentHash, createRecipe, deleteRecipe, EditorialError, getPublishedRecipe, getPublishedRecipeById, getPublishedRecipes, getRecipe, listRecipes, performRecipeAction, saveRecipe } from './store';
import { aiAssets, aiJobs } from '../ai/schema';
import { publicationIssues } from './validation';
import { registerFixturePhotos } from '../ai/recipe-photo-test-fixture';

// Real Postgres, isolated disposable schema; never alter the existing editorial data.
const schema = `editorial_test_${randomUUID().replaceAll('-', '')}`;
let adminPool: Pool;
let isolatedPool: Pool;
const actor: EditorialActor = { id: 'test-owner', name: 'Forged client name', email: 'owner@example.invalid', role: 'owner' };
const checks = { pl: true, en: true, quantities: true, method: true, photos: true, sources: true };

before(async () => {
  if (process.env.NODE_ENV === 'production') throw new Error('Tests require a development environment.');
  config({ path: '.env.local', quiet: true });
  // Neon pooling rejects startup search_path; isolation uses its direct endpoint.
  const connection = process.env.EDITORIAL_TEST_DATABASE_URL || process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL_NON_POOLING;
  if (!connection) throw new Error('A real development Postgres connection is required.');
  adminPool = new Pool({ connectionString: connection, max: 1 });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(connection);
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  isolatedPool = new Pool({ connectionString: url.toString(), max: 1 });
  await isolatedPool.query(`CREATE TABLE auth_user(id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE, email_verified boolean NOT NULL DEFAULT false, image text, role text NOT NULL DEFAULT 'admin', disabled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
  await isolatedPool.query(`INSERT INTO auth_user(id,name,email,role) VALUES('test-owner','Stored owner','owner@example.invalid','owner')`);
  // Apply the current schema, including columns read by lifecycle and publication queries.
  const migrations = (await readdir('migrations')).filter(file => /^\d{4}-.*\.sql$/.test(file)).sort();
  for (const migration of migrations) {
    await isolatedPool.query(await readFile(`migrations/${migration}`, 'utf8'));
  }
});

after(async () => {
  await closeDb();
  if (isolatedPool) await isolatedPool.end();
  if (adminPool) { await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await adminPool.end(); }
});

function completeContent(id: string): EditorialContent {
  const recipe = structuredClone(recipes[0]);
  const originalId = recipe.id;
  recipe.id = id;
  recipe.slug = { pl: `przepis-${id}`, en: `recipe-${id}` };
  return { recipe, originalText: 'Original input must remain in immutable history.', author: 'Stored owner', sources: [], photos: { ingredients: Object.fromEntries(recipe.ingredients.map(ingredient => [ingredient.id, getIngredientImage(originalId, ingredient.id)])), steps: Object.fromEntries(recipe.steps.map(step => [step.id, getStepImage(originalId, step.id)])) } };
}
async function fixture() {
  const draft = await createRecipe({ title: 'Integration recipe', originalText: 'Original input' }, actor);
  const content = await registerFixturePhotos(completeContent(draft.id), actor, draft.revision);
  return saveRecipe(draft.id, { expectedRevision: draft.revision, content }, actor);
}
async function approved(record: EditorialRecord) {
  const reviewed = await performRecipeAction(record.id, { action: 'checks', expectedRevision: record.revision, checks }, actor);
  return performRecipeAction(record.id, { action: 'approve', expectedRevision: reviewed.revision }, actor);
}
async function published(record: EditorialRecord) {
  const ready = await approved(record);
  return performRecipeAction(record.id, { action: 'publish', expectedRevision: ready.revision }, actor);
}

async function ingredientSourceAsset(source: EditorialRecord, targetId: string, assetTargetId = targetId) {
  const id = randomUUID(), ingredient = source.content.recipe.ingredients.find(item => item.id === targetId)!;
  assert(ingredient);
  await getDb().insert(aiJobs).values({ id, recipeId: source.id, baseRevision: source.revision, kind: 'ingredient', targetId,
    status: 'ready', provider: 'fal', model: 'openai/gpt-image-2.5/sunburst/text-to-image', brief: ingredient.name.pl,
    requestKey: `ingredient-source-${id}`, inputHash: contentHash(source.content), input: source.content,
    createdBy: actor.id, createdByName: 'Stored owner', reservedUsd: '0', chargedUsd: '0', costBasis: 'usage' });
  await getDb().insert(aiAssets).values({ id, recipeId: source.id, jobId: id, kind: 'ingredient', targetId: assetTargetId,
    blobPathname: `test/${id}.webp`, width: 1024, height: 1024, contentType: 'image/webp', alt: ingredient.name,
    caption: { pl: '', en: '' }, model: 'openai/gpt-image-2.5/sunburst/text-to-image' });
  return { src: `/media/${id}`, columns: 1, rows: 1, index: 0, alt: ingredient.name, aspectRatio: 1 };
}

test('lemon photos reject legacy juice atlas assignments before saving or applying a proposal', async () => {
  const initial = await fixture();
  const bad = structuredClone(initial.content);
  bad.photos.ingredients['lemon-juice'] = { src: '/images/ingredients-1.webp', columns: 4, rows: 3, index: 4, alt: { pl: 'Sok z cytryny', en: 'Lemon juice' } };
  const mismatch = (error: unknown) => error instanceof EditorialError && error.code === 'INGREDIENT_PHOTO_MISMATCH';
  await assert.rejects(saveRecipe(initial.id, { expectedRevision: initial.revision, content: bad }, actor), mismatch);
  await assert.rejects(getDb().transaction(tx => applyAiProposalInTransaction(tx, initial.id, initial.revision, bad, actor, 'Invalid lemon photo')), mismatch);
  assert.deepEqual((await getRecipe(initial.id)).content, initial.content);
  assert.equal((await getRecipe(initial.id)).revision, initial.revision);
});

test('lemon photos retain captured source form across recipes even when only juice is present', async () => {
  const source = await fixture(), initial = await fixture();
  const zest = await ingredientSourceAsset(source, 'lemon-zest'), juice = await ingredientSourceAsset(source, 'lemon-juice');
  const content = structuredClone(initial.content);
  content.recipe.ingredients = content.recipe.ingredients.filter(item => item.id !== 'lemon-zest');
  delete content.photos.ingredients['lemon-zest'];
  content.photos.ingredients['lemon-juice'] = zest;
  const mismatch = (error: unknown) => error instanceof EditorialError && error.code === 'INGREDIENT_PHOTO_MISMATCH';
  await assert.rejects(saveRecipe(initial.id, { expectedRevision: initial.revision, content }, actor), mismatch);
  await assert.rejects(getDb().transaction(tx => applyAiProposalInTransaction(tx, initial.id, initial.revision, content, actor, 'Opposite lemon form')), mismatch);
  content.photos.ingredients['lemon-juice'] = { ...juice, alt: content.recipe.ingredients.find(item => item.id === 'lemon-juice')!.name };
  const saved = await saveRecipe(initial.id, { expectedRevision: initial.revision, content }, actor);
  assert.equal(saved.revision, initial.revision + 1);
  assert.deepEqual(saved.issues, []);
});

test('lemon photos cannot return through an old revision or corrupted approved publication source', async () => {
  const source = await fixture(), initial = await fixture();
  const zest = await ingredientSourceAsset(source, 'lemon-zest');
  const bad = structuredClone(initial.content);
  bad.recipe.ingredients = bad.recipe.ingredients.filter(item => item.id !== 'lemon-zest');
  delete bad.photos.ingredients['lemon-zest']; bad.photos.ingredients['lemon-juice'] = zest;
  await isolatedPool.query(`INSERT INTO editorial_version(recipe_id,revision,content,content_hash,reason,created_by,created_by_name)
    VALUES($1,100,$2::jsonb,$3,'Legacy invalid lemon photo',$4,'Stored owner')`, [initial.id, JSON.stringify(bad), contentHash(bad), actor.id]);
  await assert.rejects(performRecipeAction(initial.id, { action: 'restore', expectedRevision: initial.revision, version: 100 }, actor),
    (error: unknown) => error instanceof EditorialError && error.code === 'INGREDIENT_PHOTO_MISMATCH');
  assert.equal((await getRecipe(initial.id)).revision, initial.revision);
  await isolatedPool.query(`UPDATE editorial_recipe SET content=$2::jsonb,content_hash=$3 WHERE id=$1`, [initial.id, JSON.stringify(bad), contentHash(bad)]);
  await assert.rejects(performRecipeAction(initial.id, { action: 'approve_and_publish', expectedRevision: initial.revision, checks }, actor),
    (error: unknown) => error instanceof EditorialError && error.code === 'PUBLICATION_BLOCKED');
  assert.equal((await isolatedPool.query('SELECT count(*)::int AS count FROM editorial_publication WHERE recipe_id=$1', [initial.id])).rows[0].count, 0);
});

test('every ingredient keeps its source product across recipes, including a forged matching alt', async () => {
  const source = await fixture(), initial = await fixture();
  const cheese = await ingredientSourceAsset(source, 'cheese'), butter = await ingredientSourceAsset(source, 'butter');
  const content = structuredClone(initial.content);
  content.photos.ingredients.butter = { ...cheese, alt: content.recipe.ingredients.find(item => item.id === 'butter')!.name };
  const mismatch = (error: unknown) => error instanceof EditorialError && error.code === 'INGREDIENT_PHOTO_MISMATCH';
  await assert.rejects(saveRecipe(initial.id, { expectedRevision: initial.revision, content }, actor), mismatch);
  await assert.rejects(getDb().transaction(tx => applyAiProposalInTransaction(tx, initial.id, initial.revision, content, actor, 'Wrong product')), mismatch);
  assert.equal((await getRecipe(initial.id)).revision, initial.revision);
  content.photos.ingredients.butter = butter;
  const saved = await saveRecipe(initial.id, { expectedRevision: initial.revision, content }, actor);
  assert.deepEqual(saved.issues, []);
  assert.equal((await published(saved)).publicationStatus, 'published');
});

test('material form mismatches cannot return through history or a corrupted publication source', async () => {
  const source = await fixture(), initial = await fixture(), solidButter = await ingredientSourceAsset(source, 'butter');
  const bad = structuredClone(initial.content);
  bad.recipe.ingredients.find(item => item.id === 'butter')!.name = { pl: 'roztopione masło', en: 'melted butter' };
  bad.photos.ingredients.butter = solidButter;
  await isolatedPool.query(`INSERT INTO editorial_version(recipe_id,revision,content,content_hash,reason,created_by,created_by_name)
    VALUES($1,100,$2::jsonb,$3,'Legacy incorrect butter form',$4,'Stored owner')`, [initial.id, JSON.stringify(bad), contentHash(bad), actor.id]);
  await assert.rejects(performRecipeAction(initial.id, { action: 'restore', expectedRevision: initial.revision, version: 100 }, actor),
    (error: unknown) => error instanceof EditorialError && error.code === 'INGREDIENT_PHOTO_MISMATCH');
  await isolatedPool.query('UPDATE editorial_recipe SET content=$2::jsonb,content_hash=$3 WHERE id=$1', [initial.id, JSON.stringify(bad), contentHash(bad)]);
  await assert.rejects(performRecipeAction(initial.id, { action: 'approve_and_publish', expectedRevision: initial.revision, checks }, actor),
    (error: unknown) => error instanceof EditorialError && error.code === 'PUBLICATION_BLOCKED');
  assert.equal((await isolatedPool.query('SELECT count(*)::int AS count FROM editorial_publication WHERE recipe_id=$1', [initial.id])).rows[0].count, 0);
});

test('ingredient assets must also match the immutable job target binding', async () => {
  const source = await fixture(), initial = await fixture();
  const misbound = await ingredientSourceAsset(source, 'butter', 'cheese');
  const content = structuredClone(initial.content); content.photos.ingredients.butter = misbound;
  await assert.rejects(saveRecipe(initial.id, { expectedRevision: initial.revision, content }, actor),
    (error: unknown) => error instanceof EditorialError && error.code === 'INGREDIENT_PHOTO_MISMATCH');
  assert.equal((await getRecipe(initial.id)).revision, initial.revision);
});

test('hero and step assignments require their actual source kind and step target', async () => {
  const source = await fixture(), initial = await fixture(), content = structuredClone(initial.content);
  const [first, second] = content.recipe.steps;
  const mismatch = (error: unknown) => error instanceof EditorialError && error.code === 'RECIPE_PHOTO_MISMATCH';
  content.photos.steps[first.id] = { ...content.photos.steps[first.id], src: source.content.recipe.image };
  await assert.rejects(saveRecipe(initial.id, { expectedRevision: initial.revision, content }, actor), mismatch);
  content.photos.steps[first.id] = structuredClone(initial.content.photos.steps[second.id]);
  delete content.photos.steps[second.id];
  await assert.rejects(saveRecipe(initial.id, { expectedRevision: initial.revision, content }, actor), mismatch);
  content.photos.steps = structuredClone(initial.content.photos.steps);
  content.recipe.image = initial.content.photos.steps[first.id].src;
  await assert.rejects(getDb().transaction(tx => applyAiProposalInTransaction(tx, initial.id, initial.revision, content, actor, 'Wrong hero source')), mismatch);
  assert.equal((await getRecipe(initial.id)).revision, initial.revision);
});

test('registered recipe images require agreement between asset and captured job metadata', async () => {
  const initial = await fixture(), content = structuredClone(initial.content), first = content.recipe.steps[0].id;
  const id = randomUUID();
  await getDb().insert(aiJobs).values({ id, recipeId: initial.id, baseRevision: initial.revision, kind: 'step', targetId: first,
    status: 'ready', provider: 'fal', model: 'openai/gpt-image-2.5/sunburst/text-to-image', brief: 'Step photo', requestKey: `misbound_${id}`,
    inputHash: contentHash(content), input: content, createdBy: actor.id, createdByName: actor.name, reservedUsd: '0', chargedUsd: '0', costBasis: 'usage' });
  await getDb().insert(aiAssets).values({ id, recipeId: initial.id, jobId: id, kind: 'step', targetId: content.recipe.steps[1].id,
    blobPathname: `test/${id}.webp`, width: 2240, height: 960, contentType: 'image/webp', alt: content.recipe.steps[0].title,
    caption: content.recipe.steps[0].title, model: 'openai/gpt-image-2.5/sunburst/text-to-image' });
  content.photos.steps[first] = { ...content.photos.steps[first], src: `/media/${id}` };
  await assert.rejects(saveRecipe(initial.id, { expectedRevision: initial.revision, content }, actor),
    (error: unknown) => error instanceof EditorialError && error.code === 'RECIPE_PHOTO_MISMATCH');
  assert.equal((await getRecipe(initial.id)).revision, initial.revision);
});

test('registered culinary clones can share the same stage while editorial wording stays editable', async () => {
  const source = await fixture(), initial = await fixture(), content = structuredClone(initial.content);
  const id = content.recipe.steps[0].id;
  content.recipe.title = { pl: 'Drugi tytuł tego samego przepisu', en: 'A second title for the same recipe' };
  content.photos.steps[id] = structuredClone(source.content.photos.steps[id]);
  const saved = await saveRecipe(initial.id, { expectedRevision: initial.revision, content }, actor);
  assert.deepEqual(saved.issues, []);
  const own = structuredClone(initial.content);
  own.recipe.steps[1].text.pl += ' Pracuj starannie.';
  const edited = await saveRecipe(saved.id, { expectedRevision: saved.revision, content: own }, actor);
  assert.equal(edited.revision, saved.revision + 1);
});

test('wrong step images cannot return through historical restore or a corrupted publication source', async () => {
  const initial = await fixture(), bad = structuredClone(initial.content);
  const [first, second] = bad.recipe.steps;
  bad.photos.steps[first.id] = structuredClone(bad.photos.steps[second.id]);
  await isolatedPool.query(`INSERT INTO editorial_version(recipe_id,revision,content,content_hash,reason,created_by,created_by_name)
    VALUES($1,100,$2::jsonb,$3,'Wrong historical step photo',$4,'Stored owner')`, [initial.id, JSON.stringify(bad), contentHash(bad), actor.id]);
  await assert.rejects(performRecipeAction(initial.id, { action: 'restore', expectedRevision: initial.revision, version: 100 }, actor),
    (error: unknown) => error instanceof EditorialError && error.code === 'RECIPE_PHOTO_MISMATCH');
  await isolatedPool.query('UPDATE editorial_recipe SET content=$2::jsonb,content_hash=$3 WHERE id=$1', [initial.id, JSON.stringify(bad), contentHash(bad)]);
  await assert.rejects(performRecipeAction(initial.id, { action: 'approve_and_publish', expectedRevision: initial.revision, checks }, actor),
    (error: unknown) => error instanceof EditorialError && error.code === 'PUBLICATION_BLOCKED');
  assert.equal((await isolatedPool.query('SELECT count(*)::int AS count FROM editorial_publication WHERE recipe_id=$1', [initial.id])).rows[0].count, 0);
});

test('incomplete drafts persist after a new connection, and language badges stay incomplete', async () => {
  const draft = await createRecipe({ title: 'Only a title', originalText: 'Keep this original' }, actor);
  draft.content.recipe.ingredients = [{ id: 'new', name: { pl: '', en: '' }, amount: { kind: 'exact', value: '' }, unit: 'g', scaling: 'linear', group: { pl: '', en: '' } }];
  draft.content.recipe.steps = [{ id: 'new-step', title: { pl: '', en: '' }, text: { pl: '', en: '' } }];
  const saved = await saveRecipe(draft.id, { expectedRevision: draft.revision, content: draft.content }, actor);
  await closeDb();
  const reloaded = await getRecipe(saved.id);
  assert.equal(reloaded.content.originalText, 'Keep this original');
  assert.equal(reloaded.content.recipe.ingredients[0].amount.kind, 'exact');
  assert(reloaded.issues.length > 0);
  assert.equal(reloaded.updatedBy, 'Stored owner');
  const summary = (await listRecipes()).find(recipe => recipe.id === saved.id)!;
  assert.deepEqual(summary.languages, { pl: false, en: false });
});

test('two concurrent saves cannot overwrite each other; losing writer receives latest immutable revision', async () => {
  const initial = await fixture();
  const first = structuredClone(initial.content); first.recipe.title.pl = 'Concurrent A';
  const second = structuredClone(initial.content); second.recipe.title.pl = 'Concurrent B';
  const results = await Promise.allSettled([saveRecipe(initial.id, { expectedRevision: initial.revision, content: first }, actor), saveRecipe(initial.id, { expectedRevision: initial.revision, content: second }, actor)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert(failure.reason instanceof EditorialError);
  assert.equal(failure.reason.code, 'REVISION_CONFLICT');
  assert(failure.reason.latest);
  assert.equal(failure.reason.latest.revision, initial.revision + 1);
  assert.equal((await getRecipe(initial.id)).versions.length, 3);
});

function publicReferenceCases(content: EditorialContent) {
  const stepId = content.recipe.steps[0].id;
  const fields: { path: string; change: (draft: EditorialContent, text: string) => void }[] = [
    { path: 'recipe.description.pl', change: (draft, text) => { draft.recipe.description.pl = text; } },
    { path: 'recipe.tips.en.0', change: (draft, text) => { draft.recipe.tips.en[0] = text; } },
    { path: 'recipe.storage.pl', change: (draft, text) => { draft.recipe.storage.pl = text; } },
    { path: `photos.steps.${stepId}.caption.en`, change: (draft, text) => { draft.photos.steps[stepId].caption = { pl: 'Gotowe danie', en: text }; } },
  ];
  return fields.flatMap(field => [
    { ...field, text: 'See [the cooking guide](https://example.com/cooking).' },
    { ...field, text: 'Whole Foods Market recommends this method.' },
  ]);
}

test('manual saves reject external URLs and service names in public copy and photo captions without changing approved content', async () => {
  const initial = await approved(await fixture());
  for (const example of publicReferenceCases(initial.content)) {
    const content = structuredClone(initial.content);
    example.change(content, example.text);
    await assert.rejects(saveRecipe(initial.id, { expectedRevision: initial.revision, content }, actor),
      (error: unknown) => error instanceof EditorialError && error.status === 422 && error.code === 'EXTERNAL_REFERENCE'
        && error.issues?.some(issue => issue.field === example.path) === true,
      `${example.path}: ${example.text}`);
  }
  const unchanged = await getRecipe(initial.id);
  assert.equal(unchanged.revision, initial.revision);
  assert.equal(unchanged.editorialStatus, 'approved');
  assert.deepEqual(unchanged.content, initial.content);
  assert.deepEqual(unchanged.checks, initial.checks);
  assert.deepEqual(unchanged.versions, initial.versions);
});

test('applying an AI proposal rejects external references atomically before creating an editorial revision', async () => {
  const initial = await approved(await fixture());
  const historyBefore = await isolatedPool.query('SELECT count(*)::int AS count FROM editorial_audit WHERE recipe_id=$1', [initial.id]);
  for (const example of publicReferenceCases(initial.content)) {
    const content = structuredClone(initial.content);
    example.change(content, example.text);
    await assert.rejects(getDb().transaction(tx => applyAiProposalInTransaction(tx, initial.id, initial.revision, content, actor, 'Rejected AI proposal')),
      (error: unknown) => error instanceof EditorialError && error.status === 422 && error.code === 'EXTERNAL_REFERENCE'
        && error.issues?.some(issue => issue.field === example.path) === true,
      `${example.path}: ${example.text}`);
  }
  const unchanged = await getRecipe(initial.id);
  assert.equal(unchanged.revision, initial.revision);
  assert.equal(unchanged.editorialStatus, 'approved');
  assert.deepEqual(unchanged.content, initial.content);
  assert.deepEqual(unchanged.checks, initial.checks);
  assert.deepEqual(unchanged.versions, initial.versions);
  assert.deepEqual((await isolatedPool.query('SELECT count(*)::int AS count FROM editorial_audit WHERE recipe_id=$1', [initial.id])).rows, historyBefore.rows);
});

test('manual saves and AI proposals retain external research exclusively in private editorial fields', async () => {
  const initial = await fixture();
  const content = structuredClone(initial.content);
  content.sources = [{ id: 'private-source', title: 'Whole Foods Market', url: 'https://example.com/recipe' }];
  content.originalText = 'According to Whole Foods Market: https://example.com/recipe';
  content.recipe.provenance.note.en = 'Private research from Whole Foods Market: https://example.com/recipe';
  const saved = await saveRecipe(initial.id, { expectedRevision: initial.revision, content }, actor);
  assert.deepEqual(saved.content.sources, content.sources);
  assert.equal(saved.content.originalText, content.originalText);
  const proposal = structuredClone(saved.content);
  proposal.recipe.description.en = 'A self-contained recipe for everyday cooking.';
  const applied = await getDb().transaction(tx => applyAiProposalInTransaction(tx, saved.id, saved.revision, proposal, actor, 'Clean AI proposal with private research'));
  assert.equal(applied.revision, saved.revision + 1);
  assert.deepEqual(applied.content.sources, content.sources);
  assert.equal(applied.content.recipe.provenance.note.en, content.recipe.provenance.note.en);
  assert.deepEqual(applied.issues, []);
});

test('authorization loads current stored role and disabled flag instead of trusting actor', async () => {
  await assert.rejects(createRecipe({ title: 'Forbidden', originalText: '' }, { ...actor, id: 'missing' }), (error: unknown) => error instanceof EditorialError && error.status === 403);
  await isolatedPool.query(`INSERT INTO auth_user(id,name,email,role,disabled) VALUES('disabled','Disabled','disabled@example.invalid','owner',true),('reader','Reader','reader@example.invalid','reader',false)`);
  for (const id of ['disabled', 'reader']) await assert.rejects(createRecipe({ title: 'Forbidden', originalText: '' }, { ...actor, id }), (error: unknown) => error instanceof EditorialError && error.status === 403);
});

test('publication rejects a complete but unapproved draft and checks are tied to the exact revision', async () => {
  const initial = await fixture();
  assert.deepEqual(initial.issues, []);
  await assert.rejects(performRecipeAction(initial.id, { action: 'publish', expectedRevision: initial.revision }, actor), (error: unknown) => error instanceof EditorialError && error.code === 'PUBLICATION_BLOCKED');
  const ready = await approved(initial);
  const changed = structuredClone(ready.content); changed.recipe.title.pl += ' changed';
  const saved = await saveRecipe(ready.id, { expectedRevision: ready.revision, content: changed }, actor);
  assert.equal(saved.editorialStatus, 'draft');
  assert(Object.values(saved.checks).every(value => value === false));
  await assert.rejects(performRecipeAction(saved.id, { action: 'publish', expectedRevision: ready.revision }, actor), (error: unknown) => error instanceof EditorialError && error.code === 'REVISION_CONFLICT');
  await assert.rejects(performRecipeAction(saved.id, { action: 'publish', expectedRevision: saved.revision }, actor), (error: unknown) => error instanceof EditorialError && error.code === 'PUBLICATION_BLOCKED');
});

test('active public snapshot survives draft edits, excludes private source text, and withdrawal does not resurrect static data', async () => {
  const initial = await fixture();
  const content = structuredClone(initial.content);
  content.recipe.heroPresentation = resolveHeroPresentation(content.recipe);
  assert(content.recipe.heroPresentation);
  const saved = await saveRecipe(initial.id, { expectedRevision: initial.revision, content }, actor);
  const live = await published(saved);
  const oldTitle = live.content.recipe.title.pl;
  const changed = structuredClone(live.content); changed.recipe.title.pl = 'Private changed title';
  const draft = await saveRecipe(live.id, { expectedRevision: live.revision, content: changed }, actor);
  const publicRecipe = await getPublishedRecipe(live.content.recipe.slug.pl, 'pl');
  assert.equal(publicRecipe?.title.pl, oldTitle);
  assert(publicRecipe?.photos);
  assert.equal('originalText' in publicRecipe!, false);
  assert.equal('heroPresentation' in publicRecipe!, false);
  assert.equal('heroPresentation' in (await getPublishedRecipes()).find(recipe => recipe.id === live.id)!, false);
  assert(live.content.recipe.heroPresentation);
  const summary = (await listRecipes()).find(recipe => recipe.id === live.id)!;
  assert.equal(summary.hasUnpublishedChanges, true);
  const withdrawn = await performRecipeAction(draft.id, { action: 'unpublish', expectedRevision: draft.revision }, actor);
  assert.equal(withdrawn.publicationStatus, 'unpublished');
  assert.equal(await getPublishedRecipe(live.content.recipe.slug.pl, 'pl'), null);
  assert.equal((await getPublishedRecipes()).some(recipe => recipe.id === live.id), false);
});

test('database itself forbids changing or deleting immutable versions and publication snapshots', async () => {
  const live = await published(await fixture());
  await assert.rejects(isolatedPool.query('UPDATE editorial_version SET reason=$1 WHERE recipe_id=$2', ['overwrite', live.id]), /immutable/);
  await assert.rejects(isolatedPool.query('DELETE FROM editorial_publication WHERE recipe_id=$1', [live.id]), /immutable/);
  await assert.rejects(isolatedPool.query('UPDATE editorial_audit SET action=$1 WHERE recipe_id=$2', ['overwrite', live.id]), /immutable/);
});

test('the newest dish is based on first publication, excluding drafts and withdrawn recipes', async () => {
  const older = await published(await fixture());
  const newest = await published(await fixture());
  const unpublished = await fixture();
  const ids = new Set([older.id, newest.id, unpublished.id]);
  const book = async () => (await getPublishedRecipes()).filter(recipe => ids.has(recipe.id));
  assert.deepEqual((await book()).map(recipe => recipe.id), [newest.id, older.id]);

  const edited = structuredClone(older.content);
  edited.recipe.title.pl = 'Updated older dish';
  const saved = await saveRecipe(older.id, { expectedRevision: older.revision, content: edited }, actor);
  await published(saved);
  const afterUpdate = await book();
  assert.deepEqual(afterUpdate.map(recipe => recipe.id), [newest.id, older.id]);
  assert.equal(afterUpdate[1].title.pl, edited.recipe.title.pl);
  assert.equal('firstPublishedAt' in afterUpdate[0], false);

  await performRecipeAction(newest.id, { action: 'unpublish', expectedRevision: newest.revision }, actor);
  assert.deepEqual((await book()).map(recipe => recipe.id), [older.id]);
});

test('slug collision rolls the whole publication back; historical addresses remain reserved', async () => {
  const live = await published(await fixture());
  const second = await fixture();
  second.content.recipe.slug = live.content.recipe.slug;
  const colliding = await saveRecipe(second.id, { expectedRevision: second.revision, content: second.content }, actor);
  const ready = await approved(colliding);
  await assert.rejects(performRecipeAction(ready.id, { action: 'publish', expectedRevision: ready.revision }, actor), (error: unknown) => error instanceof EditorialError && error.code === 'SLUG_TAKEN');
  const unchanged = await getRecipe(ready.id);
  assert.equal(unchanged.revision, ready.revision);
  assert.equal(unchanged.publicationStatus, 'never_published');
  const rows = await isolatedPool.query('SELECT count(*)::int AS count FROM editorial_publication WHERE recipe_id=$1', [ready.id]);
  assert.equal(rows.rows[0].count, 0);
});

test('restoring a historical revision creates a fresh unapproved draft while public publication remains whole', async () => {
  const first = await fixture();
  const live = await published(first);
  const restored = await performRecipeAction(live.id, { action: 'restore', expectedRevision: live.revision, version: first.revision }, actor);
  assert.equal(restored.revision, live.revision + 1);
  assert.equal(restored.editorialStatus, 'draft');
  assert(Object.values(restored.checks).every(value => value === false));
  assert.equal(restored.publicationStatus, 'published');
  assert.equal((await getPublishedRecipe(first.content.recipe.slug.pl, 'pl'))?.title.pl, first.content.recipe.title.pl);
});

test('recipes can be moved to trash from every editorial stage, including incomplete drafts', async () => {
  const stages = [
    await createRecipe({ title: 'Incomplete draft for deletion', originalText: '' }, actor),
    await performRecipeAction((await fixture()).id, { action: 'review', expectedRevision: 2 }, actor),
    await approved(await fixture()),
    await performRecipeAction((await fixture()).id, { action: 'archive', expectedRevision: 2 }, actor),
  ];
  for (const recipe of stages) {
    const deleted = await deleteRecipe(recipe.id, { expectedRevision: recipe.revision }, actor);
    assert(deleted.deletedAt);
    assert.equal(deleted.revision, recipe.revision + 1);
    assert.equal(deleted.publicationStatus, 'never_published');
    assert(Object.values(deleted.checks).every(value => value === false));
    assert.deepEqual(deleted.content, recipe.content);
    assert.equal(deleted.versions.length, recipe.versions.length + 1);
    const summary = (await listRecipes()).find(item => item.id === recipe.id)!;
    assert.equal(summary.deletedAt, deleted.deletedAt);
    await assert.rejects(saveRecipe(recipe.id, { expectedRevision: deleted.revision, content: recipe.content }, actor),
      (error: unknown) => error instanceof EditorialError && error.code === 'RECIPE_DELETED');
    for (const action of ['review', 'approve', 'publish', 'archive', 'restore', 'duplicate'] as const) {
      await assert.rejects(performRecipeAction(recipe.id, { action, expectedRevision: deleted.revision }, actor),
        (error: unknown) => error instanceof EditorialError && error.code === 'RECIPE_DELETED');
    }
    const repeated = await deleteRecipe(recipe.id, { expectedRevision: deleted.revision }, actor);
    assert.equal(repeated.revision, deleted.revision);
    assert.equal(repeated.versions.length, deleted.versions.length);
    const restored = await performRecipeAction(recipe.id, { action: 'restore_deleted', expectedRevision: deleted.revision }, actor);
    assert.equal(restored.deletedAt, null);
    assert.equal(restored.editorialStatus, 'draft');
    assert.equal(restored.publicationStatus, 'never_published');
    assert(Object.values(restored.checks).every(value => value === false));
  }
});

test('deleting a published recipe withdraws every locale and emits one removal event while retaining history and slugs', async () => {
  const live = await published(await fixture());
  const changed = structuredClone(live.content); changed.recipe.title.pl = 'Unpublished edit before deletion';
  const draft = await saveRecipe(live.id, { expectedRevision: live.revision, content: changed }, actor);
  const deleted = await deleteRecipe(draft.id, { expectedRevision: draft.revision }, actor);
  assert.equal(deleted.publicationStatus, 'unpublished');
  assert.equal(deleted.publishedRevision, live.publishedRevision);
  assert.equal(await getPublishedRecipe(live.content.recipe.slug.pl, 'pl'), null);
  assert.equal(await getPublishedRecipe(live.content.recipe.slug.en, 'en'), null);
  assert.equal(await getPublishedRecipeById(live.id), null);
  assert.equal((await getPublishedRecipes()).some(item => item.id === live.id), false);
  assert.equal((await isolatedPool.query('SELECT count(*)::int AS count FROM editorial_publication WHERE recipe_id=$1', [live.id])).rows[0].count, 1);
  assert.equal((await isolatedPool.query('SELECT count(*)::int AS count FROM editorial_slug WHERE recipe_id=$1', [live.id])).rows[0].count, 2);
  assert.equal((await isolatedPool.query("SELECT count(*)::int AS count FROM editorial_outbox WHERE recipe_id=$1 AND event='delete'", [live.id])).rows[0].count, 1);
  await deleteRecipe(live.id, { expectedRevision: deleted.revision }, actor);
  assert.equal((await isolatedPool.query("SELECT count(*)::int AS count FROM editorial_outbox WHERE recipe_id=$1 AND event='delete'", [live.id])).rows[0].count, 1);
  await assert.rejects(isolatedPool.query("UPDATE editorial_recipe SET publication_status='published' WHERE id=$1", [live.id]), /editorial_deleted_not_publishable/);
  const restored = await performRecipeAction(live.id, { action: 'restore_deleted', expectedRevision: deleted.revision }, actor);
  assert.equal(restored.deletedAt, null);
  assert.equal(restored.editorialStatus, 'draft');
  assert.equal(restored.publicationStatus, 'unpublished');
  assert.equal(restored.content.recipe.title.pl, changed.recipe.title.pl);
  assert.equal(await getPublishedRecipeById(live.id), null);
  await assert.rejects(performRecipeAction(live.id, { action: 'publish', expectedRevision: restored.revision }, actor),
    (error: unknown) => error instanceof EditorialError && error.code === 'PUBLICATION_BLOCKED');
});

test('delete requires a current authorized account and revision, and serializes with concurrent edits', async () => {
  const original = await fixture();
  for (const id of ['missing', 'disabled', 'reader']) {
    await assert.rejects(deleteRecipe(original.id, { expectedRevision: original.revision }, { ...actor, id }),
      (error: unknown) => error instanceof EditorialError && error.status === 403);
  }
  await assert.rejects(deleteRecipe(original.id, { expectedRevision: original.revision - 1 }, actor),
    (error: unknown) => error instanceof EditorialError && error.code === 'REVISION_CONFLICT');
  const changed = structuredClone(original.content); changed.recipe.title.pl = 'Concurrent saved text';
  const results = await Promise.allSettled([
    deleteRecipe(original.id, { expectedRevision: original.revision }, actor),
    saveRecipe(original.id, { expectedRevision: original.revision, content: changed }, actor),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert(failure.reason instanceof EditorialError);
  assert.equal(failure.reason.code, 'REVISION_CONFLICT');
  const current = await getRecipe(original.id);
  assert.equal(current.revision, original.revision + 1);
  if (!current.deletedAt) await deleteRecipe(current.id, { expectedRevision: current.revision }, actor);
  assert((await getRecipe(original.id)).deletedAt);
});

test('publication gates catch unknown quantity references, mismatched translations, missing assets and unsupported kitchen claims', async () => {
  const content = completeContent(randomUUID());
  content.recipe.steps[0].text.pl += ' {{missing}}';
  content.photos.ingredients.pasta.src = '/images/does-not-exist.webp';
  content.photos.steps.prep.columns = 4;
  content.recipe.provenance.kitchenTested = true;
  const issues = publicationIssues(content);
  assert(issues.some(issue => issue.message.includes('nieznanego składnika')));
  assert(issues.some(issue => issue.message.includes('różnią się')));
  assert(issues.some(issue => issue.field === 'ingredients.pasta.photo'));
  assert(issues.some(issue => issue.field === 'steps.prep.photo'));
  assert(issues.some(issue => issue.field === 'provenance.kitchenTested'));
});

test('duplicating produces a separate unpublished identity with no inherited approvals or URLs', async () => {
  const live = await published(await fixture());
  const copied = await performRecipeAction(live.id, { action: 'duplicate', expectedRevision: live.revision }, actor);
  assert.notEqual(copied.id, live.id);
  assert.equal(copied.content.recipe.id, copied.id);
  assert.equal(copied.publicationStatus, 'never_published');
  assert.deepEqual(copied.content.recipe.slug, { pl: '', en: '' });
  assert(Object.values(copied.checks).every(value => value === false));
});
