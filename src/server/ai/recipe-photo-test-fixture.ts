import { createHash, randomUUID } from 'node:crypto';
import type { EditorialContent } from '@/lib/editorial-types';
import { getDb } from '@/server/db';
import { aiAssets, aiJobs } from './schema';
import { approvedImageModel } from './image-actions';

/** Test fixtures have their own immutable sources instead of borrowing a seed
 * photo for different food. No result is attached, so these source rows cannot
 * satisfy a test that intentionally admits a new missing-photo job. */
export async function registerFixturePhotos(content: EditorialContent, actor: { id: string; name: string }, baseRevision: number) {
  const input = structuredClone(content);
  const jobs: typeof aiJobs.$inferInsert[] = [], assets: typeof aiAssets.$inferInsert[] = [];
  const slots = [
    ...(content.recipe.image ? [{ kind: 'hero' as const, targetId: null, photo: { src: content.recipe.image, alt: content.recipe.imageAlt, caption: { pl: '', en: '' } } }] : []),
    ...content.recipe.ingredients.flatMap(item => content.photos.ingredients[item.id] ? [{ kind: 'ingredient' as const, targetId: item.id, photo: content.photos.ingredients[item.id] }] : []),
    ...content.recipe.steps.flatMap(item => content.photos.steps[item.id] ? [{ kind: 'step' as const, targetId: item.id, photo: content.photos.steps[item.id] }] : []),
  ];
  for (const slot of slots) {
    const id = randomUUID(), height = slot.kind === 'step' ? 960 : 1024, width = slot.kind === 'step' ? 2240 : 1024;
    jobs.push({ id, recipeId: content.recipe.id, baseRevision, kind: slot.kind, targetId: slot.targetId,
      status: 'applied', provider: 'fal', model: approvedImageModel, brief: 'Registered test fixture photo',
      requestKey: `fixture_${id}`, inputHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'), input,
      createdBy: actor.id, createdByName: actor.name, reservedUsd: '0', chargedUsd: '0', costBasis: 'usage', providerFinishedAt: new Date() });
    assets.push({ id, recipeId: content.recipe.id, jobId: id, kind: slot.kind, targetId: slot.targetId,
      blobPathname: `fixture/${id}.webp`, width, height, contentType: 'image/webp', alt: slot.photo.alt,
      caption: slot.photo.caption ?? { pl: '', en: '' }, model: approvedImageModel });
    if (slot.kind === 'hero') content.recipe.image = `/media/${id}`;
    else content.photos[slot.kind === 'ingredient' ? 'ingredients' : 'steps'][slot.targetId!] = {
      ...slot.photo, src: `/media/${id}`, columns: 1, rows: 1, index: 0, aspectRatio: width / height,
    };
  }
  if (jobs.length) { await getDb().insert(aiJobs).values(jobs); await getDb().insert(aiAssets).values(assets); }
  return content;
}
