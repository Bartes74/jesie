import 'server-only';
import { isDeepStrictEqual } from 'node:util';
import { and, eq } from 'drizzle-orm';
import { collectionAccentSlots, type CollectionTheme } from '@/lib/collections';
import { getDb } from '@/server/db';
import { collectionAssets, collectionThemeGenerations } from './theme-schema';
import { collectionThemeSchema } from './validation';
import { CollectionError } from './errors';

/** Publication checks only persisted approval and registered assets; no generation dependencies. */
export async function assertThemeAssets(collectionId: string, theme: CollectionTheme, generationId?: string | null) {
  collectionThemeSchema.parse(theme);
  if (!generationId) throw new CollectionError(422, 'THEME_NOT_APPROVED', 'Zaakceptuj wygenerowaną wersję wyglądu.');
  const [generation] = await getDb().select().from(collectionThemeGenerations).where(eq(collectionThemeGenerations.id, generationId));
  if (!generation || generation.collectionId !== collectionId || generation.status !== 'ready' || !generation.theme || !isDeepStrictEqual(generation.theme, theme) || generation.appliedRevision === null) throw new CollectionError(422, 'THEME_NOT_APPROVED', 'Oprawa nie odpowiada zaakceptowanej wersji tej kolekcji.');
  const accents = collectionAccentSlots.map(slot => [slot, theme.accents?.[slot] ?? null] as const);
  for (const [kind, asset] of [['hero', theme.hero] as const, ['atmosphere', theme.atmosphere] as const, ...accents]) {
    if (!asset) continue;
    const [row] = await getDb().select().from(collectionAssets).where(and(eq(collectionAssets.id, asset.assetId), eq(collectionAssets.collectionId, collectionId), eq(collectionAssets.kind, kind)));
    if (!row || row.width !== asset.width || row.height !== asset.height) throw new CollectionError(422, 'THEME_ASSET_MISSING', 'Nie znaleziono grafiki zaakceptowanej oprawy.');
  }
}
