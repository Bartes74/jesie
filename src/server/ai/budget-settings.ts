import 'server-only';
import Decimal from 'decimal.js';
import { desc } from 'drizzle-orm';
import { z } from 'zod';
import type { AiBudgetSnapshot, UpdateAiBudgetSettings } from '../../lib/ai-budget-types';
import type { EditorialActor } from '../../lib/editorial-types';
import { getDb } from '../db';
import { readBudgetPolicy } from './budget-policy';
import { AiError } from './errors';
import { aiBudgetAudit } from './schema';
import { budget, budgetLock, trustedActor, type AiTransaction } from './store';

const cap = z.string().regex(/^\d{1,7}(\.\d{1,8})?$/).refine(value => new Decimal(value).lte(1_000_000), 'Limit nie może przekraczać 1 000 000 USD.');
const revision = z.number().int().nonnegative().max(2_147_483_646);
export const updateAiBudgetInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('limits'), expectedRevision: revision, dailyLimitUsd: cap, monthlyLimitUsd: cap, pilotLimitUsd: cap }).strict(),
  z.object({ action: z.literal('suspend'), expectedRevision: revision, durationMinutes: z.union([z.literal(60), z.literal(240), z.literal(1440)]).default(60) }).strict(),
  z.object({ action: z.literal('resume'), expectedRevision: revision }).strict(),
]);
async function snapshot(tx: AiTransaction): Promise<AiBudgetSnapshot> {
  const settings = await readBudgetPolicy(tx);
  const usage = await budget(tx);
  const audit = await tx.select().from(aiBudgetAudit).orderBy(desc(aiBudgetAudit.revision)).limit(20);
  return { settings, budget: { ...usage, serverNow: settings.serverNow, limitsEnforced: settings.limitsEnforced },
    audit: audit.map(entry => ({ ...entry, createdAt: entry.createdAt.toISOString() })) };
}
export async function getAiBudgetSettings(actor: EditorialActor): Promise<AiBudgetSnapshot> {
  return getDb().transaction(async tx => { await budgetLock(tx); await trustedActor(tx, actor.id); return snapshot(tx); });
}
export async function updateAiBudgetSettings(_input: UpdateAiBudgetSettings, actor: EditorialActor): Promise<AiBudgetSnapshot> {
  return getDb().transaction(async tx => {
    await budgetLock(tx); await trustedActor(tx, actor.id);
    throw new AiError(410, 'BUDGETS_REMOVED', 'Limity i rezerwacje finansowe zostały usunięte. Panel pokazuje wyłącznie rzeczywiste, potwierdzone koszty.');
  });
}
