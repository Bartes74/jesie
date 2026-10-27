import { z } from 'zod';
import { adminActor, adminFailure, adminResponse, readJson } from '@/server/http/admin';
import { getReviewedSchedule, updateReviewedSchedule } from '@/server/trends/publication';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try { await adminActor(request); return adminResponse({ schedule: await getReviewedSchedule() }); }
  catch (error) { return adminFailure(error); }
}

export async function PATCH(request: Request) {
  try {
    const actor = await adminActor(request, true);
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(await readJson(request));
    const schedule = await updateReviewedSchedule(enabled, actor);
    return adminResponse({ schedule, timerArmed: false });
  } catch (error) { return adminFailure(error); }
}
