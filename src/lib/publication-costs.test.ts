import test from 'node:test';
import assert from 'node:assert/strict';
import { recipeCosts } from './publication-costs';
test('cost report includes only real charges and counts unconfirmed costs separately', () => {
  const result = recipeCosts({ recipeId: 'x', title: 'X', published: true, jobs: [
    { kind: 'hero', targetId: null, reservedUsd: '2', chargedUsd: '0.4', costBasis: 'usage' },
    { kind: 'hero', targetId: null, reservedUsd: '2', chargedUsd: '2', costBasis: 'reservation' },
    { kind: 'ingredient', targetId: 'a', reservedUsd: '0.5', chargedUsd: null, costBasis: null },
  ], research: [{ reservedUsd: '2', chargedUsd: '0.1', packetRemainingUsd: '1' }] });
  assert.equal(result.confirmedUsd, '0.50000000'); assert.equal(result.estimatedUsd, '0.00000000');
  assert.equal(result.reservedUsd, '0.00000000'); assert.equal(result.costUsd, '0.50000000'); assert.equal(result.correctionsUsd, '0.00000000');
  assert.equal(result.pendingCostCount, 2);
});
test('a zero-reservation receipt with unknown cost is not shown as free and still identifies a later correction', () => {
  const result = recipeCosts({ recipeId: 'x', title: 'X', published: false, jobs: [
    { kind: 'hero', targetId: null, reservedUsd: '0', chargedUsd: null, costBasis: 'reservation', providerRequestId: 'already-sent' },
    { kind: 'hero', targetId: null, reservedUsd: '0', chargedUsd: '0.3', costBasis: 'usage', providerRequestId: 'correction' },
  ], research: [] });
  assert.equal(result.pendingCostCount, 1); assert.equal(result.costUsd, '0.30000000'); assert.equal(result.correctionsUsd, '0.30000000');
});
test('free reuse does not classify the first paid image as a correction', () => {
  const jobs = [ { kind: 'ingredient', targetId: 'x', reservedUsd: '0', chargedUsd: '0', costBasis: 'usage' }, { kind: 'ingredient', targetId: 'x', reservedUsd: '0.5', chargedUsd: '0.3', costBasis: 'usage' } ];
  assert.equal(recipeCosts({ recipeId: 'x', title: 'X', published: false, jobs, research: [] }).correctionsUsd, '0.00000000');
});
test('ingredient verification adds its original charge and pending count without becoming a correction', () => {
  const report = recipeCosts({ recipeId: 'x', title: 'X', published: false, jobs: [], research: [], verification: { chargedUsd: '0.02', pendingCount: 1 } });
  assert.equal(report.costUsd, '0.02000000'); assert.equal(report.correctionsUsd, '0.00000000'); assert.equal(report.pendingCostCount, 1);
});
