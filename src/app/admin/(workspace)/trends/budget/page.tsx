import { TrendsDashboard } from '@/components/admin/TrendsDashboard';
import { pageAdmin } from '@/server/auth-page';

export default async function TrendBudgetPage() {
  const { user } = await pageAdmin();
  return <TrendsDashboard budgetOnly canManage={user.role === 'owner'} />;
}
