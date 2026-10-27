import { adminActor, adminResponse, readJson } from '@/server/http/admin';
import { trendFailure, trendStartInput, trendSettingsInput } from '@/server/trends/http';
import { getTrendDashboard, admitTrendRun, updateTrendSettings } from '@/server/trends/store';
import { dispatchAdmittedPreparation, dispatchPublicationTimer } from '@/server/trends/daily-dispatch';
export const runtime = 'nodejs';
export async function GET(request: Request) { try {
    const actor = await adminActor(request);
    return adminResponse(await getTrendDashboard(actor));
}
catch (error) {
    return trendFailure(error);
} }
export async function PATCH(request: Request) { try {
    const actor = await adminActor(request, true);
    const input = trendSettingsInput.parse(await readJson(request));
    const settings = await updateTrendSettings(input.enabled, actor, input.acknowledgeAutoPause, input.expectedAutoPauseToken, input.monthlyLimitUsd);
    const timer = input.enabled ? await dispatchPublicationTimer() : null;
    return adminResponse({ settings, timer });
}
catch (error) {
    return trendFailure(error);
} }
export async function POST(request: Request) { try {
    const actor = await adminActor(request, true);
    const input = trendStartInput.parse(await readJson(request));
    const admitted = await admitTrendRun(input.action === 'run' ? 'daily' : 'control', actor, new Date(), input.action === 'control', input.action === 'manual' ? input.requestKey : undefined);
    if ('skipped' in admitted)
        return adminResponse(admitted);
    const detail = await dispatchAdmittedPreparation(admitted);
    const timer = input.action === 'run' ? await dispatchPublicationTimer() : null;
    return adminResponse({ run: detail.run, created: admitted.created, restarted: admitted.restarted, timer }, 202);
}
catch (error) {
    return trendFailure(error);
} }
