import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { config, parse } from 'dotenv';
import { Pool } from 'pg';
import { closeDb } from '@/server/db';
import { ingredientEvidencePolicyVersion, type IngredientVerificationInput, type IngredientVerificationResult } from '@/lib/ingredient-verification';
import { attachReceipt, completeVerification, failVerification, getVerification, getVerificationBudgetTotals, getVerificationCosts,
  ingredientVerificationKey, lookupExactAliases, lookupExactAliasRecords, markUncertain, startOrClaimVerification } from './ingredient-dictionary-store';

const schema = `ingredient_dictionary_${randomUUID().replaceAll('-', '')}`;
let adminPool: Pool; let pool: Pool; let createdSchema = false;
const input: IngredientVerificationInput = { name: { pl: 'świeże liście moringi', en: 'fresh moringa leaves' }, note: { pl: 'Liście rośliny.', en: 'The leaves of the plant.' } };
function result(value: IngredientVerificationInput = input, changes: Partial<IngredientVerificationResult> = {}): IngredientVerificationResult {
  return { decision: 'verified', canonicalName: { pl: 'moringa', en: 'moringa' }, kind: 'plant', diet: 'vegan', suggestedName: null,
    reason: 'Test fixture with independently verified botanical identity and culinary use.', sameIdentity: true, singleIngredient: true, confidence: 'high',
    queriedNames: value.name, autoLearnEligible: true,
    sources: [{ title: 'Institution fixture', url: 'https://www.kew.org/test/moringa', supports: ['identity'], finding: 'The queried name denotes a plant.' },
      { title: 'Food institution fixture', url: 'https://www.usda.gov/test/moringa', supports: ['culinary_use', 'diet'], finding: 'The leaves are used as a food ingredient.' }], ...changes };
}
function identity(connection: string) { const url = new URL(connection); return `${url.hostname.replace('-pooler.', '.')}${url.pathname}`; }

