import { redirect } from 'next/navigation';
import { pageAdmin } from '@/server/auth-page';

export default async function TrendsPage() {
  await pageAdmin();
  redirect('/admin/automation');
}
