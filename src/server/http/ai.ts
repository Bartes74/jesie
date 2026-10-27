import 'server-only';
import { z } from 'zod';
import { AiError } from '@/server/ai/errors';
import { adminFailure, adminResponse } from './admin';

export function aiFailure(error: unknown) {
  if (error instanceof AiError) return adminResponse({ code: error.code, error: error.message, latest: error.latest }, error.status);
  return adminFailure(error);
}
export const createAiInput = z.object({
  recipeId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), expectedRevision: z.number().int().positive(),
  kind: z.enum(['recipe', 'hero', 'ingredient', 'step']), targetId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
  imageAction: z.enum(['remove_background', 'crop_step', 'fill_cutout', 'cutout_result']).optional(),
  sourceJobId: z.string().uuid().optional(),
  regenerate: z.boolean().optional(),
  brief: z.string().trim().min(1).max(2000), requestKey: z.string().uuid(),
}).strict();
export const aiActionInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('apply'), expectedRevision: z.number().int().positive(), acknowledgeStale: z.boolean() }).strict(),
  z.object({ action: z.literal('cancel') }).strict(),
  z.object({ action: z.literal('resume') }).strict(),
  z.object({ action: z.literal('recover') }).strict(),
]);
