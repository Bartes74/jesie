import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
import { getDb, closeDb } from '../src/server/db';
import { aiPhotoBatches } from '../src/server/ai/schema';
import { reuseReviewedLiquidCream, type ReviewedLiquidCreamReuse } from '../src/server/ai/reviewed-photo-correction';
const option = (name: string) => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
config({ path: option('--env') ?? '.env.production.local', quiet: true });
async function main() { try {
  const path = option('--manifest'); if (!path || !process.argv.includes('--apply')) throw new Error('REVIEWED_MANIFEST_AND_APPLY_REQUIRED');
  const input = JSON.parse(await readFile(resolve(path), 'utf8')) as ReviewedLiquidCreamReuse;
  const [batch] = await getDb().select().from(aiPhotoBatches).where(eq(aiPhotoBatches.id, input.batchId));
  if (!batch) throw new Error('BATCH_NOT_FOUND');
  const result = await reuseReviewedLiquidCream(input, { id: batch.createdBy, name: batch.createdByName, role: 'admin', email: '' });
  console.log(JSON.stringify({ batchId: result.id, status: result.status, paidSubmission: false,
    originalCeilingUsd: result.reservedUsd, remainingReservedUsd: result.remainingReservedUsd,
    ingredient: result.slots.find(slot => slot.kind === 'ingredient' && slot.targetId === input.targetId)?.job }));
} finally { await closeDb(); } }
void main().catch(error => { console.error('REVIEWED_CREAM_REUSE_FAILED', error instanceof Error && 'code' in error ? String(error.code) : 'CHECK_PRIVATE_MANIFEST'); process.exitCode = 1; });
