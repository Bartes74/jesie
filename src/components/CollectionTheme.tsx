import type { CSSProperties, ReactNode } from 'react';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import type { CollectionAccentSlot, CollectionTheme, PublicCollection } from '@/lib/collections';
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

const accentSizes: Record<CollectionAccentSlot, string> = { corner: '(max-width:700px) 40vw, 260px', garland: '(max-width:1320px) 100vw, 1320px', spot: '(max-width:700px) 50vw, 240px' };
/** Decorative only: hidden from assistive technology and absent when the theme has no such accent. */
export function CollectionAccent({ theme, slot }: { theme: CollectionTheme | null; slot: CollectionAccentSlot }) {
  const accent = theme?.accents?.[slot];
  if (!accent) return null;
  return <div className={`collection-accent collection-accent-${slot}`} aria-hidden="true"><MediaImage src={accent.src} alt="" width={accent.width} height={accent.height} loading={slot === 'corner' ? 'eager' : 'lazy'} sizes={accentSizes[slot]} maximumWidth={slot === 'garland' ? 1600 : 640} /></div>;
}

/** Dedicated event artwork never borrows a recipe photo when the asset is absent. */
export function CollectionHeroPromotion({ collection, locale }: { collection: PublicCollection; locale: Locale }) {
  if (!collection.theme) return null;
  return <Link href={collection.path} className="collection-hero-promotion" style={collectionThemeStyle(collection.theme)} aria-label={`${locale === 'pl' ? 'Zobacz kolekcję' : 'Explore collection'}: ${collection.title[locale]}`}>
    <div className="hero-circle" /><CollectionArtwork theme={collection.theme} locale={locale} eager />
    <span className="hero-caption"><span>{locale === 'pl' ? 'Na wyjątkową okazję' : 'For a special occasion'}</span><strong>{collection.title[locale]}<ArrowUpRight size={17} aria-hidden="true" /></strong></span>
  </Link>;
}
