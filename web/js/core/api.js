import { t, has } from './i18n.js';

// JSON client for /api. Adds the CSRF header from the readable CSRF cookie, an Idempotency-Key when asked
// (every money-moving call, from Phase 2), and turns errors into ApiError with a localized message.
export class ApiError extends Error {
  constructor(status, code, message, fields, requestId) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.requestId = requestId;
  }
}

function csrfToken() {
  for (const part of document.cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === '__Host-zx_csrf' || name === 'zx_csrf') return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export const newIdempotencyKey = () => crypto.randomUUID();

export function loginUrl() {
  return `/login.html?next=${encodeURIComponent(`${location.pathname}${location.search}${location.hash}`)}`;
}

let onUnauthorized = null;
// App pages register a handler that sends the member to sign in and back again (section 5).
export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

export async function request(method, path, body, options = {}) {
  const headers = { Accept: 'application/json' };
  const unsafe = method !== 'GET' && method !== 'HEAD';
  if (unsafe) {
    headers['Content-Type'] = 'application/json';
    const token = csrfToken();
    if (token) headers['X-CSRF-Token'] = token;
  }
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  let res;
  try {
    res = await fetch(path, {
      method, headers, credentials: 'same-origin', signal: options.signal,
      body: unsafe ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, 'network', t('errors.network', {}, 'Network problem. Check your connection and try again.'));
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.ok) return data;
  const err = data?.error ?? {};
  const code = err.code ?? `http_${res.status}`;
  const message = has(`errors.${code}`) ? t(`errors.${code}`) : err.message ?? t('errors.unexpected', {}, 'Something went wrong.');
  const apiError = new ApiError(res.status, code, message, err.fields, err.requestId);
  if (res.status === 401 && code === 'auth.required' && onUnauthorized && !options.noRedirect) onUnauthorized(apiError);
  throw apiError;
}

export const api = {
  get: (path, options) => request('GET', path, undefined, options),
  post: (path, body, options) => request('POST', path, body, options),
  put: (path, body, options) => request('PUT', path, body, options),
  patch: (path, body, options) => request('PATCH', path, body, options),
  delete: (path, options) => request('DELETE', path, undefined, options),
};
