import assert from 'node:assert/strict';
import test from 'node:test';
import { isUsageBot, parseUsageEvent, usageDay, usagePath, usagePeriod, usageSource } from './usage-metrics';

test('public path allowlist removes tracking and cooking state and excludes private routes', () => {
  assert.equal(usagePath('/pl/recipes/cytrynowy-makaron?servings=8&utm_source=mail#step-1'), '/pl/recipes/cytrynowy-makaron');
  assert.equal(usagePath('/en/'), '/en');
  for (const path of ['/pl', '/en', '/pl/o-serwisie', '/pl/kolekcje', '/en/poradniki', '/en/kolekcje/one-pot', '/pl/poradniki/porcje']) assert.equal(usagePath(path), path);
  for (const path of ['/admin', '/pl/admin', '/pl/recipes/x/preview', '/pl/lodowka', '/pl/recipes', '/api/analytics', 'https://www.jesie.pl/pl', '//attacker.test/pl', '/pl/recipes/../secret', '/pl/recipes/a%2fb', '/pl/recipes/a\\b', '/pl/recipes/with space', '/de', '/pl/recipes/Uppercase', '/pl/recipes/x--y']) assert.equal(usagePath(path), null, path);
  assert.equal(usagePath(`/pl/recipes/${'a'.repeat(500)}`), null);
});

test('only fixed event and source names are accepted; arbitrary dimensions and non-recipe actions are rejected', () => {
  assert.deepEqual(parseUsageEvent({ name: 'page_view', path: '/pl?email=user@example.test', source: 'google' }), { name: 'page_view', path: '/pl', source: 'google' });
  assert.deepEqual(parseUsageEvent({ name: 'servings_change', path: '/en/recipes/pasta', source: 'direct' }), { name: 'servings_change', path: '/en/recipes/pasta', source: 'direct' });
  for (const input of [null, [], {}, { name: 'custom', path: '/pl', source: 'direct' }, { name: 'page_view', path: '/pl', source: 'user@example.test' }, { name: 'page_view', path: '/pl', source: 'google', referrer: 'https://google.com/private-query' }, { name: 'page_view', path: '/pl', source: 'direct', userId: 'user-1' }, { name: 'recipe_save', path: '/pl/o-serwisie', source: 'direct' }]) assert.equal(parseUsageEvent(input), null);
});

test('plan pages accept aggregate catalog actions without tracking queries or private plan state', () => {
  for (const locale of ['pl', 'en']) {
    const path = `/${locale}/plan`;
    assert.equal(usagePath(path), path);
    assert.equal(usagePath(`${path}/?servings=5&substitution=private&email=user@example.test#shopping`), path);
    for (const name of ['page_view', 'shopping_copy', 'plan_remove', 'pantry_use', 'search', 'no_results']) {
      assert.deepEqual(parseUsageEvent({ name, path: `${path}?q=private&recipeId=private#shopping`, source: 'direct' }), { name, path, source: 'direct' });
    }
    assert.equal(parseUsageEvent({ name: 'servings_change', path, source: 'direct' }), null);
    assert.equal(parseUsageEvent({ name: 'page_view', path, source: 'direct', meals: ['private'] }), null);
  }
  for (const path of ['/pl/plan/private', '/en/plan/recipe', '/de/plan', '/pl/planner']) assert.equal(usagePath(path), null);
});

test('referrers become coarse source categories without matching spoofed hostnames', () => {
  const origin = 'https://www.jesie.pl';
  const cases = [
    ['', 'direct'], ['https://www.jesie.pl/pl/recipes/x?q=secret', 'direct'], ['https://www.google.pl/search?q=secret', 'google'], ['https://www.google.co.uk/search', 'google'],
    ['https://images.google.com/imgres?imgurl=private', 'google'], ['https://www.bing.com/search?q=secret', 'bing'], ['https://pl.pinterest.com/pin/secret/', 'pinterest'],
    ['https://chatgpt.com/c/private-conversation', 'chatgpt'], ['https://chat.openai.com/share/secret', 'chatgpt'], ['https://www.perplexity.ai/search/private', 'perplexity'],
    ['https://claude.ai/chat/private', 'claude'], ['https://google.com.attacker.test/', 'other'], ['https://notpinterest.com/', 'other'], ['https://attacker-google.pl/', 'other'],
    ['https://bing.com@attacker.test/', 'other'], ['https://user:password@google.com/', 'other'], ['file:///private', 'other'], ['invalid', 'other'],
  ];
  for (const [referrer, source] of cases) assert.equal(usageSource(referrer, origin), source, referrer);
});

test('known search, AI and automated agents are skipped without retaining their user agent', () => {
  for (const agent of [null, '', 'Googlebot/2.1', 'bingbot/2.0', 'OAI-SearchBot', 'ChatGPT-User/1.0', 'Claude-User/1.0', 'Perplexity-User/1.0', 'HeadlessChrome', 'curl/8', 'python-requests']) assert.equal(isUsageBot(agent), true);
  assert.equal(isUsageBot('Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Safari/604.1'), false);
});

test('calendar buckets use Warsaw midnight and summary days cross DST as calendar days', () => {
  assert.equal(usageDay(new Date('2026-07-01T22:00:00Z')), '2026-07-02');
  assert.equal(usageDay(new Date('2026-01-01T22:00:00Z')), '2026-01-01');
  assert.equal(usageDay(new Date('2026-01-01T23:00:00Z')), '2026-01-02');
  assert.deepEqual(usagePeriod(3, new Date('2026-10-26T12:00:00Z')), { from: '2026-10-24', to: '2026-10-26', days: 3, timeZone: 'Europe/Warsaw' });
  assert.deepEqual(usagePeriod(3, new Date('2026-03-30T12:00:00Z')), { from: '2026-03-28', to: '2026-03-30', days: 3, timeZone: 'Europe/Warsaw' });
  assert.equal(usagePeriod(0).days, 1);
  assert.equal(usagePeriod(999).days, 365);
  assert.equal(usagePeriod(Number.NaN).days, 30);
  assert.throws(() => usageDay(new Date('invalid')), /INVALID_USAGE_DATE/);
});
