import { RetryableError } from 'workflow';
import { getConfiguration } from './store';

export async function checkAiInfrastructure() {
  'use step';
  try {
    const configuration = await getConfiguration();
    return { database: true, workflow: true, openai: configuration.openai, fal: configuration.fal, storage: configuration.storage };
  } catch { throw new RetryableError('AI_INFRASTRUCTURE_UNAVAILABLE'); }
}
