/**
 * The read model behind every page.
 *
 * Two rules from §12 shape this file:
 *
 *   "Fast. All analytics precomputed. No page should wait on an external API."
 *      — nothing here calls a provider. Live quotes come from `quotes_live`,
 *        which a scheduled job fills; risk comes from `analytics_snapshots`,
 *        which the nightly Python job fills.
 *
 *   "Data freshness is always visible."
 *      — every price carries the delay and provider that produced it, all the
 *        way to the badge.
 *
 * Positions themselves are still derived from the ledger on every read (§2).
 * That is cheap — it is a walk over the trade list — and it is what guarantees
 * the displayed holdings can never drift from the trades behind them.
 */
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  accounts,
  analyticsSnapshots,
  benchmarks,
  corporateActions,
  dataHealth,
  earningsEvents,
  instruments,
  jobRuns,
  macroSeries,
  portfolioDaily,
  pricesDaily,
  quotesLive,
  watchlist,
} from '@/db/schema';
import { Decimal, ONE, ZERO, dec, divOrZero } from './decimal';
import { addDays, daysBetween, eachDay, monthKey, quarterKey, todayIso, yearKey } from './dates';
import type { LevelPoint } from './engine/windows';
import {
  attribute,
  byInstrument,
  makeGroupers,
  periodReturns,
  type AttributionResult,
} from './engine/attribution';
import { groupWeights, summariseWeights, type WeightRow } from './engine/concentration';
import { loadFx, loadLedger, loadPrices } from './engine/load';
import { computePositions } from './engine/positions';
import { cashOn, toAttributionDays, type DailySnapshot } from './engine/snapshots';
import { chainLink, dailyTwrSeries, maxDrawdown, type TwrPoint } from './engine/twr';
import { portfolioMwr } from './engine/xirr';
import { decompose, type FxLookup, type PriceLookup } from './engine/valuation';
import type { EngineInstrument, IsoDate, Position, ReturnDecomposition } from './types';

export interface QuoteInfo {
  price: Decimal;
  changePct: Decimal | null;
  delaySeconds: number | null;
  provider: string | null;
  asOf: string | null;
  /** True when the price came from a stored daily close, not a live quote. */
  isStale: boolean;
}

export interface HoldingRow {
  position: Position;
  symbol: string;
  name: string;
  sector: string | null;
  country: string | null;
  exchangeMic: string | null;
  quoteCurrency: string;
  assetClass: string;
  quote: QuoteInfo | null;
  fxToGbp: Decimal;
  marketValueGbp: Decimal;
  unrealisedGbp: Decimal;
  unrealisedPct: Decimal | null;
  dayChangeGbp: Decimal | null;
  weight: Decimal;
  decomposition: ReturnDecomposition | null;
  /** Set when the holding could not be stated in GBP, with the reason. */
  unvaluedReason: string | null;
}

export interface OverviewData {
  accountId: number | null;
  accountName: string;
  asOf: IsoDate;
  holdings: HoldingRow[];
  closed: Position[];
  /** Symbol and name for every instrument ever held, including closed lines. */
  instrumentById: Map<number, EngineInstrument>;
  marketValueGbp: Decimal;
  costBasisGbp: Decimal;
  cashGbp: Decimal;
  totalValueGbp: Decimal;
  unrealisedGbp: Decimal;
  realisedGbp: Decimal;
  dividendsGbp: Decimal;
  feesGbp: Decimal;
  netDepositsGbp: Decimal;
  dayChangeGbp: Decimal | null;
  dayChangePct: Decimal | null;
  twr: {
    series: TwrPoint[];
    sinceInception: Decimal | null;
    ytd: Decimal | null;
    oneMonth: Decimal | null;
    threeMonth: Decimal | null;
    maxDrawdown: ReturnType<typeof maxDrawdown> | null;
  };
  /**
   * Total value against cumulative net deposits, one point per cached day. The
   * gap between the two lines is the money the portfolio has made or lost.
   */
  valueSeries: Array<{ date: IsoDate; valueGbp: number; netDepositsGbp: number }>;
  mwr: number | null;
  concentration: ReturnType<typeof summariseWeights>;
  bySector: ReturnType<typeof groupWeights>;
  byRevenueGeography: ReturnType<typeof groupWeights>;
  byListingCountry: ReturnType<typeof groupWeights>;
  byCurrency: ReturnType<typeof groupWeights>;
  byTheme: ReturnType<typeof groupWeights>;
  topMovers: HoldingRow[];
  bottomMovers: HoldingRow[];
  warnings: string[];
  /** True when `portfolio_daily` is empty and the time series is unavailable. */
  needsRecompute: boolean;
}

