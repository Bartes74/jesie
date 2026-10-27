import Decimal from 'decimal.js';
export type RecipeCostInput = { recipeId: string; title: string; published: boolean; jobs: { kind: string; targetId: string | null; reservedUsd: string; chargedUsd: string | null; costBasis: string | null; providerRequestId?: string | null }[]; research: { reservedUsd: string; chargedUsd: string | null; packetRemainingUsd: string }[]; verification?: { chargedUsd: string; pendingCount: number } };
export function recipeCosts(input: RecipeCostInput) {
  let confirmed = new Decimal(0), corrections = new Decimal(0), pendingCostCount = 0;
  const slots = new Set<string>();
  for (const job of input.jobs) {
    const known = job.costBasis === 'usage' && job.chargedUsd !== null;
    const cost = new Decimal(known ? job.chargedUsd! : 0);
    if (known) confirmed = confirmed.plus(cost); else pendingCostCount++;
    const key = `${job.kind}:${job.targetId ?? ''}`;
    if (slots.has(key)) corrections = corrections.plus(cost);
    // Zero-cost reused jobs do not turn the first paid photograph into a correction.
    if (cost.gt(0) || job.providerRequestId || new Decimal(job.reservedUsd).gt(0)) slots.add(key);
  }
  for (const run of input.research) {
    if (run.chargedUsd === null) pendingCostCount++;
    else confirmed = confirmed.plus(run.chargedUsd);
  }
  if (input.verification) {
    confirmed = confirmed.plus(input.verification.chargedUsd);
    pendingCostCount += input.verification.pendingCount;
  }
  return { id: input.recipeId, title: input.title, published: input.published, confirmedUsd: confirmed.toFixed(8), estimatedUsd: '0.00000000', reservedUsd: '0.00000000', correctionsUsd: corrections.toFixed(8), costUsd: confirmed.toFixed(8), pendingCostCount };
}
