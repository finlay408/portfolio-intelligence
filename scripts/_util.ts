/** Shared plumbing for the CLI jobs: arg parsing, job logging, clean exit. */
import { eq } from 'drizzle-orm';
import { closeDb, db } from '../src/db';
import { dataHealth, jobRuns } from '../src/db/schema';
import { setHealthSink } from '../src/lib/providers/registry';

export function args(): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (const raw of process.argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const [key, ...rest] = raw.slice(2).split('=');
    out[key!] = rest.length > 0 ? rest.join('=') : true;
  }
  return out;
}

/**
 * Provider degradation is persisted for every job. A fallback nobody can see is
 * the same failure as no fallback at all (§6).
 */
export function persistProviderHealth(): void {
  setHealthSink(async (event) => {
    // 'ok' events are the overwhelming majority and carry no information; only
    // degradation and failure are worth a row.
    if (event.status === 'ok') return;
    await db.insert(dataHealth).values({
      provider: event.provider,
      capability: event.capability,
      instrumentId: event.instrumentId,
      status: event.status,
      detail: event.detail,
      servedBy: event.servedBy,
    });
  });
}

export async function runJob(
  name: string,
  fn: () => Promise<Record<string, unknown> | void>,
): Promise<void> {
  persistProviderHealth();
  const started = Date.now();
  const [run] = await db.insert(jobRuns).values({ job: name }).returning({ id: jobRuns.id });

  try {
    const detail = (await fn()) ?? {};
    await db
      .update(jobRuns)
      .set({
        status: 'ok',
        finishedAt: new Date(),
        detail: { ...detail, durationMs: Date.now() - started },
      })
      .where(eq(jobRuns.id, run!.id));
    console.log(`[${name}] ok in ${Date.now() - started}ms`, detail);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(jobRuns)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        detail: { error: message, durationMs: Date.now() - started },
      })
      .where(eq(jobRuns.id, run!.id));
    console.error(`[${name}] FAILED:`, message);
    await closeDb();
    process.exit(1);
  }
  await closeDb();
}

export const chunk = <T>(xs: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / size) }, (_, i) => xs.slice(i * size, i * size + size));

/* ---------------- CSV ---------------- */

/** RFC 4180: quoted fields may contain commas, newlines and doubled quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  const body = text.replace(/^﻿/, ''); // strip a spreadsheet BOM

  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quoted) {
      if (c === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && body[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows;
}
