import type { z } from 'zod';
import { badRequest, type AppError } from '../lib/errors.js';

function validationError(err: z.ZodError): AppError {
  const fields: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_form';
    (fields[key] ??= []).push(issue.message);
  }
  return badRequest('validation_failed', 'Please check the highlighted fields.', fields);
}

// Every endpoint parses its input with a strict Zod schema (section 11). Unknown keys are rejected.
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input ?? {});
  if (!result.success) throw validationError(result.error);
  return result.data;
}