async function resolveAccount(accountId?: number) {
  const rows = accountId
    ? await db.select().from(accounts).where(eq(accounts.id, accountId))
    : await db.select().from(accounts);
  return {
    id: accountId ?? null,
    name: accountId ? (rows[0]?.name ?? `Account ${accountId}`) : 'All accounts',
    rows,
  };
}

export async function getOverview(accountId?: number): Promise<OverviewData> {
  const asOf = todayIso();
  const account = await resolveAccount(accountId);
  const ledger = await loadLedger(accountId ? { accountId } : {});

  // Lenient mode: one malformed row degrades a single position rather than
  // blanking the dashboard. Strict mode belongs to the jobs and the tests.
  const derived = computePositions(ledger.trades, ledger.corporateActions, ledger.cashFlows, {
    asOf,
    accountId,
    strict: false,
  });

  const heldIds = [...new Set(ledger.trades.map((t) => t.instrumentId))];

  // Load from inception, not from a rolling window. `priceOn` carries the last
  // close forward, and it can only carry forward from what was loaded — so a
  // fixed window silently drops any instrument whose most recent price is older
  // than the window, and the position vanishes from the portfolio total.
  const earliest =
    [...ledger.trades.map((t) => t.tradeDate), ...ledger.cashFlows.map((f) => f.flowDate)].sort()[0] ??
    addDays(asOf, -400);

  const [prices, fx, quoteRows] = await Promise.all([
    loadPrices(heldIds, earliest, asOf),
    loadFx(earliest, asOf),
    heldIds.length > 0
      ? db.select().from(quotesLive).where(inArray(quotesLive.instrumentId, heldIds))
      : Promise.resolve([]),
  ]);

  const quoteByInstrument = new Map(quoteRows.map((q) => [q.instrumentId, q]));
  const holdings = derived.open
    .map((position) => toHoldingRow(position, ledger, prices, fx, quoteByInstrument, asOf))
    .filter((h): h is HoldingRow => h !== null);

  const marketValueGbp = holdings.reduce<Decimal>((a, h) => a.plus(h.marketValueGbp), ZERO);
  for (const h of holdings) h.weight = divOrZero(h.marketValueGbp, marketValueGbp);
  holdings.sort((a, b) => b.marketValueGbp.comparedTo(a.marketValueGbp));

  const costBasisGbp = holdings.reduce<Decimal>((a, h) => a.plus(h.position.costBasisGbp), ZERO);
  const cashGbp = cashOn(ledger.trades, ledger.cashFlows, asOf, accountId);
  const realisedGbp = derived.all.reduce<Decimal>((a, p) => a.plus(p.realisedGbpAverage), ZERO);
  const dividendsGbp = derived.all.reduce<Decimal>((a, p) => a.plus(p.dividendsGbp), ZERO);
  const feesGbp = derived.all.reduce<Decimal>((a, p) => a.plus(p.feesGbp), ZERO);
  const netDepositsGbp = ledger.cashFlows
    .filter((f) => (f.kind === 'deposit' || f.kind === 'withdrawal') && f.flowDate <= asOf)
    .reduce<Decimal>((a, f) => a.plus(f.amount.times(f.fxRate)), ZERO);

  const dayChangeGbp = holdings.every((h) => h.dayChangeGbp === null)
    ? null
    : holdings.reduce<Decimal>((a, h) => a.plus(h.dayChangeGbp ?? ZERO), ZERO);

  // --- time series, from the cache ---
  const snapshots = await db
    .select({
      accountId: portfolioDaily.accountId,
      snapDate: portfolioDaily.snapDate,
      twrDaily: portfolioDaily.twrDaily,
      marketValueGbp: portfolioDaily.marketValueGbp,
      cashGbp: portfolioDaily.cashGbp,
      netFlowGbp: portfolioDaily.netFlowGbp,
    })
    .from(portfolioDaily)
    .where(accountId ? eq(portfolioDaily.accountId, accountId) : sql`true`)
    .orderBy(portfolioDaily.snapDate);

  const merged = mergeSnapshots(snapshots);
  const series = merged.length > 0 ? dailyTwrSeries(merged) : [];
  const startOfYear = `${asOf.slice(0, 4)}-01-01`;

  const mwr = portfolioMwr(
    ledger.cashFlows
      .filter((f) => f.kind === 'deposit' || f.kind === 'withdrawal')
      .map((f) => ({ date: f.flowDate, depositGbp: f.amount.times(f.fxRate).toNumber() })),
    { date: asOf, valueGbp: marketValueGbp.plus(cashGbp).toNumber() },
  );

  // --- exposure tables ---
  const groupers = makeGroupers(ledger.meta);
  const weightRows: WeightRow[] = holdings.map((h) => ({
    key: String(h.position.instrumentId),
    label: h.symbol,
    weight: h.weight,
    valueGbp: h.marketValueGbp,
  }));
  const positionsForGrouping = holdings.map((h) => ({
    instrumentId: h.position.instrumentId,
    valueGbp: h.marketValueGbp,
  }));

  const movers = [...holdings]
    .filter((h) => h.dayChangeGbp !== null)
    .sort((a, b) => (b.quote?.changePct ?? ZERO).comparedTo(a.quote?.changePct ?? ZERO));

  return {
    accountId: account.id,
    accountName: account.name,
    asOf,
    holdings,
    closed: derived.closed,
    instrumentById: ledger.instrumentById,
    marketValueGbp,
    costBasisGbp,
    cashGbp,
    totalValueGbp: marketValueGbp.plus(cashGbp),
    unrealisedGbp: marketValueGbp.minus(costBasisGbp),
    realisedGbp,
    dividendsGbp,
    feesGbp,
    netDepositsGbp,
    dayChangeGbp,
    dayChangePct:
      dayChangeGbp && !marketValueGbp.isZero()
        ? dayChangeGbp.div(marketValueGbp.minus(dayChangeGbp))
        : null,
    twr: {
      series,
      sinceInception: series.length > 0 ? series.at(-1)!.cumulative.minus(ONE) : null,
      ytd: windowReturn(series, startOfYear),
      oneMonth: windowReturn(series, addDays(asOf, -30)),
      threeMonth: windowReturn(series, addDays(asOf, -91)),
      maxDrawdown: series.length > 0 ? maxDrawdown(series) : null,
    },
    valueSeries: (() => {
      let deposits = ZERO;
      return merged.map((m) => {
        deposits = deposits.plus(m.netFlowGbp);
        return {
          date: m.date,
          valueGbp: m.marketValueGbp.toNumber(),
          netDepositsGbp: deposits.toNumber(),
        };
      });
    })(),
    mwr,
    concentration: summariseWeights(weightRows),
    bySector: groupWeights(positionsForGrouping, groupers.sector),
    byRevenueGeography: groupWeights(positionsForGrouping, groupers.revenueGeography),
    byListingCountry: groupWeights(positionsForGrouping, groupers.listingCountry),
    byCurrency: groupWeights(positionsForGrouping, groupers.currency),
    byTheme: groupWeights(positionsForGrouping, groupers.theme),
    topMovers: movers.slice(0, 5),
    bottomMovers: movers.slice(-5).reverse(),
    warnings: [
      ...derived.warnings.map((w) => `${w.date}: ${w.message}`),
      ...holdings
        .filter((h) => h.unvaluedReason)
        .map((h) => `${h.symbol} is not valued in the total: ${h.unvaluedReason}`),
    ],
    needsRecompute: merged.length === 0,
  };
}

