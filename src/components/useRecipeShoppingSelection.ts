'use client';

import { useLocalStorage } from '@/lib/browser-storage';
import { EMPTY_SHOPPING_SELECTION, isShoppingSelection } from '@/lib/shopping';

export function useRecipeShoppingSelection(recipeId: string) {
  return useLocalStorage(`jesie:shopping:v1:${recipeId}`, EMPTY_SHOPPING_SELECTION, isShoppingSelection);
}
