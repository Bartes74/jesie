import assert from 'node:assert/strict';
import test from 'node:test';
import { legacyRedirects } from './legacy-redirects';

test('legacy blog redirects are permanent, one hop and never shadow current routes', () => {
  const current = ['pl', 'en', 'admin', 'api', 'media', 'llms.txt', 'sitemap.xml', 'robots.txt', 'icon.svg', 'indexnow-key.txt', '.well-known'];
  const sources = legacyRedirects.map(item => item.source);
  assert.equal(new Set(sources).size, sources.length);
  for (const redirect of legacyRedirects) {
    assert.equal(redirect.permanent, true);
    assert.match(redirect.source, /^\/[a-z0-9-]+\/:path\*$/);
    assert(!current.includes(redirect.source.split('/')[1]), redirect.source);
    assert(['/pl', '/pl/o-serwisie', '/pl/feed.xml'].includes(redirect.destination));
  }
  assert(sources.includes('/przepisy/:path*'));
});
