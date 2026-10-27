import { adminActor, adminResponse, readJson } from '@/server/http/admin';
import { getCollection, saveCollection } from '@/server/collections/store';
import { collectionFailure } from '@/server/collections/errors';
import { saveCollectionInput } from '@/server/collections/validation';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Context) {
  try { await adminActor(request); return adminResponse({ collection: await getCollection((await params).id) }); }
  catch (error) { return collectionFailure(error); }
}
export async function PATCH(request: Request, { params }: Context) {
  try {
    const actor = await adminActor(request, true);
    const input = saveCollectionInput.parse(await readJson(request));
    return adminResponse({ collection: await saveCollection((await params).id, input, actor) });
  } catch (error) { return collectionFailure(error); }
}