function toHoldingRow(
  position: Position,
  ledger: Awaited<ReturnType<typeof loadLedger>>,
  prices: PriceLookup,
  fx: FxLookup,
  quotes: Map<number, typeof quotesLive.$inferSelect>,
  asOf: IsoDate,
): HoldingRow | null {
  const inst = ledger.instrumentById.get(position.instrumentId);
  if (!inst) return null;

  const live = quotes.get(position.instrumentId);
  const daily = prices.priceOn(position.instrumentId, asOf);
  const previous = daily ? prices.priceOn(position.instrumentId, addDays(daily.date, -1)) : null;

  // Prefer a live quote; fall back to the last stored close, and say which.
  const quote: QuoteInfo | null = live
    ? {
        price: dec(live.price),
        changePct: live.changePct === null ? null : dec(live.changePct).div(100),
        delaySeconds: live.delaySeconds,
        provider: live.provider,
        asOf: live.asOf.toISOString(),
        isStale: false,
      }
    : daily
      ? {
          price: daily.price,
          changePct:
            previous && !previous.price.isZero()
              ? daily.price.div(previous.price).minus(ONE)
              : null,
          // Report the real age of the close rather than a nominal delay, so a
          // price from six months ago is not badged as "15 min delayed".
          delaySeconds: Math.max(0, daysBetween(daily.date, asOf)) * 86_400,
          provider: 'daily close',
          asOf: daily.date,
          isStale: true,
        }
      : null;

  // A missing FX rate is not parity. Without one the position cannot be stated
  // in GBP at all, so it is left unvalued and the UI says why.
  const rate = inst.quoteCurrency === 'GBP' ? ONE : fx.rateOn(inst.quoteCurrency, 'GBP', asOf);
  const fxToGbp = rate ?? ONE;
  const valuable = quote !== null && rate !== null;
  const marketValueGbp = valuable ? quote!.price.times(position.quantity).times(fxToGbp) : ZERO;
  const unrealisedGbp = marketValueGbp.minus(position.costBasisGbp);

  const dayChangeGbp =
    quote?.changePct && !quote.changePct.isZero()
      ? marketValueGbp.minus(marketValueGbp.div(ONE.plus(quote.changePct)))
      : quote
        ? ZERO
        : null;

  return {
    position,
    symbol: inst.symbol,
    name: inst.name,
    sector: inst.sector,
    country: inst.country,
    exchangeMic: inst.exchangeMic,
    quoteCurrency: inst.quoteCurrency,
    assetClass: inst.assetClass,
    quote,
    fxToGbp,
    marketValueGbp,
    unrealisedGbp: valuable ? unrealisedGbp : ZERO,
    unrealisedPct:
      valuable && !position.costBasisGbp.isZero()
        ? unrealisedGbp.div(position.costBasisGbp)
        : null,
    dayChangeGbp,
    weight: ZERO,
    decomposition: valuable ? decompose(position, quote!.price, fxToGbp) : null,
    unvaluedReason: valuable
      ? null
      : quote === null
        ? 'no price history'
        : `no ${inst.quoteCurrency}/GBP rate`,
  };
}

