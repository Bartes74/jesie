import type { PhotoBillingReadStatus } from './photo-batch-billing-types';

export type PhotoCostReconciliationReport = {
  checkedAt: string;
  scannedJobs: number;
  reconciledJobs: number;
  pendingJobs: number;
  alreadySettledJobs: number;
  remainingJobs: number;
  limited: boolean;
  estimatedCostBeforeUsd: string;
  verifiedCostUsd: string;
  before: { usedUsd: string; reservedUsd: string };
  after: { usedUsd: string; reservedUsd: string };
  read: { status: PhotoBillingReadStatus; httpStatus: number | null };
};
