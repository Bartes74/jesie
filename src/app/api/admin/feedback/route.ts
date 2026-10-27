import { z } from 'zod';
import { adminActor, adminFailure, adminResponse, readJson } from '@/server/http/admin';
import { getReaderFeedback, resolveReaderFeedback } from '@/server/reader-feedback';
export async function GET(request: Request) {
  try { await adminActor(request); return adminResponse(await getReaderFeedback()); } catch (error) { return adminFailure(error); }
}
export async function PATCH(request: Request) {
  try { const actor = await adminActor(request, true); const { id } = z.object({ id: z.string().uuid() }).strict().parse(await readJson(request)); await resolveReaderFeedback(id, actor.id); return adminResponse({ resolved: true }); } catch (error) { return adminFailure(error); }
}
