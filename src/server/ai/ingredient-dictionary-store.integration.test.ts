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
  const conflict = await completeVerification(second.verification.key, 'resp_conflicting_identity', result(otherInput), { chargedUsd: '0.02' });
  assert.equal(conflict.learned, false); assert.equal(conflict.errorCode, 'INGREDIENT_ALIAS_CONFLICT');
  const aliases = await lookupExactAliasRecords([input.name.pl, otherInput.name.en]);
  assert.equal(aliases.get('swieze liscie moringi')?.verificationKey, first.verification.key);
  assert.equal(aliases.has(otherInput.name.en), false);
  assert.equal((await getVerificationCosts()).chargedUsd, '0.07000000');
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
