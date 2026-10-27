import { after } from 'next/server';
import { z } from 'zod';
import { adminActor, adminResponse, readJson } from '@/server/http/admin';
import { collectionFailure } from '@/server/collections/errors';
import { resumeThemeGeneration } from '@/server/collections/theme-store';
import { dispatchThemeGeneration } from '@/server/collections/theme-dispatch';
export const runtime = 'nodejs';
export const maxDuration = 60;
const inputSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();
export async function POST(request: Request, { params }: { params: Promise<{ id: string; generationId: string }> }) {
  try {
    const actor = await adminActor(request, true); const { id, generationId } = await params;
    const input = inputSchema.parse(await readJson(request));
    const generation = await resumeThemeGeneration(id, generationId, input.expectedRevision, actor);
    after(async () => { await dispatchThemeGeneration(generation.id); });
    return adminResponse({ generation }, 202);
  } catch (error) { return collectionFailure(error); }
}
