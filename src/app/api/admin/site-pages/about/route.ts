import { adminActor, adminResponse, readJson } from '@/server/http/admin';
import { getAboutPage, saveAboutPage, saveAboutPageInput, sitePageFailure } from '@/server/site-pages';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  try { await adminActor(request); return adminResponse({ page: await getAboutPage() }); }
  catch (error) { return sitePageFailure(error); }
}
export async function PATCH(request: Request) {
  try {
    const actor = await adminActor(request, true);
    return adminResponse({ page: await saveAboutPage(saveAboutPageInput.parse(await readJson(request)), actor) });
  } catch (error) { return sitePageFailure(error); }
}
