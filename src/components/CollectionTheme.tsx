import type { CSSProperties, ReactNode } from 'react';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import type { CollectionTheme, PublicCollection } from '@/lib/collections';
import type { Locale } from '@/lib/recipes';
import { MediaImage } from './MediaImage';
import './collections.css';

export function collectionThemeStyle(theme: CollectionTheme | null): CSSProperties | undefined {
  if (!theme) return undefined;
  const values = Object.fromEntries(Object.entries(theme.palette).map(([key, value]) => [`--collection-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, value]));
  return { ...values, '--collection-decoration-opacity': theme.decorationOpacity } as CSSProperties;
}

export function CollectionThemeSurface({ theme, children, className = '' }: { theme: CollectionTheme | null; children: ReactNode; className?: string }) {
  return <div className={`collection-theme ${className}`} style={collectionThemeStyle(theme)}>
    {theme?.atmosphere && <div className="collection-atmosphere" aria-hidden="true" style={{ backgroundImage: `url("${theme.atmosphere.src}")` }} />}
    {children}
  </div>;
}

export function CollectionArtwork({ theme, locale, eager = false }: { theme: CollectionTheme; locale: Locale; eager?: boolean }) {
  return <div className="collection-artwork"><MediaImage src={theme.hero.src} alt={theme.hero.alt[locale]} width={theme.hero.width} height={theme.hero.height} loading={eager ? 'eager' : 'lazy'} fetchPriority={eager ? 'high' : undefined} sizes="(max-width:700px) 90vw, 50vw" /></div>;
}

/** Dedicated event artwork never borrows a recipe photo when the asset is absent. */
export function CollectionHeroPromotion({ collection, locale }: { collection: PublicCollection; locale: Locale }) {
  if (!collection.theme) return null;
  return <Link href={collection.path} className="collection-hero-promotion" style={collectionThemeStyle(collection.theme)} aria-label={`${locale === 'pl' ? 'Zobacz kolekcję' : 'Explore collection'}: ${collection.title[locale]}`}>
    <div className="hero-circle" /><CollectionArtwork theme={collection.theme} locale={locale} eager />
    <span className="hero-caption"><span>{locale === 'pl' ? 'Na wyjątkową okazję' : 'For a special occasion'}</span><strong>{collection.title[locale]}<ArrowUpRight size={17} aria-hidden="true" /></strong></span>
  </Link>;
}
