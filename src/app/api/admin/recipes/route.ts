import { listRecipes, createRecipe } from '@/server/editorial/store';
import { adminActor, adminResponse, adminFailure, readJson, createInput } from '@/server/http/admin';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  try { await adminActor(request); return adminResponse({ recipes: await listRecipes() }); }
  catch (error) { return adminFailure(error); }
}
export async function POST(request: Request) {
  try { const actor = await adminActor(request, true); const input = createInput.parse(await readJson(request)); const result = await createRecipe(input, actor); return adminResponse({ id: result.id }, 201); }
  catch (error) { return adminFailure(error); }
}
