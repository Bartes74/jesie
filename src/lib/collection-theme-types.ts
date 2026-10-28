import type { CollectionTheme } from './collections';

export type ThemeGenerationPart = 'all' | 'hero' | 'background' | 'accents';
export type ThemeGenerationStatus = 'queued' | 'running' | 'ready' | 'failed' | 'uncertain';
export type GenerationDto = {
  id: string; collectionId: string; status: ThemeGenerationStatus; part: ThemeGenerationPart;
  brief: string; theme: CollectionTheme | null; error: string | null; chargedUsd: string | null;
  createdAt: string; appliedRevision: number | null;
};
