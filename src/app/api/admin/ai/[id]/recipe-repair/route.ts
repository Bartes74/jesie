import { adminActor, adminResponse, readJson } from '@/server/http/admin';
import { aiFailure } from '@/server/http/ai';
import { manualRecipeRepairInput, recipeManualRepairView, saveManualRecipeRepair } from '@/server/ai/recipe-manual-repair';
import { recheckRecipeResult } from '@/server/ai/recipe-recovery-dispatch';
import { AiError } from '@/server/ai/errors';

export const runtime = 'nodejs';
export const maxDuration = 180;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await adminActor(request);
    const { id } = await context.params;
    const view = await recipeManualRepairView(id);
    return adminResponse({ jobId: view.jobId, recipeId: view.recipeId, expectedRevision: view.expectedRevision, version: view.version,
      proposal: view.proposal, reviewedIngredients: view.reviewedIngredients, reason: view.reason, evidenceUrls: view.evidenceUrls, canEdit: view.canEdit, issues: view.issues });
  } catch (error) { return aiFailure(error); }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await adminActor(request, true);
    const { id } = await context.params;
    const input = manualRecipeRepairInput.parse(await readJson(request));
    const saved = await saveManualRecipeRepair(id, input, actor);
    try {
      return adminResponse({ ...saved, job: await recheckRecipeResult(id, actor) }, 202);
    } catch (error) {
      // A dispatch outage must not hide the successfully saved correction.
      return adminResponse({ ...saved, recoveryPending: true, message: error instanceof AiError ? error.message
        : 'Korekta jest zapisana. Ponów wznowienie sprawdzania zachowanego wyniku.' }, 202);
    }
  } catch (error) { return aiFailure(error); }
}
