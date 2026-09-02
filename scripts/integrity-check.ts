/**
 * Weekly integrity check (CLAUDE.md §8).
 *
 * Recompute every daily snapshot from inception and diff it against what is
 * cached. This is not optional: it is what catches silent drift between the
 * ledger and the cache, and a cache that has quietly diverged is worse than no
 * cache, because every number downstream still looks plausible.
 *
 *   npm run integrity-check
 *   npm run integrity-check -- --tolerance=0.01 --fix
 */
import { and, asc, eq, gte, inArray } from 'drizzle-orm';
import { closeDb, db } from '../src/db';
import { accounts, portfolioDaily, pricesDaily } from '../src/db/schema';
import { Decimal, dec } from '../src/lib/decimal';
import { todayIso } from '../src/lib/dates';
import { inceptionDate, loadFx, loadLedger, loadPrices } from '../src/lib/engine/load';
import { buildSeries } from '../src/lib/engine/snapshots';
import { args, runJob } from './_util';

const argv = args();
/** Pennies. A cache that disagrees by more than this is drift, not rounding. */
const tolerance = new Decimal(typeof argv.tolerance === 'string' ? argv.tolerance : '0.01');

interface Mismatch {
  accountId: number;
  date: string;
  field: string;
  cached: string;
  recomputed: string;
  delta: string;
}

/**
 * One trading calendar for the whole portfolio.
 *
 * Every account gets a snapshot on every date that any held instrument has a
 * price for. Deriving a calendar per account instead means a GIA holding only
 * UK names has no row on the August bank holiday while an ISA holding US names
 * does — and any view that sums the two then loses the GIA for a day, which
 * chains a phantom loss and recovery straight into TWR and max drawdown.
 *
 * Dates come from stored prices rather than from a generated calendar: a
 * fabricated day produces a fabricated zero return.
 */
async function portfolioCalendar(from: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ d: pricesDaily.priceDate })
    .from(pricesDaily)
    .where(gte(pricesDaily.priceDate, from))
    .orderBy(asc(pricesDaily.priceDate));
  return rows.map((r) => r.d);
}

await runJob('integrity-check', async () => {
  const accountRows = await db.select().from(accounts);
  const mismatches: Mismatch[] = [];
  let compared = 0;
  let missing = 0;

  const calendar = await portfolioCalendar((await inceptionDate()) ?? todayIso());

  for (const account of accountRows) {
    const inception = await inceptionDate(account.id);
    if (!inception) continue;
    const to = todayIso();

    const ledger = await loadLedger({ accountId: account.id });
    const heldIds = [...new Set(ledger.trades.map((t) => t.instrumentId))];
    const [prices, fx] = await Promise.all([
      loadPrices(heldIds, inception, to),
      loadFx(inception, to),
    ]);

    const series = buildSeries({
      trades: ledger.trades,
      corporateActions: ledger.corporateActions,
      cashFlows: ledger.cashFlows,
      instrumentById: ledger.instrumentById,
      prices,
      fx,
      accountId: account.id,
      from: inception,
      to,
      tradingDays: calendar,
    });

    const cachedRows = await db
      .select()
      .from(portfolioDaily)
      .where(eq(portfolioDaily.accountId, account.id));
    const cachedByDate = new Map(cachedRows.map((r) => [r.snapDate, r]));

    for (const snap of series.snapshots) {
      const cached = cachedByDate.get(snap.date);
      if (!cached) {
        missing++;
        continue;
      }
      compared++;

      const checks: Array<[string, Decimal, Decimal]> = [
        ['market_value_gbp', dec(cached.marketValueGbp), snap.marketValueGbp],
        ['cost_basis_gbp', dec(cached.costBasisGbp), snap.costBasisGbp],
        ['cash_gbp', dec(cached.cashGbp), snap.cashGbp],
        ['net_flow_gbp', dec(cached.netFlowGbp), snap.netFlowGbp],
      ];

      for (const [field, cachedValue, recomputed] of checks) {
        const delta = cachedValue.minus(recomputed).abs();
        if (delta.greaterThan(tolerance)) {
          mismatches.push({
            accountId: account.id,
            date: snap.date,
            field,
            cached: cachedValue.toFixed(2),
            recomputed: recomputed.toFixed(2),
            delta: delta.toFixed(4),
          });
        }
      }
    }
  }

  if (mismatches.length > 0) {
    console.error(`\n${mismatches.length} snapshot mismatches (tolerance ${tolerance.toFixed()}):`);
    for (const m of mismatches.slice(0, 40)) {
      console.error(
        `  account ${m.accountId} ${m.date} ${m.field}: cached ${m.cached} vs ${m.recomputed} (Δ${m.delta})`,
      );
    }
    if (mismatches.length > 40) console.error(`  ...and ${mismatches.length - 40} more`);
    console.error('\nRun `npm run recompute -- --from=inception` to rebuild the cache.\n');
  }

  if (missing > 0) {
    console.warn(`${missing} recomputed days have no cached row; the cache is stale.`);
  }

  const result = { compared, missing, mismatches: mismatches.length };

  // Exit non-zero so the scheduled workflow fails loudly rather than passing
  // with a warning nobody reads.
  if (mismatches.length > 0 && !argv.fix) {
    await closeDb();
    console.error('[integrity-check] FAILED');
    process.exit(2);
  }

  return result;
});
