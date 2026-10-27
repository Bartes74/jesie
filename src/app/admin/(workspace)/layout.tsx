import { redirect } from 'next/navigation';
import { getAdminSession } from '@/server/auth';
import { AdminShell } from '@/components/admin/AdminShell';
export const dynamic = 'force-dynamic';

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const session = await getAdminSession();
  if (!session) redirect('/admin/login');
  return <AdminShell user={session.user}>{children}</AdminShell>;
}
