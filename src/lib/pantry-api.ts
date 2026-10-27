import { buildIngredientCatalog, searchIngredientCatalog } from './ingredient-catalog';
import { isPantryProducts, matchPantryRecipes, MAX_PANTRY_PRODUCTS } from './pantry';
import type { PublicRecipe } from './recipe-presentation';
import type { Locale } from './recipes';

export class PantryQueryError extends Error {}

export function pantryLocale(params: URLSearchParams): Locale {
  const locale = params.get('locale') ?? 'pl';
  if (locale !== 'pl' && locale !== 'en') throw new PantryQueryError('Nieprawidłowy język.');
  return locale;
}

export function parseIngredientCatalogQuery(params: URLSearchParams) {
  const locale = pantryLocale(params);
  const query = params.get('q') ?? '';
  if (query.length > 100) throw new PantryQueryError('Wyszukiwanie może mieć najwyżej 100 znaków.');
  return { locale, query };
}

export function ingredientCatalogResponse(recipes: PublicRecipe[], params: URLSearchParams) {
  const { locale, query } = parseIngredientCatalogQuery(params);
  return { locale, products: searchIngredientCatalog(buildIngredientCatalog(recipes), query, locale).map(item => ({ id: item.id, name: item.name[locale] })) };
}

export function parseRecipeMatchQuery(params: URLSearchParams) {
  const locale = pantryLocale(params);
  const raw = params.get('products') ?? '';
  if (raw.length > 12000) throw new PantryQueryError('Lista produktów jest zbyt długa.');
  const products = raw ? raw.split(',') : [];
  if (!isPantryProducts(products)) throw new PantryQueryError(`Wybierz najwyżej ${MAX_PANTRY_PRODUCTS} różnych produktów.`);
  return { locale, products };
}

export function recipeMatchesResponse(recipes: PublicRecipe[], params: URLSearchParams) {
  const { locale, products } = parseRecipeMatchQuery(params);
  return { locale, products, matches: matchPantryRecipes(recipes, products).map(match => ({
    recipe: {
      id: match.recipe.id, slug: match.recipe.slug[locale], title: match.recipe.title[locale],
      description: match.recipe.description[locale], image: match.recipe.image, imageAlt: match.recipe.imageAlt[locale],
      times: match.recipe.times, difficulty: match.recipe.difficulty, baseServings: match.recipe.baseServings,
      collection: match.recipe.collection ?? 'author', ...(match.recipe.trendConfirmedAt ? { trendConfirmedAt: match.recipe.trendConfirmedAt } : {}),
    },
    owned: match.owned.map(item => ({ id: item.id, name: item.name[locale] })),
    missing: match.missing.map(item => ({ id: item.id, name: item.name[locale] })),
    coverage: match.coverage,
    alternatives: match.alternatives.map(item => ({ ingredientId: item.ingredientId, productId: item.productId, name: item.substitution.name[locale], note: item.substitution.note[locale] })),
  })) };
}
