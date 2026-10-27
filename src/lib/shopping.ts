import Decimal from 'decimal.js';
import { buildIngredientCatalog, expandOwnedProducts, ingredientProductIds } from './ingredient-catalog';
import { isCookingByproduct, isOptionalIngredient } from './pantry';
import { formatIngredientAmount, scaleIngredientAmount } from './quantities';
import type { PublicRecipe } from './recipe-presentation';
import type { Ingredient, IngredientAmount, IngredientUnit, Localised, Locale, UnitSystem } from './recipes';

const ShoppingDecimal = Decimal.clone({ precision: 60 });
export type ShoppingSelection = { optionalIngredientIds: string[]; substitutions: Record<string, string>; includeOwnedProductIds: string[] };
export const EMPTY_SHOPPING_SELECTION: ShoppingSelection = { optionalIngredientIds: [], substitutions: {}, includeOwnedProductIds: [] };
export const PANTRY_STORAGE_KEY = 'jesie:pantry:v1';
export const PANTRY_USE_STORAGE_KEY = 'jesie:pantry-use:v1';
export const PANTRY_FIRST_STORAGE_KEY = 'jesie:pantry-first:v1';

function isIds(value: unknown, maximum = 100): value is string[] {
  return Array.isArray(value) && value.length <= maximum && new Set(value).size === value.length && value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 600 && !/[\u0000-\u001f]/.test(id));
}
export function isShoppingSelection(value: unknown): value is ShoppingSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const selection = value as Partial<ShoppingSelection>;
  return isIds(selection.optionalIngredientIds) && isIds(selection.includeOwnedProductIds) && Boolean(selection.substitutions && typeof selection.substitutions === 'object' && !Array.isArray(selection.substitutions)
    && Object.entries(selection.substitutions).length <= 100 && Object.entries(selection.substitutions).every(([key, item]) => key.length <= 100 && typeof item === 'string' && item.length <= 100));
}

export type ShoppingLine = {
  id: string; recipeId: string; ingredientId: string; productId: string; name: Localised;
  amount: IngredientAmount; unit: IngredientUnit; owned: boolean; active: boolean; included: boolean;
  optional: boolean; quantityKnown: boolean; substitutionNote?: Localised;
};

const checkQuantity: IngredientAmount = { kind: 'qualitative', text: { pl: 'sprawdź potrzebną ilość', en: 'check the quantity needed' } };

/** A selected alternative owns its own amount; the original quantity is never reused. */
export function buildRecipeShopping(recipe: PublicRecipe, servings: number, ownedIds: string[], selection: ShoppingSelection = EMPTY_SHOPPING_SELECTION): ShoppingLine[] {
  const catalog = buildIngredientCatalog([recipe]);
  const products = new Map(catalog.map(item => [item.id, item]));
  const owned = expandOwnedProducts(ownedIds, catalog);
  const includeOwned = expandOwnedProducts(selection.includeOwnedProductIds, catalog);
  return recipe.ingredients.filter(ingredient => !isCookingByproduct(ingredient)).flatMap(original => {
    const substitution = recipe.substitutions?.find(item => item.status === 'approved' && item.ingredientId === original.id && item.id === selection.substitutions[original.id]);
    const ingredient: Ingredient = substitution ? { ...original, name: substitution.name, amount: substitution.amount ?? checkQuantity,
      unit: substitution.amount ? substitution.unit ?? null : null, scaling: substitution.scaling ?? 'linear' } : original;
    const ids = ingredientProductIds(ingredient);
    const optional = isOptionalIngredient(original);
    const active = !optional || selection.optionalIngredientIds.includes(original.id);
    // A compound has no trustworthy per-product numeric split.
    const known = ids.length === 1 && (!substitution || Boolean(substitution.amount));
    const amount = known ? scaleIngredientAmount(ingredient, recipe.baseServings, servings) : ingredient.amount.kind === 'qualitative' ? ingredient.amount : checkQuantity;
    return ids.map(productId => {
      const has = owned.has(productId);
      return { id: `${recipe.id}:${original.id}:${productId}`, recipeId: recipe.id, ingredientId: original.id, productId,
        name: ids.length > 1 ? products.get(productId)?.name ?? ingredient.name : ingredient.name,
        amount, unit: known ? ingredient.unit : null, owned: has, active,
        included: active && (!has || includeOwned.has(productId)), optional, quantityKnown: known,
        ...(substitution ? { substitutionNote: substitution.note } : {}) };
    });
  });
}

