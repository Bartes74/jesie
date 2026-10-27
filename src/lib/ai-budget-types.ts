import type { AiBudget } from './ai-types';

export type AiBudgetState = {
  dailyLimitUsd: string; monthlyLimitUsd: string; pilotLimitUsd: string;
  bypassUntil: string | null; source: 'environment' | 'database';
};
export type AiBudgetSettings = AiBudgetState & {
  revision: number; limitsEnforced: boolean; serverNow: string;
  updatedAt: string; updatedByName: string | null;
};
export type UpdateAiBudgetSettings =
  | { action: 'limits'; expectedRevision: number; dailyLimitUsd: string; monthlyLimitUsd: string; pilotLimitUsd: string }
  | { action: 'suspend'; expectedRevision: number; durationMinutes?: 60 | 240 | 1440 }
  | { action: 'resume'; expectedRevision: number };
export type AiBudgetAuditEntry = {
  id: string; revision: number; action: UpdateAiBudgetSettings['action'];
  actorId: string; actorName: string; createdAt: string;
  before: AiBudgetState; after: AiBudgetState;
};
export type AiBudgetSnapshot = { settings: AiBudgetSettings; budget: AiBudget; audit: AiBudgetAuditEntry[] };
