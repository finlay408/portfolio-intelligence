/**
 * The one place that maps database rows onto engine types.
 *
 * Everything else in `src/lib/engine` is a pure function of its arguments, so
 * the whole analytics stack is testable without a database. This module is the
 * seam: it reads, converts `numeric` strings into Decimals, and hands over
 * plain data.
 */
import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  cashFlows,
  corporateActions,
  fxRatesDaily,
  instrumentThemes,
  instruments,
  pricesDaily,
  themes,
  trades,
} from '@/db/schema';
import { Decimal, dec } from '../decimal';
import type {
  CashFlowKind,
  CorporateActionKind,
  EngineCashFlow,
  EngineCorporateAction,
  EngineInstrument,
  EngineTrade,
  IsoDate,
  Side,
} from '../types';
import { MapFxLookup, MapPriceLookup } from './valuation';
import type { InstrumentMeta } from './attribution';

export interface LedgerSnapshot {
  instruments: EngineInstrument[];
  instrumentById: Map<number, EngineInstrument>;
  trades: EngineTrade[];
  corporateActions: EngineCorporateAction[];
  cashFlows: EngineCashFlow[];
  meta: Map<number, InstrumentMeta>;
}

export function toEngineInstrument(row: typeof instruments.$inferSelect): EngineInstrument {
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    assetClass: row.assetClass,
    exchangeMic: row.exchangeMic,
    quoteCurrency: row.quoteCurrency,
    quoteMultiplier: dec(row.quoteMultiplier),
    country: row.country,
    revenueRegions: row.revenueRegions ?? null,
    sector: row.sector,
    sectorWeights: row.sectorWeights ?? null,
    industry: row.industry,
    yahooSymbol: row.yahooSymbol,
    alpacaSymbol: row.alpacaSymbol,
    finnhubSymbol: row.finnhubSymbol,
  };
}

export function toEngineTrade(row: typeof trades.$inferSelect): EngineTrade {
  return {
    id: row.id,
    accountId: row.accountId,
    instrumentId: row.instrumentId,
    tradeDate: row.tradeDate,
    side: row.side as Side,
    quantity: dec(row.quantity),
    price: dec(row.price),
    tradeCurrency: row.tradeCurrency,
    fxRate: dec(row.fxRate),
    commission: dec(row.commission),
    stampDuty: dec(row.stampDuty),
    fxFee: dec(row.fxFee),
    otherFees: dec(row.otherFees),
    source: row.source,
  };
}

/**
 * Load everything the engine needs.
 *
 * Two filters are load-bearing:
 *   - voided trades are excluded here, so no downstream code has to remember;
 *   - only `applied = true` corporate actions are returned, so an unconfirmed
 *     split cannot silently rewrite cost basis (§6).
 */
export async function loadLedger(options: { accountId?: number } = {}): Promise<LedgerSnapshot> {
  const [instrumentRows, tradeRows, actionRows, flowRows, themeRows] = await Promise.all([
    db.select().from(instruments),
    options.accountId
      ? db
          .select()
          .from(trades)
          .where(and(eq(trades.isVoid, false), eq(trades.accountId, options.accountId)))
          .orderBy(asc(trades.tradeDate), asc(trades.id))
      : db
          .select()
          .from(trades)
          .where(eq(trades.isVoid, false))
          .orderBy(asc(trades.tradeDate), asc(trades.id)),
    db.select().from(corporateActions).where(eq(corporateActions.applied, true)),
    options.accountId
      ? db.select().from(cashFlows).where(eq(cashFlows.accountId, options.accountId))
      : db.select().from(cashFlows),
    db
      .select({
        instrumentId: instrumentThemes.instrumentId,
        weight: instrumentThemes.weight,
        name: themes.name,
      })
      .from(instrumentThemes)
      .innerJoin(themes, eq(themes.id, instrumentThemes.themeId)),
  ]);

  const engineInstruments = instrumentRows.map(toEngineInstrument);
  const instrumentById = new Map(engineInstruments.map((i) => [i.id, i]));

  const themesByInstrument = new Map<number, Array<{ key: string; weight: Decimal }>>();
  for (const t of themeRows) {
    const list = themesByInstrument.get(t.instrumentId) ?? [];
    list.push({ key: t.name, weight: dec(t.weight) });
    themesByInstrument.set(t.instrumentId, list);
  }

  const meta = new Map<number, InstrumentMeta>(
    engineInstruments.map((i) => [
      i.id,
      {
        id: i.id,
        sector: i.sector,
        sectorWeights: i.sectorWeights ?? null,
        country: i.country,
        currency: i.quoteCurrency,
        assetClass: i.assetClass,
        revenueRegions: i.revenueRegions,
        themes: themesByInstrument.get(i.id) ?? [],
      },
    ]),
  );

  return {
    instruments: engineInstruments,
    instrumentById,
    trades: tradeRows.map(toEngineTrade),
    corporateActions: actionRows.map((row) => ({
      id: row.id,
      instrumentId: row.instrumentId,
      actionDate: row.actionDate,
      kind: row.kind as CorporateActionKind,
      ratio: row.ratio === null ? null : dec(row.ratio),
      amount: row.amount === null ? null : dec(row.amount),
      currency: row.currency,
      detail: row.detail ?? null,
    })),
    cashFlows: flowRows.map((row) => ({
      id: row.id,
      accountId: row.accountId,
      flowDate: row.flowDate,
      kind: row.kind as CashFlowKind,
      amount: dec(row.amount),
      flowCurrency: row.flowCurrency,
      fxRate: dec(row.fxRate),
      instrumentId: row.instrumentId,
      withholding: dec(row.withholding),
    })),
    meta,
  };
}

