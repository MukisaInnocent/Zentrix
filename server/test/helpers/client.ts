export const TEST_ORIGIN = 'http://localhost:3000';

export interface TestResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

// A browser-like HTTP client: keeps cookies, sends Origin and the CSRF header on state-changing calls,
// and presents a fixed client IP through X-Forwarded-For (the test app trusts one proxy hop).
export class TestClient {
  readonly cookies = new Map<string, string>();
  constructor(private readonly baseUrl: string, readonly ip: string) {}

  async request<T = Record<string, unknown>>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<TestResponse<T>> {
    const unsafe = !['GET', 'HEAD'].includes(method);
    const h: Record<string, string> = { 'x-forwarded-for': this.ip, ...headers };
    if (unsafe) {
      h['content-type'] ??= 'application/json';
      h.origin ??= TEST_ORIGIN;
      const csrf = this.cookies.get('zx_csrf');
      if (csrf !== undefined && h['x-csrf-token'] === undefined) h['x-csrf-token'] = csrf;
    }
    if (this.cookies.size > 0) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const payload = unsafe ? (typeof body === 'string' ? body : JSON.stringify(body ?? {})) : undefined;
    const res = await fetch(this.baseUrl + path, { method, headers: h, body: payload, redirect: 'manual' });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair = '', ...attrs] = cookie.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some(a => /max-age=0/i.test(a.trim()) || /expires=thu, 01 jan 1970/i.test(a.trim()));
      if (expired || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON (HTML pages); keep the text.
    }
    return { status: res.status, body: parsed as T, headers: res.headers };
  }

  get<T = Record<string, unknown>>(path: string, headers?: Record<string, string>) {
    return this.request<T>('GET', path, undefined, headers);
  }
  post<T = Record<string, unknown>>(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>('POST', path, body, headers);
  }
  patch<T = Record<string, unknown>>(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>('PATCH', path, body, headers);
  }
  put<T = Record<string, unknown>>(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>('PUT', path, body, headers);
  }
  delete<T = Record<string, unknown>>(path: string, headers?: Record<string, string>) {
    return this.request<T>('DELETE', path, undefined, headers);
  }
}
