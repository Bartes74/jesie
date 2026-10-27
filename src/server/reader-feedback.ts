import 'server-only';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '@/server/db';
import { readerFeedbackInput, type ReaderFeedback, type ReaderFeedbackInput } from '@/lib/reader-feedback';

const response = (status: number, error?: string) => Response.json(error ? { error } : { accepted: true }, { status, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
type Dependencies = { published: (id: string, version?: string) => Promise<{ version?: string; steps: { id: string }[] } | null>; submit: (input: ReaderFeedbackInput) => Promise<boolean> };
class FeedbackConflict extends Error {}
export function sameFeedbackSubmission(stored: Record<string, unknown>, input: ReaderFeedbackInput): boolean {
  return stored.recipe_id === input.recipeId && Number(stored.publication_revision) === Number(input.version)
    && stored.kind === input.kind && (stored.step_id ?? null) === (input.stepId ?? null) && stored.message === input.message;
}

async function publishedVersion(id: string, version?: string) {
  if (!version) return null;
  // Steps belong to the submitted immutable publication, not a newer page which
  // may have removed or renamed a step while the reader was cooking.
  const result = await getDb().execute(sql`SELECT p.revision,p.snapshot->'recipe'->'steps' AS steps
    FROM editorial_recipe r JOIN editorial_publication p ON p.recipe_id=r.id AND p.revision=${Number(version)}
    WHERE r.id=${id} AND r.publication_status='published' AND r.deleted_at IS NULL LIMIT 1`);
  const row = result.rows[0];
  if (!row || !Array.isArray(row.steps)) return null;
  return { version: String(row.revision), steps: row.steps.flatMap((step: unknown) => step && typeof step === 'object' && typeof (step as { id?: unknown }).id === 'string' ? [{ id: (step as { id: string }).id }] : []) };
}

async function submit(input: ReaderFeedbackInput) {
  return getDb().transaction(async tx => {
    // Cap voluntary reports per recipe/day without retaining IPs or visitor identifiers.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'reader-feedback:' + input.recipeId}))`);
    const prior = await tx.execute(sql`SELECT recipe_id,publication_revision,kind,step_id,message FROM reader_feedback WHERE request_key=${input.requestKey}::uuid`);
    if (prior.rows.length) {
      if (!sameFeedbackSubmission(prior.rows[0], input)) throw new FeedbackConflict();
      return true;
    }
    const count = await tx.execute(sql`SELECT count(*)::int AS count FROM reader_feedback WHERE recipe_id=${input.recipeId} AND created_at>=now()-interval '24 hours'`);
    if (Number(count.rows[0]?.count) >= 200) return false;
    // Bind the submitted revision to an actual immutable publication, including a
    // valid older page open while the owner released an update.
    const result = await tx.execute(sql`INSERT INTO reader_feedback(id,request_key,recipe_id,publication_revision,kind,step_id,message)
      SELECT ${randomUUID()}::uuid,${input.requestKey}::uuid,r.id,p.revision,${input.kind},${input.stepId ?? null},${input.message}
      FROM editorial_recipe r JOIN editorial_publication p ON p.recipe_id=r.id AND p.revision=${Number(input.version)}
      WHERE r.id=${input.recipeId} AND r.publication_status='published' AND r.deleted_at IS NULL
        AND (${input.stepId ?? null}::text IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(p.snapshot->'recipe'->'steps') step WHERE step->>'id'=${input.stepId ?? null}))
      ON CONFLICT(request_key) DO NOTHING RETURNING id`);
    if (result.rows.length) return true;
    // A conflicting key from another recipe uses a different recipe lock. Read
    // the unique-key winner after INSERT, rather than acknowledging other text.
    const winner = await tx.execute(sql`SELECT recipe_id,publication_revision,kind,step_id,message FROM reader_feedback WHERE request_key=${input.requestKey}::uuid`);
    if (winner.rows.length) {
      if (!sameFeedbackSubmission(winner.rows[0], input)) throw new FeedbackConflict();
      return true;
    }
    return false;
  });
}

export async function handleReaderFeedback(request: Request, overrides: Partial<Dependencies> = {}) {
  try {
    if (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') return response(403, 'Niedozwolone pochodzenie.');
    if (!request.headers.get('content-type')?.startsWith('application/json')) return response(415, 'Wymagany format JSON.');
    if (Number(request.headers.get('content-length') ?? 0) > 8192 || !request.body) return response(413, 'Wiadomość jest zbyt długa.');
    const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > 8192) { await reader.cancel(); return response(413, 'Wiadomość jest zbyt długa.'); } chunks.push(next.value); } }
    finally { reader.releaseLock(); }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { return response(400, 'Nieprawidłowa wiadomość.'); }
    const parsed = readerFeedbackInput.safeParse(body);
    if (!parsed.success) return response(400, 'Wybierz odpowiedź i opisz zmianę lub problem (maksymalnie 1500 znaków).');
    const revision = Number(parsed.data.version);
    if (!Number.isSafeInteger(revision) || revision < 1 || revision > 2_147_483_647) return response(400, 'Nieprawidłowa wersja przepisu.');
    const dependencies: Dependencies = { published: publishedVersion, submit, ...overrides };
    const recipe = await dependencies.published(parsed.data.recipeId, parsed.data.version);
    if (!recipe || (parsed.data.stepId && !recipe.steps.some(step => step.id === parsed.data.stepId))) return response(404, 'Ten przepis lub krok nie jest już dostępny.');
    const accepted = await dependencies.submit(parsed.data);
    return accepted ? response(202) : response(429, 'Nie można teraz przyjąć kolejnej opinii. Spróbuj później.');
  } catch (error) {
    if (error instanceof FeedbackConflict) return response(409, 'Ta próba wysłania dotyczy już innej opinii. Odśwież formularz i spróbuj ponownie.');
    return response(503, 'Nie udało się wysłać opinii. Zachowaj treść i spróbuj ponownie.');
  }
}

export async function getReaderFeedback(): Promise<{ available: boolean; items: ReaderFeedback[] }> {
  try {
    const result = await getDb().execute(sql`SELECT f.*,r.content->'recipe'->'title'->>'pl' AS title FROM reader_feedback f JOIN editorial_recipe r ON r.id=f.recipe_id WHERE f.status='open' ORDER BY CASE f.kind WHEN 'problem' THEN 0 ELSE 1 END,f.created_at DESC LIMIT 50`);
    return { available: true, items: result.rows.map(row => ({ id: String(row.id), recipeId: String(row.recipe_id), title: String(row.title || 'Przepis'), revision: Number(row.publication_revision), kind: row.kind as ReaderFeedback['kind'], stepId: row.step_id as string | null, message: String(row.message), createdAt: new Date(row.created_at as string).toISOString(), status: 'open' })) };
  } catch (error) {
    if ((error as { cause?: { code?: string }; code?: string }).code === '42P01' || (error as { cause?: { code?: string } }).cause?.code === '42P01') return { available: false, items: [] };
    throw error;
  }
}

export async function resolveReaderFeedback(id: string, actorId: string) {
  await getDb().execute(sql`UPDATE reader_feedback SET status='resolved',resolved_at=now(),resolved_by=${actorId} WHERE id=${id}::uuid AND status='open'`);
}
