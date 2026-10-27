import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
import { recipes } from '../src/lib/recipes';
import { getIngredientImage, getStepImage } from '../src/lib/recipe-media';
import type { EditorialContent } from '../src/lib/editorial-types';

async function main() {
  config({ path: process.argv[2] || '.env.local', quiet: true });
  const { getDb, closeDb } = await import('../src/server/db');
  const { editorialRecipes, editorialPublications, editorialVersions, editorialSlugs, editorialAudit } = await import('../src/server/db/schema');
  const { contentHash, emptyChecks } = await import('../src/server/editorial/store');
  let inserted = 0;
  try {
    for (const recipe of recipes) {
      await getDb().transaction(async tx => {
        const content: EditorialContent = { recipe, originalText: `${recipe.title.pl}\n\n${recipe.description.pl}\n\n${recipe.steps.map(step => `${step.title.pl}\n${step.text.pl}`).join('\n\n')}`, author: 'Demonstracja projektu', sources: [], photos: { ingredients: Object.fromEntries(recipe.ingredients.map(ingredient => [ingredient.id, getIngredientImage(recipe.id, ingredient.id)])), steps: Object.fromEntries(recipe.steps.map(step => [step.id, getStepImage(recipe.id, step.id)])) } };
        const hash = contentHash(content);
        const checks = emptyChecks();
        const [row] = await tx.insert(editorialRecipes).values({ id: recipe.id, content, contentHash: hash, checks, createdBy: 'legacy-demo-import', updatedBy: 'legacy-demo-import', updatedByName: 'Import istniejącej demonstracji' }).onConflictDoNothing().returning();
        if (!row) return; // Never overwrite edits or resurrect an unpublished imported recipe.
        const publicationId = randomUUID();
        await tx.insert(editorialVersions).values({ recipeId: row.id, revision: 1, content, contentHash: hash, reason: 'Import istniejącej wersji demonstracyjnej, bez ręcznych akceptacji', createdBy: 'legacy-demo-import', createdByName: 'Import istniejącej demonstracji' });
        await tx.insert(editorialPublications).values({ id: publicationId, recipeId: row.id, revision: 1, snapshot: content, contentHash: hash, checks, approvalOrigin: 'legacy_demo_import', publishedBy: 'legacy-demo-import', publishedByName: 'Import istniejącej demonstracji' });
        await tx.update(editorialRecipes).set({ publishedId: publicationId, publishedRevision: 1, publicationStatus: 'published' }).where(eq(editorialRecipes.id, row.id));
        await tx.insert(editorialSlugs).values((['pl', 'en'] as const).map(locale => ({ locale, slug: recipe.slug[locale], recipeId: row.id })));
        await tx.insert(editorialAudit).values({ id: randomUUID(), recipeId: row.id, revision: 1, action: 'legacy_demo_import', actorId: 'legacy-demo-import', actorName: 'Import istniejącej demonstracji' });
        inserted++;
      });
    }
    console.log(`Imported ${inserted} existing demo recipes; existing records were preserved.`);
  } finally { await closeDb(); }
}
main().catch(() => { console.error('Editorial seed failed. No credentials were logged.'); process.exitCode = 1; });
