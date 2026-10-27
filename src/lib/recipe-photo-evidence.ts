import type { EditorialContent, PublicationIssue } from './editorial-types';
import type { MediaTile } from './recipe-media';
import { recipes, type Recipe } from './recipes';
import { curatedRecipePhotoSources, type CuratedRecipePhotoSource } from './curated-recipe-photos';

export type RecipePhotoSource = CuratedRecipePhotoSource;
export type RecipePhotoSources = ReadonlyMap<string, RecipePhotoSource>;
type PhotoCrop = Pick<MediaTile, 'src' | 'columns' | 'rows' | 'index'>;

export function recipePhotoCropKey(photo: PhotoCrop): string {
  return JSON.stringify([photo.src, photo.columns, photo.rows, photo.index]);
}

/** These exact crops were checked against their captured method. Low-value
 * omissions are deliberately separate; only confirmed wrong lessons are denied. */
export const reviewedWrongStepPhotoKeys: ReadonlySet<string> = new Set([
  ['/media/b80c52cd-ba4d-4e07-a397-a8bba410ecfc', 1, 1, 0], // roasted fruit before roasting
  ['/media/aa81db26-6a98-41e7-8f2e-b8a98fd0e325', 1, 1, 0], // finished soup instead of melting cheese
  ['/media/ec3cccb0-73ff-436d-8972-9dd230a45252', 1, 1, 0], // yolk finish absent
  ['/media/dc7055f2-c2e9-405d-acb6-9c186f7dd5e1', 1, 1, 0], // stack instead of crepe frying
  ['/media/75d50ce9-3090-4cfd-b42c-6b5d7dd61033', 1, 1, 0], // baked food before the oven
  ['/media/b366d762-ec74-4801-a300-26ff14de762a', 1, 1, 0], // roasted fruit during raw preparation
  ['/media/2ddd3db3-4d7e-47d4-8bb2-9b54ac4bb36f', 1, 1, 0], // doneness contradicts approved method
  ['/media/e664be56-3cfd-4a53-96d1-68d364585e36', 1, 1, 0], // hot-centre check absent
  ['/media/9b1e6102-b79e-44bb-bb44-a5ceae771dce', 1, 1, 0], // paper parcel technique absent
  ['/media/153f0bcd-e157-4cf7-b8d8-64f102b017ae', 1, 1, 0], // boning technique absent
  ['/media/48bec760-8e45-4100-bd2c-a4e56926260e', 1, 1, 0], // conventional layers instead of torn-sheet lasagne
  ['/media/7ad9f089-c311-4dc0-84ef-7c9323811a58', 1, 1, 0], // sauce poured over skin that must stay crisp
  ['/images/steps-pumpkin-soup.webp', 2, 3, 4], // finished soup instead of seed toasting
].map(crop => JSON.stringify(crop)));

export function isReviewedWrongStepPhoto(photo: PhotoCrop): boolean {
  return reviewedWrongStepPhotoKeys.has(recipePhotoCropKey(photo));
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** Comparison signature only, never a persisted AI/reuse key. Recipe titles and
 * IDs are editorial; ingredient tokens are normalised by their recipe position. */
export function recipePhotoCulinarySignature(recipe: Pick<Recipe, 'baseServings' | 'ingredients' | 'steps'>): string {
  const ids = new Map(recipe.ingredients.map((ingredient, index) => [ingredient.id, `ingredient-${index}`]));
  const subject = stable({
    baseServings: recipe.baseServings,
    ingredients: recipe.ingredients.map(({ name, amount, unit, scaling, note }) => ({ name, amount, unit, scaling, note })),
    steps: recipe.steps.map(({ text, timerMinutes }) => ({
      text: Object.fromEntries((['pl', 'en'] as const).map(locale => [locale, text[locale].replace(/\{\{([^}]+)\}\}/gu, (_, id: string) => `{{${ids.get(id) ?? id}}}`).replace(/\s+/gu, ' ').trim()])),
      timerMinutes,
    })),
  });
  // Two independent 64-bit accumulators keep this synchronous and portable to
  // shared validation/client bundles. The source registry itself remains trusted.
  let left = BigInt('0xcbf29ce484222325'), right = BigInt('0x84222325cbf29ce4');
  const multiplier = BigInt('0x100000001b3');
  for (const character of subject) {
    const point = BigInt(character.codePointAt(0)!);
    left = BigInt.asUintN(64, (left ^ point) * multiplier);
    right = BigInt.asUintN(64, (right ^ point) * multiplier);
  }
  return left.toString(16).padStart(16, '0') + right.toString(16).padStart(16, '0');
}

