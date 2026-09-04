/**
 * Trading 212 export importer — command-line entry point.
 *
 *   npm run import:t212 -- --dir=./exports --dry-run   # preview
 *   npm run import:t212 -- --dir=./exports             # commit
 *   npm run import:t212 -- --file=from_2026-08-02_to_2026-09-02.csv
 *
 * The same code path as the upload card on /trades: each file is stored in
 * `import_files`, previewed against the ledger, and committed. Rows already
 * recorded — by broker ID, or by natural key for rows imported before IDs were
 * kept — are skipped, so overlapping date ranges are safe. New securities are
 * resolved against Yahoo by ISIN and currency and created with their
 * classification; the old `--resolve` step and `t212-instruments.csv` mapping
 * file are no longer needed.
 *
 * The format's traps are documented in `src/lib/import/t212.ts`.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../src/db';
import { accounts } from '../src/db/schema';
import { commitUpload, previewUpload, storeUpload } from '../src/lib/import/apply';
import { args, runJob } from './_util';

const argv = args();

await runJob('import-t212', async () => {
  const dryRun = Boolean(argv['dry-run']);
  const accountName = typeof argv.account === 'string' ? argv.account : 'Trading 212 ISA';
  const wrapper = typeof argv.wrapper === 'string' ? argv.wrapper : 'ISA';

  let files: string[];
  if (typeof argv.file === 'string') {
    files = [argv.file];
  } else {
    const dir = typeof argv.dir === 'string' ? argv.dir : '.';
    files = (await readdir(dir))
      .filter((f) => f.toLowerCase().endsWith('.csv'))
      .sort()
      .map((f) => path.join(dir, f));
    if (files.length === 0) throw new Error(`no CSV files in ${dir}`);
  }

  const [existingAccount] = await db.select().from(accounts).where(eq(accounts.name, accountName));
  let accountId = existingAccount?.id;
  if (!accountId) {
    if (dryRun) throw new Error(`account "${accountName}" does not exist; run without --dry-run to create it`);
    const [created] = await db
      .insert(accounts)
      .values({ name: accountName, wrapper, baseCurrency: 'GBP', broker: 'Trading 212' })
      .returning({ id: accounts.id });
    accountId = created!.id;
    console.log(`[t212] created account "${accountName}" (${wrapper})`);
  }

  const totals = { trades: 0, flows: 0, instruments: 0, mismatches: 0, problems: 0 };

  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const { fileId, existing } = await storeUpload({ accountId, filename: path.basename(file), text });
    const p = await previewUpload(fileId);
    console.log(
      `[t212] ${p.filename}${existing ? ' (seen before)' : ''}: ${p.rows} rows ${p.from} to ${p.to} — ` +
        `${p.trades.new} new trades, ${p.flows.new} new cash flows, ${p.newInstruments.length} new instruments; ` +
        `${p.trades.duplicate + p.flows.duplicate} already recorded, ${p.skipped} not portfolio events`,
    );
    for (const n of p.newInstruments) {
      const flag = n.status === 'ok' ? ' ' : n.status === 'currency-mismatch' ? '~' : '!';
      console.log(`   ${flag} ${n.ticker.padEnd(7)} ${n.currency.padEnd(4)} -> ${(n.yahooSymbol ?? 'UNRESOLVED').padEnd(12)} ${n.name.slice(0, 40)}`);
    }
    for (const m of p.mismatches) console.warn(`   ~ ${m}`);
    for (const m of p.problems) console.warn(`   ! ${m}`);
    totals.mismatches += p.mismatches.length;
    totals.problems += p.problems.length;

    if (dryRun || p.trades.new + p.flows.new === 0) continue;

    const r = await commitUpload(fileId);
    totals.trades += r.written.trades;
    totals.flows += r.written.flows;
    totals.instruments += r.written.instruments;
    console.log(
      `[t212]   wrote ${r.written.trades} trades, ${r.written.flows} flows, ${r.written.instruments} instruments; ` +
        `${r.backfill.bars} bars fetched; ${r.recompute.ok ? `${r.recompute.rowsWritten} days rebuilt` : `recompute failed: ${r.recompute.error}`}`,
    );
    for (const f of r.backfill.failures) console.warn(`   ! ${f}`);
  }

  if (dryRun) console.log('\n[t212] Dry run — nothing written.');
  return { dryRun, files: files.length, ...totals };
});
