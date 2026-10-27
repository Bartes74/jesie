import { performRecipeAction } from '@/server/editorial/store';
import { after } from 'next/server';
import { dispatchDiscoveryWorkflows } from '@/server/seo/dispatch';
import { adminActor, adminResponse, adminFailure, readJson, actionInput } from '@/server/http/admin';

export const runtime = 'nodejs';
export const maxDuration = 300;
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await adminActor(request, true); const { id } = await params;
    const input = actionInput.parse(await readJson(request));
    const result = await performRecipeAction(id, input, actor);
    if (['publish', 'approve_and_publish', 'unpublish', 'archive'].includes(input.action)) after(async () => { await dispatchDiscoveryWorkflows({ recipeId: id }); });
    return adminResponse(input.action === 'duplicate' ? { id: result.id } : { recipe: result });
  } catch (error) { return adminFailure(error); }
}