/**
 * Sum snapshots across accounts when no single account is selected.
 *
 * Accounts do not share a calendar: an ISA holding US names has a snapshot on
 * the August bank holiday, a GIA holding only UK names does not. Summing only
 * the rows that exist on each date makes the second account's value disappear
 * for a day and reappear the next — a phantom -14% followed by a +15%, chained
 * straight into TWR, volatility and max drawdown.
 *
 * So each account is forward-filled: an account with no row on a date still
 * holds whatever it held the day before.
 */
function mergeSnapshots(
  rows: Array<{
    accountId: number;
    snapDate: string;
    twrDaily: string | null;
    marketValueGbp: string;
    cashGbp: string;
    netFlowGbp: string;
  }>,
) {
  const dates = [...new Set(rows.map((r) => r.snapDate))].sort();
  const accountIds = [...new Set(rows.map((r) => r.accountId))];

  const byAccountDate = new Map<string, { value: Decimal; flow: Decimal }>();
  for (const r of rows) {
    byAccountDate.set(`${r.accountId}:${r.snapDate}`, {
      value: dec(r.marketValueGbp).plus(dec(r.cashGbp)),
      flow: dec(r.netFlowGbp),
    });
  }

  const lastKnown = new Map<number, Decimal>();
  return dates.map((date) => {
    let marketValueGbp = ZERO;
    let netFlowGbp = ZERO;
    for (const accountId of accountIds) {
      const row = byAccountDate.get(`${accountId}:${date}`);
      if (row) {
        lastKnown.set(accountId, row.value);
        netFlowGbp = netFlowGbp.plus(row.flow);
      }
      // An account that has not started yet contributes nothing; one that is
      // simply closed for the day contributes what it held yesterday.
      marketValueGbp = marketValueGbp.plus(lastKnown.get(accountId) ?? ZERO);
    }
    return { date, marketValueGbp, netFlowGbp };
  });
}

function windowReturn(series: TwrPoint[], from: IsoDate): Decimal | null {
  const window = series.filter((p) => p.date > from);
  if (window.length === 0) return null;
  return chainLink(window.map((p) => p.dailyReturn));
}

/* ---------------- Analytics snapshots ---------------- */

