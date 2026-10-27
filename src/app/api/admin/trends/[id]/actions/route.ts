import { start } from 'workflow/api';
import { dailyTrends } from '@/workflows/trends';
import { adminActor, adminResponse, readJson } from '@/server/http/admin';
import { actOnTrendRun, reverifyTrendSearch, prepareTrendInspiration, attachTrendWorkflow, failTrendRun, getTrendExecution } from '@/server/trends/store';
import { trendActionInput, trendFailure } from '@/server/trends/http';
export const runtime = 'nodejs';
export async function POST(request: Request, { params }: {
    params: Promise<{
        id: string;
    }>;
}) { try {
    const actor = await adminActor(request, true);
    const id = (await params).id;
    const input = trendActionInput.parse(await readJson(request));
    const result = input.action === 'prepare_inspiration'
        ? await prepareTrendInspiration(id, input.candidateId, actor)
        : input.action === 'reverify' ? await reverifyTrendSearch(id, actor) : await actOnTrendRun(id, input, actor);
    if (result.resume) {
        const generation = 'generation' in result && typeof result.generation === 'number' ? result.generation : (await getTrendExecution(id)).generation;
        try {
            const workflow = await start(dailyTrends, [id, generation], { region: 'fra1' });
            await attachTrendWorkflow(id, workflow.runId, generation);
        }
        catch {
            await failTrendRun(id, 'Nie potwierdzono wznowienia przebiegu. Sprawdź zachowane zlecenia.', true, generation);
        }
    }
    return adminResponse(result);
}
catch (error) {
    return trendFailure(error);
} }
