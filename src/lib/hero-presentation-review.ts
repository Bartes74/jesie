import { z } from 'zod';
import { heroContainers } from './hero-presentation';

/** The guided review edits only what the editor sees, never private step evidence. */
export const heroPresentationReviewSchema = z.object({
  container: z.enum(heroContainers),
  finalAppearance: z.object({
    pl: z.string().trim().min(1).max(600),
    en: z.string().trim().min(1).max(600),
  }).strict(),
}).strict();

export type HeroPresentationReview = z.infer<typeof heroPresentationReviewSchema>;
