import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { pageAdmin } from '@/server/auth-page';
import { pageRecipe } from '@/server/editorial/page-recipe';
import { RecipeEditor } from '@/components/admin/RecipeEditor';
import { GuidedRecipeEditor } from '@/components/admin/GuidedRecipeEditor';
import { listRecipes } from '@/server/editorial/store';

export default async function EditorPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ advanced?: string; generate?: string }> }) {
  await pageAdmin();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const recipe = await pageRecipe(id);
  if (query.advanced === '1') return <><Link className="admin-text-link" href={`/admin/recipes/${encodeURIComponent(id)}`}><ArrowLeft size={16} />Wróć do treści, zdjęć i publikacji</Link><RecipeEditor key={recipe.id} initialRecipe={recipe} recipes={await listRecipes()} /></>;
  return <GuidedRecipeEditor key={recipe.id} initialRecipe={recipe} autoGenerate={query.generate === '1'} />;
}
