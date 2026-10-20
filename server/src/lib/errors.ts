// Errors the HTTP layer turns into JSON: { error: { code, message, fields? } }. The code is stable and
// machine-readable; the browser maps it to a localized string and falls back to the message.
export class AppError extends Error {
  override name = 'AppError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string[]>,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, fields?: Record<string, string[]>) =>
  new AppError(400, code, message, fields);
export const unauthorized = (code = 'auth.required', message = 'Please sign in to continue.') =>
  new AppError(401, code, message);
export const forbidden = (code = 'auth.forbidden', message = 'You do not have access to this.') =>
  new AppError(403, code, message);
export const notFound = (code = 'not_found', message = 'Not found.') => new AppError(404, code, message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const tooManyRequests = (message = 'Too many attempts. Please wait and try again.') =>
  new AppError(429, 'rate_limited', message);

// SQLSTATE codes raised by Zentrix triggers (see server/migrations).
export const DB_ERRORS = {
  appendOnly: 'ZX001',
  immutableColumn: 'ZX002',
  configMismatch: 'ZX003',
  uniqueViolation: '23505',
  checkViolation: '23514',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
} as const;

export function pgErrorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
}
