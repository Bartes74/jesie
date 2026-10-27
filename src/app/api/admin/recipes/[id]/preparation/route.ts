import { adminActor, adminResponse, readJson } from '@/server/http/admin';
import { aiFailure } from '@/server/http/ai';
import { preparationInput, prepareRecipe, recipePreparation } from '@/server/editorial/preparation';

export const runtime = 'nodejs';
export const maxDuration = 180;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await adminActor(request);
    const { id } = await context.params;
    return adminResponse(await recipePreparation(id));
  } catch (error) { return aiFailure(error); }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await adminActor(request, true);
    const { id } = await context.params;
    const input = preparationInput.parse(await readJson(request));
    return adminResponse(await prepareRecipe(id, input, actor));
  } catch (error) { return aiFailure(error); }
}
