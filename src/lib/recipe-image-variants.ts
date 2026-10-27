import type { Recipe } from './recipes';

export type RecipeImageSource = Pick<Recipe, 'id' | 'image'> & Partial<Pick<Recipe, 'slug'>>;
export const recipeImageDimensions = {
  classic: { width: 1600, height: 1200 },
  landscape: { width: 1600, height: 900 },
  square: { width: 1200, height: 1200 },
  social: { width: 1200, height: 630 },
  pinterest: { width: 1000, height: 1500 },
} as const;
export type RecipeImageVariantName = keyof typeof recipeImageDimensions;
export type RecipeImageVariant = { url: string; width: number; height: number };
export type RecipeImageVariants = Record<RecipeImageVariantName, RecipeImageVariant>;

/** Version the rendering rules as well as the immutable source, without a Node dependency. */
export function recipeImageVersion(image: string): string {
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  const hashes = seeds.map(seed => {
    let value = seed;
    for (let index = 0; index < image.length; index++) value = Math.imul(value ^ image.charCodeAt(index), 0x01000193);
    return (value >>> 0).toString(16).padStart(8, '0');
  });
  return `v1-${hashes.join('')}`;
}

function filename(recipe: RecipeImageSource) {
  const name = recipe.slug?.pl || recipe.image.split('/').at(-1)?.replace(/\.[^.]+$/, '') || recipe.id;
  return name.toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100).replace(/-+$/, '') || 'gotowa-potrawa';
}

/** All variants depict one finished dish. Ingredient and instruction atlases never enter this list. */
export function getRecipeImageVariants(recipe: RecipeImageSource): RecipeImageVariants {
  const base = `/media/recipes/${encodeURIComponent(recipe.id)}/${recipeImageVersion(recipe.image)}`;
  const description = filename(recipe);
  return Object.fromEntries(Object.entries(recipeImageDimensions).map(([name, dimensions]) => [name, {
    url: `${base}/${description}-gotowe-${dimensions.width}x${dimensions.height}.webp`, ...dimensions,
  }])) as RecipeImageVariants;
}
