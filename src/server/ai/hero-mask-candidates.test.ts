import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { rankHeroMaskCandidates, selectHeroMaskCandidate } from './hero-mask-candidates';
import { applyHeroMask, fillEnclosedCutout, PhotoFormatError, validateSolidHeroCutout } from './photo-format';
import { ProviderError } from './provider-error';

test('accepted mask ranking uses scores, metadata fallback and deterministic provider order', () => {
  const masks = [{ url: 'first' }, { url: 'second' }, { url: 'third' }];
  assert.deepEqual(rankHeroMaskCandidates({ masks, scores: [0.2], metadata: [{ index: 1, score: 0.9 }, { index: 0, score: 1 }] }), [
    { url: 'second', index: 1, score: 0.9 }, { url: 'first', index: 0, score: 0.2 }, { url: 'third', index: 2, score: 0 },
  ]);
  assert.deepEqual(rankHeroMaskCandidates({ masks, scores: [0.5, 0.5, 0.5] }).map(item => item.index), [0, 1, 2]);
  assert.deepEqual(rankHeroMaskCandidates({ masks }).map(item => item.index), [0, 1, 2]);
});

test('only an explicit empty mask array reports a missing mask; malformed or oversized sets fail before reads', async () => {
  for (const [data, code] of [
    [{ masks: [] }, 'AI_MASK_NOT_FOUND'], [null, 'AI_IMAGE_INVALID'], [{}, 'AI_IMAGE_INVALID'],
    [{ masks: [{}] }, 'AI_IMAGE_INVALID'], [{ masks: [{ url: 'mask' }], scores: [Infinity] }, 'AI_IMAGE_INVALID'],
    [{ masks: Array.from({ length: 4 }, () => ({ url: 'mask' })) }, 'AI_IMAGE_INVALID'],
  ] as const) {
    await assert.rejects(selectHeroMaskCandidate(data, {
      read: async () => assert.fail('Invalid response must not reach mask storage.'),
      format: async () => assert.fail('Invalid response must not reach formatting.'),
    }), error => error instanceof ProviderError && error.code === code);
  }
});

async function maskFixture() {
  const width = 100, height = 80;
  const source = await sharp({ create: { width, height, channels: 3, background: '#a16a31' } }).png().toBuffer();
  const masks: Record<string, Buffer> = {};
  for (const complete of [false, true]) {
    const pixels = Buffer.alloc(width * height);
    for (let y = 10; y < 70; y++) for (let x = 10; x < 90; x++) {
      const food = x >= 25 && x < 75 && y >= 25 && y < 55;
      const openRim = x >= 45 && x < 55 && y < 35;
      pixels[y * width + x] = complete || !food && !openRim ? 255 : 0;
    }
    masks[complete ? 'complete' : 'vessel-only'] = await sharp(pixels, { raw: { width, height, channels: 1 } }).png().toBuffer();
  }
  return { source, masks };
}

test('a lower-scored complete dish replaces a higher-scored mask that erases the food, without another submission', async () => {
  const { source, masks } = await maskFixture();
  const reads: string[] = [];
  const result = await selectHeroMaskCandidate({ masks: [{ url: 'complete' }, { url: 'vessel-only' }], scores: [0.7, 0.99] }, {
    read: async candidate => { reads.push(candidate.url); return masks[candidate.url]; },
    format: async mask => {
      const cutout = await applyHeroMask(source, mask);
      const formatted = await fillEnclosedCutout(source, cutout.bytes);
      await validateSolidHeroCutout(formatted.bytes);
      return formatted;
    },
  });
  assert.deepEqual(reads, ['vessel-only', 'complete']);
  assert.equal(result.index, 0);
  assert.equal(result.mask, masks.complete);
  await validateSolidHeroCutout(result.formatted.bytes);
});

test('all locally rejected candidates preserve the first ranked validation failure', async () => {
  const first = new PhotoFormatError('PHOTO_CUTOUT_INVALID', 'The highest-ranked mask removes the food.');
  const second = new ProviderError('AI_IMAGE_INVALID', 'The lower-ranked mask is empty.');
  const attempts: number[] = [];
  await assert.rejects(selectHeroMaskCandidate({ masks: [{ url: 'lower' }, { url: 'higher' }], scores: [0.1, 0.9] }, {
    read: async () => Buffer.from('accepted-mask'),
    format: async (_mask, candidate) => { attempts.push(candidate.index); throw candidate.index === 1 ? first : second; },
  }), error => error === first);
  assert.deepEqual(attempts, [1, 0]);
});

test('a valid highest-ranked mask stops candidate reads immediately', async () => {
  const bytes = Buffer.from('valid-mask');
  const reads: number[] = [];
  const result = await selectHeroMaskCandidate({ masks: [{ url: 'lower' }, { url: 'higher' }], scores: [0.1, 0.9] }, {
    read: async candidate => { reads.push(candidate.index); return bytes; },
    format: async () => 'complete dish',
  });
  assert.deepEqual(reads, [1]);
  assert.deepEqual(result, { mask: bytes, formatted: 'complete dish', index: 1 });
});

test('read failures and uncertain or source formatting errors propagate without trying another mask', async () => {
  const response = { masks: [{ url: 'first' }, { url: 'second' }] };
  for (const error of [
    new ProviderError('AI_IMAGE_DOWNLOAD_UNAVAILABLE', 'Download unavailable.', true),
    new ProviderError('AI_IMAGE_INVALID', 'A read adapter failed.'), new Error('Temporary network failure.'),
  ]) {
    let reads = 0, formats = 0;
    await assert.rejects(selectHeroMaskCandidate(response, {
      read: async () => { reads++; throw error; },
      format: async () => { formats++; },
    }), actual => actual === error);
    assert.equal(reads, 1); assert.equal(formats, 0);
  }
  for (const error of [
    new ProviderError('AI_IMAGE_INVALID', 'Acceptance is uncertain.', true),
    new ProviderError('AI_REFERENCE_UNAVAILABLE', 'Source unavailable.'),
    new PhotoFormatError('PHOTO_SOURCE_INVALID', 'Source is not an opaque photograph.'), new Error('Unexpected formatter failure.'),
  ]) {
    let reads = 0, formats = 0;
    await assert.rejects(selectHeroMaskCandidate(response, {
      read: async () => { reads++; return Buffer.from('accepted-mask'); },
      format: async () => { formats++; throw error; },
    }), actual => actual === error);
    assert.equal(reads, 1); assert.equal(formats, 1);
  }
});
