import 'server-only';
import { z } from 'zod';
import { PhotoFormatError } from './photo-format';
import { ProviderError } from './provider-error';

export type HeroMaskCandidate = { url: string; index: number; score: number };

const masksSchema = z.object({
  masks: z.array(z.object({ url: z.string() })).min(1).max(3),
  scores: z.array(z.number().finite()).optional(),
  metadata: z.array(z.object({ index: z.number().int(), score: z.number().finite().optional() })).optional(),
});

/** Rank only candidates returned by one already accepted segmentation request. */
export function rankHeroMaskCandidates(data: unknown): HeroMaskCandidate[] {
  const parsed = masksSchema.safeParse(data);
  if (!parsed.success) {
    const empty = data !== null && typeof data === 'object' && 'masks' in data && Array.isArray(data.masks) && data.masks.length === 0;
    throw new ProviderError(empty ? 'AI_MASK_NOT_FOUND' : 'AI_IMAGE_INVALID', empty ? 'Dostawca nie zwrócił maski wycięcia.' : 'Dostawca zwrócił nieprawidłowe dane wycięcia.');
  }
  return parsed.data.masks.map((mask, index) => ({
    url: mask.url,
    index,
    score: parsed.data.scores?.[index] ?? parsed.data.metadata?.find(item => item.index === index)?.score ?? 0,
  })).sort((a, b) => b.score - a.score || a.index - b.index);
}

function rejectedGeometry(error: unknown) {
  return error instanceof PhotoFormatError && ['PHOTO_MASK_INVALID', 'PHOTO_CUTOUT_INVALID'].includes(error.code)
    || error instanceof ProviderError && error.code === 'AI_IMAGE_INVALID' && !error.uncertain;
}

/**
 * Prefer the highest-ranked locally valid mask, using existing result GETs only.
 * A transport or source failure is not evidence that another mask is preferable.
 */
export async function selectHeroMaskCandidate<T>(data: unknown, operations: {
  read: (candidate: HeroMaskCandidate) => Promise<Buffer>;
  format: (mask: Buffer, candidate: HeroMaskCandidate) => Promise<T>;
}): Promise<{ mask: Buffer; formatted: T; index: number }> {
  const candidates = rankHeroMaskCandidates(data);
  let firstRejection: unknown;
  for (const candidate of candidates) {
    // Keep reads outside the geometry catch, even if a transport adapter happens
    // to report its failure with the same code as an invalid image.
    const mask = await operations.read(candidate);
    try {
      const formatted = await operations.format(mask, candidate);
      return { mask, formatted, index: candidate.index };
    } catch (error) {
      if (!rejectedGeometry(error)) throw error;
      firstRejection ??= error;
    }
  }
  throw firstRejection;
}
