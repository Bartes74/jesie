import Link from 'next/link';
import { pageAdmin } from '@/server/auth-page';
import { pageRecipe } from '@/server/editorial/page-recipe';
import { RecipeDetail } from '@/components/RecipeDetail';
import { SiteHeader, SiteFooter } from '@/components/SiteHeader';
import type { Locale } from '@/lib/recipes';
import { toPublicRecipe } from '@/lib/recipe-presentation';
import { isRecipeContentApproved } from '@/server/editorial/content-approval';
import { verifiedPublicationIssues } from '@/server/editorial/store';
import { getDb } from '@/server/db';
import { RecipePreviewReady } from '@/components/admin/RecipePreviewReady';
import { recipePreviewUrl, validPreviewReviewToken } from '@/lib/recipe-preview';
import type { Metadata } from 'next';
export const metadata: Metadata = { robots: { index: false, follow: false } };
export default async function PreviewPage({ params, searchParams }: { params: Promise<{ locale: Locale; id: string }>; searchParams: Promise<{ revision?: string; previewReview?: string }> }) {
  await pageAdmin(); const { locale, id } = await params; const record = await pageRecipe(id);
  const { revision, previewReview } = await searchParams;
  if (revision && revision !== String(record.revision)) return <main id="main" className="page-width" style={{ paddingBlock: 50 }}><h1>Przepis ma nowszą wersję</h1><p>Odśwież panel przed sprawdzeniem i zatwierdzeniem bieżącego przepisu.</p></main>;
  const content = structuredClone(record.content);
  const acceptsSubstitutions = content.recipe.substitutions?.some(item => item.status === 'to_review') && await isRecipeContentApproved(record);
  if (acceptsSubstitutions) for (const item of content.recipe.substitutions ?? []) item.status = 'approved';
  const issues = acceptsSubstitutions ? await verifiedPublicationIssues(content, getDb()) : record.issues;
  if (issues.length) return <main id="main" className="page-width" style={{ paddingBlock: 50 }}><h1>Uzupełnij szkic przed podglądem</h1><p>Podgląd korzysta z zapisanego przepisu.</p><ul>{issues.map((issue, index) => <li key={`${issue.field}:${index}`}>{issue.message}</li>)}</ul><Link className="primary-button" href={`/admin/recipes/${id}`}>Wróć do edycji</Link></main>;
  const recipe = toPublicRecipe({ ...content.recipe, photos: content.photos });
  const scope = validPreviewReviewToken(previewReview) ? { recipeId: record.id, revision: record.revision, token: previewReview } : null;
  return <div data-preview-recipe={record.id} data-preview-revision={record.revision} data-preview-locale={locale}><div className="preview-notice no-print" style={{ background: '#e9efdf', padding: '12px 24px', textAlign: 'center', fontSize: 13 }}>Prywatny podgląd szkicu v{record.revision} · <Link href={`/admin/recipes/${id}`}>Wróć do edytora</Link></div><SiteHeader locale={locale} alternateHref={recipePreviewUrl(record.id, record.revision, locale === 'pl' ? 'en' : 'pl', scope?.token)} /><RecipeDetail recipe={recipe} locale={locale} /><SiteFooter locale={locale} />{scope && <RecipePreviewReady scope={scope} locale={locale} />}</div>;
}
