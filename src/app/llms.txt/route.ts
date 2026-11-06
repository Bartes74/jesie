import { publicRecipes } from '@/server/public/recipes';
import { getOptionalCollections } from '@/server/public/collections';
import { getGuideHref, guides } from '@/lib/content-hubs';
import { buildLlmsText, isProductionIndexable, PUBLIC_LOCALES, type LlmsLink } from '@/lib/seo';
import type { Locale } from '@/lib/recipes';
import { defaultAboutPage } from '@/lib/about-page';
import { getAboutPage } from '@/server/site-pages';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (!isProductionIndexable()) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
  const recipes = await publicRecipes();
  const entries = await Promise.all(PUBLIC_LOCALES.map(async locale => [locale, {
    collections: (await getOptionalCollections(recipes, locale)).map(collection => ({ path: collection.path, title: collection.title[locale], description: collection.description[locale] })),
    guides: guides.map(guide => ({ path: getGuideHref(guide, locale), title: guide.title[locale], description: guide.description[locale] })),
  }] as const));
  const sections = Object.fromEntries(entries) as Record<Locale, { collections: LlmsLink[]; guides: LlmsLink[] }>;
  // The summary is the editor-maintained About description; the built-in text covers any read failure, as on the About page.
  const about = await getAboutPage().then(page => page?.content ?? defaultAboutPage, () => defaultAboutPage);
  return new Response(buildLlmsText(recipes, sections, { pl: about.pl.description, en: about.en.description }), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=0, must-revalidate', 'X-Robots-Tag': 'noindex, follow' },
  });
}
