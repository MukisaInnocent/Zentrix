import { pino, type Logger } from 'pino';

export type { Logger };

// Structured JSON logs to stdout (12-factor). Code never logs bodies, tokens or personal data on
// purpose; the redaction list is a safety net for mistakes.
export function createLogger(opts: { level: string; mode: string; service?: string }): Logger {
  return pino({
    level: opts.level,
    base: { service: opts.service ?? 'zentrix-api', mode: opts.mode },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: label => ({ level: label }) },
    redact: {
      paths: [
        'password', '*.password', 'newPassword', '*.newPassword', 'token', '*.token', 'code', '*.code',
        'secret', '*.secret', 'email', '*.email', 'phone', '*.phone', 'phoneE164', '*.phoneE164',
        'headers.cookie', 'req.headers.cookie', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]',
      ],
      censor: '[redacted]',
    },
  });
}
