import { TrendsDashboard } from '@/components/admin/TrendsDashboard';
import { pageAdmin } from '@/server/auth-page';

export default async function TrendRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await pageAdmin();
  const { id } = await params;
  return <TrendsDashboard runId={id} canManage={user.role === 'owner'} />;
}
