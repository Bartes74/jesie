import type { Metadata } from "next";
import localFont from "next/font/local";
import { notFound } from "next/navigation";
import { PUBLIC_SITE_URL, publicRobots, isProductionIndexable } from '@/lib/seo';
import { UsageMetrics } from '@/components/UsageMetrics';
import "../globals.css";
import '@/components/content-hubs.css';
import '@/components/kitchen.css';
import '@/components/planning.css';
import '@/components/reader-feedback.css';

const lora = localFont({ src: [{ path: "../../fonts/lora.woff2", weight: "400 700" }, { path: "../../fonts/lora-latin-ext.woff2", weight: "400 700" }], variable: "--font-lora", display: "swap" });
const manrope = localFont({ src: [{ path: "../../fonts/manrope.woff2", weight: "200 800" }, { path: "../../fonts/manrope-latin-ext.woff2", weight: "200 800" }], variable: "--font-manrope", display: "swap" });

export const metadata: Metadata = {
  verification: { google: process.env.GOOGLE_SITE_VERIFICATION, other: process.env.BING_SITE_VERIFICATION ? { 'msvalidate.01': process.env.BING_SITE_VERIFICATION } : {} },
  metadataBase: new URL(PUBLIC_SITE_URL),
  title: { default: "jesie.pl — dobre jedzenie na co dzień", template: "%s | jesie.pl" },
  description: "Przepisy, do których chce się wracać. Wybierz coś dla siebie i gotuj po swojemu.",
  robots: publicRobots(),
};

export function generateStaticParams() { return [{ locale: "pl" }, { locale: "en" }]; }
export default async function LocaleLayout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (locale !== "pl" && locale !== "en") notFound();
  return <html lang={locale === 'en' ? 'en-GB' : 'pl'} className={`${lora.variable} ${manrope.variable}`}><body>
    <a className="skip-link" href="#main">{locale === "pl" ? "Przejdź do treści" : "Skip to content"}</a>
    {children}
    <UsageMetrics enabled={isProductionIndexable()} />
  </body></html>;
}
