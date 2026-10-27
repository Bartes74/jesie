import { pageAdmin } from '@/server/auth-page';
import { getDailyAutomationDashboard } from '@/server/trends/automated-publication';
import { DailyAutomationPanel } from '@/components/admin/DailyAutomationPanel';

export default async function AutomationPage() {
  const session = await pageAdmin();
  const automation = await getDailyAutomationDashboard({ id: session.user.id, name: session.user.name, email: session.user.email, role: session.user.role as 'owner' | 'admin' });
  return <><div className="admin-page-heading"><div><h1>Codzienne inspiracje</h1><p>Codzienny szkic do oceny. Ty decydujesz o zdjęciach i ręcznej publikacji.</p></div></div><DailyAutomationPanel initial={automation} owner={session.user.role === 'owner'} /></>;
}
