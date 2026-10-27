import { AiStudio } from '@/components/admin/AiStudio';
import { pageAdmin } from '@/server/auth-page';

export default async function AiPage({ searchParams }: { searchParams: Promise<{ recipe?: string | string[] }> }) {
  await pageAdmin();
  const { recipe } = await searchParams;
  return <AiStudio key={typeof recipe === 'string' ? recipe : ''} initialRecipeId={typeof recipe === 'string' ? recipe : ''} />;
}
