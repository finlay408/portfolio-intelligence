/**
 * Historical backfill of daily bars and FX (Phase 2).
 *
 *   npm run backfill                          # everything held, since inception
 *   npm run backfill -- --from=2020-01-01
 *   npm run backfill -- --symbol=RR.L --force
 *
 * Never re-requests a bar already held (§6): the default `from` for each
 * instrument is the day after its most recent stored close.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../src/db';
import { benchmarks, fxRatesDaily, instruments, pricesDaily, trades, watchlist } from '../src/db/schema';
import { addDays, todayIso } from '../src/lib/dates';
import { toEngineInstrument } from '../src/lib/engine/load';
import { getDailyBars, getFxHistory } from '../src/lib/providers/registry';
import { args, chunk, runJob } from './_util';

const argv = args();
const DEFAULT_START = '2019-01-01';

await runJob('backfill', async () => {
  const to = typeof argv.to === 'string' ? argv.to : todayIso();

  // Everything held, watched, or used as a benchmark proxy.
  const heldIds = await db
    .selectDistinct({ id: trades.instrumentId })
    .from(trades)
    .where(eq(trades.isVoid, false));
  const watchedIds = await db.selectDistinct({ id: watchlist.instrumentId }).from(watchlist);
  const wanted = new Set([...heldIds, ...watchedIds].map((r) => r.id));

  const instrumentRows = await db.select().from(instruments);

  // Benchmark proxies are not held, but alpha, beta, tracking error and the RRG
  // are all uncomputable without their history, so they are always ingested.
  const benchRows = await db.select().from(benchmarks);
  for (const bench of benchRows) {
    const match = instrumentRows.find((i) => i.symbol === bench.proxySymbol);
    if (match) wanted.add(match.id);
  }
  const targets = instrumentRows.filter((i) =>
    typeof argv.symbol === 'string' ? i.symbol === argv.symbol : wanted.has(i.id),
  );

  let barsWritten = 0;
  const failures: string[] = [];

  for (const row of targets) {
    const inst = toEngineInstrument(row);
    let from = typeof argv.from === 'string' ? argv.from : DEFAULT_START;

    if (!argv.force) {
      const [latest] = await db
        .select({ d: pricesDaily.priceDate })
        .from(pricesDaily)
        .where(eq(pricesDaily.instrumentId, inst.id))
        .orderBy(desc(pricesDaily.priceDate))
        .limit(1);
      if (latest) from = addDays(latest.d, 1);
    }
    if (from > to) {
      console.log(`[backfill] ${inst.symbol}: already current`);
      continue;
    }

    try {
      const { value: bars, servedBy, degraded } = await getDailyBars(inst, from, to);
      if (bars.length === 0) {
        console.log(`[backfill] ${inst.symbol}: no new bars`);
        continue;
      }

      for (const batch of chunk(bars, 500)) {
        await db
          .insert(pricesDaily)
          .values(
            batch.map((b) => ({
              instrumentId: inst.id,
              priceDate: b.date,
              open: b.open?.toFixed() ?? null,
              high: b.high?.toFixed() ?? null,
              low: b.low?.toFixed() ?? null,
              close: b.close.toFixed(),
              adjClose: b.adjClose?.toFixed() ?? null,
              volume: b.volume,
              provider: b.provider,
            })),
          )
          .onConflictDoUpdate({
            target: [pricesDaily.instrumentId, pricesDaily.priceDate],
            set: {
              close: sql.raw('excluded.close'),
              adjClose: sql.raw('excluded.adj_close'),
              open: sql.raw('excluded.open'),
              high: sql.raw('excluded.high'),
              low: sql.raw('excluded.low'),
              volume: sql.raw('excluded.volume'),
              provider: sql.raw('excluded.provider'),
              ingestedAt: sql.raw('now()'),
            },
          });
        barsWritten += batch.length;
      }
      console.log(
        `[backfill] ${inst.symbol}: ${bars.length} bars from ${servedBy}` +
          (degraded ? ' (primary provider degraded)' : ''),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${inst.symbol}: ${message}`);
      console.error(`[backfill] ${inst.symbol} FAILED: ${message}`);
    }
  }

  // --- FX ---
  const currencies = new Set(instrumentRows.map((i) => i.quoteCurrency).filter((c) => c !== 'GBP'));
  let fxWritten = 0;
  for (const ccy of currencies) {
    const pair = `${ccy}GBP`;
    const fxFrom = typeof argv.from === 'string' ? argv.from : DEFAULT_START;
    try {
      const { value: rates, servedBy } = await getFxHistory(pair, fxFrom, to);
      for (const batch of chunk(rates, 500)) {
        await db
          .insert(fxRatesDaily)
          .values(
            batch.map((r) => ({
              pair: r.pair,
              rateDate: r.date,
              rate: r.rate.toFixed(),
              provider: r.provider,
            })),
          )
          .onConflictDoUpdate({
            target: [fxRatesDaily.pair, fxRatesDaily.rateDate],
            set: { rate: sql.raw('excluded.rate'), provider: sql.raw('excluded.provider') },
          });
        fxWritten += batch.length;
      }
      console.log(`[backfill] ${pair}: ${rates.length} rates from ${servedBy}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${pair}: ${message}`);
      console.error(`[backfill] ${pair} FAILED: ${message}`);
    }
  }

  // A benchmark with no instrument row makes alpha, beta and tracking error
  // uncomputable, so its absence is reported rather than discovered later.
  const benchInstruments = await db
    .select()
    .from(instruments)
    .where(
      inArray(
        instruments.symbol,
        benchRows.map((b) => b.proxySymbol),
      ),
    );
  const missingBenchmarks = benchRows
    .filter((b) => !benchInstruments.some((i) => i.symbol === b.proxySymbol))
    .map((b) => `${b.code} (${b.proxySymbol})`);
  if (missingBenchmarks.length > 0) {
    console.warn(
      `[backfill] benchmark proxies not present as instruments: ${missingBenchmarks.join(', ')}. ` +
        'Add them to `instruments` so alpha and beta can be computed.',
    );
  }

  return { instruments: targets.length, barsWritten, fxWritten, failures: failures.length };
});