export async function getAnalytics<T = Record<string, unknown>>(
  kind: string,
  accountId?: number,
): Promise<{ payload: T; snapDate: string; computedAt: Date } | null> {
  const rows = await db
    .select()
    .from(analyticsSnapshots)
    .where(
      accountId
        ? and(eq(analyticsSnapshots.kind, kind), eq(analyticsSnapshots.accountId, accountId))
        : eq(analyticsSnapshots.kind, kind),
    )
    .orderBy(desc(analyticsSnapshots.snapDate))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return { payload: row.payload as T, snapDate: row.snapDate, computedAt: row.computedAt };
}

/* ---------------- Market context: benchmark levels and the risk-free rate ---------------- */

export interface MarketContext {
  benchmark: {
    code: string;
    name: string;
    currency: string;
    proxySymbol: string;
    /** Key into `levels` for the GBP-translated series — the default view (§3.3). */
    gbpLabel: string;
    /** Key into `levels` for the local-currency series, or null for a GBP benchmark. */
    localLabel: string | null;
    levels: Record<string, LevelPoint[]>;
  } | null;
  /** Daily GBP risk-free rate by calendar date, carried forward. Empty until FRED is loaded. */
  riskFreeDaily: Map<IsoDate, number>;
  riskFreeSource: string | null;
}

/**
 * Benchmark price levels in both currencies, read straight from the stored
 * daily bars and FX so the comparison is always as current as the portfolio
 * series it sits beside. Regressions still come from the nightly job; this is
 * only the plain "you versus the index" arithmetic.
 *
 * A missing FX rate drops the day rather than assuming parity (§3).
 */
export async function getMarketContext(code = 'SPX'): Promise<MarketContext> {
  const [bench] = await db.select().from(benchmarks).where(eq(benchmarks.code, code)).limit(1);
  const riskFree = await loadRiskFree();

  if (!bench) return { benchmark: null, ...riskFree };

  const [proxy] = await db
    .select({ id: instruments.id, quoteCurrency: instruments.quoteCurrency })
    .from(instruments)
    .where(eq(instruments.symbol, bench.proxySymbol))
    .limit(1);
  if (!proxy) return { benchmark: null, ...riskFree };

  const rows = await db
    .select({ date: pricesDaily.priceDate, close: pricesDaily.close })
    .from(pricesDaily)
    .where(eq(pricesDaily.instrumentId, proxy.id))
    .orderBy(asc(pricesDaily.priceDate));
  if (rows.length === 0) return { benchmark: null, ...riskFree };

  const local: LevelPoint[] = rows.map((r) => ({ date: r.date, level: Number(r.close) }));
  const gbpLabel = `${bench.name} (GBP)`;

  if (proxy.quoteCurrency === 'GBP') {
    return {
      benchmark: {
        code: bench.code,
        name: bench.name,
        currency: 'GBP',
        proxySymbol: bench.proxySymbol,
        gbpLabel,
        localLabel: null,
        levels: { [gbpLabel]: local },
      },
      ...riskFree,
    };
  }

  const fx = await loadFx(rows[0]!.date, todayIso());
  const gbp: LevelPoint[] = [];
  for (const r of rows) {
    const rate = fx.rateOn(proxy.quoteCurrency, 'GBP', r.date);
    if (rate) gbp.push({ date: r.date, level: Number(r.close) * rate.toNumber() });
  }
  const localLabel = `${bench.name} (${proxy.quoteCurrency})`;

  return {
    benchmark: {
      code: bench.code,
      name: bench.name,
      currency: proxy.quoteCurrency,
      proxySymbol: bench.proxySymbol,
      gbpLabel,
      localLabel,
      levels: { [gbpLabel]: gbp, [localLabel]: local },
    },
    ...riskFree,
  };
}

/** SONIA from FRED (IUDSOIA), annualised percent, as a daily decimal by calendar date. */
async function loadRiskFree(): Promise<Pick<MarketContext, 'riskFreeDaily' | 'riskFreeSource'>> {
  const rows = await db
    .select({ date: macroSeries.obsDate, value: macroSeries.value })
    .from(macroSeries)
    .where(eq(macroSeries.seriesId, 'IUDSOIA'))
    .orderBy(asc(macroSeries.obsDate));
  const observations = rows.filter((r) => r.value !== null);
  if (observations.length === 0) return { riskFreeDaily: new Map(), riskFreeSource: null };

  const byDate = new Map(observations.map((r) => [r.date, Number(r.value) / 100 / 252]));
  const out = new Map<IsoDate, number>();
  let last = 0;
  for (const d of eachDay(observations[0]!.date, todayIso())) {
    last = byDate.get(d) ?? last;
    out.set(d, last);
  }
  return { riskFreeDaily: out, riskFreeSource: 'SONIA (FRED IUDSOIA)' };
}