export type ShoppingItem = {
  id: string; productId: string; name: Localised; amount: IngredientAmount; unit: IngredientUnit;
  recipeIds: string[]; quantityKnown: boolean;
};

function numericBounds(amount: IngredientAmount) {
  return amount.kind === 'exact' ? { min: amount.value, max: amount.value } : amount.kind === 'range' ? amount : null;
}
function safeUnit(amount: IngredientAmount, unit: IngredientUnit): { amount: IngredientAmount; unit: IngredientUnit } {
  if (amount.kind === 'qualitative' || (unit !== 'tsp' && unit !== 'tbsp')) return { amount, unit };
  const multiplier = unit === 'tsp' ? 5 : 15;
  const times = (value: string) => new ShoppingDecimal(value).mul(multiplier).toString();
  return { amount: amount.kind === 'exact' ? { ...amount, value: times(amount.value) } : { ...amount, min: times(amount.min), max: times(amount.max) }, unit: 'ml' };
}

/** Canonical product + physical unit is required. No ingredient density is inferred. */
export function combineShoppingLines(lines: ShoppingLine[]): ShoppingItem[] {
  const groups = new Map<string, ShoppingItem>();
  for (const line of lines) {
    const normalized = safeUnit(line.amount, line.unit);
    const qualitative = normalized.amount.kind === 'qualitative' ? JSON.stringify(normalized.amount.text) : '';
    const key = JSON.stringify([line.productId, normalized.unit, line.quantityKnown, qualitative]);
    const previous = groups.get(key);
    if (!previous) {
      groups.set(key, { id: key, productId: line.productId, name: line.name, ...normalized, recipeIds: [line.recipeId], quantityKnown: line.quantityKnown });
      continue;
    }
    const first = numericBounds(previous.amount);
    const next = numericBounds(normalized.amount);
    if (first && next) {
      const min = new ShoppingDecimal(first.min).plus(next.min).toString();
      const max = new ShoppingDecimal(first.max).plus(next.max).toString();
      const approximate = previous.amount.kind !== 'qualitative' && previous.amount.approximate || normalized.amount.kind !== 'qualitative' && normalized.amount.approximate;
      previous.amount = min === max ? { kind: 'exact', value: min, ...(approximate ? { approximate: true } : {}) } : { kind: 'range', min, max, ...(approximate ? { approximate: true } : {}) };
    }
    previous.recipeIds = [...new Set([...previous.recipeIds, line.recipeId])];
  }
  // A changed quantity gets a new check key; an old tick cannot hide an increased need.
  return [...groups.values()].map(item => ({ ...item, id: `${item.id}:${JSON.stringify(item.amount)}` }));
}

export function formatShoppingAmount(item: Pick<ShoppingItem, 'amount' | 'unit' | 'name'>, locale: Locale, units: UnitSystem = 'metric'): string {
  return formatIngredientAmount({ id: 'shopping', name: item.name, amount: item.amount, unit: item.unit, scaling: 'fixed', group: { pl: '', en: '' } }, 1, 1, units, locale);
}

export function shoppingText(items: Array<Pick<ShoppingItem, 'amount' | 'unit' | 'name'>>, locale: Locale, units: UnitSystem = 'metric'): string {
  return items.map(item => `☐ ${item.name[locale]} — ${formatShoppingAmount(item, locale, units)}`).join('\n');
}
