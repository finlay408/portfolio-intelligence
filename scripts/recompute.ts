/**
 * Rebuild the cached daily snapshots from the ledger.
 *
 *   npm run recompute -- --from=inception
 *   npm run recompute -- --from=2025-01-01 --account=1
 *
 * The cache in `portfolio_daily` is a performance optimisation and nothing
 * more (§2). This command is the definition of what those rows should contain,
 * and it must be able to reproduce every one of them from the trade ledger plus
 * price history alone.
 */
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '../src/db';
import { accounts, portfolioDaily, pricesDaily } from '../src/db/schema';
import { toNumericString } from '../src/lib/decimal';
import { todayIso } from '../src/lib/dates';
import { inceptionDate, loadFx, loadLedger, loadPrices } from '../src/lib/engine/load';
import { buildSeries } from '../src/lib/engine/snapshots';
import { dailyTwrSeries } from '../src/lib/engine/twr';
import { args, chunk, runJob } from './_util';

const argv = args();

/** `excluded.<column>` for an upsert — Drizzle has no typed helper for this. */
function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
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

await runJob('recompute', async () => {
  const accountFilter = argv.account ? Number(argv.account) : undefined;
  const accountRows = accountFilter
    ? await db.select().from(accounts).where(eq(accounts.id, accountFilter))
    : await db.select().from(accounts);

  const to = typeof argv.to === 'string' ? argv.to : todayIso();
  let rowsWritten = 0;

  const earliest = (await inceptionDate()) ?? to;
  const calendarFrom =
    argv.from === 'inception' || argv.from === undefined || argv.from === true
      ? earliest
      : String(argv.from);
  const calendar = await portfolioCalendar(calendarFrom);

  for (const account of accountRows) {
    const inception = await inceptionDate(account.id);
    if (!inception) {
      console.log(`[recompute] account ${account.id} has no activity; skipping`);
      continue;
    }

    const from =
      argv.from === 'inception' || argv.from === undefined || argv.from === true
        ? inception
        : String(argv.from);

    const ledger = await loadLedger({ accountId: account.id });
    const heldIds = [...new Set(ledger.trades.map((t) => t.instrumentId))];
    const [prices, fx] = await Promise.all([loadPrices(heldIds, from, to), loadFx(from, to)]);


    const series = buildSeries({
      trades: ledger.trades,
      corporateActions: ledger.corporateActions,
      cashFlows: ledger.cashFlows,
      instrumentById: ledger.instrumentById,
      prices,
      fx,
      accountId: account.id,
      from,
      to,
      tradingDays: calendar,
    });

    const twr = dailyTwrSeries(series.dailyPoints);
    const twrByDate = new Map(twr.map((p) => [p.date, p.dailyReturn]));

    const rows = series.snapshots.map((s) => ({
      accountId: account.id,
      snapDate: s.date,
      marketValueGbp: toNumericString(s.marketValueGbp),
      costBasisGbp: toNumericString(s.costBasisGbp),
      cashGbp: toNumericString(s.cashGbp),
      netFlowGbp: toNumericString(s.netFlowGbp),
      twrDaily: twrByDate.get(s.date)?.toFixed() ?? null,
      holdings: s.positions.map((p) => ({
        instrument_id: p.instrumentId,
        quantity: p.quantity.toFixed(),
        price_local: p.priceLocal?.toFixed() ?? null,
        fx_to_gbp: p.fxToGbp.toFixed(),
        value_gbp: p.valueGbp.toFixed(),
        cost_basis_gbp: p.costBasisGbp.toFixed(),
      })),
    }));

    for (const batch of chunk(rows, 500)) {
      if (batch.length === 0) continue;
      await db
        .insert(portfolioDaily)
        .values(batch)
        .onConflictDoUpdate({
          target: [portfolioDaily.accountId, portfolioDaily.snapDate],
          set: {
            marketValueGbp: sqlExcluded('market_value_gbp'),
            costBasisGbp: sqlExcluded('cost_basis_gbp'),
            cashGbp: sqlExcluded('cash_gbp'),
            netFlowGbp: sqlExcluded('net_flow_gbp'),
            twrDaily: sqlExcluded('twr_daily'),
            holdings: sqlExcluded('holdings'),
          },
        });
      rowsWritten += batch.length;
    }

    console.log(
      `[recompute] account ${account.id} (${account.name}): ${rows.length} days from ${from}`,
    );
  }

  return { accounts: accountRows.length, rowsWritten };
});
