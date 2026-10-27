'use client';

import { useLocalStorage } from '@/lib/browser-storage';
import { collectionSelectionKey, EMPTY_COLLECTION_SELECTION, isCollectionSelection } from '@/lib/collection-selection';

export function useCollectionSelection(collectionId: string) {
  return useLocalStorage(collectionSelectionKey(collectionId), EMPTY_COLLECTION_SELECTION, isCollectionSelection);
}
