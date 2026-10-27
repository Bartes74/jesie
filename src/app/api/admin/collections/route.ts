import { adminActor, adminResponse, readJson } from '@/server/http/admin';
import { collectionRecipePicker, createCollection, listCollections } from '@/server/collections/store';
import { collectionFailure } from '@/server/collections/errors';
import { createCollectionInput } from '@/server/collections/validation';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    await adminActor(request);
    const includeRecipes = new URL(request.url).searchParams.get('includeRecipes') === '1';
    const [collections, recipes] = await Promise.all([listCollections(), includeRecipes ? collectionRecipePicker() : Promise.resolve(undefined)]);
    return adminResponse({ collections, ...(recipes ? { recipes } : {}) });
  } catch (error) { return collectionFailure(error); }
}
export async function POST(request: Request) {
  try {
    const actor = await adminActor(request, true);
    const input = createCollectionInput.parse(await readJson(request));
    const collection = await createCollection(input, actor);
    return adminResponse({ id: collection.id }, 201);
  } catch (error) { return collectionFailure(error); }
}
