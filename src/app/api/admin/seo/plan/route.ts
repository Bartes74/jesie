import { z } from 'zod';
import { adminActor, adminFailure, adminResponse, readJson } from '@/server/http/admin';
import { getPublicationPlan, removePublicationPlan, savePublicationPlan } from '@/server/trends/publication-plan';

export const runtime = 'nodejs';

const entry = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), recipeId: z.string().min(1).max(200), expectedRevision: z.number().int().positive() }).strict();
const input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save'), entries: z.array(entry).min(1).max(31) }).strict(),
  z.object({ action: z.literal('remove'), date: entry.shape.date }).strict(),
]);

export async function GET(request: Request) {
  try { await adminActor(request); return adminResponse({ plan: await getPublicationPlan() }); }
  catch (error) { return adminFailure(error); }
}

export async function POST(request: Request) {
  try {
    const actor = await adminActor(request, true);
    const body = input.parse(await readJson(request));
    const plan = body.action === 'save' ? await savePublicationPlan(body.entries, actor) : await removePublicationPlan(body.date, actor);
    return adminResponse({ plan, timerArmed: false });
  } catch (error) { return adminFailure(error); }
}