/* ---------------- Operational views ---------------- */

export async function getDataHealth(hours = 48) {
  const since = new Date(Date.now() - hours * 3_600_000);
  const [events, jobs, staleQuotes] = await Promise.all([
    db
      .select()
      .from(dataHealth)
      .where(gte(dataHealth.occurredAt, since))
      .orderBy(desc(dataHealth.occurredAt))
      .limit(200),
    db.select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(25),
    db
      .select({
        instrumentId: quotesLive.instrumentId,
        symbol: instruments.symbol,
        asOf: quotesLive.asOf,
        delaySeconds: quotesLive.delaySeconds,
        provider: quotesLive.provider,
      })
      .from(quotesLive)
      .innerJoin(instruments, eq(instruments.id, quotesLive.instrumentId))
      .orderBy(quotesLive.asOf),
  ]);

  return { events, jobs, quotes: staleQuotes };
}

/** Corporate actions awaiting confirmation (§6). */
export async function getPendingActions() {
  return db
    .select({
      action: corporateActions,
      symbol: instruments.symbol,
      name: instruments.name,
    })
    .from(corporateActions)
    .innerJoin(instruments, eq(instruments.id, corporateActions.instrumentId))
    .where(eq(corporateActions.applied, false))
    .orderBy(desc(corporateActions.actionDate));
}

export async function getUpcomingEarnings(days = 30) {
  const today = todayIso();
  return db
    .select({
      event: earningsEvents,
      symbol: instruments.symbol,
      name: instruments.name,
    })
    .from(earningsEvents)
    .innerJoin(instruments, eq(instruments.id, earningsEvents.instrumentId))
    .where(
      and(gte(earningsEvents.reportDate, today), sql`${earningsEvents.reportDate} <= ${addDays(today, days)}`),
    )
    .orderBy(earningsEvents.reportDate)
    .limit(20);
}

export async function getWatchlist() {
  const rows = await db
    .select({
      entry: watchlist,
      instrument: instruments,
      quote: quotesLive,
    })
    .from(watchlist)
    .innerJoin(instruments, eq(instruments.id, watchlist.instrumentId))
    .leftJoin(quotesLive, eq(quotesLive.instrumentId, watchlist.instrumentId))
    .orderBy(desc(watchlist.conviction));

  return rows.map((r) => {
    const price = r.quote ? dec(r.quote.price) : null;
    const target = r.entry.targetEntry ? dec(r.entry.targetEntry) : null;
    return {
      ...r,
      price,
      target,
      distanceToTarget: price && target && !target.isZero() ? price.div(target).minus(ONE) : null,
      alertTriggered:
        price !== null &&
        ((r.entry.alertAbove !== null && price.greaterThan(dec(r.entry.alertAbove))) ||
          (r.entry.alertBelow !== null && price.lessThan(dec(r.entry.alertBelow)))),
    };
  });
}

export async function listAccounts() {
  return db.select().from(accounts).orderBy(accounts.id);
}

/* ---------------- Attribution ---------------- */

export interface AttributionGrids {
  from: IsoDate;
  to: IsoDate;
  days: number;
  totalReturn: Decimal;
  grids: Record<string, AttributionResult>;
  labels: Map<string, string>;
  months: ReturnType<typeof periodReturns>;
  quarters: ReturnType<typeof periodReturns>;
  years: ReturnType<typeof periodReturns>;
  needsRecompute: boolean;
}

/**
 * Rebuild the attribution grids from `portfolio_daily`.
 *
 * The cached `holdings` payload carries each day's quantity, local price and FX
 * rate, which is exactly what the weight-and-return decomposition needs — so
 * this reads the cache rather than re-deriving positions for every day.
 */
