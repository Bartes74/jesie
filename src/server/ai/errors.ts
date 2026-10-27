import type { EditorialRecord } from '../../lib/editorial-types';

export class AiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly latest?: EditorialRecord) {
    super(message); this.name = 'AiError';
  }
}
