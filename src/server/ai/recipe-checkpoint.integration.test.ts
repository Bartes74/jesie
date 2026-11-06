import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import type { Response as ProviderResponse } from 'openai/resources/responses/responses';
import { recipes } from '@/lib/recipes';
import type { EditorialActor, EditorialContent } from '@/lib/editorial-types';
import { inspectRecipeDiet } from '@/lib/recipe-diet';
import { closeDb } from '@/server/db';
import { createRecipe, EditorialError, getRecipe, saveRecipe } from '@/server/editorial/store';
import { applyJob, failJob, finishRecipe, getJob, getJobForExecution } from './store';
import { getRecipeResponse, recipeResponseCheckpoint, retainRecipeResponse, reviewedIngredientDictionary } from './recipe-checkpoint';
import { recipeManualRepairView, saveManualRecipeRepair } from './recipe-manual-repair';
import { beginRecipeResultRecovery } from './recipe-recovery';
import { resolveRecipeIngredients } from './recipe-ingredient-resolution';
import { pollText, usageCost } from './text-provider';
import { getRecipeVerifiedAliases } from './recipe-ingredient-dictionary';

const schema = `checkpoint_test_${randomUUID().replaceAll('-', '')}`;
const actor: EditorialActor = { id: 'owner', name: 'Owner', email: 'owner@example.invalid', role: 'owner' };
let admin: Pool, pool: Pool, originalFetch: typeof fetch;

before(async () => {
  const connection = process.env.AI_TEST_DATABASE_URL;
  if (!connection || !new URL(connection).searchParams.get('host')?.startsWith('/private/tmp/jesie-recovery-pg-'))
    throw new Error('An explicitly isolated local recovery-test cluster is required.');
  admin = new Pool({ connectionString: connection });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(connection); url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  pool = new Pool({ connectionString: url.toString() });
  await pool.query("CREATE TABLE auth_user(id text PRIMARY KEY,name text NOT NULL,email text NOT NULL UNIQUE,email_verified boolean NOT NULL DEFAULT false,image text,role text NOT NULL DEFAULT 'admin',disabled boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())");
  await pool.query("INSERT INTO auth_user(id,name,email,role) VALUES('owner','Owner','owner@example.invalid','owner')");
  for (const file of (await readdir('migrations')).filter(file => /^\d{4}-.*\.sql$/.test(file)).sort()) await pool.query(await readFile(`migrations/${file}`, 'utf8'));
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Provider transport is forbidden: the checkpoint must be sufficient.'); };
});
beforeEach(async () => { await pool.query('TRUNCATE editorial_recipe CASCADE'); });
after(async () => {
  if (originalFetch) globalThis.fetch = originalFetch;
  await closeDb();
  if (pool) await pool.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
});

async function fixture() {
  const draft = await createRecipe({ title: 'Owsianka z teff', originalText: 'Oryginalne wskazówki autora.' }, actor);
  const base = structuredClone(recipes[0]); base.id = draft.id;
  const input: EditorialContent = { ...draft.content, aiPhotography: { recipeDietVersion: 'ingredient-diet-v1' } };
  const raw = { slug: { pl: `teff-${draft.id}`, en: `teff-${draft.id}` }, title: { pl: 'Owsianka z teff', en: 'Teff porridge' },
    description: { pl: 'Prosta owsianka przygotowana z ziarna teff.', en: 'A simple porridge made with teff grain.' },
    primaryCategory: base.primaryCategory, categories: base.categories, difficulty: base.difficulty,
    cuisine: base.cuisine, baseServings: base.baseServings, times: base.times,
    ingredients: [{ id: 'teff', name: { pl: 'teff', en: 'teff' }, amount: { kind: 'exact', value: '100', approximate: false }, unit: 'g', scaling: 'linear', group: { pl: '', en: '' }, note: null }],
    steps: [{ id: 'prepare', title: { pl: 'Przygotuj', en: 'Prepare' }, text: { pl: 'Przygotuj ziarno teff i podaj.', en: 'Prepare the teff grain and serve.' }, timerMinutes: null }],
    equipment: base.equipment, tips: base.tips, storage: base.storage, scalingNote: null, notes: [], substitutions: [] };
  const id = randomUUID(), requestId = `resp_${id.replaceAll('-', '')}`;
  await pool.query("INSERT INTO ai_job(id,recipe_id,base_revision,kind,status,provider,model,brief,request_key,input_hash,input,created_by,created_by_name,provider_request_id,reserved_usd) VALUES($1,$2,1,'recipe','generating','openai','gpt-6.1-sol','Fixture',$3,$4,$5,'owner','Owner',$6,0)",
    [id, draft.id, randomUUID(), createHash('sha256').update(id).digest('hex'), input, requestId]);
  const response = { id: requestId, status: 'completed', object: 'response', output_text: JSON.stringify(raw),
    usage: { input_tokens: 10, output_tokens: 20 },
    output: [{ id: 'msg_fixture', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(raw), annotations: [] }] }] } as unknown as ProviderResponse;
  await retainRecipeResponse(id, response);
  const cost = usageCost('gpt-6.1-sol', response.usage!);
  await failJob(id, { code: 'AI_RESULT_INVALID', message: 'Unrecognised ingredient', uncertain: false, chargedUsd: cost.chargedUsd, providerFinished: true,
    validation: { issues: [{ field: 'ingredients.teff.name', code: 'DIET_INGREDIENT_UNRECOGNISED', message: 'Unknown ingredient.' }], repairable: false } });
  return { id, draft, raw, response, input, cost };
}

