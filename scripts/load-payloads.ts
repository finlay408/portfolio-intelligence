/**
 * Load analytics payloads produced by `analytics/dump_payloads.py`.
 *
 *   python analytics/dump_payloads.py --out .scratch/payloads.json
 *   npm run load-payloads -- --file=.scratch/payloads.json
 *
 * This exists to close the loop between the two runtimes. The Python job and
 * the risk pages are written independently against the same payload shapes, and
 * only an actual round trip proves they agree — so this takes genuine Python
 * output and writes it where the pages read from.
 *
 * It is a development tool. Payloads marked `synthetic` are written with a flag
 * in the payload itself so nothing downstream mistakes them for real analytics.
 */
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { db } from '../src/db';
import { analyticsSnapshots } from '../src/db/schema';
import { args, runJob } from './_util';

const argv = args();

interface Dump {
  account_id: number;
  snap_date: string;
  synthetic?: boolean;
  payloads: Record<string, Record<string, unknown>>;
}

await runJob('load-payloads', async () => {
  const file = typeof argv.file === 'string' ? argv.file : '.scratch/payloads.json';
  const dump = JSON.parse(await readFile(file, 'utf8')) as Dump;

  const kinds: string[] = [];
  for (const [kind, payload] of Object.entries(dump.payloads)) {
    await db
      .insert(analyticsSnapshots)
      .values({
        accountId: dump.account_id,
        snapDate: dump.snap_date,
        kind,
        payload: dump.synthetic ? { ...payload, __synthetic: true } : payload,
      })
      .onConflictDoUpdate({
        target: [analyticsSnapshots.accountId, analyticsSnapshots.snapDate, analyticsSnapshots.kind],
        set: { payload: sql.raw('excluded.payload'), computedAt: sql.raw('now()') },
      });
    kinds.push(kind);
  }

  if (dump.synthetic) {
    console.warn(
      '\n[load-payloads] These payloads are SYNTHETIC. They prove the pages render real Python\n' +
        '                output; the numbers themselves mean nothing.\n',
    );
  }

  return { file, account: dump.account_id, snapDate: dump.snap_date, kinds };
});
