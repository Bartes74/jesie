import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { config } from 'dotenv';
import { Pool } from 'pg';
import type { EditorialActor, EditorialContent } from '@/lib/editorial-types';
import type { IngredientVerificationResult } from '@/lib/ingredient-verification';
import { recipes } from '@/lib/recipes';
import { heroPresentationProfile } from '@/lib/hero-presentation';
import { closeDb, getDb } from '@/server/db';
import { approveRecipeContent, isRecipeContentApproved } from '@/server/editorial/content-approval';
import { applyAiProposalInTransaction, createRecipe, EditorialError, getRecipe, saveRecipe } from '@/server/editorial/store';
import { attachReceipt, completeVerification, startOrClaimVerification } from './ingredient-dictionary-store';

// Real Postgres in a disposable schema. No production editorial rows or paid API calls.
const schema = `ingredient_approval_test_${randomUUID().replaceAll('-', '')}`;
const actor: EditorialActor = { id: 'owner', name: 'Owner', email: 'owner@example.invalid', role: 'owner' };
let admin: Pool, pool: Pool, originalFetch: typeof fetch;

before(async () => {
  if (process.env.NODE_ENV === 'production') throw new Error('Tests require a development environment.');
  config({ path: '.env.local', quiet: true });
  const connection = process.env.EDITORIAL_TEST_DATABASE_URL || process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL_NON_POOLING;
  if (!connection) throw new Error('A real development Postgres connection is required.');
  admin = new Pool({ connectionString: connection, max: 1, connectionTimeoutMillis: 20_000, query_timeout: 30_000 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(connection); url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  pool = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 20_000, query_timeout: 30_000 });
  await pool.query("CREATE TABLE auth_user(id text PRIMARY KEY,name text NOT NULL,email text NOT NULL UNIQUE,email_verified boolean NOT NULL DEFAULT false,image text,role text NOT NULL DEFAULT 'admin',disabled boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())");
  await pool.query("INSERT INTO auth_user(id,name,email,role) VALUES('owner','Owner','owner@example.invalid','owner')");
  for (const migration of (await readdir('migrations')).filter(file => /^\d{4}-.*\.sql$/.test(file)).sort())
    await pool.query(await readFile(`migrations/${migration}`, 'utf8'));
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Provider HTTP is forbidden in this test.'); };
});

after(async () => {
  if (originalFetch) globalThis.fetch = originalFetch;
  await closeDb();
  if (pool) await pool.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
});

function content(id: string, name = 'Kōji'): EditorialContent {
  const recipe = structuredClone(recipes[0]);
  Object.assign(recipe, { id, title: { pl: 'Przepis testowy', en: 'Test recipe' },
    slug: { pl: `skladnik-${id}`, en: `ingredient-${id}` }, image: '', imageAlt: { pl: '', en: '' }, diet: 'vegan',
    ingredients: [{ id: 'verified', name: { pl: name, en: name }, amount: { kind: 'exact', value: '10' }, unit: 'g',
      scaling: 'linear', group: { pl: 'Składniki', en: 'Ingredients' } }],
    steps: [{ id: 'prepare', title: { pl: 'Przygotuj', en: 'Prepare' }, text: { pl: 'Przygotuj {{verified}} i podaj.', en: 'Prepare {{verified}} and serve.' } }],
    substitutions: [], dietaryTags: [],
    heroPresentation: { container: 'bowl', finalAppearance: { pl: 'Gotowe danie w misce.', en: 'The finished dish in a bowl.' }, evidenceStepIds: ['prepare'], profileVersion: heroPresentationProfile },
  });
  recipe.provenance.kitchenTested = false;
  return { recipe, originalText: 'Oryginalny opis autora z Kōji pozostaje bez zmian.', author: actor.name, sources: [], photos: { ingredients: {}, steps: {} } };
}

async function learn() {
  const input = { name: { pl: 'Kōji', en: 'Kōji' } };
  const started = await startOrClaimVerification(input);
  if (started.verification.status === 'complete') return;
  assert(started.claimed);
  const receipt = 'resp_dictionary_approval_fixture';
  await attachReceipt(started.verification.key, started.claimToken, receipt);
  const result: IngredientVerificationResult = {
    queriedNames: input.name, decision: 'verified', canonicalName: input.name,
    kind: 'fungus', diet: 'vegan', suggestedName: null, sameIdentity: true, singleIngredient: true,
    confidence: 'high', autoLearnEligible: true, reason: 'Trusted fixture: established culinary ingredient.',
    sources: ['https://primary.example.invalid/koji', 'https://independent.example.invalid/koji'].map(url => ({
      title: 'Independent source fixture', url, supports: ['identity', 'culinary_use', 'diet'], finding: 'Fixture confirms the exact culinary identity and category.',
    })),
  };
  assert.equal((await completeVerification(started.verification.key, receipt, result, { chargedUsd: '0', costBasis: 'usage' })).learned, true);
}

test('learned exact ingredient survives apply and ordinary save, leaves the approval UI unblocked and can be accepted before photos', async () => {
  await learn();
  for (const method of ['apply', 'save'] as const) {
    const draft = await createRecipe({ title: 'Learned ingredient', originalText: 'Original' }, actor);
    const proposal = content(draft.id);
    const saved = method === 'apply'
      ? await getDb().transaction(tx => applyAiProposalInTransaction(tx, draft.id, draft.revision, proposal, actor, 'Verified ingredient fixture'))
      : await saveRecipe(draft.id, { expectedRevision: draft.revision, content: proposal }, actor);
    assert.equal(saved.content.recipe.diet, 'vegan');
    assert.equal(saved.content.originalText, proposal.originalText);
    const cookingIssues = saved.issues.filter(issue => issue.field !== 'image' && !issue.field.startsWith('imageAlt.') && !/^(?:ingredients|steps)\..+\.photo(?:\.|$)/.test(issue.field));
    assert.deepEqual(cookingIssues, [], 'The authoritative record sent to the editor must not retain an unknown-name blocker.');
    const approval = await approveRecipeContent(saved.id, saved.revision, actor);
    assert.equal(approval.recipeId, saved.id);
    assert.equal(await isRecipeContentApproved(await getRecipe(saved.id)), true);
    assert.equal((await getRecipe(saved.id)).publicationStatus, 'never_published');
  }
  assert.equal((await pool.query('SELECT count(*)::int n FROM editorial_publication')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM ai_job')).rows[0].n, 0);
});

test('a forged client diet or alias claim cannot supply evidence and a changed compound remains blocked', async () => {
  for (const name of ['undocumented-fixture', 'Kōji sauce']) {
    const draft = await createRecipe({ title: 'Unverified ingredient', originalText: 'Original' }, actor);
    const proposal = content(draft.id, name);
    const forged = { ...proposal, verifiedAliases: { [name]: 'vegan' } };
    const saved = await saveRecipe(draft.id, { expectedRevision: draft.revision, content: forged }, actor);
    assert.equal(saved.content.recipe.diet, 'meat');
    assert(saved.issues.some(issue => issue.field === 'ingredients.verified.name'));
    await assert.rejects(approveRecipeContent(saved.id, saved.revision, actor), error => error instanceof EditorialError && error.code === 'CONTENT_REVIEW_REQUIRED');
    assert.equal(await isRecipeContentApproved(saved), false);
  }
  assert.equal((await pool.query('SELECT count(*)::int n FROM editorial_publication')).rows[0].n, 0);
});
