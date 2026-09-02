/**
 * Apply the generated migrations.
 *
 *   npm run db:migrate           # drizzle-kit, against Postgres
 *   npm run migrate              # this script, works for pglite:// too
 *
 * drizzle-kit talks to Postgres directly and cannot see a pglite:// URL, so
 * local development gets this path instead. Both run the same SQL files.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { closeDb, db } from '../src/db';

const MIGRATIONS_DIR = path.join(process.cwd(), 'drizzle');

async function main() {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.error('No migrations found. Run `npm run db:generate` first.');
    process.exit(1);
  }

  await db.execute(
    sql`create table if not exists __migrations (name text primary key, applied_at timestamptz not null default now())`,
  );
  // postgres.js returns an array; PGlite returns `{ rows }`. Normalise.
  const applied = await db.execute(sql`select name from __migrations`);
  const appliedRows = (Array.isArray(applied) ? applied : (applied as { rows?: unknown[] }).rows) ?? [];
  const seen = new Set((appliedRows as Array<{ name: string }>).map((r) => r.name));

  for (const file of files) {
    if (seen.has(file)) {
      console.log(`[migrate] ${file} already applied`);
      continue;
    }
    const body = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    // drizzle-kit separates statements with its own breakpoint marker.
    const statements = body
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const statement of statements) {
      await db.execute(sql.raw(statement));
    }
    await db.execute(sql`insert into __migrations (name) values (${file})`);
    console.log(`[migrate] applied ${file} (${statements.length} statements)`);
  }

  await closeDb();
}

await main();
