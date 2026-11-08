import { pageAdmin } from '@/server/auth-page';
import { RecipeRecoveryEditor } from '@/components/admin/RecipeRecoveryEditor';

export default async function RecipeRepairPage({ params }: { params: Promise<{ id: string }> }) {
  await pageAdmin();
  const { id } = await params;
  return <RecipeRecoveryEditor key={id} jobId={id} />;
}
