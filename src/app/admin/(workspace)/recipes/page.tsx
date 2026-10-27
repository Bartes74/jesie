import { pageAdmin } from '@/server/auth-page';
import { listRecipes } from '@/server/editorial/store';
import { RecipeList } from '@/components/admin/RecipeList';
import type { RecipeListFilter } from '@/lib/editorial-presentation';

export default async function RecipesPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  await pageAdmin();
  const { filter } = await searchParams;
  const selected: RecipeListFilter = filter === 'draft' || filter === 'published' || filter === 'archived' || filter === 'deleted' ? filter : 'all';
  return <RecipeList initialFilter={selected} initialRecipes={await listRecipes()} />;
}
