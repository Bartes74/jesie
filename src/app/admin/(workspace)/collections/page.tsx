import { pageAdmin } from '@/server/auth-page';
import { listCollections } from '@/server/collections/store';
import { CollectionsList } from '@/components/admin/CollectionsList';

export default async function CollectionsPage({ searchParams }: { searchParams: Promise<{ recipe?: string }> }) {
  await pageAdmin();
  const [{ recipe }, collections] = await Promise.all([searchParams, listCollections()]);
  return <CollectionsList collections={collections} recipeId={recipe} />;
}
