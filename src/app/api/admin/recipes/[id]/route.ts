import { after } from 'next/server';
import { deleteRecipe, getRecipe, saveRecipe } from '@/server/editorial/store';
import { dispatchDiscoveryWorkflows } from '@/server/seo/dispatch';
import { adminActor, adminResponse, adminFailure, readJson, saveInput, deleteInput } from '@/server/http/admin';

export const runtime = 'nodejs';
export const maxDuration = 300;
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Context) {
  try { await adminActor(request); const { id } = await params; const recipe = await getRecipe(id); return recipe ? adminResponse({ recipe }) : adminResponse({ error: 'Nie znaleziono przepisu.' }, 404); }
  catch (error) { return adminFailure(error); }
}
export async function PATCH(request: Request, { params }: Context) {
  try { const actor = await adminActor(request, true); const { id } = await params; const input = saveInput.parse(await readJson(request)); return adminResponse({ recipe: await saveRecipe(id, input, actor) }); }
  catch (error) { return adminFailure(error); }
}
export async function DELETE(request: Request, { params }: Context) {
  try {
    const actor = await adminActor(request, true); const { id } = await params;
    const input = deleteInput.parse(await readJson(request));
    const recipe = await deleteRecipe(id, input, actor);
    if (recipe.publishedRevision !== null) after(async () => { await dispatchDiscoveryWorkflows({ recipeId: id }); });
    return adminResponse({ recipe });
  } catch (error) { return adminFailure(error); }
}
