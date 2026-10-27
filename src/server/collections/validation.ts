import { z } from 'zod';
import { collectionThemeIssues, defaultCollectionPalette, isCollectionDate, isLegacyCollection, validCollectionPromotion, type CollectionContent, type CollectionIssue, type CollectionTheme } from '@/lib/collections';

const localised = (maximum: number) => z.object({ pl: z.string().trim().max(maximum), en: z.string().trim().max(maximum) }).strict();
const uuid = z.string().uuid();
const color = z.string().regex(/^#[0-9a-f]{6}$/i, 'Podaj kolor w formacie #RRGGBB.');
const palette = Object.fromEntries(Object.keys(defaultCollectionPalette).map(key => [key, color])) as Record<keyof typeof defaultCollectionPalette, typeof color>;
export const collectionThemeAssetSchema = z.object({ assetId: uuid, src: z.string().max(100), width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192), alt: localised(500) }).strict()
  .refine(asset => asset.src === `/media/collections/${asset.assetId}`, { message: 'Adres grafiki nie odpowiada jej identyfikatorowi.', path: ['src'] });
export const collectionThemeSchema = z.object({ version: z.literal(1), palette: z.object(palette).strict(), hero: collectionThemeAssetSchema,
  atmosphere: collectionThemeAssetSchema.nullable(), decorationOpacity: z.number().min(0).max(.18) }).strict().superRefine((theme, context) => {
    for (const issue of collectionThemeIssues(theme as CollectionTheme)) context.addIssue({ code: 'custom', path: issue.field.replace(/^theme\./, '').split('.'), message: issue.message });
  });
export const collectionPromotionSchema = z.object({ from: z.string().refine(isCollectionDate, 'Wybierz poprawną datę początku.'), to: z.string().refine(isCollectionDate, 'Wybierz poprawną datę końca.') }).strict()
  .refine(validCollectionPromotion, { path: ['to'], message: 'Koniec promocji nie może wypadać przed jej początkiem.' });
export const collectionContentSchema = z.object({ title: localised(200), description: localised(1200),
  slug: localised(100).superRefine((slugs, context) => { for (const locale of ['pl', 'en'] as const) if (slugs[locale] && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slugs[locale])) context.addIssue({ code: 'custom', path: [locale], message: 'Adres może zawierać małe litery, cyfry i łączniki.' }); }),
  selectionMode: z.enum(['manual', 'quick-dinners']), recipeIds: z.array(z.string().trim().min(1).max(200)).max(5000), minimumRecipes: z.union([z.literal(1), z.literal(5)]),
  theme: collectionThemeSchema.nullable(), promotion: collectionPromotionSchema.nullable(), appearanceBrief: z.string().trim().max(8000), inspirationAssetId: uuid.nullable(), themeGenerationId: uuid.nullable(),
}).strict().superRefine((content, context) => {
  if (new Set(content.recipeIds).size !== content.recipeIds.length) context.addIssue({ code: 'custom', path: ['recipeIds'], message: 'Przepis może wystąpić w kolekcji tylko raz.' });
});
export const createCollectionInput = z.object({ title: z.string().trim().min(1).max(200) }).strict();
export const saveCollectionInput = z.object({ expectedRevision: z.number().int().positive(), content: collectionContentSchema }).strict();
export const collectionActionInput = z.object({ expectedRevision: z.number().int().positive(), action: z.enum(['publish', 'unpublish']) }).strict();
export const collectionDefinitionSchema = z.object({ id: z.string().min(1).max(200), title: collectionContentSchema.shape.title,
  description: collectionContentSchema.shape.description, slug: collectionContentSchema.shape.slug,
  selectionMode: collectionContentSchema.shape.selectionMode, recipeIds: collectionContentSchema.shape.recipeIds,
  minimumRecipes: collectionContentSchema.shape.minimumRecipes, theme: collectionContentSchema.shape.theme,
  promotion: collectionContentSchema.shape.promotion, dateModified: z.string().datetime({ offset: true }).optional(),
}).strict();
export function collectionPublicationIssues(id: string, content: CollectionContent): CollectionIssue[] {
  const issues: CollectionIssue[] = [];
  for (const locale of ['pl', 'en'] as const) for (const field of ['title', 'description', 'slug'] as const) {
    if (!content[field][locale].trim()) issues.push({ field: `${field}.${locale}`, message: `Uzupełnij ${field === 'title' ? 'tytuł' : field === 'description' ? 'opis' : 'adres'} ${locale.toUpperCase()}.` });
  }
  if (!isLegacyCollection(id) || content.promotion) {
    if (!content.theme || !content.themeGenerationId) issues.push({ field: 'theme', message: 'Najpierw wygeneruj, sprawdź i zaakceptuj wygląd kolekcji.' });
  }
  return issues;
}
