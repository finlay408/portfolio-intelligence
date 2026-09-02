/** Shared fetch plumbing: timeouts, retries and typed provider errors. */
import { ProviderError, RateLimitError, type Capability } from './types';

export interface FetchOptions {
  provider: string;
  capability: Capability;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Retries on 5xx and network errors only. 429 is surfaced immediately. */
  retries?: number;
}

export async function fetchJson<T>(url: string, opts: FetchOptions): Promise<T> {
  const { provider, capability, timeoutMs = 12_000, retries = 2 } = opts;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          // Yahoo's endpoints reject requests without a browser-shaped UA.
          'User-Agent': 'portfolio-intelligence/0.1 (+private single-user analytics)',
          Accept: 'application/json',
          ...opts.headers,
        },
        signal: controller.signal,
      });

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after') ?? '60') * 1000;
        throw new RateLimitError(provider, capability, retryAfter);
      }
      if (res.status >= 500) {
        throw new ProviderError(provider, capability, `upstream ${res.status}`, res.status);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new ProviderError(
          provider,
          capability,
          `${res.status} ${body.slice(0, 200)}`,
          res.status,
        );
      }
      return (await res.json()) as T;
    } catch (err) {
      lastError = err;
      if (err instanceof RateLimitError) throw err;
      if (err instanceof ProviderError && err.status && err.status < 500) throw err;
      if (attempt === retries) break;
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof ProviderError
    ? lastError
    : new ProviderError(provider, capability, String(lastError));
}

export async function fetchText(url: string, opts: FetchOptions): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'portfolio-intelligence/0.1', ...opts.headers },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new ProviderError(opts.provider, opts.capability, `${res.status}`, res.status);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}
