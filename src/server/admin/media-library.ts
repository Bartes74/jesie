import 'server-only';
import { desc, eq, inArray } from 'drizzle-orm';
import type { LibraryImage, LibraryTarget } from '@/lib/media-library';
import type { EditorialActor } from '@/lib/editorial-types';
import { getDb } from '@/server/db';
import { aiAssets, aiJobs, ingredientImages } from '@/server/ai/schema';
import { editorialRecipes } from '@/server/db/schema';
import { capturedIngredientStyleProfile, ingredientImageIdentity, staticIngredientCandidates } from '@/server/ai/ingredient-profile';
import { EditorialError, getRecipe, saveRecipe } from '@/server/editorial/store';
import { getMediaBlob } from '@/server/media/storage';
import { libraryImageCompatible, libraryPhotoIdentity, validLibraryTarget } from './media-library-policy';

export async function getMediaLibrary(target?: LibraryTarget): Promise<LibraryImage[]> {
  const db = getDb();
  const [assets, recipes, catalog] = await Promise.all([
    db.select({ asset: aiAssets, input: aiJobs.input, jobKind: aiJobs.kind, jobRecipeId: aiJobs.recipeId, jobTargetId: aiJobs.targetId }).from(aiAssets).innerJoin(aiJobs, eq(aiAssets.jobId, aiJobs.id)).where(inArray(aiJobs.status, ['ready', 'applied'])).orderBy(desc(aiAssets.createdAt)).limit(1000),
    db.select({ id: editorialRecipes.id, content: editorialRecipes.content, deletedAt: editorialRecipes.deletedAt, editorialStatus: editorialRecipes.editorialStatus }).from(editorialRecipes),
    db.select().from(ingredientImages).where(inArray(ingredientImages.eligibility, ['usable', 'approved'])),
  ]);
  const selected = target ? recipes.find(recipe => recipe.id === target.recipeId) : null;
  if (target && (!selected || selected.deletedAt || selected.editorialStatus === 'archived')) throw new EditorialError(404, 'NOT_FOUND', 'Wybierz dostępny szkic przepisu.');
  if (target && selected && !validLibraryTarget(target, selected.content)) throw new EditorialError(422, 'INVALID_TARGET', 'Wybierz istniejący składnik lub krok.');
  const ingredient = selected?.content.recipe.ingredients.find(item => item.id === target?.targetId);
  const desired = ingredient && selected ? ingredientImageIdentity(ingredient, capturedIngredientStyleProfile(selected.content)) : null;
  const uses = (photo: LibraryImage['photo']) => recipes.filter(recipe => recipe.content.recipe.image === photo.src || [...Object.values(recipe.content.photos.ingredients), ...Object.values(recipe.content.photos.steps)].some(item => libraryPhotoIdentity(item) === libraryPhotoIdentity(photo))).map(recipe => ({ id: recipe.id, title: recipe.content.recipe.title.pl }));
  const generated: LibraryImage[] = assets.map(({ asset, input, jobKind, jobRecipeId, jobTargetId }) => {
    const entry = catalog.find(item => item.assetId === asset.id && (!desired || item.key === desired.key));
    const photo = { src: `/media/${asset.id}`, columns: 1, rows: 1, index: 0, alt: asset.alt, caption: asset.caption, aspectRatio: asset.width / asset.height };
    const sourceBound = asset.kind === jobKind && asset.recipeId === jobRecipeId && asset.targetId === jobTargetId && input.recipe.id === asset.recipeId;
    return { id: asset.id, kind: asset.kind, title: asset.alt.pl || input.recipe.title.pl, photo, sourceRecipeId: asset.recipeId, product: entry?.product ?? '', form: entry?.form ?? '', profile: entry?.styleProfile ?? capturedIngredientStyleProfile(input), createdAt: asset.createdAt.toISOString(), compatible: Boolean(sourceBound && target && selected && libraryImageCompatible({ kind: asset.kind, recipeId: asset.recipeId, targetId: asset.targetId, input, ingredientKey: entry?.key, src: photo.src }, selected.content, target)), uses: uses(photo) };
  });
  const defaults: LibraryImage[] = [...staticIngredientCandidates().values()].map(({ identity, photo }) => ({ id: `static:${identity.key}`, kind: 'ingredient', title: photo.alt.pl, photo, sourceRecipeId: '', product: identity.product, form: identity.form, profile: identity.styleProfile, createdAt: '', compatible: Boolean(target?.kind === 'ingredient' && desired?.key === identity.key), uses: uses(photo) }));
  return [...generated, ...defaults];
}

export async function reuseLibraryImage(input: LibraryTarget & { imageId: string; expectedRevision: number }, actor: EditorialActor) {
  const recipe = await getRecipe(input.recipeId);
  if (!recipe || recipe.deletedAt || recipe.editorialStatus === 'archived') throw new EditorialError(404, 'NOT_FOUND', 'Wybierz dostępny szkic przepisu.');
  if (recipe.revision !== input.expectedRevision) throw new EditorialError(409, 'REVISION_CONFLICT', 'Szkic zmienił się. Otwórz bibliotekę ponownie.', recipe);
  if (!validLibraryTarget(input, recipe.content)) throw new EditorialError(422, 'INVALID_TARGET', 'Wybierz istniejący składnik lub krok.');
  const image = (await getMediaLibrary(input)).find(item => item.id === input.imageId && item.compatible);
  if (!image) throw new EditorialError(422, 'INCOMPATIBLE_IMAGE', 'Zdjęcie nie pasuje do tego produktu, jego postaci, stylu lub miejsca w przepisie.');
  if (!input.imageId.startsWith('static:')) {
    const [asset] = await getDb().select({ path: aiAssets.blobPathname }).from(aiAssets).where(eq(aiAssets.id, input.imageId));
    if (!asset) throw new EditorialError(404, 'IMAGE_MISSING', 'Zdjęcie nie jest dostępne.');
    try {
      const stored = await getMediaBlob(asset.path, { useCache: false });
      if (!stored || stored.statusCode !== 200) throw new Error('IMAGE_MISSING');
      await stored.stream.cancel().catch(() => {});
    } catch { throw new EditorialError(503, 'IMAGE_UNAVAILABLE', 'Nie udało się potwierdzić dostępności zdjęcia. Szkic nie został zmieniony.'); }
  }
  const content = structuredClone(recipe.content);
  if (input.kind === 'hero') { content.recipe.image = image.photo.src; content.recipe.imageAlt = image.photo.alt; }
  else content.photos[input.kind === 'ingredient' ? 'ingredients' : 'steps'][input.targetId!] = input.kind === 'ingredient'
    ? { ...image.photo, alt: structuredClone(content.recipe.ingredients.find(item => item.id === input.targetId)!.name) } : image.photo;
  // saveRecipe performs the authoritative revision check again after all reads.
  return saveRecipe(input.recipeId, { expectedRevision: input.expectedRevision, content }, actor);
}
