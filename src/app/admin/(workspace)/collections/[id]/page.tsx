import { notFound } from 'next/navigation';
import { pageAdmin } from '@/server/auth-page';
import { getCollection } from '@/server/collections/store';
import { getPublishedRecipes } from '@/server/editorial/store';
import { CollectionsEditor } from '@/components/admin/CollectionsEditor';
import { CollectionError } from '@/server/collections/errors';

export default async function EditCollectionPage({ params }: { params: Promise<{ id: string }> }) {
  await pageAdmin();
  const { id } = await params;
  const [collection, recipes] = await Promise.all([getCollection(id).catch(error => { if (error instanceof CollectionError && error.status === 404) notFound(); throw error; }), getPublishedRecipes()]);
  if (!collection) notFound();
  return <CollectionsEditor key={collection.id} initialCollection={collection} recipes={recipes.map(({ id, title, image, primaryCategory, times }) => ({ id, title, image, primaryCategory, times }))} />;
}
