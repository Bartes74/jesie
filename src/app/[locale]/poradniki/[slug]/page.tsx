import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { SiteHeader, SiteFooter } from '@/components/SiteHeader';
import { JsonLd } from '@/components/JsonLd';
import { RecipeGrid } from '@/components/RecipeGrid';
import { getGuideHref, guides } from '@/lib/content-hubs';
import { getOptionalCollections } from '@/server/public/collections';
import { absoluteUrl, organizationStructuredData, pageMetadata } from '@/lib/seo';
import { publicRecipes } from '@/server/public/recipes';
import { getRecipeImageVariants } from '@/lib/recipe-image-variants';
import type { Locale } from '@/lib/recipes';
export const dynamic = 'force-dynamic';
type Props = { params: Promise<{ locale: string; slug: string }> };
async function guideFor(params: Props['params']) {
  const { locale, slug } = await params;
  if (locale !== 'pl' && locale !== 'en') notFound();
  const guide = guides.find(item => item.slug[locale] === slug);
  if (!guide) notFound();
  return { locale: locale as Locale, guide };
}
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, guide } = await guideFor(params);
  return pageMetadata({ locale, title: guide.title[locale], description: guide.description[locale], path: getGuideHref(guide, locale), type: 'article', datePublished: guide.datePublished, dateModified: guide.dateModified, author: 'jesie.pl', languages: { pl: getGuideHref(guide, 'pl'), 'en-GB': getGuideHref(guide, 'en') } });
}
export default async function GuidePage({ params }: Props) {
  const { locale, guide } = await guideFor(params);
  const recipes = await publicRecipes();
  const collections = (await getOptionalCollections(recipes, locale)).filter(item => guide.collectionIds.includes(item.id));
  const matching = recipes.filter(recipe => recipe.times.total <= 30 && ['main', 'lunch', 'soup', 'dinner'].includes(recipe.primaryCategory)).slice(0, 3);
  const url = absoluteUrl(getGuideHref(guide, locale));
  const date = new Intl.DateTimeFormat(locale === 'pl' ? 'pl-PL' : 'en-GB', { dateStyle: 'long', timeZone: 'Europe/Warsaw' }).format(new Date(guide.datePublished));
  return <><SiteHeader locale={locale} alternateHref={getGuideHref(guide, locale === 'pl' ? 'en' : 'pl')} /><main id="main" className="hub-page page-width">
    <nav className="content-breadcrumb" aria-label={locale === 'pl' ? 'Ścieżka strony' : 'Breadcrumb'}><Link href={`/${locale}`}>jesie.pl</Link><span aria-hidden="true"> / </span><Link href={`/${locale}/poradniki`}>{locale === 'pl' ? 'Poradniki' : 'Guides'}</Link></nav>
    <article className="guide-article"><header className="hub-heading"><p className="eyebrow">{locale === 'pl' ? 'PORADNIK' : 'GUIDE'}</p><h1>{guide.title[locale]}</h1><p>{guide.description[locale]}</p><div className="publication-byline">{locale === 'pl' ? 'Opracowanie' : 'Editorial'}: <Link href={`/${locale}/o-serwisie`}>jesie.pl</Link> · <time dateTime={guide.datePublished}>{date}</time></div></header>{guide.sections.map(section => <section key={section.heading.pl}><h2>{section.heading[locale]}</h2>{section.paragraphs[locale].map(paragraph => <p key={paragraph}>{paragraph}</p>)}</section>)}</article>
    {collections.length > 0 && <section className="guide-collections"><h2>{locale === 'pl' ? 'Wybierz kolekcję' : 'Choose a collection'}</h2><ul>{collections.map(item => <li key={item.id}><Link href={item.path}>{item.title[locale]}</Link></li>)}</ul></section>}
    {matching.length > 0 && <section className="guide-recipes"><h2>{locale === 'pl' ? 'Pomysły na szybki obiad' : 'Quick dinner ideas'}</h2><RecipeGrid recipes={matching} locale={locale} /></section>}
    <Link href={`/${locale}#recipes`}>{locale === 'pl' ? 'Znajdź swój przepis →' : 'Find your recipe →'}</Link>
  </main><SiteFooter locale={locale} /><JsonLd data={{ '@context': 'https://schema.org', '@graph': [organizationStructuredData(),
    { '@type': 'Article', '@id': `${url}#article`, url, mainEntityOfPage: url, headline: guide.title[locale], description: guide.description[locale], inLanguage: locale === 'pl' ? 'pl' : 'en-GB', datePublished: guide.datePublished, dateModified: guide.dateModified, author: { '@id': `${absoluteUrl('/')}#organization` }, publisher: { '@id': `${absoluteUrl('/')}#organization` }, ...(matching[0] ? { image: absoluteUrl(getRecipeImageVariants(matching[0]).landscape.url) } : {}) },
    { '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'jesie.pl', item: absoluteUrl(`/${locale}`) }, { '@type': 'ListItem', position: 2, name: locale === 'pl' ? 'Poradniki' : 'Guides', item: absoluteUrl(`/${locale}/poradniki`) }, { '@type': 'ListItem', position: 3, name: guide.title[locale], item: url }] },
  ] }} /></>;
}
