const connectionCodes = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  '57P01', '57P02', '57P03', '53300', '28P01', '28000', '3D000',
]);

// These exact strings come from pg/pg-pool, which can omit a connection code.
const connectionMessages = new Set([
  'DATABASE_NOT_CONFIGURED',
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout',
  'Connection terminated unexpectedly',
]);

/** Follow only the cause chain; query text and parameters are never inspected or returned. */
export function isDatabaseUnavailable(error: unknown): boolean {
  let current = error;
  const seen = new Set<object>();
  for (let depth = 0; depth < 20 && current && typeof current === 'object'; depth++) {
    if (seen.has(current)) return false;
    seen.add(current);
    const code = Object.getOwnPropertyDescriptor(current, 'code')?.value as unknown;
    const message = Object.getOwnPropertyDescriptor(current, 'message')?.value as unknown;
    if (typeof code === 'string' && (connectionCodes.has(code) || /^08[A-Z0-9]{3}$/.test(code))) return true;
    if (typeof message === 'string' && connectionMessages.has(message)) return true;
    current = Object.getOwnPropertyDescriptor(current, 'cause')?.value as unknown;
  }
  return false;
}
