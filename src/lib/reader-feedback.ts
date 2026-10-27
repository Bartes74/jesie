import { z } from 'zod';

export const readerFeedbackInput = z.object({
  requestKey: z.string().uuid(), recipeId: z.string().min(1).max(200),
  version: z.string().regex(/^\d+$/).max(12), kind: z.enum(['success', 'changed', 'problem']),
  stepId: z.string().min(1).max(200).optional(), message: z.string().trim().max(1500).default(''),
}).strict().refine(value => value.kind === 'success' || value.message.length >= 3, { message: 'Opisz krótko zmianę lub problem.', path: ['message'] });
export type ReaderFeedbackInput = z.infer<typeof readerFeedbackInput>;
export type ReaderFeedback = { id: string; recipeId: string; title: string; revision: number; kind: 'success' | 'changed' | 'problem'; stepId: string | null; message: string; createdAt: string; status: 'open' | 'resolved' };
