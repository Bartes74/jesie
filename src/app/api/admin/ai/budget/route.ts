import { getAiBudgetSettings, updateAiBudgetInput, updateAiBudgetSettings } from '@/server/ai/budget-settings';
import { adminActor, adminResponse, readJson } from '@/server/http/admin';
import { aiFailure } from '@/server/http/ai';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  try { return adminResponse(await getAiBudgetSettings(await adminActor(request))); }
  catch (error) { return aiFailure(error); }
}
export async function PATCH(request: Request) {
  try {
    const actor = await adminActor(request, true);
    return adminResponse(await updateAiBudgetSettings(updateAiBudgetInput.parse(await readJson(request)), actor));
  } catch (error) { return aiFailure(error); }
}
