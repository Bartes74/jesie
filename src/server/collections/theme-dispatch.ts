import 'server-only';
import { start } from 'workflow/api';
import { collectionThemeWorkflow } from '@/workflows/collection-theme';
import { attachThemeWorkflow, claimThemeDispatch, stopThemeGeneration } from './theme-store';

export async function dispatchThemeGeneration(id: string) {
  const token = await claimThemeDispatch(id);
  if (!token) return;
  try {
    const run = await start(collectionThemeWorkflow, [id, token], { region: 'fra1' });
    await attachThemeWorkflow(id, token, run.runId);
  } catch {
    await stopThemeGeneration(id, 'Nie potwierdzono uruchomienia generowania. Zachowano zlecenie; sprawdź i wznów je w panelu.', token);
  }
}
