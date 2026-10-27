import assert from 'node:assert/strict';
import test from 'node:test';
import type { IngredientVerificationResult } from '@/lib/ingredient-verification';
import { sameVerifiedIngredientIdentity } from './ingredient-alias-identity';

function verified(): IngredientVerificationResult {
  return { decision: 'verified', queriedNames: { pl: 'liście bai chaplu', en: 'wild betel leaves' },
    canonicalName: { pl: 'młode liście bai chaplu (Piper sarmentosum)', en: 'young wild betel leaves (Piper sarmentosum)' },
    kind: 'plant', diet: 'vegan', confidence: 'high', sameIdentity: true, singleIngredient: true,
    suggestedName: null, autoLearnEligible: true, reason: 'Synthetic evidence fixture for the reported bilingual overlap.',
    sources: [{ title: 'Institutional identity fixture', url: 'https://www.nparks.gov.sg/florafaunaweb/flora/2/3/2342',
      supports: ['identity', 'culinary_use', 'diet'], finding: 'Fixture establishing the exact culinary plant identity.' }] };
}

test('independently verified wording variants share identity without equating their query keys', () => {
  const first = verified(), second = verified();
  first.queriedNames.en = 'large, young wild betel leaves (bai chaplu or lá lốt)';
  second.queriedNames.en = 'large, young bai chaplu leaves (lá lốt, wild betel)';
  assert.notDeepEqual(first.queriedNames, second.queriedNames);
  assert.equal(sameVerifiedIngredientIdentity(first, second), true);
  assert.equal(sameVerifiedIngredientIdentity(second, first), true);
});

test('vegan homonyms and matching labels without shared identity evidence remain separate', () => {
  const first = verified();
  const otherPlant = verified(); otherPlant.canonicalName = { pl: 'liście innej rośliny', en: 'leaves of another plant' };
  const noSharedPage = verified(); noSharedPage.sources[0].url = 'https://www.nparks.gov.sg/florafaunaweb/flora/another-plant';
  const culinaryOnly = verified(); culinaryOnly.sources[0].supports = ['culinary_use', 'diet'];
  const missingTranslation = verified(); missingTranslation.canonicalName!.en = '';
  const correction = verified(); correction.suggestedName = { pl: 'inna nazwa', en: 'another name' };
  for (const candidate of [otherPlant, noSharedPage, culinaryOnly, missingTranslation, correction]) {
    assert.equal(sameVerifiedIngredientIdentity(first, candidate), false);
    assert.equal(sameVerifiedIngredientIdentity(candidate, first), false);
  }
});

test('untrusted evidence cannot join the dictionary despite a matching claimed identity', () => {
  const first = verified();
  const invalid: IngredientVerificationResult[] = [
    { ...verified(), autoLearnEligible: false }, { ...verified(), confidence: 'medium' },
    { ...verified(), sameIdentity: false }, { ...verified(), singleIngredient: false },
    { ...verified(), canonicalName: null }, { ...verified(), diet: 'meat' }, { ...verified(), kind: 'compound' },
  ];
  const insecure = verified(); insecure.sources[0].url = 'http://www.nparks.gov.sg/florafaunaweb/flora/2/3/2342'; invalid.push(insecure);
  for (const candidate of invalid) assert.equal(sameVerifiedIngredientIdentity(first, candidate), false);
  assert.equal(sameVerifiedIngredientIdentity(null, first), false);
});
