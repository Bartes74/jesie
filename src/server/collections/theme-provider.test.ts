import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultCollectionPalette } from '@/lib/collections';
import { ApiError } from '@fal-ai/client';
import { collectionImageInput, collectionThemeRequest, pollThemeImage } from './theme-provider';
import type { ThemeProposal } from './theme-policy';
import { ProviderError } from '@/server/ai/provider-error';

const proposal: ThemeProposal = { palette: { ...defaultCollectionPalette }, decorationOpacity: .1,
  heroPrompt: 'Independent festive artwork with an entire arrangement inside the frame.', atmospherePrompt: 'A subdued background with seasonal ornaments at its edges.',
  heroAlt: { pl: 'Ilustracja wydarzenia', en: 'Event illustration' }, atmosphereAlt: { pl: 'Tło', en: 'Background' } };

test('theme requests keep user descriptions as data and demand a strict structured response', () => {
  const input = { brief: 'A cosy winter evening; <script>not executable</script>', title: { pl: 'Wydarzenie', en: 'Event' }, description: { pl: 'Opis', en: 'Description' }, part: 'all' as const, baseTheme: null };
  const request = collectionThemeRequest('configured-model', input, Buffer.from('image-reference'));
  assert.equal(request.model, 'configured-model');
  assert.equal(request.background, true);
  assert.equal(request.text.format.strict, true);
  assert.equal(request.text.format.schema.additionalProperties, false);
  assert.equal(request.input[0].content[0].type, 'input_text');
  assert.deepEqual(JSON.parse((request.input[0].content[0] as { text: string }).text), input);
  assert.equal(request.input[0].content[1].type, 'input_image');
  assert.ok(request.instructions.includes('Lora/Manrope'));
  assert.ok(request.instructions.includes('without text'));
});

test('dedicated collection art uses the square hero and a separate tileable atmospheric background', () => {
  const hero = collectionImageInput('hero', proposal, []);
  const background = collectionImageInput('atmosphere', proposal, ['https://v3.fal.media/reference.webp']);
  assert.deepEqual(hero.image_size, { width: 1536, height: 1536 });
  assert.deepEqual(background.image_size, { width: 1536, height: 1536 });
  assert.ok(hero.prompt.startsWith(proposal.heroPrompt));
  assert.ok(background.prompt.startsWith(proposal.atmospherePrompt));
  assert.equal(hero.background, 'opaque');
  assert.equal(hero.num_images, 1);
  assert.equal(hero.sync_mode, false);
  assert.equal('image_urls' in hero, false);
  assert.deepEqual(background.image_urls, ['https://v3.fal.media/reference.webp']);
  assert.equal(hero.output_format, 'png');
});

test('known failed receipts become terminal errors and retain known charges without submitting new work', async () => {
  for (const status of [400, 404, 422]) for (const stage of ['status', 'result'] as const) {
    let billingReads = 0;
    const rejected = new ApiError({ message: 'Provider internals are not reader-facing', status });
    await assert.rejects(pollThemeImage('model', 'known-receipt', {
      status: async () => { if (stage === 'status') throw rejected; return { status: 'COMPLETED' }; },
      result: async () => { throw rejected; }, bill: async requestId => { assert.equal(requestId, 'known-receipt'); billingReads++; return { chargedUsd: '0.12500000' }; },
    }), error => error instanceof ProviderError && error.code === 'THEME_RESULT_FAILED' && error.uncertain === false && error.chargedUsd === '0.12500000' && !error.message.includes('internals'));
    assert.equal(billingReads, 1);
  }
});

test('missing billing remains unknown when a known receipt is rejected', async () => {
  await assert.rejects(pollThemeImage('model', 'known-receipt', { status: async () => { throw new ApiError({ message: 'Rejected', status: 422 }); }, bill: async () => { throw new Error('billing temporarily unavailable'); } }), error => error instanceof ProviderError && error.code === 'THEME_RESULT_FAILED' && error.chargedUsd === undefined && error.uncertain === false);
});

test('network failures, rate limits and 5xx responses remain retryable receipt reads', async () => {
  for (const failure of [new TypeError('fetch failed'), new ApiError({ message: 'Rate limited', status: 429 }), new ApiError({ message: 'Temporarily unavailable', status: 503 }), new DOMException('Timed out', 'TimeoutError')]) {
    let billingReads = 0;
    await assert.rejects(pollThemeImage('model', 'receipt', { status: async () => { throw failure; }, bill: async () => { billingReads++; return null; } }), error => error === failure);
    assert.equal(billingReads, 0);
  }
});

test('a completed receipt without image data records a terminal failure with its charge', async () => {
  for (const data of [null, { images: [] }, { images: [{ url: null }] }]) await assert.rejects(pollThemeImage('model', 'receipt', { status: async () => ({ status: 'COMPLETED' }), result: async () => ({ data }), bill: async () => ({ chargedUsd: '0.04000000' }) }), error => error instanceof ProviderError && error.code === 'THEME_IMAGE_INVALID' && error.chargedUsd === '0.04000000');
});

test('queued jobs do not read results or billing and completed jobs use bounded approved downloads', async () => {
  let reads = 0;
  const queued = await pollThemeImage('model', 'receipt', { status: async () => ({ status: 'IN_PROGRESS' }), result: async () => { reads++; return { data: {} }; }, bill: async () => { reads++; return null; } });
  assert.deepEqual(queued, { done: false });
  assert.equal(reads, 0);
  const complete = await pollThemeImage('model', 'receipt', { status: async () => ({ status: 'COMPLETED' }), result: async () => ({ data: { images: [{ url: 'https://v3.fal.media/collection.png' }] } }), bill: async () => ({ chargedUsd: '0.12' }), download: async url => { assert.equal(url.hostname, 'v3.fal.media'); return new Response(new Uint8Array([1, 2, 3])); }, read: async (_body, maximum) => { assert.equal(maximum, 32 * 1024 * 1024); return Buffer.from([1, 2, 3]); } });
  assert.deepEqual(complete, { done: true, bytes: Buffer.from([1, 2, 3]), chargedUsd: '0.12' });
});