export async function getAttribution(
  accountId?: number,
  from?: IsoDate,
): Promise<AttributionGrids> {
  const ledger = await loadLedger(accountId ? { accountId } : {});
  const rows = await db
    .select()
    .from(portfolioDaily)
    .where(
      accountId
        ? from
          ? and(eq(portfolioDaily.accountId, accountId), gte(portfolioDaily.snapDate, from))
          : eq(portfolioDaily.accountId, accountId)
        : from
          ? gte(portfolioDaily.snapDate, from)
          : sql`true`,
    )
    .orderBy(portfolioDaily.snapDate);

  const snapshots = rebuildSnapshots(rows);
  const days = toAttributionDays(snapshots);
  const groupers = makeGroupers(ledger.meta);

  const labels = new Map<string, string>();
  for (const inst of ledger.instruments) labels.set(String(inst.id), inst.symbol);

  const grids: Record<string, AttributionResult> = {
    position: attribute(days, byInstrument),
    sector: attribute(days, groupers.sector),
    theme: attribute(days, groupers.theme),
    revenueGeography: attribute(days, groupers.revenueGeography),
    listingCountry: attribute(days, groupers.listingCountry),
    currency: attribute(days, groupers.currency),
    assetClass: attribute(days, groupers.assetClass),
  };

  return {
    from: snapshots[0]?.date ?? todayIso(),
    to: snapshots.at(-1)?.date ?? todayIso(),
    days: days.length,
    totalReturn: grids.position!.totalReturn,
    grids,
    labels,
    months: periodReturns(days, monthKey),
    quarters: periodReturns(days, quarterKey),
    years: periodReturns(days, yearKey),
    needsRecompute: rows.length === 0,
  };
}

/**
 * Merge cached rows back into snapshots for the whole portfolio.
 *
 * Accounts are forward-filled onto the union of dates for the same reason as in
 * `mergeSnapshots`: an account closed for a bank holiday still holds what it
 * held yesterday, and dropping it for a day would produce a phantom loss that
 * attribution would then explain as a real one.
 */
function rebuildSnapshots(rows: Array<typeof portfolioDaily.$inferSelect>): DailySnapshot[] {
  interface AccountDay {
    marketValueGbp: Decimal;
    costBasisGbp: Decimal;
    cashGbp: Decimal;
    netFlowGbp: Decimal;
    positions: DailySnapshot['positions'];
  }

  const parse = (row: typeof portfolioDaily.$inferSelect): AccountDay => ({
    marketValueGbp: dec(row.marketValueGbp),
    costBasisGbp: dec(row.costBasisGbp),
    cashGbp: dec(row.cashGbp),
    netFlowGbp: dec(row.netFlowGbp),
    positions: (
      (row.holdings ?? []) as Array<{
        instrument_id: number;
        quantity: string;
        price_local: string | null;
        fx_to_gbp: string;
        value_gbp: string;
        cost_basis_gbp: string;
      }>
    ).map((h) => ({
      instrumentId: h.instrument_id,
      quantity: dec(h.quantity),
      priceLocal: h.price_local === null ? null : dec(h.price_local),
      fxToGbp: dec(h.fx_to_gbp),
      valueGbp: dec(h.value_gbp),
      costBasisGbp: dec(h.cost_basis_gbp),
    })),
  });

  const byAccountDate = new Map<string, AccountDay>();
  for (const row of rows) byAccountDate.set(`${row.accountId}:${row.snapDate}`, parse(row));

  const dates = [...new Set(rows.map((r) => r.snapDate))].sort();
  const accountIds = [...new Set(rows.map((r) => r.accountId))];
  const lastKnown = new Map<number, AccountDay>();

  return dates.map((date) => {
    let marketValueGbp = ZERO;
    let costBasisGbp = ZERO;
    let cashGbp = ZERO;
    let netFlowGbp = ZERO;
    let positions: DailySnapshot['positions'] = [];

    for (const accountId of accountIds) {
      const today = byAccountDate.get(`${accountId}:${date}`);
      if (today) {
        lastKnown.set(accountId, today);
        netFlowGbp = netFlowGbp.plus(today.netFlowGbp);
      }
      const effective = lastKnown.get(accountId);
      if (!effective) continue; // account has not started yet
      marketValueGbp = marketValueGbp.plus(effective.marketValueGbp);
      costBasisGbp = costBasisGbp.plus(effective.costBasisGbp);
      cashGbp = cashGbp.plus(effective.cashGbp);
      positions = [...positions, ...effective.positions];
    }

    return {
      date,
      marketValueGbp,
      costBasisGbp,
      cashGbp,
      totalValueGbp: marketValueGbp.plus(cashGbp),
      netFlowGbp,
      positions,
      // The cached row records only what WAS valued; anything unvaluable was
      // already reported by the job that wrote it.
      unvalued: [],
    };
  });
}
