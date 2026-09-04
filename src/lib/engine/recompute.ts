/**
 * Rebuild the cached daily snapshots from the ledger.
 *
 * The cache in `portfolio_daily` is a performance optimisation and nothing
 * more (§2). This function is the definition of what those rows should
 * contain, and it must be able to reproduce every one of them from the trade
 * ledger plus price history alone. `npm run recompute` calls it from the
 * command line; an export upload calls it in-process so the figures on screen
 * move the moment the ledger does.
 */
import { asc, eq, gte, sql } from 'drizzle-orm';
import { db } from '@/db';
import { accounts, portfolioDaily, pricesDaily } from '@/db/schema';
import { toNumericString } from '../decimal';
import { todayIso } from '../dates';
import type { IsoDate } from '../types';
import { inceptionDate, loadFx, loadLedger, loadPrices } from './load';
import { buildSeries } from './snapshots';
import { dailyTwrSeries } from './twr';

/** `excluded.<column>` for an upsert — Drizzle has no typed helper for this. */
const sqlExcluded = (column: string) => sql.raw(`excluded.${column}`);

const chunk = <T>(xs: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / size) }, (_, i) => xs.slice(i * size, i * size + size));

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
async function portfolioCalendar(from: IsoDate): Promise<IsoDate[]> {
  const rows = await db
    .selectDistinct({ d: pricesDaily.priceDate })
    .from(pricesDaily)
    .where(gte(pricesDaily.priceDate, from))
    .orderBy(asc(pricesDaily.priceDate));
  return rows.map((r) => r.d);
}

export interface RecomputeOptions {
  /** 'inception' or an ISO date. */
  from?: IsoDate | 'inception';
  to?: IsoDate;
  accountId?: number;
  log?: (line: string) => void;
}

export interface RecomputeResult {
  accounts: number;
  rowsWritten: number;
}

export async function recomputeSnapshots(options: RecomputeOptions = {}): Promise<RecomputeResult> {
  const log = options.log ?? (() => undefined);
  const accountRows = options.accountId
    ? await db.select().from(accounts).where(eq(accounts.id, options.accountId))
    : await db.select().from(accounts);

  const to = options.to ?? todayIso();
  const fromOption = options.from ?? 'inception';
  let rowsWritten = 0;

  const earliest = (await inceptionDate()) ?? to;
  const calendar = await portfolioCalendar(fromOption === 'inception' ? earliest : fromOption);

  for (const account of accountRows) {
    const inception = await inceptionDate(account.id);
    if (!inception) {
      log(`account ${account.id} has no activity; skipping`);
      continue;
    }
    // A date before the account existed is just inception.
    const from = fromOption === 'inception' || fromOption < inception ? inception : fromOption;

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

    log(`account ${account.id} (${account.name}): ${rows.length} days from ${from}`);
  }

  return { accounts: accountRows.length, rowsWritten };
}
