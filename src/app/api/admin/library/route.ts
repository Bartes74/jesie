import { z } from 'zod';
import { adminActor, adminFailure, adminResponse, readJson } from '@/server/http/admin';
import { getMediaLibrary, reuseLibraryImage } from '@/server/admin/media-library';
const target = z.object({ recipeId: z.string().min(1).max(200), kind: z.enum(['hero', 'ingredient', 'step']), targetId: z.string().min(1).max(200).optional() });
export async function GET(request: Request) {
  try { await adminActor(request); const params = Object.fromEntries(new URL(request.url).searchParams); return adminResponse({ images: await getMediaLibrary(params.recipeId ? target.parse(params) : undefined) }); } catch (error) { return adminFailure(error); }
}
export async function POST(request: Request) {
  try { const actor = await adminActor(request, true); const input = target.extend({ imageId: z.string().min(1).max(500), expectedRevision: z.number().int().positive() }).strict().parse(await readJson(request)); return adminResponse({ recipe: await reuseLibraryImage(input, actor) }); } catch (error) { return adminFailure(error); }
}
