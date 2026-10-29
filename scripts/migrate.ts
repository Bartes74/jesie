import { spawnSync } from 'node:child_process';
const envFile = process.argv[2] || '.env.local';
for (const script of ['scripts/migrate-auth.ts', 'scripts/migrate-editorial.ts', 'scripts/migrate-ai.ts', 'scripts/migrate-trends.ts', 'scripts/migrate-ingredient-reuse.ts', 'scripts/migrate-photo-corrections.ts', 'scripts/migrate-photo-batches.ts', 'scripts/migrate-ai-budget-settings.ts', 'scripts/migrate-daily-publication.ts', 'scripts/migrate-seo-discovery.ts', 'scripts/migrate-seo-metrics.ts', 'scripts/migrate-reviewed-publication-guard.ts', 'scripts/migrate-seo-workflows.ts', 'scripts/migrate-recipe-trash.ts', 'scripts/migrate-media-compaction.ts', 'scripts/migrate-publication-plan.ts', 'scripts/migrate-content-approval.ts', 'scripts/migrate-simplified-daily-automation.ts', 'scripts/migrate-manual-automation-takeover.ts', 'scripts/migrate-recipe-result-recovery.ts']) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', script, envFile], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
for (const migration of ['0022-media-maintenance', '0023-media-backup-proof-guards']) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/migrate-media-maintenance.ts', envFile, migration], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
const kitchen = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/migrate-kitchen-experience.ts', envFile], { stdio: 'inherit' });
if (kitchen.status !== 0) process.exit(kitchen.status || 1);
const planMetrics = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/migrate-plan-metrics.ts', envFile], { stdio: 'inherit' });
if (planMetrics.status !== 0) process.exit(planMetrics.status || 1);
const costOnly = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/migrate-remove-spending-limits.ts', envFile], { stdio: 'inherit' });
if (costOnly.status !== 0) process.exit(costOnly.status || 1);
const manualReview = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/migrate-manual-review-workflow.ts', envFile], { stdio: 'inherit' });
if (manualReview.status !== 0) process.exit(manualReview.status || 1);
const ingredientDictionary = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/migrate-ingredient-dictionary.ts', envFile], { stdio: 'inherit' });
if (ingredientDictionary.status !== 0) process.exit(ingredientDictionary.status || 1);
const ingredientEvidenceRecheck = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/migrate-ingredient-evidence-recheck.ts', envFile], { stdio: 'inherit' });
if (ingredientEvidenceRecheck.status !== 0) process.exit(ingredientEvidenceRecheck.status || 1);
for (const script of ['scripts/migrate-collections.ts', 'scripts/migrate-collection-themes.ts', 'scripts/migrate-collection-accents.ts', 'scripts/migrate-site-pages.ts']) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', script, envFile], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