export function recipePhotoSource(recipe: Recipe, kind: 'hero' | 'step', targetId: string | null, src: string): RecipePhotoSource | null {
  const stepIndex = kind === 'step' ? recipe.steps.findIndex(step => step.id === targetId) : null;
  if (kind === 'hero' && targetId !== null || kind === 'step' && (stepIndex === null || stepIndex < 0)) return null;
  return { src, kind, recipeId: recipe.id, targetId, stepIndex, culinarySignature: recipePhotoCulinarySignature(recipe) };
}

export function compatibleRecipePhotoSource(source: RecipePhotoSource, recipe: Recipe, kind: 'hero' | 'step', targetId: string | null): boolean {
  if (source.kind !== kind) return false;
  if (source.kind === 'hero' && (source.targetId !== null || source.stepIndex !== null)
    || source.kind === 'step' && (!source.targetId || source.stepIndex === null || source.stepIndex < 0)) return false;
  const index = kind === 'step' ? recipe.steps.findIndex(step => step.id === targetId) : null;
  if (kind === 'step' && (index === null || index < 0) || kind === 'hero' && targetId !== null) return false;
  // This immutable source belongs to the same slot. Harmless editorial wording
  // must not invalidate every existing image; reviewed wrong-state crops do.
  if (source.recipeId === recipe.id && source.targetId === targetId) return true;
  return source.culinarySignature === recipePhotoCulinarySignature(recipe)
    && (kind === 'hero' || source.stepIndex === index);
}

function staticPhotoSource(photo: PhotoCrop): RecipePhotoSource | null {
  const curated = curatedRecipePhotoSources.find(source => source.src === photo.src);
  if (curated) return photo.columns === 1 && photo.rows === 1 && photo.index === 0 ? curated : null;
  const hero = recipes.find(recipe => recipe.image === photo.src);
  if (hero) return photo.columns === 1 && photo.rows === 1 && photo.index === 0 ? recipePhotoSource(hero, 'hero', null, photo.src) : null;
  const recipe = recipes.find(item => `/images/steps-${item.id}.webp` === photo.src);
  if (!recipe || photo.columns !== 2 || photo.rows !== 3 || !recipe.steps[photo.index]) return null;
  return recipePhotoSource(recipe, 'step', recipe.steps[photo.index].id, photo.src);
}

/** Source captions never establish identity. Passing evidence makes registered
 * media mandatory; omitting it still checks static sources and exact duplicates. */
export function recipePhotoAssignmentIssues(content: EditorialContent, knownSources?: RecipePhotoSources): PublicationIssue[] {
  const issues: PublicationIssue[] = [];
  const add = (field: string, message: string) => issues.push({ field, message });
  const check = (photo: PhotoCrop, kind: 'hero' | 'step', targetId: string | null, field: string) => {
    const registered = /^\/media\/[a-f0-9-]{36}$/iu.test(photo.src);
    const source = knownSources?.get(recipePhotoCropKey(photo)) ?? staticPhotoSource(photo);
    if (source && !compatibleRecipePhotoSource(source, content.recipe, kind, targetId)) add(field, 'Fotografia pochodzi z innego dania lub innego etapu przygotowania. Wybierz zdjęcie właściwe dla tego miejsca.');
    else if (registered && knownSources && !source) add(field, 'Fotografia wymaga potwierdzonego rodzaju, przepisu, kroku i kadru w bibliotece.');
    else if (photo.src.startsWith('/images/') && !source) add(field, 'Wybierz sprawdzone zdjęcie i kadr właściwy dla tego przepisu i kroku.');
  };
  if (content.recipe.image) check({ src: content.recipe.image, columns: 1, rows: 1, index: 0 }, 'hero', null, 'image');
  const seen = new Map<string, string>();
  for (const step of content.recipe.steps) {
    const photo = content.photos.steps[step.id];
    if (!photo) continue;
    const field = `steps.${step.id}.photo`;
    if (isReviewedWrongStepPhoto(photo)) add(field, 'To zdjęcie wycofano po przeglądzie: nie pokazuje właściwej czynności lub stanu tego kroku. Wybierz poprawiony kadr.');
    if (photo.src === content.recipe.image) add(field, 'Zdjęcie gotowej potrawy nie może zastępować instruktażowego zdjęcia kroku.');
    const key = recipePhotoCropKey(photo), prior = seen.get(key);
    if (prior && prior !== step.id) {
      const message = 'Dwa różne kroki nie mogą korzystać z tego samego zdjęcia i kadru.';
      add(field, message); add(`steps.${prior}.photo`, message);
    }
    seen.set(key, step.id);
    check(photo, 'step', step.id, field);
  }
  return issues.filter((issue, index) => issues.findIndex(other => other.field === issue.field && other.message === issue.message) === index);
}
