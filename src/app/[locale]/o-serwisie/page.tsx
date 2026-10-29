import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { cache } from 'react';
import { SiteHeader, SiteFooter } from '@/components/SiteHeader';
import { pageMetadata } from '@/lib/seo';
import type { Locale } from '@/lib/recipes';
import { aboutSections, defaultAboutPage } from '@/lib/about-page';
import { getAboutPage } from '@/server/site-pages';
export const dynamic = 'force-dynamic';
// ponytail: any read failure (unmigrated table, outage, quota) serves the built-in text; a static page should never error.
const aboutContent = cache(async () => {
  try { return (await getAboutPage())?.content ?? defaultAboutPage; }
  catch { console.error('About page content unavailable; serving built-in text.'); return defaultAboutPage; }
});
export async function generateMetadata({ params }: { params: Promise<{ locale: Locale }> }): Promise<Metadata> {
  const { locale } = await params;
  if (locale !== 'pl' && locale !== 'en') notFound();
  const { description } = (await aboutContent())[locale];
  return pageMetadata({ locale, title: locale === 'pl' ? 'O jesie.pl' : 'About jesie.pl', description, path: `/${locale}/o-serwisie`, languages: { pl: '/pl/o-serwisie', 'en-GB': '/en/o-serwisie' } });
}
export default async function AboutPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (locale !== 'pl' && locale !== 'en') notFound();
  const pl = locale === 'pl';
  const text = (await aboutContent())[locale];
  return <><SiteHeader locale={locale} alternateHref={`/${pl ? 'en' : 'pl'}/o-serwisie`} /><main id="main" className="hub-page page-width"><article className="guide-article"><header className="hub-heading"><p className="eyebrow">jesie.pl</p><h1>{text.heading}</h1>{text.lead && <p>{text.lead}</p>}</header>{aboutSections(text.body).map((section, index) => <section key={index}>{section.heading && <h2>{section.heading}</h2>}{section.paragraphs.map((paragraph, item) => <p key={item}>{paragraph}</p>)}</section>)}<Link href={`/${locale}#recipes`}>{pl ? 'Przejdź do przepisów →' : 'Browse recipes →'}</Link></article></main><SiteFooter locale={locale} /></>;
}
