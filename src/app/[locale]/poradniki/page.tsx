import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { SiteHeader, SiteFooter } from '@/components/SiteHeader';
import { getGuideHref, guides } from '@/lib/content-hubs';
import { pageMetadata } from '@/lib/seo';
import type { Locale } from '@/lib/recipes';
export async function generateMetadata({ params }: { params: Promise<{ locale: Locale }> }): Promise<Metadata> {
  const { locale } = await params;
  return pageMetadata({ locale, title: locale === 'pl' ? 'Poradniki do codziennego gotowania' : 'Everyday cooking guides', description: locale === 'pl' ? 'Jak dobrać przepis do składników, przeliczyć porcje i wygodnie gotować z jesie.pl.' : 'How to choose a recipe by ingredients, adjust servings and cook comfortably with jesie.pl.', path: `/${locale}/poradniki`, languages: { pl: '/pl/poradniki', 'en-GB': '/en/poradniki' } });
}
export default async function GuidesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (locale !== 'pl' && locale !== 'en') notFound();
  return <><SiteHeader locale={locale} alternateHref={`/${locale === 'pl' ? 'en' : 'pl'}/poradniki`} /><main id="main" className="hub-page page-width"><header className="hub-heading"><h1>{locale === 'pl' ? 'Pomoc w codziennym gotowaniu' : 'Help with everyday cooking'}</h1><p>{locale === 'pl' ? 'Praktyczne wskazówki do korzystania z przepisów.' : 'Practical advice for using recipes.'}</p></header><div className="content-hub-grid">{guides.map(guide => <Link key={guide.slug.pl} href={getGuideHref(guide, locale)}><h2>{guide.title[locale]}</h2><p>{guide.description[locale]}</p></Link>)}</div></main><SiteFooter locale={locale} /></>;
}
