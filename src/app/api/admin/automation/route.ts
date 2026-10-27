import { adminActor, adminResponse, readJson } from '@/server/http/admin';
import { getDailyAutomationDashboard } from '@/server/trends/automated-publication';
import { updateTrendSettings } from '@/server/trends/store';
import { dispatchPublicationTimer } from '@/server/trends/daily-dispatch';
import { trendFailure } from '@/server/trends/http';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  try { return adminResponse({ automation: await getDailyAutomationDashboard(await adminActor(request)) }); }
  catch (error) { return trendFailure(error); }
}
export async function PATCH(request: Request) {
  try {
    const actor = await adminActor(request, true);
    const input = await readJson(request) as { enabled?: unknown; expectedAutoPauseToken?: unknown };
    if (!input || typeof input.enabled !== 'boolean') return adminResponse({ error: 'Wybierz stan automatu.' }, 422);
    const pauseToken = typeof input.expectedAutoPauseToken === 'string' ? input.expectedAutoPauseToken : undefined;
    await updateTrendSettings(input.enabled, actor, Boolean(pauseToken), pauseToken);
    let timerArmed = false;
    if (input.enabled) {
      try { const timer = await dispatchPublicationTimer(); timerArmed = !('skipped' in timer); }
      catch { console.error('Daily automation timer will be recovered by cron.'); }
    }
    return adminResponse({ automation: await getDailyAutomationDashboard(actor), timerArmed });
  } catch (error) { return trendFailure(error); }
}
