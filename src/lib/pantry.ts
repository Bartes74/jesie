import { buildIngredientCatalog, expandOwnedProducts, ingredientProductIds, type IngredientProduct } from './ingredient-catalog';
import type { PublicRecipe } from './recipe-presentation';
import type { Ingredient, IngredientSubstitution, Locale, UnitSystem } from './recipes';
import { formatIngredientAmount } from './quantities';

export const MAX_PANTRY_PRODUCTS = 30;
export const EMPTY_PANTRY: string[] = [];

export function isPantryProducts(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_PANTRY_PRODUCTS && new Set(value).size === value.length && value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 600 && !/[\u0000-\u001f,]/.test(id));
}

export type PantryAlternative = { ingredientId: string; productId: string; substitution: IngredientSubstitution };
export type PantryMatch = { recipe: PublicRecipe; owned: IngredientProduct[]; missing: IngredientProduct[]; coverage: number; weightedCoverage: number; priorityOwned: IngredientProduct[]; alternatives: PantryAlternative[] };

export function isCookingByproduct(ingredient: Pick<Ingredient, 'name'>): boolean {
  const names = [ingredient.name.pl, ingredient.name.en].join(' ').toLowerCase();
  return /wod[ayę]\s+(?:z|po)\s+gotowani[au]\s+makaronu|pasta\s+(?:cooking\s+)?water|water\s+(?:from|reserved\s+from)\s+cooking\s+(?:the\s+)?pasta/.test(names);
}

export function isOptionalIngredient(ingredient: Ingredient): boolean {
  const text = [ingredient.name.pl, ingredient.name.en, ingredient.note?.pl, ingredient.note?.en, ingredient.amount.kind === 'qualitative' ? `${ingredient.amount.text.pl} ${ingredient.amount.text.en}` : ''].join(' ').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /opcjonaln|optional|wedlug uznania|if desired/.test(text.replace(/not\s+optional|nie\s+(?:jest\s+)?opcjonaln\w*/g, ''));
}

function requiresPantryProduct(ingredient: Ingredient): boolean {
  return !isCookingByproduct(ingredient) && !isOptionalIngredient(ingredient);
}

const SPICES = new Set(['salt', 'black-pepper', 'nutmeg', 'cinnamon', 'baking-powder', 'baking-soda', 'water']);
const SUPPORTING = new Set(['olive-oil', 'rapeseed-oil', 'sunflower-oil', 'frying-oil', 'balsamic-vinegar', 'soy-sauce', 'garlic', 'ginger', 'basil', 'sage']);
export function pantryProductWeight(id: string): number { return SPICES.has(id) ? 0.1 : SUPPORTING.has(id) ? 0.4 : 1; }

export function comparePantryMatches(a: PantryMatch, b: PantryMatch): number {
  return b.priorityOwned.length - a.priorityOwned.length || b.weightedCoverage - a.weightedCoverage || a.missing.length - b.missing.length || a.recipe.times.total - b.recipe.times.total || a.recipe.id.localeCompare(b.recipe.id);
}

/** Input is the currently published public projection, never editorial drafts. */
export function matchPantryRecipes(recipes: PublicRecipe[], selectedIds: string[], priorityIds: string[] = []): PantryMatch[] {
  if (!selectedIds.length) return [];
  const catalog = buildIngredientCatalog(recipes);
  const selected = expandOwnedProducts(selectedIds.slice(0, MAX_PANTRY_PRODUCTS), catalog);
  const priority = expandOwnedProducts(priorityIds.slice(0, 3), catalog);
  const products = new Map(catalog.map(item => [item.id, item]));
  return recipes.flatMap(recipe => {
    const ids = [...new Set(recipe.ingredients.filter(requiresPantryProduct).flatMap(ingredientProductIds))];
    const owned = ids.filter(id => selected.has(id)).map(id => products.get(id)!);
    if (!owned.some(item => pantryProductWeight(item.id) > 0.1)) return [];
    const missing = ids.filter(id => !selected.has(id)).map(id => products.get(id)!);
    const missingIds = new Set(missing.map(item => item.id));
    const alternatives = (recipe.substitutions ?? []).filter(item => item.status === 'approved').flatMap(substitution => {
      const ingredient = recipe.ingredients.find(item => item.id === substitution.ingredientId);
      if (!ingredient || !ingredientProductIds(ingredient).some(id => missingIds.has(id))) return [];
      const productId = ingredientProductIds({ name: substitution.name }).find(id => selected.has(id));
      return productId ? [{ ingredientId: ingredient.id, productId, substitution }] : [];
    });
    const totalWeight = ids.reduce((sum, id) => sum + pantryProductWeight(id), 0);
    const ownedWeight = owned.reduce((sum, item) => sum + pantryProductWeight(item.id), 0);
    return [{ recipe, owned, missing, coverage: owned.length / ids.length, weightedCoverage: ownedWeight / totalWeight,
      priorityOwned: owned.filter(item => priority.has(item.id)), alternatives }];
  }).sort(comparePantryMatches);
}

export function pantryMatchReasons(match: PantryMatch, locale: Locale): string[] {
  const first = match.priorityOwned.map(item => item.name[locale]);
  const main = match.owned.filter(item => pantryProductWeight(item.id) === 1).slice(0, 3).map(item => item.name[locale]);
  return [first.length ? `${locale === 'pl' ? 'Zużyj najpierw' : 'Use first'}: ${first.join(', ')}` : main.length ? `${locale === 'pl' ? 'Wykorzystasz' : 'Uses'}: ${main.join(', ')}` : locale === 'pl' ? 'Masz część dodatków — sprawdź pozostałe produkty.' : 'You have some seasonings — check the main ingredients.',
    match.missing.length ? `${locale === 'pl' ? 'Do uzupełnienia' : 'Still needed'}: ${match.missing.length}` : locale === 'pl' ? 'Wszystkie produkty masz na liście lodówki. Sprawdź ilości.' : 'All ingredients are in your fridge list. Check quantities.'];
}

/** Substitution quantities are independent of the recipe's original ingredient. */
export function formatSubstitutionAmount(substitution: IngredientSubstitution, baseServings: number, targetServings: number, units: UnitSystem, locale: Locale): string | null {
  if (!substitution.amount) return null;
  return formatIngredientAmount({
    id: substitution.id, name: substitution.name, amount: substitution.amount,
    unit: substitution.unit ?? null, scaling: substitution.scaling ?? 'linear',
    group: { pl: 'Zamienniki', en: 'Substitutions' },
  }, baseServings, targetServings, units, locale);
}

export function isPopularNow(recipe: Pick<PublicRecipe, 'collection' | 'trendConfirmedAt'>, now = Date.now()): boolean {
  if (recipe.collection !== 'trends' || !recipe.trendConfirmedAt) return false;
  const confirmed = Date.parse(recipe.trendConfirmedAt);
  return Number.isFinite(confirmed) && confirmed <= now && now - confirmed < 14 * 24 * 60 * 60 * 1000;
}