before(async () => {
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') throw new Error('Tests require development.');
  config({ path: '.env.local', quiet: true });
  const connection = process.env.AI_TEST_DATABASE_URL || process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL_NON_POOLING;
  if (!connection) throw new Error('An isolated development Postgres connection is required.');
  const production = parse(await readFile('.env.production.local', 'utf8').catch(() => '')).DATABASE_URL;
  if (production && identity(connection) === identity(production)) throw new Error('Tests must use a separate development database.');
  adminPool = new Pool({ connectionString: connection, max: 1, connectionTimeoutMillis: 20_000, query_timeout: 30_000 });
  await adminPool.query(`CREATE SCHEMA "${schema}"`); createdSchema = true;
  const scoped = new URL(connection); scoped.searchParams.set('options', `-c search_path=${schema}`); process.env.DATABASE_URL = scoped.toString();
  pool = new Pool({ connectionString: scoped.toString(), max: 3, connectionTimeoutMillis: 20_000, query_timeout: 30_000 });
  await pool.query('CREATE TABLE ai_job(id text PRIMARY KEY, trend_run_id text)');
  await pool.query(await readFile('migrations/0028-ingredient-dictionary.sql', 'utf8'));
  // Apply the upgrade over real v1 history; the migration must preserve its
  // accepted receipt, model findings and known charge without a provider call.
  const oldResult = result(input, { autoLearnEligible: false });
  await pool.query(`INSERT INTO ai_ingredient_verification(verification_key,input,model,status,claim_token,claim_expires_at,provider_request_id,result,charged_usd,cost_basis)
    VALUES($1,$2,'gpt-6.1-sol','complete',$3,now(),'resp_migration_history',$4,0.05,'usage')`, [ingredientVerificationKey(input), input, randomUUID(), oldResult]);
  await pool.query(await readFile('migrations/0029-ingredient-evidence-recheck.sql', 'utf8'));
  const migrated = (await pool.query('SELECT eligibility_policy_version,result,provider_request_id,charged_usd FROM ai_ingredient_verification')).rows[0];
  assert.equal(migrated.eligibility_policy_version, 'ingredient-evidence-v1'); assert.deepEqual(migrated.result, oldResult);
  assert.equal(migrated.provider_request_id, 'resp_migration_history'); assert.equal(migrated.charged_usd, '0.05000000');
});
beforeEach(async () => { await pool.query('TRUNCATE ai_job CASCADE'); });
after(async () => {
  await closeDb(); if (pool) await pool.end();
  if (adminPool) { if (createdSchema) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`); await adminPool.end(); }
});

test('one exact normalized query can be submitted once; an expired unsent lease remains uncertain', async () => {
  const equivalent = { name: { pl: ' ŚWIEŻE LIŚCIE MORINGI ', en: 'Fresh moringa leaves' }, note: { pl: 'Inny opis.', en: 'Changed notes.' } };
  assert.equal(ingredientVerificationKey(input), ingredientVerificationKey(equivalent));
  assert.notEqual(ingredientVerificationKey(input), ingredientVerificationKey({ name: { pl: 'liście moringa', en: '' } }));
  const [first, second] = await Promise.all([startOrClaimVerification(input), startOrClaimVerification(equivalent)]);
  assert.equal(Number(first.claimed) + Number(second.claimed), 1);
  const owner = first.claimed ? first : second;
  assert(owner.claimToken);
  await pool.query("UPDATE ai_ingredient_verification SET claim_expires_at=clock_timestamp()-interval '1 second'");
  const expired = await startOrClaimVerification(input);
  assert.equal(expired.claimed, false); assert.equal(expired.verification.status, 'uncertain');
  assert.equal((await pool.query('SELECT count(*)::int n FROM ai_ingredient_verification')).rows[0].n, 1);
  await assert.rejects(attachReceipt(owner.verification.key, randomUUID(), 'resp_late'), /CLAIM_MISMATCH/);
  const late = await attachReceipt(owner.verification.key, owner.claimToken, 'resp_late');
  assert.equal(late.status, 'generating');
  assert.equal((await attachReceipt(late.key, owner.claimToken, 'resp_late')).providerRequestId, 'resp_late');
  await assert.rejects(attachReceipt(late.key, owner.claimToken, 'resp_different'), /RECEIPT_MISMATCH/);
  assert.equal((await startOrClaimVerification(input)).claimed, false);
});

test('verified evidence learns only exact queried aliases and its accepted receipt, result and charge stay immutable', async () => {
  const claim = await startOrClaimVerification(input); assert(claim.claimToken);
  await attachReceipt(claim.verification.key, claim.claimToken, 'resp_verified');
  const completed = await completeVerification(claim.verification.key, 'resp_verified', result(), { chargedUsd: '0.05', costBasis: 'usage', usage: { inputTokens: 10, outputTokens: 20 } });
  assert.equal(completed.learned, true); assert.equal(completed.status, 'complete');
  const exact = await lookupExactAliases(['ŚWIEŻE LIŚCIE MORINGI', 'fresh moringa leaves', 'moringa', 'fresh moringa leaves with cream']);
  assert.equal(exact.size, 2); assert.equal(exact.get('swieze liscie moringi'), 'vegan');
  assert.equal((await lookupExactAliasRecords(['fresh moringa leaves'])).get('fresh moringa leaves')?.verificationKey, completed.key);
  assert.equal((await completeVerification(completed.key, 'resp_verified', result(), { chargedUsd: '0.05000000', costBasis: 'usage' })).chargedUsd, '0.05000000');
  await assert.rejects(completeVerification(completed.key, 'resp_other', result(), {}), /RECEIPT_MISMATCH/);
  await assert.rejects(completeVerification(completed.key, 'resp_verified', result(input, { queriedNames: { pl: 'other name', en: '' } }), {}), /QUERY_MISMATCH/);
  await assert.rejects(completeVerification(completed.key, 'resp_verified', result(input, { reason: 'Changed evidence.' }), {}), /RESULT_CONFLICT/);
  await assert.rejects(completeVerification(completed.key, 'resp_verified', result(), { chargedUsd: '0.06' }), /COST_CONFLICT/);
  await assert.rejects(completeVerification(completed.key, 'resp_verified', result(), { usage: { inputTokens: -1, outputTokens: 0 } }), /USAGE_INVALID/);
  assert.equal((await getVerificationCosts()).chargedUsd, '0.05000000');
  await assert.rejects(pool.query("UPDATE ai_ingredient_verification SET provider_request_id='resp_replaced'"), /RECEIPT_IMMUTABLE/);
  await assert.rejects(pool.query('DELETE FROM ai_ingredient_verification'), /IDENTITY_IMMUTABLE/);
});

test('negative decisions and uncertainty are cached, and missing usage never becomes an invented zero charge', async () => {
  const typoInput = { name: { pl: 'morigna', en: '' } };
  const typo = await startOrClaimVerification(typoInput); assert(typo.claimToken);
  await attachReceipt(typo.verification.key, typo.claimToken, 'resp_typo');
  await completeVerification(typo.verification.key, 'resp_typo', result(typoInput, { decision: 'possible_typo', canonicalName: null, suggestedName: { pl: 'moringa', en: 'moringa' }, sameIdentity: false, autoLearnEligible: false }), { chargedUsd: '0.03' });
  assert.equal((await startOrClaimVerification(typoInput)).claimed, false);
  assert.equal((await lookupExactAliases(['morigna', 'moringa'])).size, 0);
  const uncertain = await startOrClaimVerification({ name: { pl: 'nieznany produkt', en: 'unknown product' } }); assert(uncertain.claimToken);
  await markUncertain(uncertain.verification.key, uncertain.claimToken, { code: 'TRANSPORT_UNKNOWN', message: 'Acceptance was not confirmed.' });
  assert.equal((await startOrClaimVerification(uncertain.verification.input)).claimed, false);
  const eligible = await startOrClaimVerification(input); assert(eligible.claimToken);
  await attachReceipt(eligible.verification.key, eligible.claimToken, 'resp_usage_missing');
  const cached = await completeVerification(eligible.verification.key, 'resp_usage_missing', result(), {});
  assert.equal(cached.learned, true); assert.equal(cached.chargedUsd, null);
  assert.deepEqual(await getVerificationCosts(), { chargedUsd: '0.03000000', pendingCount: 2, requestCount: 3 });
  await completeVerification(eligible.verification.key, 'resp_usage_missing', result(), { chargedUsd: '0.04' });
  assert.equal((await getVerificationBudgetTotals()).pendingCount, 1);
  const rejected = await startOrClaimVerification({ name: { pl: 'inny produkt', en: 'different product' } }); assert(rejected.claimToken);
  await failVerification(rejected.verification.key, rejected.claimToken, { code: 'CONFIRMED_REJECTION', message: 'The provider rejected submission.' }, { chargedUsd: '0', costBasis: 'usage' });
  assert.equal((await startOrClaimVerification(rejected.verification.input)).claimed, false);
  assert.equal((await getVerificationCosts()).pendingCount, 1);
});

test('overlapping aliases cannot overwrite or partially expand another verified identity; cost is still retained', async () => {
  const first = await startOrClaimVerification(input); assert(first.claimToken);
  await attachReceipt(first.verification.key, first.claimToken, 'resp_first_identity');
  await completeVerification(first.verification.key, 'resp_first_identity', result(), { chargedUsd: '0.05' });
  const otherInput = { name: { ...input.name, en: 'different queried botanical label' } };
  const second = await startOrClaimVerification(otherInput); assert(second.claimToken);
  await attachReceipt(second.verification.key, second.claimToken, 'resp_conflicting_identity');
  const conflict = await completeVerification(second.verification.key, 'resp_conflicting_identity', result(otherInput, {
    canonicalName: { pl: 'inna roślina kulinarna', en: 'another culinary plant' },
  }), { chargedUsd: '0.02' });
  assert.equal(conflict.learned, false); assert.equal(conflict.errorCode, 'INGREDIENT_ALIAS_CONFLICT');
  const aliases = await lookupExactAliasRecords([input.name.pl, otherInput.name.en]);
  assert.equal(aliases.get('swieze liscie moringi')?.verificationKey, first.verification.key);
  assert.equal(aliases.has(otherInput.name.en), false);
  assert.equal((await getVerificationCosts()).chargedUsd, '0.07000000');
});

test('independently verified names for one exact ingredient preserve prior alias ownership, receipts and costs', async () => {
  await pool.query("INSERT INTO ai_job(id,trend_run_id) VALUES('first-origin',NULL),('second-origin','trend-origin')");
  const first = await startOrClaimVerification(input, { originJobId: 'first-origin', originRecipeId: 'first-recipe' }); assert(first.claimToken);
  await attachReceipt(first.verification.key, first.claimToken, 'resp_same_identity_first');
  const original = await completeVerification(first.verification.key, 'resp_same_identity_first', result(), { chargedUsd: '0.05' });
  const translated = { name: { ...input.name, en: 'young fresh moringa leaves' } };
  const second = await startOrClaimVerification(translated, { originJobId: 'second-origin', originRecipeId: 'second-recipe' }); assert(second.claimToken);
  await attachReceipt(second.verification.key, second.claimToken, 'resp_same_identity_second');
  const savedResult = result(translated, { canonicalName: { pl: ' MORINGA ', en: 'Moringa' } });
  const completed = await completeVerification(second.verification.key, 'resp_same_identity_second', savedResult, { chargedUsd: '0.02' });
  assert.equal(completed.learned, true); assert.equal(completed.errorCode, null); assert.equal(completed.errorMessage, null);
  const aliases = await lookupExactAliasRecords([input.name.pl, input.name.en, translated.name.en, 'moringa']);
  assert.equal(aliases.size, 3); assert.equal(aliases.get('swieze liscie moringi')?.verificationKey, original.key);
  assert.equal(aliases.get(input.name.en)?.verificationKey, original.key);
  assert.equal(aliases.get(translated.name.en)?.verificationKey, second.verification.key);
  assert.deepEqual(await getVerification(original.key), original, 'Reusing a compatible alias must not rewrite its owner.');
  const replayed = await completeVerification(completed.key, 'resp_same_identity_second', savedResult, {});
  for (const field of ['input', 'result', 'providerRequestId', 'providerFinishedAt', 'createdAt', 'claimToken', 'originJobId', 'originRecipeId', 'chargedUsd', 'costBasis'] as const)
    assert.deepEqual(replayed[field], completed[field], `Replay changed ${field}.`);
  assert.deepEqual(await getVerificationCosts(), { chargedUsd: '0.07000000', pendingCount: 0, requestCount: 2 });
});

const incompatibleIdentities: Array<[string, Partial<IngredientVerificationResult>]> = [
  ['different Polish canonical identity', { canonicalName: { pl: 'mięta', en: 'moringa' } }],
  ['different English canonical identity', { canonicalName: { pl: 'moringa', en: 'mint' } }],
  ['missing canonical identity', { canonicalName: { pl: '', en: 'moringa' } }],
  ['punctuation-only canonical identity', { canonicalName: { pl: '!!!', en: 'moringa' } }],
  ['different kind despite equal vegan classification', { kind: 'fungus' }],
  ['different dietary classification', { kind: 'egg', diet: 'vegetarian' }],
  ['no shared exact identity source', { sources: [
    { title: 'Other institution', url: 'https://www.kew.org/test/other-page', supports: ['identity'], finding: 'A separate identity source.' },
    { title: 'Other food institution', url: 'https://www.usda.gov/test/other-page', supports: ['culinary_use'], finding: 'A separate culinary source.' },
  ] }],
  ['shared pages without shared identity evidence', { sources: [
    { title: 'Institution fixture', url: 'https://www.kew.org/test/moringa', supports: ['culinary_use'], finding: 'Does not assert identity.' },
    { title: 'Food fixture', url: 'https://www.usda.gov/test/moringa', supports: ['culinary_use'], finding: 'Does not assert identity.' },
  ] }],
];
for (const [label, changes] of incompatibleIdentities) test(`overlapping names remain blocked with ${label}`, async () => {
  const first = await startOrClaimVerification(input); assert(first.claimToken);
  await attachReceipt(first.verification.key, first.claimToken, 'resp_incompatible_owner');
  await completeVerification(first.verification.key, 'resp_incompatible_owner', result(), { chargedUsd: '0.05' });
  const translated = { name: { ...input.name, en: 'unlearned translated name' } };
  const second = await startOrClaimVerification(translated); assert(second.claimToken);
  await attachReceipt(second.verification.key, second.claimToken, 'resp_incompatible_current');
  const savedResult = result(translated, changes);
  const conflict = await completeVerification(second.verification.key, 'resp_incompatible_current', savedResult, { chargedUsd: '0.02' });
  assert.equal(conflict.learned, false); assert.equal(conflict.errorCode, 'INGREDIENT_ALIAS_CONFLICT');
  const before = await lookupExactAliasRecords([input.name.pl, input.name.en, translated.name.en]);
  assert.equal(before.size, 2); assert.equal(before.has(translated.name.en), false);
  assert.equal(before.get('swieze liscie moringi')?.verificationKey, first.verification.key);
  const retried = await completeVerification(conflict.key, 'resp_incompatible_current', savedResult, {});
  assert.equal(retried.learned, false); assert.equal(retried.errorCode, 'INGREDIENT_ALIAS_CONFLICT');
  assert.deepEqual(await lookupExactAliasRecords([input.name.pl, input.name.en, translated.name.en]), before);
  assert.deepEqual(retried.result, savedResult); assert.equal(retried.chargedUsd, '0.02000000');
});

test('compatible names cannot reuse an unlearned or obsolete-policy owner', async () => {
  const first = await startOrClaimVerification(input); assert(first.claimToken);
  await attachReceipt(first.verification.key, first.claimToken, 'resp_owner_state');
  await completeVerification(first.verification.key, 'resp_owner_state', result(), { chargedUsd: '0.05' });
  const translated = { name: { ...input.name, en: 'pending compatible moringa name' } };
  const second = await startOrClaimVerification(translated); assert(second.claimToken);
  await attachReceipt(second.verification.key, second.claimToken, 'resp_owner_state_current');
  for (const ownerState of [
    { learned: false, version: ingredientEvidencePolicyVersion },
    { learned: true, version: 'ingredient-evidence-v1' },
  ]) {
    await pool.query('UPDATE ai_ingredient_verification SET learned=$1,eligibility_policy_version=$2 WHERE verification_key=$3',
      [ownerState.learned, ownerState.version, first.verification.key]);
    const conflict = await completeVerification(second.verification.key, 'resp_owner_state_current', result(translated), { chargedUsd: '0.02' });
    assert.equal(conflict.learned, false); assert.equal(conflict.errorCode, 'INGREDIENT_ALIAS_CONFLICT');
    assert.equal((await lookupExactAliasRecords([translated.name.en])).size, 0);
  }
});

test('every existing alias owner must prove the same identity before a query is accepted', async () => {
  const first = await startOrClaimVerification(input); assert(first.claimToken);
  await attachReceipt(first.verification.key, first.claimToken, 'resp_multi_owner_first');
  await completeVerification(first.verification.key, 'resp_multi_owner_first', result(), { chargedUsd: '0.05' });
  const different = { name: { pl: 'świeże liście innej rośliny', en: 'other botanical leaves' } };
  const second = await startOrClaimVerification(different); assert(second.claimToken);
  await attachReceipt(second.verification.key, second.claimToken, 'resp_multi_owner_second');
  await completeVerification(second.verification.key, 'resp_multi_owner_second', result(different, {
    canonicalName: { pl: 'mięta', en: 'mint' },
  }), { chargedUsd: '0.02' });
  const combined = { name: { pl: input.name.pl, en: different.name.en } };
  const third = await startOrClaimVerification(combined); assert(third.claimToken);
  await attachReceipt(third.verification.key, third.claimToken, 'resp_multi_owner_current');
  const names = [...Object.values(input.name), ...Object.values(different.name)];
  const before = await lookupExactAliasRecords(names);
  const rejected = await completeVerification(third.verification.key, 'resp_multi_owner_current', result(combined), { chargedUsd: '0.01' });
  assert.equal(rejected.learned, false); assert.equal(rejected.errorCode, 'INGREDIENT_ALIAS_CONFLICT');
  assert.deepEqual(await lookupExactAliasRecords(names), before, 'A compatible first owner cannot hide an incompatible second owner.');
  assert.equal((await getVerificationCosts()).chargedUsd, '0.08000000');
});

test('a current-policy historical alias conflict heals from its stored facts without changing paid history', async () => {
  const first = await startOrClaimVerification(input); assert(first.claimToken);
  await attachReceipt(first.verification.key, first.claimToken, 'resp_historical_owner');
  await completeVerification(first.verification.key, 'resp_historical_owner', result(), { chargedUsd: '0.05' });
  const translated = { name: { ...input.name, en: 'young moringa leaves' } };
  const second = await startOrClaimVerification(translated, { originRecipeId: 'retained-recipe' }); assert(second.claimToken);
  await attachReceipt(second.verification.key, second.claimToken, 'resp_historical_conflict');
  await pool.query(`UPDATE ai_ingredient_verification SET result=$1,status='complete',learned=false,eligibility_policy_version=$2,
    error_code='INGREDIENT_ALIAS_CONFLICT',error_message='Previously rejected overlapping query.',charged_usd=0.02,cost_basis='usage',provider_finished_at=now()
    WHERE verification_key=$3`, [result(translated), ingredientEvidencePolicyVersion, second.verification.key]);
  const before = await getVerification(second.verification.key); assert(before?.result);
  const healed = await completeVerification(before.key, before.providerRequestId!, before.result, {});
  assert.equal(healed.learned, true); assert.equal(healed.errorCode, null); assert.equal(healed.errorMessage, null);
  for (const field of ['input', 'result', 'providerRequestId', 'providerFinishedAt', 'createdAt', 'claimToken', 'originJobId', 'originRecipeId', 'chargedUsd', 'costBasis'] as const)
    assert.deepEqual(healed[field], before[field], `Reconciliation changed ${field}.`);
  assert.equal((await lookupExactAliasRecords([input.name.pl])).get('swieze liscie moringi')?.verificationKey, first.verification.key);
  assert.equal((await lookupExactAliasRecords([translated.name.en])).get(translated.name.en)?.verificationKey, healed.key);
  assert.deepEqual(await getVerificationCosts(), { chargedUsd: '0.07000000', pendingCount: 0, requestCount: 2 });
});

test('concurrent compatible completions learn both queries without deadlock or alias reassignment', { timeout: 15_000 }, async () => {
  const translated = { name: { ...input.name, en: 'young moringa leaves' } };
  const first = await startOrClaimVerification(input), second = await startOrClaimVerification(translated);
  assert(first.claimToken); assert(second.claimToken);
  await attachReceipt(first.verification.key, first.claimToken, 'resp_concurrent_first');
  await attachReceipt(second.verification.key, second.claimToken, 'resp_concurrent_second');
  const completed = await Promise.all([
    completeVerification(first.verification.key, 'resp_concurrent_first', result(), { chargedUsd: '0.05' }),
    completeVerification(second.verification.key, 'resp_concurrent_second', result(translated), { chargedUsd: '0.02' }),
  ]);
  assert(completed.every(row => row.learned && row.errorCode === null));
  const aliases = await lookupExactAliasRecords([input.name.pl, input.name.en, translated.name.en]);
  assert.equal(aliases.size, 3);
  const originalOwner = aliases.get('swieze liscie moringi')?.verificationKey;
  assert(completed.some(row => row.key === originalOwner));
  await completeVerification(second.verification.key, 'resp_concurrent_second', result(translated), {});
  assert.equal((await lookupExactAliasRecords([input.name.pl])).get('swieze liscie moringi')?.verificationKey, originalOwner);
  assert.deepEqual(await getVerificationCosts(), { chargedUsd: '0.07000000', pendingCount: 0, requestCount: 2 });
});

test('shared cached verifications are billed once to their original job and trend ownership', async () => {
  await pool.query("INSERT INTO ai_job(id,trend_run_id) VALUES('manual',NULL),('trend','run-1')");
  const manual = await startOrClaimVerification(input, { originJobId: 'manual', originRecipeId: 'manual-recipe' }); assert(manual.claimToken);
  await attachReceipt(manual.verification.key, manual.claimToken, 'resp_manual');
  await completeVerification(manual.verification.key, 'resp_manual', result(), { chargedUsd: '0.10' });
  const reused = await startOrClaimVerification(input, { originJobId: 'trend', originRecipeId: 'trend-recipe' });
  assert.equal(reused.claimed, false); assert.equal(reused.verification.originJobId, 'manual');
  const trendInput = { name: { pl: 'inny liść', en: 'other leaf' } };
  const trend = await startOrClaimVerification(trendInput, { originJobId: 'trend', originRecipeId: 'trend-recipe' }); assert(trend.claimToken);
  await attachReceipt(trend.verification.key, trend.claimToken, 'resp_trend');
  await completeVerification(trend.verification.key, 'resp_trend', result(trendInput), { chargedUsd: '0.20' });
  assert.equal((await getVerificationCosts()).chargedUsd, '0.30000000');
  assert.equal((await getVerificationCosts({ trendOnly: false })).chargedUsd, '0.10000000');
  assert.equal((await getVerificationCosts({ trendOnly: true })).chargedUsd, '0.20000000');
  assert.equal((await getVerificationCosts({ trendRunId: 'run-1' })).chargedUsd, '0.20000000');
  assert.equal((await getVerificationCosts({ jobId: 'manual' })).chargedUsd, '0.10000000');
  assert.equal((await getVerificationCosts({ recipeId: 'trend-recipe' })).chargedUsd, '0.20000000');
  assert.equal((await getVerificationCosts({ since: new Date(Date.now() + 86_400_000) })).chargedUsd, '0.00000000');
  assert.deepEqual(await getVerificationBudgetTotals({ trendOnly: false }), { daily: '0.10000000', monthly: '0.10000000', pilot: '0.10000000', pendingCount: 0 });
  assert.equal((await getVerification(manual.verification.key))?.chargedUsd, '0.10000000');
});

test('a policy recheck promotes the same paid response without new submission, changed facts or a second charge', async () => {
  const key = ingredientVerificationKey(input), token = randomUUID(), oldResult = result(input, { autoLearnEligible: false });
  await pool.query(`INSERT INTO ai_ingredient_verification(verification_key,input,model,status,claim_token,claim_expires_at,provider_request_id,result,charged_usd,cost_basis,provider_finished_at)
    VALUES($1,$2,'gpt-6.1-sol','complete',$3,now(),'resp_original_paid',$4,0.05,'usage',now())`, [key, input, token, oldResult]);
  const before = await getVerification(key); assert(before);
  assert.equal(before.eligibilityPolicyVersion, 'ingredient-evidence-v1'); assert.equal(before.learned, false);
  assert.equal((await startOrClaimVerification(input)).claimed, false);
  const promoted = await completeVerification(key, 'resp_original_paid', result(), { chargedUsd: '0.05' });
  assert.equal(promoted.eligibilityPolicyVersion, ingredientEvidencePolicyVersion); assert.equal(promoted.learned, true);
  assert.equal(promoted.providerRequestId, before.providerRequestId); assert.equal(promoted.claimToken, token);
  assert.deepEqual(promoted.providerFinishedAt, before.providerFinishedAt); assert.equal(promoted.chargedUsd, before.chargedUsd);
  const { autoLearnEligible: wasEligible, ...originalFacts } = oldResult;
  const { autoLearnEligible: isEligible, ...promotedFacts } = promoted.result!;
  assert.equal(wasEligible, false); assert.equal(isEligible, true); assert.deepEqual(promotedFacts, originalFacts);
  assert.equal((await lookupExactAliases([input.name.pl, input.name.en, 'moringa'])).size, 2);
  assert.deepEqual(await getVerificationCosts(), { chargedUsd: '0.05000000', pendingCount: 0, requestCount: 1 });
  await completeVerification(key, 'resp_original_paid', result(), { chargedUsd: '0.05' });
  assert.equal((await startOrClaimVerification(input)).claimed, false);
  await assert.rejects(completeVerification(key, 'resp_original_paid', result(input, { reason: 'Changed source finding.' }), {}), /RESULT_CONFLICT/);
  await assert.rejects(pool.query("UPDATE ai_ingredient_verification SET result=jsonb_set(result,'{sources,0,finding}','\"Changed source finding.\"'::jsonb)"), /RESULT_IMMUTABLE/);
  await assert.rejects(pool.query("UPDATE ai_ingredient_verification SET charged_usd=0.06"), /COST_IMMUTABLE/);
  await assert.rejects(pool.query("UPDATE ai_ingredient_verification SET provider_request_id='resp_replacement'"), /RECEIPT_IMMUTABLE/);
  const negativeInput = { name: { pl: 'nazwa nadal niepotwierdzona', en: '' } }, negativeKey = ingredientVerificationKey(negativeInput);
  const negativeResult = result(negativeInput, { decision: 'unverified', autoLearnEligible: false });
  await pool.query(`INSERT INTO ai_ingredient_verification(verification_key,input,model,status,claim_token,claim_expires_at,provider_request_id,result,charged_usd,cost_basis)
    VALUES($1,$2,'gpt-6.1-sol','complete',$3,now(),'resp_negative_policy',$4,0.02,'usage')`, [negativeKey, negativeInput, randomUUID(), negativeResult]);
  const negative = await completeVerification(negativeKey, 'resp_negative_policy', negativeResult, {});
  assert.equal(negative.eligibilityPolicyVersion, ingredientEvidencePolicyVersion); assert.equal(negative.learned, false);
  assert.equal((await lookupExactAliases([negativeInput.name.pl])).size, 0);
});
