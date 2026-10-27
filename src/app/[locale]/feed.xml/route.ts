import { publicRecipes } from '@/server/public/recipes';
import { PUBLIC_SITE_URL, buildRecipeFeed, isProductionIndexable } from '@/lib/seo';
import { getGuideHref, guides } from '@/lib/content-hubs';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (locale !== 'pl' && locale !== 'en') return new Response('Not found', { status: 404 });
  const articles = guides.map(guide => ({ id: `${PUBLIC_SITE_URL}/#guide-${guide.slug.pl}-${locale}`, path: getGuideHref(guide, locale), title: guide.title[locale], description: guide.description[locale], datePublished: guide.datePublished, dateModified: guide.dateModified }));
  return new Response(buildRecipeFeed(await publicRecipes(), locale, articles), {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': isProductionIndexable() ? 'public, max-age=0, must-revalidate' : 'private, no-store',
      'X-Robots-Tag': isProductionIndexable() ? 'noindex, follow' : 'noindex, nofollow',
    },
  });
}
