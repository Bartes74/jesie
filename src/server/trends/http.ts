import { z } from 'zod';
import { adminFailure, adminResponse } from '@/server/http/admin';
import { TrendError } from './store';
export const trendStartInput = z.discriminatedUnion('action', [
    z.object({ action: z.enum(['run', 'control']) }).strict(),
    z.object({ action: z.literal('manual'), requestKey: z.string().uuid() }).strict(),
]);
export const trendSettingsInput = z.object({ enabled: z.boolean(), monthlyLimitUsd: z.unknown().optional(), acknowledgeAutoPause: z.boolean().optional(), expectedAutoPauseToken: z.string().min(1).max(128).optional() }).strict();
export const trendActionInput = z.discriminatedUnion('action', [
    z.object({ action: z.enum(['pause', 'reject', 'resume', 'reverify', 'approve_and_publish']), expectedRevision: z.number().int().positive().optional(), checks: z.object({ pl: z.boolean(), en: z.boolean(), quantities: z.boolean(), method: z.boolean(), photos: z.boolean(), sources: z.boolean() }).strict().optional() }).strict(),
    z.object({ action: z.literal('prepare_inspiration'), candidateId: z.string().min(1).max(250) }).strict(),
    z.object({ action: z.literal('repair'), expectedRevision: z.number().int().positive(), requestKey: z.string().uuid() }).strict(),
    z.object({ action: z.literal('regenerate_photo'), kind: z.enum(['hero', 'ingredient', 'step']), targetId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(), expectedRevision: z.number().int().positive(), requestKey: z.string().uuid() }).strict(),
]);
export function trendFailure(error: unknown) { if (error instanceof TrendError)
    return adminResponse({ code: error.code, error: error.message }, error.status); return adminFailure(error); }
