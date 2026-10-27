import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import sharp from 'sharp';
import { createMediaVariantRepository, declaredMediaVariants } from './delivery-variant-store';
import { deliveryVariantInput, deliveryVariantKey, deliveryVariantPath, deliveryVariantDimensions, type MediaDeliveryVariantInput, type MediaDeliveryVariantRecord } from './delivery-variant-cache';
import { renderMediaDelivery } from './delivery';
import type { MediaDeliveryWidth } from '@/lib/media-delivery';

const schema = `media_variant_test_${randomUUID().replaceAll('-', '')}`;
const asset = { id: randomUUID(), kind: 'ingredient', blobPathname: 'ai/test/master.webp' };
let admin: Pool, isolated: Pool;
let repository: ReturnType<typeof createMediaVariantRepository>;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

before(async () => {
  if (process.env.NODE_ENV === 'production') throw new Error('Media tests require an isolated development schema');
  config({ path: '.env.local', quiet: true });
  const connection = process.env.EDITORIAL_TEST_DATABASE_URL || process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL_NON_POOLING;
  if (!connection) throw new Error('A development Postgres test connection is required');
  admin = new Pool({ connectionString: connection, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(connection); url.searchParams.set('options', `-c search_path=${schema}`);
  isolated = new Pool({ connectionString: url.toString(), max: 4 });
  await isolated.query('CREATE TABLE ai_asset(id text PRIMARY KEY,blob_pathname text NOT NULL,kind text NOT NULL,width integer NOT NULL,height integer NOT NULL)');
  await isolated.query('INSERT INTO ai_asset VALUES($1,$2,$3,512,512)', [asset.id, asset.blobPathname, asset.kind]);
  const migration = await readFile('migrations/0022-media-maintenance.sql', 'utf8');
  await isolated.query(migration.split('-- Durable daily snapshots')[0]);
  const db = drizzle(isolated); repository = createMediaVariantRepository(() => db);
});
after(async () => {
  if (isolated) await isolated.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
});

async function record(input: MediaDeliveryVariantInput): Promise<MediaDeliveryVariantRecord> {
  const source = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#fa7846' } }).png().toBuffer();
  const width = Number(input.variantKey.split(':')[1]) as MediaDeliveryWidth;
  const photo = await renderMediaDelivery(source, input.kind, width);
  const value: MediaDeliveryVariantRecord = { ...input, key: deliveryVariantKey(input), sourceSha256: digest(source), sourceBytes: source.length,
    contentSha256: digest(photo.bytes), byteLength: photo.bytes.length, width: photo.width, height: photo.height, blobPathname: '' };
  value.blobPathname = deliveryVariantPath(value); return value;
}

test('simultaneous workers receive one lease and a ready receipt cannot be claimed again', async () => {
  const input = deliveryVariantInput(asset, 160);
  const tokens = await Promise.all(Array.from({ length: 8 }, () => repository.claim(input)));
  assert.equal(tokens.filter(Boolean).length, 1);
  const receipt = await record(input);
  assert.deepEqual(await repository.complete(receipt, tokens.find(Boolean)!), receipt);
  assert.equal(await repository.claim(input), null);
  assert.deepEqual(await repository.find(input), receipt);
});

test('lease expiry allows takeover but fences late completion and late failure from the old worker', async () => {
  const input = deliveryVariantInput(asset, 320); const first = await repository.claim(input); assert(first);
  await isolated.query("UPDATE media_delivery_variant SET lease_until=clock_timestamp()-interval '1 second' WHERE cache_key=$1", [deliveryVariantKey(input)]);
  const receipt = await record(input);
  assert.equal(await repository.complete(receipt, first), null, 'Even before takeover, an expired owner cannot complete');
  const second = await repository.claim(input); assert(second); assert.notEqual(first, second);
  await repository.fail(input, first);
  assert.equal(await repository.complete(receipt, first), null);
  assert.deepEqual(await repository.complete(receipt, second), receipt);
});

test('a source binding mismatch cannot claim or complete and a failed cache returns to pending', async () => {
  const input = deliveryVariantInput(asset, 480);
  assert.equal(await repository.claim({ ...input, sourcePathname: 'ai/unrelated.webp' }), null);
  const token = await repository.claim(input); assert(token);
  // The production ai_asset table additionally rejects this mutation. A minimal
  // test fixture permits it to prove the final fenced statement checks binding.
  await isolated.query('UPDATE ai_asset SET blob_pathname=$1 WHERE id=$2', ['ai/new.webp', asset.id]);
  assert.equal(await repository.complete(await record(input), token), null);
  await isolated.query('UPDATE ai_asset SET blob_pathname=$1 WHERE id=$2', [asset.blobPathname, asset.id]);
  await repository.fail(input, token);
  const state = await isolated.query('SELECT status,lease_token,error_code FROM media_delivery_variant WHERE cache_key=$1', [deliveryVariantKey(input)]);
  assert.deepEqual(state.rows[0], { status: 'pending', lease_token: null, error_code: 'VARIANT_UNAVAILABLE' });
});

test('the database prevents incomplete ready receipts and public roles cannot mutate the private index', async () => {
  const input = deliveryVariantInput(asset, 640); const token = await repository.claim(input); assert(token);
  await assert.rejects(isolated.query("UPDATE media_delivery_variant SET status='ready',lease_token=NULL,lease_until=NULL WHERE cache_key=$1", [deliveryVariantKey(input)]), (error: unknown) => (error as { code?: string }).code === '23514');
  const protection = await isolated.query("SELECT c.relrowsecurity AS rls, NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x WHERE x.grantee=0) AS no_public FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='media_delivery_variant'", [schema]);
  assert.deepEqual(protection.rows[0], { rls: true, no_public: true });
});

test('pending enumeration preserves immutable source identities, skips ready targets and paginates assets', async () => {
  const page = await repository.pending({ limit: 2 });
  assert.equal(page.nextAssetId, null); assert.equal(page.inputs.length, 5);
  for (const input of page.inputs) {
    assert.equal(input.assetId, asset.id); assert.equal(input.sourcePathname, asset.blobPathname);
    assert.equal(input.sourceIdentity, deliveryVariantKey(input));
    assert(!['responsive:160', 'responsive:320'].includes(input.variantKey));
  }
  assert.deepEqual(await repository.pending({ afterAssetId: asset.id, limit: 2 }), { inputs: [], nextAssetId: null });
});

test('pending SQL skips complete assets before LIMIT and extra or mismatched receipts cannot hide missing declared targets', async () => {
  const cursor = 'ffffffff-ffff-4fff-8fff-000000000000';
  const assets = ['hero', 'step', 'ingredient', 'ingredient', 'step', 'step'].map((kind, index) => ({
    id: `ffffffff-ffff-4fff-8fff-${String(index + 1).padStart(12, '0')}`, kind,
    blobPathname: `ai/test/pending-${index + 1}.webp`,
  }));
  for (const value of assets) await isolated.query('INSERT INTO ai_asset VALUES($1,$2,$3,512,512)', [value.id, value.blobPathname, value.kind]);
  assert.deepEqual(assets.slice(0, 3).map(value => declaredMediaVariants(value).length), [14, 8, 7]);
  const inputs = [
    ...assets.slice(0, 3).flatMap(value => declaredMediaVariants(value)),
    ...declaredMediaVariants(assets[3]).filter(input => input.variantKey !== 'responsive:1280'),
    deliveryVariantInput(assets[3], 1600), // Seven ready rows, but only six declared targets.
    ...declaredMediaVariants({ ...assets[4], blobPathname: 'ai/test/old-source.webp' }),
    ...declaredMediaVariants({ ...assets[5], kind: 'ingredient' }),
    deliveryVariantInput({ ...assets[5], kind: 'ingredient' }, 1600),
  ];
  const receipts = inputs.map(input => {
    const dimensions = deliveryVariantDimensions(input)!;
    return { ...input, key: deliveryVariantKey(input), sourceSha256: 'a'.repeat(64), sourceBytes: 100,
      blobPathname: deliveryVariantPath({ ...input, sourceSha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64) }),
      contentSha256: 'b'.repeat(64), byteLength: 100, width: dimensions.width, height: dimensions.height ?? 1 };
  });
  await isolated.query(`INSERT INTO media_delivery_variant
    (cache_key,asset_id,source_pathname,kind,variant_key,renderer_version,status,source_sha256,source_bytes,
      blob_pathname,content_sha256,byte_length,width,height,verified_at)
    SELECT key,"assetId","sourcePathname",kind,"variantKey","rendererVersion",'ready',"sourceSha256","sourceBytes",
      "blobPathname","contentSha256","byteLength",width,height,clock_timestamp()
    FROM jsonb_to_recordset($1::jsonb) AS r(key text,"assetId" text,"sourcePathname" text,kind text,
      "variantKey" text,"rendererVersion" text,"sourceSha256" text,"sourceBytes" integer,"blobPathname" text,
      "contentSha256" text,"byteLength" integer,width integer,height integer)`, [JSON.stringify(receipts)]);

  const first = await repository.pending({ afterAssetId: cursor, limit: 1 });
  assert.equal(first.nextAssetId, assets[3].id);
  assert.deepEqual(first.inputs.map(input => [input.assetId, input.variantKey]), [[assets[3].id, 'responsive:1280']]);
  const second = await repository.pending({ afterAssetId: first.nextAssetId!, limit: 1 });
  assert.equal(second.nextAssetId, assets[4].id);
  assert.equal(second.inputs.length, 8);
  assert(second.inputs.every(input => input.assetId === assets[4].id && input.sourcePathname === assets[4].blobPathname));
  const third = await repository.pending({ afterAssetId: second.nextAssetId!, limit: 2 });
  assert.equal(third.nextAssetId, null);
  assert.equal(third.inputs.length, 8);
  assert(third.inputs.every(input => input.assetId === assets[5].id && input.kind === 'step'));
  assert.deepEqual(await repository.pending({ afterAssetId: assets[5].id, limit: 1 }), { inputs: [], nextAssetId: null });
});