/** Price history for a set of instruments, ready for `MapPriceLookup`. */
export async function loadPrices(
  instrumentIds: number[],
  from: IsoDate,
  to: IsoDate,
): Promise<MapPriceLookup> {
  if (instrumentIds.length === 0) return new MapPriceLookup(new Map());
  const rows = await db
    .select({
      instrumentId: pricesDaily.instrumentId,
      priceDate: pricesDaily.priceDate,
      close: pricesDaily.close,
    })
    .from(pricesDaily)
    .where(
      and(
        inArray(pricesDaily.instrumentId, instrumentIds),
        gte(pricesDaily.priceDate, from),
        lte(pricesDaily.priceDate, to),
      ),
    )
    .orderBy(asc(pricesDaily.instrumentId), asc(pricesDaily.priceDate));

  const series = new Map<number, Array<[IsoDate, Decimal]>>();
  for (const r of rows) {
    const list = series.get(r.instrumentId) ?? [];
    list.push([r.priceDate, dec(r.close)]);
    series.set(r.instrumentId, list);
  }
  return new MapPriceLookup(series);
}

/**
 * The two most recent closes on or before `asOf` for each instrument — enough
 * for a current valuation (`priceOn(asOf)`) and its day change
 * (`priceOn(the day before that close)`), and nothing more.
 *
 * `loadPrices` from inception is right for the recompute job, which values
 * every day in the range. The overview values one day, and pulling ~40k rows
 * to do it was most of the page's wait when the database sits an ocean away
 * from the function. The window function keeps `priceOn`'s carry-forward
 * semantics: a thinly traded line whose last close is weeks old still has a
 * price here, because the two rows are the latest two whatever their dates.
 */
export async function loadLatestPrices(
  instrumentIds: number[],
  asOf: IsoDate,
): Promise<MapPriceLookup> {
  if (instrumentIds.length === 0) return new MapPriceLookup(new Map());
  // A lateral join walks the (instrument_id, price_date) primary key once per
  // instrument and stops after two rows, so its cost does not grow with the
  // depth of price history. A window function over the same rows has to sort
  // every bar first. Drizzle has no lateral helper, hence the raw SQL.
  const ids = sql`array[${sql.join(
    instrumentIds.map((id) => sql`${id}`),
    sql`,`,
  )}]::int[]`;
  const rows = (await db.execute(sql`
    select p.instrument_id as "instrumentId", p.price_date as "priceDate", p.close
    from unnest(${ids}) as i(id)
    cross join lateral (
      select instrument_id, price_date, close
      from ${pricesDaily}
      where instrument_id = i.id and price_date <= ${asOf}
      order by price_date desc
      limit 2
    ) p
    order by p.instrument_id, p.price_date
  `)) as unknown as Array<{ instrumentId: number; priceDate: IsoDate; close: string }>;

  const series = new Map<number, Array<[IsoDate, Decimal]>>();
  for (const r of rows) {
    const list = series.get(Number(r.instrumentId)) ?? [];
    list.push([r.priceDate, dec(r.close)]);
    series.set(Number(r.instrumentId), list);
  }
  return new MapPriceLookup(series);
}

export async function loadFx(from: IsoDate, to: IsoDate): Promise<MapFxLookup> {
  const rows = await db
    .select()
    .from(fxRatesDaily)
    .where(and(gte(fxRatesDaily.rateDate, from), lte(fxRatesDaily.rateDate, to)))
    .orderBy(asc(fxRatesDaily.pair), asc(fxRatesDaily.rateDate));

  const series = new Map<string, Array<[IsoDate, Decimal]>>();
  for (const r of rows) {
    const list = series.get(r.pair) ?? [];
    list.push([r.rateDate, dec(r.rate)]);
    series.set(r.pair, list);
  }
  return new MapFxLookup(series);
}

/** Earliest date with any activity — the natural start of every series. */
export async function inceptionDate(accountId?: number): Promise<IsoDate | null> {
  const [row] = await db
    .select({
      earliest: sql<string | null>`least(
        (select min(${trades.tradeDate}) from ${trades}
          where ${trades.isVoid} = false
          ${accountId ? sql`and ${trades.accountId} = ${accountId}` : sql``}),
        (select min(${cashFlows.flowDate}) from ${cashFlows}
          ${accountId ? sql`where ${cashFlows.accountId} = ${accountId}` : sql``})
      )`,
    })
    .from(sql`(select 1) as _`);
  return row?.earliest ?? null;
}
