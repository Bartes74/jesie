import { getWorkflowMetadata } from 'workflow';
import { claimMediaMaintenanceStep, advanceMediaMaintenanceStep, stopMediaMaintenanceStep } from '@/server/media-maintenance/steps';

export async function mediaMaintenance(id: string,generation: number) {
  'use workflow';
  if (!await claimMediaMaintenanceStep(id,generation,getWorkflowMetadata().workflowRunId)) return;
  try {
    // Bounded run history; the hourly dispatcher resumes saved cursors if the
    // catalogue eventually grows beyond one run's event budget.
    for (let batch=0;batch<800;batch++) {
      const result=await advanceMediaMaintenanceStep(id,generation);
      if (result.state!=='continue') return result;
    }
  } catch { /* Safe, persisted phase and immutable receipts survive the run. */ }
  await stopMediaMaintenanceStep(id,generation);
}
