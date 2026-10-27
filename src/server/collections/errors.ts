import { adminFailure, adminResponse } from '@/server/http/admin';
import type { CollectionIssue, CollectionRecord } from '@/lib/collections';

export class CollectionError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string,
    public readonly latest?: CollectionRecord, public readonly issues?: CollectionIssue[]) {
    super(message); this.name = 'CollectionError';
  }
}
export function collectionFailure(error: unknown) {
  if (error instanceof CollectionError) return adminResponse({ code: error.code, error: error.message, latest: error.latest, issues: error.issues }, error.status);
  return adminFailure(error);
}
