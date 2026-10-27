"use client";

import Link from "next/link";
import { ChefHat, ClipboardList, CookingPot, Heart } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import type { Locale } from "@/lib/recipes";
import { useLocalStorage, useSavedRecipes } from "@/lib/browser-storage";
import { EMPTY_MEAL_PLAN, isMealPlan, MEAL_PLAN_STORAGE_KEY } from '@/lib/meal-plan';
import { SectionLink, useSectionNavigation } from './SectionLink';
import './kitchen.css';
import './collections.css';

export function SiteHeader({ locale, alternateHref, preserveCollectionFilters = false }: { locale: Locale; alternateHref?: string; preserveCollectionFilters?: boolean }) {
  useSectionNavigation();
  const pathname = usePathname();
  const { savedIds } = useSavedRecipes();
  const [plan] = useLocalStorage(MEAL_PLAN_STORAGE_KEY, EMPTY_MEAL_PLAN, isMealPlan);
  const other = locale === "pl" ? "en" : "pl";
  const languageHref = alternateHref ?? `/${other}`;
  return <header className="site-header page-width">
    <Link href={`/${locale}`} className="wordmark" aria-label={locale === "pl" ? "jesie.pl — strona główna" : "jesie.pl — home"}>
      <CookingPot aria-hidden="true" strokeWidth={1.4} /> <span>jesie<span className="brand-dot">.</span>pl</span>
    </Link>
    <nav aria-label={locale === "pl" ? "Nawigacja główna" : "Main navigation"}>
      <SectionLink href={`/${locale}#recipes`} className="nav-recipes">{locale === "pl" ? "Przepisy" : "Recipes"}</SectionLink>
      <Link href={`/${locale}/kolekcje`} className="nav-collections" aria-current={pathname.startsWith(`/${locale}/kolekcje`) ? 'page' : undefined}>{locale === 'pl' ? 'Kolekcje' : 'Collections'}</Link>
      <SectionLink href={`/${locale}#my-kitchen`} className="nav-kitchen" aria-label={locale === 'pl' ? 'Moja kuchnia' : 'My kitchen'} title={locale === 'pl' ? 'Moja kuchnia' : 'My kitchen'}><ChefHat size={18} aria-hidden="true" /><span>{locale === 'pl' ? 'Moja kuchnia' : 'My kitchen'}</span></SectionLink>
      <Link href={`/${locale}/plan`} className="nav-plan" aria-label={`${locale === 'pl' ? 'Plan posiłków i zakupy' : 'Meal plan and shopping'} (${plan.meals.length}/3)`} title={locale === 'pl' ? 'Plan i zakupy' : 'Plan and shopping'}><ClipboardList size={18} aria-hidden="true" /><span className="nav-plan-label-desktop">{locale === 'pl' ? 'Plan i zakupy' : 'Plan & shopping'}</span><span className="nav-plan-label-mobile">Plan</span><small>{plan.meals.length}/3</small></Link>
      <SectionLink href={`/${locale}?saved=1#recipes`} className="nav-saved" aria-label={`${locale === "pl" ? "Ulubione przepisy" : "Saved recipes"}${savedIds.length ? ` (${savedIds.length})` : ""}`}><Heart size={17} strokeWidth={1.6} aria-hidden="true" /><span>{locale === "pl" ? "Ulubione" : "Saved"}</span>{savedIds.length > 0 && <small>{savedIds.length}</small>}</SectionLink>
      <Suspense fallback={<LanguageLinks locale={locale} href={languageHref} />}><LanguageSwitch locale={locale} alternateHref={alternateHref} preserveCollectionFilters={preserveCollectionFilters} /></Suspense>
    </nav>
  </header>;
}

function LanguageSwitch({ locale, alternateHref, preserveCollectionFilters }: { locale: Locale; alternateHref?: string; preserveCollectionFilters?: boolean }) {
  const params = useSearchParams();
  const other = locale === "pl" ? "en" : "pl";
  const collectionFilters = new URLSearchParams();
  if (preserveCollectionFilters) for (const key of ['q', 'category', 'diet', 'time', 'difficulty', 'sort', 'saved', 'selected']) { const value = params.get(key); if (value) collectionFilters.set(key, value); }
  const href = alternateHref ? `${alternateHref}${collectionFilters.size ? `?${collectionFilters}#recipes` : ''}` : `/${other}${params.size ? `?${params.toString()}#recipes` : ""}`;
  return <LanguageLinks locale={locale} href={href} />;
}
function LanguageLinks({ locale, href }: { locale: Locale; href: string }) {
  const other = locale === "pl" ? "en" : "pl";
  return <div className="language-switch" aria-label={locale === "pl" ? "Język" : "Language"}><span aria-current="true">{locale.toUpperCase()}</span><span aria-hidden="true">/</span><Link href={href} lang={other} aria-label={other === "pl" ? "Przełącz na polski" : "Switch to English"}>{other.toUpperCase()}</Link></div>;
}

export function SiteFooter({ locale }: { locale: Locale }) {
  return <footer className="site-footer page-width">
    <Link href={`/${locale}`} className="footer-brand"><CookingPot size={23} strokeWidth={1.4} aria-hidden="true" /> jesie.pl</Link>
    <p>{locale === "pl" ? "Trochę inspiracji. Dużo przyjemności z gotowania." : "A little inspiration. A lot of joy in cooking."}</p>
    <nav className="footer-links" aria-label={locale === 'pl' ? 'Więcej w serwisie' : 'More on this site'}><Link href={`/${locale}/kolekcje`}>{locale === 'pl' ? 'Kolekcje' : 'Collections'}</Link><Link href={`/${locale}/poradniki`}>{locale === 'pl' ? 'Poradniki' : 'Guides'}</Link><Link href={`/${locale}/o-serwisie`}>{locale === 'pl' ? 'O serwisie' : 'About'}</Link></nav>
  </footer>;
}
