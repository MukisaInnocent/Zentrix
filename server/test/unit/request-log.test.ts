import { describe, expect, it } from 'vitest';
import { requestLogLevel } from '../../src/http/basics.js';

describe('request log level', () => {
  it('keeps pages and API calls at info, quiets health checks and static files, and always reports failures', () => {
    expect(requestLogLevel('/api/wallet/summary', 200)).toBe('info');
    expect(requestLogLevel('/dashboard.html', 304)).toBe('info');
    expect(requestLogLevel('/healthz', 200)).toBe('debug');
    expect(requestLogLevel('/js/core/api.js', 304)).toBe('debug');
    expect(requestLogLevel('/img/icons.svg', 200)).toBe('debug');
    expect(requestLogLevel('/js/core/missing.js', 404)).toBe('warn');
    expect(requestLogLevel('/healthz', 503)).toBe('error');
  });
});
