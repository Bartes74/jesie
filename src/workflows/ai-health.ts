import { checkAiInfrastructure } from '@/server/ai/health';

export async function aiHealth() {
  'use workflow';
  return await checkAiInfrastructure();
}
