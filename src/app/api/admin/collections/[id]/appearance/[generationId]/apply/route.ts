import { z } from 'zod';
import { adminActor, adminResponse, readJson } from '@/server/http/admin';
import { collectionFailure } from '@/server/collections/errors';
import { applyThemeGeneration } from '@/server/collections/theme-store';
export const runtime = 'nodejs';
const inputSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();
export async function POST(request: Request, { params }: { params: Promise<{ id: string; generationId: string }> }) {
  try {
    const actor = await adminActor(request, true); const { id, generationId } = await params;
    const input = inputSchema.parse(await readJson(request));
    return adminResponse({ collection: await applyThemeGeneration(id, generationId, input.expectedRevision, actor) });
  } catch (error) { return collectionFailure(error); }
}
