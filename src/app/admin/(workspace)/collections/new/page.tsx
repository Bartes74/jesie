import { pageAdmin } from '@/server/auth-page';
import { NewCollectionForm } from '@/components/admin/CollectionsList';

export default async function NewCollectionPage() {
  await pageAdmin();
  return <NewCollectionForm />;
}
