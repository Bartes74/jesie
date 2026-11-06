import { adminActor, adminResponse, readJson } from '@/server/http/admin';
import { aiFailure } from '@/server/http/ai';
import { attachRecipeReceipt, recipeReceiptInput } from '@/server/ai/recipe-receipt-recovery';
import { recheckRecipeResult } from '@/server/ai/recipe-recovery-dispatch';
import { AiError } from '@/server/ai/errors';

export const runtime = 'nodejs';
export const maxDuration = 180;
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await adminActor(request, true);
    const { id } = await context.params;
    await attachRecipeReceipt(id, recipeReceiptInput.parse(await readJson(request)), actor);
    try { return adminResponse({ job: await recheckRecipeResult(id, actor) }, 202); }
    catch (error) { return adminResponse({ recoveryPending: true, message: error instanceof AiError ? error.message
      : 'Potwierdzenie jest zapisane. Wróć do szkicu i ponów sprawdzanie istniejącego wyniku.' }, 202); }
  } catch (error) { return aiFailure(error); }
}
