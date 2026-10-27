import { pageAdmin } from '@/server/auth-page';
import { getRecipe } from '@/server/editorial/store';
import { getMediaLibrary } from '@/server/admin/media-library';
import { MediaLibrary } from '@/components/admin/MediaLibrary';
import type { LibraryTarget } from '@/lib/media-library';
export default async function LibraryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await pageAdmin();
  const params = await searchParams;
  const target: LibraryTarget | undefined = typeof params.recipeId === 'string' && (params.kind === 'hero' || params.kind === 'ingredient' || params.kind === 'step') ? { recipeId: params.recipeId, kind: params.kind, ...(typeof params.targetId === 'string' ? { targetId: params.targetId } : {}) } : undefined;
  const [images, recipe] = await Promise.all([getMediaLibrary(target), target ? getRecipe(target.recipeId) : null]);
  return <><div className="admin-page-heading"><div><h1>Biblioteka zdjęć</h1><p>Znajdź zapisane zdjęcie, sprawdź jego pochodzenie i wykorzystaj je ponownie.</p></div></div><MediaLibrary images={images} target={target} revision={recipe?.revision} /></>;
}