test('completed response is immutable, survives jsonb key ordering and rejects an unrelated receipt', async () => {
  const f = await fixture();
  assert.deepEqual(await getRecipeResponse(f.response.id), f.response);
  await retainRecipeResponse(f.id, f.response);
  await assert.rejects(pool.query('UPDATE ai_recipe_response SET digest=repeat(\'0\',64) WHERE job_id=$1', [f.id]), /RECIPE_CHECKPOINT_IMMUTABLE/);
  await assert.rejects(retainRecipeResponse(f.id, { ...f.response, id: 'resp_other' }), /tożsamości/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM ai_recipe_response')).rows[0].n, 1);
});

test('manual ingredient review resumes the same locally retained receipt, preserves cost and survives ordinary save', async () => {
  const f = await fixture();
  const before = (await pool.query('SELECT * FROM ai_cost_ledger WHERE job_id=$1 ORDER BY entry', [f.id])).rows;
  const view = await recipeManualRepairView(f.id);
  assert.equal(view.version, 0); assert.equal(view.canEdit, true);
  const correction = { expectedRevision: 1, expectedVersion: 0, proposal: f.raw, reviewedIngredients: [{ ingredientId: 'teff', diet: 'vegan' as const }], reason: 'Sprawdzono dokładną tożsamość ziarna i jego skład.' };
  await saveManualRecipeRepair(f.id, correction, actor);
  await assert.rejects(saveManualRecipeRepair(f.id, correction, actor), /innym oknie/);
  await beginRecipeResultRecovery(f.id, actor, undefined, { existingOnly: true });
  const job = await getJobForExecution(f.id);
  const result = await pollText(job.model, job.providerRequestId!, job.input, [], raw => resolveRecipeIngredients(job, raw, { existingOnly: true }), recipeResponseCheckpoint(job.id));
  assert.equal(result.done, true);
  if (!result.done) assert.fail('A local correction must complete.');
  await finishRecipe(job.id, result.content, result.cost, result.notes);
  assert.equal((await getJob(f.id)).status, 'ready');
  const applied = await applyJob(f.id, { expectedRevision: 1, acknowledgeStale: false }, actor);
  const saved = await saveRecipe(f.draft.id, { expectedRevision: applied.recipe.revision, content: applied.recipe.content }, actor);
  const aliases = await getRecipeVerifiedAliases(saved.content.recipe.ingredients, undefined, saved.id);
  assert.equal(inspectRecipeDiet(saved.content.recipe, aliases).inferredDiet, 'vegan');
  assert.equal((await pool.query('SELECT count(*)::int n FROM ai_job')).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM ai_ingredient_verification')).rows[0].n, 0);
  assert.deepEqual((await pool.query('SELECT * FROM ai_cost_ledger WHERE job_id=$1 ORDER BY entry', [f.id])).rows, before);
  assert.equal((await getRecipe(f.draft.id)).publicationStatus, 'never_published');
  await assert.rejects(pool.query('DELETE FROM ai_recipe_manual_repair WHERE job_id=$1', [f.id]), /RECIPE_CHECKPOINT_IMMUTABLE/);
});

test('manual corrections reject disabled accounts, stale revisions, incomplete recipes and invented ingredient IDs', async () => {
  const f = await fixture();
  const correction = { expectedRevision: 1, expectedVersion: 0, proposal: f.raw, reviewedIngredients: [{ ingredientId: 'teff', diet: 'vegan' as const }], reason: 'Reviewed exact ingredient composition.' };
  await assert.rejects(saveManualRecipeRepair(f.id, { ...correction, reviewedIngredients: [{ ingredientId: 'invented', diet: 'vegan' }] }, actor), /nie występuje/);
  await assert.rejects(saveManualRecipeRepair(f.id, { ...correction, proposal: { ...f.raw, steps: [] } }, actor), error => error instanceof EditorialError);
  await assert.rejects(saveManualRecipeRepair(f.id, { ...correction, expectedRevision: 2 }, actor), /zmienił się/);
  await pool.query("UPDATE auth_user SET disabled=true WHERE id='owner'");
  await assert.rejects(saveManualRecipeRepair(f.id, correction, actor));
  await pool.query("UPDATE auth_user SET disabled=false WHERE id='owner'");
  assert.equal((await pool.query('SELECT count(*)::int n FROM ai_recipe_manual_repair')).rows[0].n, 0);
});

test('a review is confined to exact names and cannot relabel clear animal evidence', async () => {
  const ingredient = { id: 'food', name: { pl: 'mięso wołowe', en: 'beef' } };
  const dictionary = reviewedIngredientDictionary([ingredient], [{ ingredientId: 'food', name: ingredient.name, diet: 'vegan' }]);
  const full = { ...recipes[0].ingredients[0], ...ingredient };
  assert.equal(inspectRecipeDiet({ ingredients: [full] }, dictionary).inferredDiet, 'meat');
  const cheese = { ...full, name: { pl: 'ser brie', en: 'brie cheese' } };
  const cheeseReview = reviewedIngredientDictionary([cheese], [{ ingredientId: 'food', name: cheese.name, diet: 'vegan' }]);
  assert.equal(inspectRecipeDiet({ ingredients: [cheese] }, cheeseReview).inferredDiet, 'vegetarian');
  assert.equal(reviewedIngredientDictionary([{ ...ingredient, name: { pl: 'Inna nazwa', en: 'Different name' } }], [{ ingredientId: 'food', name: ingredient.name, diet: 'vegan' }]).size, 0);
});
