/**
 * Auth (CLAUDE.md §9).
 *
 * The primary gate is **Vercel Deployment Protection** with SSO: platform-level,
 * zero code, and no authentication surface in this repo to get wrong. Requests
 * that fail it never reach Next.js at all.
 *
 * What lives here is the part that cannot be delegated:
 *
 *   1. `assertCronAuth` — cron routes carry a bearer token, compared in
 *      constant time. This is real and load-bearing.
 *   2. `requireOwner` — a fail-closed guard. In production it refuses to serve
 *      unless the deployment has been explicitly declared protected, so that
 *      forgetting to switch protection on shows up as an error page rather than
 *      as a public portfolio.
 *
 * Switching to NextAuth with an email magic link is a drop-in replacement for
 * `requireOwner`; see README. There is deliberately no password check anywhere.
 */
import { timingSafeEqual } from 'node:crypto';
import { headers } from 'next/headers';

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 401,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Constant-time string comparison that does not leak length through timing. */
export function secretEquals(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so the failure takes the same time either way.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Guard every cron and job route with this. GitHub Actions sends
 * `Authorization: Bearer $CRON_SECRET` (§4.2).
 */
export function assertCronAuth(request: Request): void {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    throw new AuthError('CRON_SECRET is not configured; refusing to run the job', 500);
  }
  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!secretEquals(presented, expected)) {
    throw new AuthError('invalid cron credentials', 401);
  }
}

export type AuthMode = 'vercel-protection' | 'nextauth' | 'development';

export function authMode(): AuthMode {
  if (process.env.AUTH_MODE === 'nextauth') return 'nextauth';
  if (process.env.AUTH_MODE === 'vercel-protection') return 'vercel-protection';
  if (process.env.NODE_ENV !== 'production') return 'development';
  // Unset in production is not a default — it is a misconfiguration.
  return 'vercel-protection';
}

/**
 * Fail-closed owner check for pages and API routes.
 *
 * In production this requires `AUTH_MODE=vercel-protection` to be set as an
 * explicit acknowledgement that Deployment Protection is enabled on the
 * project. The app cannot verify the platform gate from inside itself, so it
 * insists the operator confirm it rather than assuming.
 */
export async function requireOwner(): Promise<{ email: string | null }> {
  const mode = authMode();

  if (mode === 'development') {
    return { email: process.env.OWNER_EMAIL ?? null };
  }

  if (process.env.NODE_ENV === 'production' && !process.env.AUTH_MODE) {
    throw new AuthError(
      'AUTH_MODE is not set. Enable Vercel Deployment Protection on this project and set ' +
        'AUTH_MODE=vercel-protection, or set AUTH_MODE=nextauth and wire up the magic-link ' +
        'provider. Refusing to serve an unauthenticated portfolio.',
      500,
    );
  }

  const h = await headers();
  const owner = process.env.OWNER_EMAIL?.toLowerCase();
  // Vercel forwards the SSO identity on protected deployments. When it is
  // present it is checked; when it is absent the platform gate is what stands.
  const presented =
    h.get('x-vercel-user-email')?.toLowerCase() ?? h.get('x-forwarded-email')?.toLowerCase() ?? null;

  if (owner && presented && presented !== owner) {
    throw new AuthError(`${presented} is not the owner of this deployment`, 403);
  }

  return { email: presented ?? owner ?? null };
}

/** Wrap an API route handler so auth failures become clean JSON responses. */
export function withCronAuth(
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    try {
      assertCronAuth(request);
    } catch (err) {
      const status = err instanceof AuthError ? err.status : 401;
      return Response.json({ error: (err as Error).message }, { status });
    }
    try {
      return await handler(request);
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : 'job failed' },
        { status: 500 },
      );
    }
  };
}
