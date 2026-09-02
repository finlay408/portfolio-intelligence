/**
 * Database client.
 *
 * `DATABASE_URL` is server-side only and must never be exposed with a
 * `NEXT_PUBLIC_` prefix (§9). The connection is cached across hot reloads and
 * across serverless invocations that reuse the same container; the pool is kept
 * small because Neon's and Supabase's free tiers cap connections tightly.
 *
 * The client is created lazily, on first query rather than on import. That
 * matters for one specific reason: `next build` imports every route module, and
 * a build should not need a live database.
 *
 * Two drivers:
 *   postgres://…   postgres.js against Neon or Supabase. The real one.
 *   pglite://<dir> an in-process Postgres, for local development and for the
 *                  end-to-end test, so neither needs a server installed.
 *
 * PGlite caveat: it is embedded and single-writer, so only ONE process may hold
 * a data directory at a time. A running `npm run dev` will not see writes made
 * by `npm run seed` in another terminal — restart the dev server after any CLI
 * job. Deployments use real Postgres and have no such constraint.
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

declare global {
  // eslint-disable-next-line no-var
  var __pgClient: ReturnType<typeof postgres> | undefined;
  // eslint-disable-next-line no-var
  var __drizzleDb: unknown;
  // eslint-disable-next-line no-var
  var __pgliteClient: { close: () => Promise<void> } | undefined;
}

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env and point it at your Neon or ' +
        'Supabase database, or use pglite://.data/local for an in-process one.',
    );
  }
  return url;
}

type PostgresDb = ReturnType<typeof drizzlePg<typeof schema>>;

function realDb(): PostgresDb {
  if (!globalThis.__drizzleDb) {
    const url = connectionString();

    if (url.startsWith('pglite://')) {
      // A synchronous require keeps `db` usable without every caller awaiting an
      // initialisation promise. PGlite is a devDependency and is never on the
      // deployed code path, so this branch never loads in production.
      const load = createRequire(import.meta.url);
      const { PGlite } = load('@electric-sql/pglite') as typeof import('@electric-sql/pglite');
      const { drizzle } = load('drizzle-orm/pglite') as typeof import('drizzle-orm/pglite');
      const dataDir = url.replace('pglite://', '');
      // PGlite will not create intermediate directories for its data dir.
      mkdirSync(dataDir, { recursive: true });
      const client = new PGlite(dataDir);
      globalThis.__pgliteClient = client;
      globalThis.__drizzleDb = drizzle(client, { schema }) as unknown as PostgresDb;
    } else {
      globalThis.__pgClient ??= postgres(url, {
        // Serverless containers should hold one connection each; free-tier
        // Postgres caps total connections tightly.
        max: process.env.VERCEL ? 1 : 5,
        idle_timeout: 20,
        connect_timeout: 15,
        // Required for transaction-mode poolers (Supabase pgbouncer).
        prepare: false,
      });
      globalThis.__drizzleDb = drizzlePg(globalThis.__pgClient, { schema });
    }
  }
  return globalThis.__drizzleDb as PostgresDb;
}

export const db: PostgresDb = new Proxy({} as PostgresDb, {
  get(_target, property, receiver) {
    return Reflect.get(realDb(), property, receiver);
  },
});

export { schema };
export type Db = PostgresDb;

/** For scripts that must close cleanly rather than hang on an open pool. */
export async function closeDb(): Promise<void> {
  if (globalThis.__pgClient) {
    await globalThis.__pgClient.end({ timeout: 5 });
    globalThis.__pgClient = undefined;
  }
  if (globalThis.__pgliteClient) {
    await globalThis.__pgliteClient.close();
    globalThis.__pgliteClient = undefined;
  }
  globalThis.__drizzleDb = undefined;
}
