export type PhotoBillingReadStatus = 'verified' | 'pending' | 'not_configured' | 'unauthenticated' | 'forbidden' | 'unavailable' | 'invalid';
export type PhotoBatchBilling = {
  batchId: string; checkedAt: string; originalReservationUsd: string;
  verifiedCostUsd: string; conservativeCostUsd: string; remainingReservationUsd: string;
  totalCommitmentUsd: string; availableWithinOriginalUsd: string;
  pendingJobs: number; reconciledJobs: number;
  read: { status: PhotoBillingReadStatus; httpStatus: number | null };
};
