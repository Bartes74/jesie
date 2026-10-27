import type { Locale, Localised } from './recipes';
import type { PublicRecipe } from './recipe-presentation';

export const collectionTimezone = 'Europe/Warsaw';
export const legacyCollectionIds = ['quick-dinners', 'one-pot', 'pantry', 'seasonal'] as const;
export type CollectionSelectionMode = 'manual' | 'quick-dinners';
export type CollectionPromotion = { from: string; to: string };
export type CollectionThemeAsset = { assetId: string; src: string; width: number; height: number; alt: Localised };
export const defaultCollectionPalette = {
  background: '#faf8f2', surface: '#fdfbf7', text: '#203f32', muted: '#4f5c52', accent: '#203f32',
  accentText: '#faf8f2', border: '#dddcd1', heroBackground: '#f4dfa0', catalogBackground: '#faf8f2',
  photoBackground: '#faf8f2', panelBackground: '#e4eadd', heading: '#203f32',
} as const;
export type CollectionPalette = { [Key in keyof typeof defaultCollectionPalette]: string };
export type CollectionTheme = {
  version: 1;
  palette: CollectionPalette;
  hero: CollectionThemeAsset;
  atmosphere: CollectionThemeAsset | null;
  decorationOpacity: number;
};
export type CollectionContent = {
  title: Localised; description: Localised; slug: Localised;
  selectionMode: CollectionSelectionMode; recipeIds: string[]; minimumRecipes: number;
  theme: CollectionTheme | null; promotion: CollectionPromotion | null;
  appearanceBrief: string; inspirationAssetId: string | null; themeGenerationId: string | null;
};
export type CollectionDefinition = Pick<CollectionContent, 'title' | 'description' | 'slug' | 'selectionMode' | 'recipeIds' | 'minimumRecipes' | 'theme' | 'promotion'> & {
  id: string; dateModified?: string;
};
export type PublicCollection = CollectionDefinition & { recipes: PublicRecipe[]; path: string };
export type CollectionRecord = {
  id: string; revision: number; content: CollectionContent;
  publicationStatus: 'never_published' | 'published' | 'unpublished'; publishedRevision: number | null;
  hasUnpublishedChanges: boolean; firstPublishedAt: string | null; createdAt: string; updatedAt: string; updatedBy: string;
};
export type CollectionIssue = { field: string; message: string };

export function isLegacyCollection(id: string) { return legacyCollectionIds.some(value => value === id); }
export function collectionSlug(value: string) {
  return value.toLocaleLowerCase('pl').replace(/ł/g, 'l').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100).replace(/-+$/g, '');
}
export function newCollectionContent(title = ''): CollectionContent {
  return { title: { pl: title, en: '' }, description: { pl: '', en: '' }, slug: { pl: collectionSlug(title), en: '' },
    selectionMode: 'manual', recipeIds: [], minimumRecipes: 1, theme: null, promotion: null,
    appearanceBrief: '', inspirationAssetId: null, themeGenerationId: null };
}

export function isCollectionDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
const warsawCalendar = new Intl.DateTimeFormat('en-CA', { timeZone: collectionTimezone, year: 'numeric', month: '2-digit', day: '2-digit' });
export function collectionDate(now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new Error('INVALID_COLLECTION_DATE');
  const parts = Object.fromEntries(warsawCalendar.formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function validCollectionPromotion(promotion: CollectionPromotion) {
  return isCollectionDate(promotion.from) && isCollectionDate(promotion.to) && promotion.from <= promotion.to;
}
export function collectionPromotionActive(promotion: CollectionPromotion | null, now = new Date()) {
  if (!promotion || !validCollectionPromotion(promotion)) return false;
  const date = collectionDate(now);
  return promotion.from <= date && date <= promotion.to;
}
export function collectionPromotionsOverlap(first: CollectionPromotion | null, second: CollectionPromotion | null) {
  return Boolean(first && second && validCollectionPromotion(first) && validCollectionPromotion(second)
    && first.from <= second.to && second.from <= first.to);
}

/** Locate the next Warsaw midnight without assuming a calendar day always has 24 hours. */
export function nextCollectionMidnight(now = new Date()) {
  const date = collectionDate(now);
  let low = now.getTime(), high = low + 27 * 60 * 60 * 1000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (collectionDate(new Date(middle)) === date) low = middle;
    else high = middle;
  }
  return new Date(high);
}

const hexColor = /^#[0-9a-f]{6}$/i;
function luminance(hex: string) {
  const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
export function collectionContrast(foreground: string, background: string) {
  if (!hexColor.test(foreground) || !hexColor.test(background)) return 0;
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + .05) / (values[1] + .05);
}
export function collectionThemeIssues(theme: CollectionTheme): CollectionIssue[] {
  const issues: CollectionIssue[] = [];
  for (const key of Object.keys(defaultCollectionPalette) as (keyof CollectionPalette)[]) {
    if (!hexColor.test(theme.palette[key] ?? '')) issues.push({ field: `theme.palette.${key}`, message: 'Podaj kolor w formacie #RRGGBB.' });
  }
  for (const surface of ['background', 'surface', 'heroBackground', 'catalogBackground', 'panelBackground'] as const) {
    for (const text of ['text', 'muted', 'heading'] as const) {
      if (collectionContrast(theme.palette[text], theme.palette[surface]) < 4.5) issues.push({ field: `theme.palette.${text}`, message: `Kolor tekstu wymaga kontrastu co najmniej 4,5:1 na powierzchni ${surface}.` });
    }
  }
  if (collectionContrast(theme.palette.accentText, theme.palette.accent) < 4.5) issues.push({ field: 'theme.palette.accentText', message: 'Tekst przycisku wymaga kontrastu co najmniej 4,5:1.' });
  if (!Number.isFinite(theme.decorationOpacity) || theme.decorationOpacity < 0 || theme.decorationOpacity > .18) issues.push({ field: 'theme.decorationOpacity', message: 'Dekoracje mogą mieć krycie od 0 do 0,18.' });
  return issues;
}

export function collectionPublicDefinition(id: string, content: CollectionContent, dateModified?: string): CollectionDefinition {
  const { title, description, slug, selectionMode, recipeIds, minimumRecipes, theme, promotion } = content;
  return { id, title, description, slug, selectionMode, recipeIds, minimumRecipes, theme, promotion, ...(dateModified ? { dateModified } : {}) };
}
const dinnerCategories = new Set(['main', 'lunch', 'dinner', 'soup']);
export function resolveCollection(definition: CollectionDefinition, recipes: readonly PublicRecipe[], locale: Locale): PublicCollection {
  const byId = new Map(recipes.map(recipe => [recipe.id, recipe]));
  const selected = definition.selectionMode === 'quick-dinners'
    ? recipes.filter(recipe => dinnerCategories.has(recipe.primaryCategory) && recipe.times.total > 0 && recipe.times.total <= 30)
    : [...new Set(definition.recipeIds)].flatMap(id => byId.get(id) ?? []);
  return { ...definition, recipes: selected, path: `/${locale}/kolekcje/${definition.slug[locale]}` };
}
export function collectionIsDiscoverable(collection: Pick<PublicCollection, 'recipes' | 'minimumRecipes'>) {
  return collection.recipes.length >= collection.minimumRecipes;
}
export function selectPromotedCollection(collections: readonly PublicCollection[], now = new Date()) {
  return collections.find(collection => collectionIsDiscoverable(collection) && collection.theme && collectionPromotionActive(collection.promotion, now)) ?? null;
}
