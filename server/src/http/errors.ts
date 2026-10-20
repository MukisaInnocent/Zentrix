import type { NextFunction, Request, Response } from 'express';
import { AppError, DB_ERRORS, pgErrorCode } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';

function bodyParserType(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'type' in err && typeof err.type === 'string' ? err.type : undefined;
}

// Turns every error into { error: { code, message, fields?, requestId } }. Internal details never reach
// the client; 5xx errors are logged with the request id the client sees.
export function errorHandler(logger: Logger) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    let status = 500;
    let code = 'internal_error';
    let message = 'Something went wrong. Please try again.';
    let fields: Record<string, string[]> | undefined;
    const pg = pgErrorCode(err);
    const parserType = bodyParserType(err);
    if (err instanceof AppError) {
      ({ status, code, message, fields } = err);
    } else if (parserType === 'entity.parse.failed') {
      status = 400;
      code = 'invalid_json';
      message = 'The request body is not valid JSON.';
    } else if (parserType === 'entity.too.large') {
      status = 413;
      code = 'payload_too_large';
      message = 'The request is too large.';
    } else if (pg === DB_ERRORS.uniqueViolation) {
      status = 409;
      code = 'conflict';
      message = 'That conflicts with an existing record.';
    } else if (pg === DB_ERRORS.checkViolation) {
      status = 400;
      code = 'invalid_values';
      message = 'Some values are not allowed. Check them and try again.';
    } else if (pg === DB_ERRORS.appendOnly || pg === DB_ERRORS.immutableColumn) {
      status = 409;
      code = 'conflict.immutable';
      message = 'That record cannot be changed.';
    }
    if (status >= 500) logger.error({ err, reqId: req.id }, 'request failed');
    if (res.headersSent) return;
    res.status(status).json({ error: { code, message, ...(fields ? { fields } : {}), requestId: req.id } });
  };
}
