import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuredIndexNowKey, discoveryRecipePaths, discoveryRetryAt, indexNowPayload } from './discovery';

test('IndexNow includes only owned canonical URLs and deduplicates historical addresses', () => {
  const paths = discoveryRecipePaths([{ locale:'pl',slug:'zupa-pomidorowa' },{ locale:'pl',slug:'zupa-pomidorowa' },{ locale:'en',slug:'tomato-soup' },{ locale:'private',slug:'draft' }]);
  assert.deepEqual(paths,['/pl/recipes/zupa-pomidorowa','/en/recipes/tomato-soup']);
  assert.deepEqual(indexNowPayload(paths,'test-key-123'), { host:'www.jesie.pl',key:'test-key-123',
    keyLocation:'https://www.jesie.pl/indexnow-key.txt',urlList:['https://www.jesie.pl/pl/recipes/zupa-pomidorowa','https://www.jesie.pl/en/recipes/tomato-soup'] });
  assert.throws(()=>indexNowPayload(['https://example.invalid/private'],'test-key-123'),/FOREIGN_ORIGIN/);
});

test('retries back off, respect server throttling and stay bounded', () => {
  const now=new Date('2026-10-12T06:00:00Z');
  assert.equal(discoveryRetryAt(1,now).toISOString(),'2026-10-12T06:01:00.000Z');
  assert.equal(discoveryRetryAt(4,now).toISOString(),'2026-10-12T06:08:00.000Z');
  assert.equal(discoveryRetryAt(1,now,'900').toISOString(),'2026-10-12T06:15:00.000Z');
  assert.equal(discoveryRetryAt(1,now,'Mon, 12 Oct 2026 07:00:00 GMT').toISOString(),'2026-10-12T07:00:00.000Z');
  assert.equal(discoveryRetryAt(99,now,'999999999').toISOString(),'2026-10-13T06:00:00.000Z');
  assert.equal(discoveryRetryAt(1,now,'nonsense').toISOString(),'2026-10-12T06:01:00.000Z');
});

test('IndexNow key is valid only when it matches the public protocol',()=>{
  const before=process.env.INDEXNOW_KEY;
  try {
    for (const value of ['', 'short', 'bad_key_123', 'a'.repeat(129)]) { process.env.INDEXNOW_KEY=value; assert.equal(configuredIndexNowKey(),null); }
    process.env.INDEXNOW_KEY='abc123XYZ-456'; assert.equal(configuredIndexNowKey(),'abc123XYZ-456');
  } finally { if(before===undefined) delete process.env.INDEXNOW_KEY; else process.env.INDEXNOW_KEY=before; }
});
