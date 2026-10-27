import { AiJobDetail } from '@/components/admin/AiJobDetail';
import { pageAdmin } from '@/server/auth-page';

export default async function AiJobPage({ params }: { params: Promise<{ id: string }> }) {
  await pageAdmin();
  const { id } = await params;
  return <AiJobDetail key={id} jobId={id} />;
}
