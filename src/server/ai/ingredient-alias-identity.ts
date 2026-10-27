import type { IngredientVerificationResult } from '@/lib/ingredient-verification';
import { normalizeIngredientVerificationName } from '@/lib/ingredient-verification';

function eligible(result: IngredientVerificationResult) {
  const expected: Partial<Record<IngredientVerificationResult['kind'], IngredientVerificationResult['diet']>> = {
    plant: 'vegan', fungus: 'vegan', mineral: 'vegan', dairy: 'vegetarian', egg: 'vegetarian', honey: 'vegetarian', meat: 'meat',
  };
  return result.autoLearnEligible && result.decision === 'verified' && result.confidence === 'high'
    && result.sameIdentity && result.singleIngredient && result.suggestedName === null && result.canonicalName !== null && result.diet !== null
    && expected[result.kind] === result.diet;
}

function identitySources(result: IngredientVerificationResult): Set<string> {
  const urls = new Set<string>();
  for (const source of result.sources) {
    if (!source.supports.includes('identity')) continue;
    try {
      const url = new URL(source.url);
      if (url.protocol !== 'https:' || url.username || url.password) continue;
      url.hash = '';
      urls.add(url.href);
    } catch { /* An invalid source cannot establish shared identity. */ }
  }
  return urls;
}

/** Equal diet alone never proves identity. Both accepted findings must name the
 * same exact bilingual ingredient and share an identity-bearing source page. */
export function sameVerifiedIngredientIdentity(left: IngredientVerificationResult | null, right: IngredientVerificationResult): boolean {
  if (!left || !eligible(left) || !eligible(right) || left.kind !== right.kind || left.diet !== right.diet) return false;
  for (const locale of ['pl', 'en'] as const) {
    const first = normalizeIngredientVerificationName(left.canonicalName![locale]);
    const second = normalizeIngredientVerificationName(right.canonicalName![locale]);
    if (!first || !second || first !== second) return false;
  }
  const sources = identitySources(left);
  return [...identitySources(right)].some(url => sources.has(url));
}
