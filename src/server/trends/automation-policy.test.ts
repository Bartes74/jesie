import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TrendCandidate, TrendEvidence } from '@/lib/trend-types';
import { automaticPublicationDate, isAutomaticPublicationRun, isVerifiedAutomaticTrend } from './automation-policy';

const now = new Date('2026-10-16T04:00:01Z');
function candidate(): TrendCandidate {
  const sources: TrendEvidence[] = [
    { url: 'https://instagram.com/chef_one/reel/one/', title: 'A', publisher: 'One', platform: 'instagram', publishedAt: '2026-10-15', excerpt: 'This pumpkin pasta is going viral this week.', interestEvidence: '', independentKey: 'ignored' },
    { url: 'https://tiktok.com/@chef_two/video/two', title: 'B', publisher: 'Two', platform: 'tiktok', publishedAt: '2026-10-14', excerpt: 'Everyone is cooking the creamy pumpkin pasta trend.', interestEvidence: '', independentKey: 'ignored' },
    { url: 'https://food.example.org/pumpkin', title: 'C', publisher: 'Three', platform: 'web', publishedAt: '2026-10-13', excerpt: 'The latest popular pasta uses roasted pumpkin and cheese.', interestEvidence: '', independentKey: 'ignored' },
  ];
  return { id: 'candidate', runId: 'run', dishKey: 'pumpkin pasta', title: { pl: 'Makaron dyniowy', en: 'Pumpkin pasta' }, aliases: [], rationale: 'Verified research', sources,
    eligible: true, rejectionReason: null, duplicateRecipeId: null, ambiguous: false, score: { independentSources: 3, newestAt: '2026-10-15', platforms: 3 }, selected: true };
}
const run = () => ({ id: 'run', date: '2026-10-15', mode: 'daily', manualRequestKey: null, status: 'awaiting_review', searchRequestId: 'receipt', searchFinishedAt: now, searchChargedUsd: '0.1' });

test('a verified new daily trend belongs only to the following Warsaw morning', () => {
  assert.equal(automaticPublicationDate('2026-10-15'), '2026-10-16');
  assert.equal(automaticPublicationDate('2026-12-31'), '2027-01-01');
  assert(isAutomaticPublicationRun(run(), candidate(), '2026-10-16', now));
  assert.equal(isAutomaticPublicationRun(run(), candidate(), '2026-10-17', now), false);
  assert.equal(isAutomaticPublicationRun(run(), candidate(), '2026-10-16', now, true), false);
  assert.equal(isAutomaticPublicationRun({ ...run(), searchDiagnostics: { preparation: { requestKey: 'human-repair' } } }, candidate(), '2026-10-16', now), false);
});
test('control, manual, unresolved and unfinished runs can never fill the automatic slot', () => {
  for (const change of [{ mode: 'control' }, { manualRequestKey: 'manual' }, { status: 'generating' }, { searchRequestId: null }, { searchFinishedAt: null }, { searchChargedUsd: null }])
    assert.equal(isAutomaticPublicationRun({ ...run(), ...change }, candidate(), '2026-10-16', now), false);
});
test('editor choices, inspirations, duplicates and an old eligibility flag never qualify', () => {
  for (const change of [{ automaticSelection: { basis: 'research' as const, reason: 'Fallback' } }, { editorChoice: { by: 'owner', at: now.toISOString() } }, { duplicateRecipeId: 'existing' }, { ambiguous: true }, { selected: false }, { eligible: false }, { sources: [] }])
    assert.equal(isVerifiedAutomaticTrend({ ...candidate(), ...change }, 'run', now), false);
  const stale = candidate(); stale.sources[0].publishedAt = '2026-09-01';
  assert.equal(isVerifiedAutomaticTrend(stale, 'run', now), false);
  const crossposts = candidate(); crossposts.sources[1].url = 'https://tiktok.com/@chef_one/video/two';
  assert.equal(isVerifiedAutomaticTrend(crossposts, 'run', now), false);
});
