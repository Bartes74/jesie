import { z } from 'zod';

/** Version of application-computed source eligibility, separate from immutable model findings. */
export const ingredientEvidencePolicyVersion = 'ingredient-evidence-v2';

const names = z.object({ pl: z.string().max(250), en: z.string().max(250) }).strict();
export const ingredientVerificationInputSchema = z.object({
  name: names.refine(value => Boolean(value.pl.trim() || value.en.trim()), 'An ingredient name is required.'),
  note: names.optional(),
}).strict();
export type IngredientVerificationInput = z.infer<typeof ingredientVerificationInputSchema>;

export const ingredientVerificationSourceSchema = z.object({
  title: z.string().min(1).max(250), url: z.string().min(1).max(2000),
  supports: z.array(z.enum(['identity', 'culinary_use', 'diet'])).min(1).max(3),
  finding: z.string().min(1).max(500),
}).strict();
export type IngredientVerificationSource = z.infer<typeof ingredientVerificationSourceSchema>;

/** The model proposes evidence; only the application computes dictionary eligibility. */
export const ingredientVerificationProposalSchema = z.object({
  decision: z.enum(['verified', 'possible_typo', 'ambiguous', 'unverified']),
  canonicalName: names.nullable(),
  kind: z.enum(['plant', 'fungus', 'mineral', 'dairy', 'egg', 'honey', 'meat', 'compound', 'non_food', 'unknown']),
  diet: z.enum(['vegan', 'vegetarian', 'meat']).nullable(),
  suggestedName: names.nullable(),
  reason: z.string().min(1).max(1000),
  sameIdentity: z.boolean(), singleIngredient: z.boolean(), confidence: z.enum(['high', 'medium', 'low']),
  sources: z.array(ingredientVerificationSourceSchema).max(6),
}).strict();
export type IngredientVerificationProposal = z.infer<typeof ingredientVerificationProposalSchema>;
export const ingredientVerificationResultSchema = ingredientVerificationProposalSchema.extend({
  queriedNames: names,
  autoLearnEligible: z.boolean(),
}).strict();
export type IngredientVerificationResult = z.infer<typeof ingredientVerificationResultSchema>;

/** Exact-name identity only: punctuation/case/diacritics, never fuzzy spelling or word removal. */
export function normalizeIngredientVerificationName(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLowerCase().replace(/ł/gu, 'l')
    .replace(/[’‘]/gu, "'").replace(/[^\p{L}\p{N}'\s-]/gu, ' ').replace(/\s+/gu, ' ').trim();
}
