export type ProviderIssue = { field: string; message: string; code?: string };

export class ProviderError extends Error {
  readonly issues: ProviderIssue[];
  readonly repairable: boolean;
  constructor(public readonly code: string, message: string, public readonly uncertain = false, public readonly chargedUsd?: string,
    details: { issues?: readonly ProviderIssue[]; repairable?: boolean } = {}) {
    super(message); this.name = 'ProviderError';
    this.issues = (details.issues ?? []).slice(0, 40).map(issue => ({ field: issue.field.slice(0, 250), message: issue.message.slice(0, 1000),
      ...(issue.code ? { code: issue.code.slice(0, 80) } : {}) }));
    this.repairable = details.repairable === true && !uncertain;
  }
}
