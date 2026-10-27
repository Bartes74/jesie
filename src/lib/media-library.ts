import type { MediaTile } from './recipe-media';
export type LibraryTarget = { recipeId: string; kind: 'hero' | 'ingredient' | 'step'; targetId?: string };
export type LibraryImage = { id: string; kind: 'hero' | 'ingredient' | 'step'; title: string; photo: MediaTile; sourceRecipeId: string; product: string; form: string; profile: string; createdAt: string; compatible: boolean; uses: { id: string; title: string }[] };
