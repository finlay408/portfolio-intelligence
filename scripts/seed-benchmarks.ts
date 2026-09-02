/**
 * Install the benchmark proxies.
 *
 *   npm run seed:benchmarks
 *
 * Separate from `npm run seed`, which loads the demo portfolio. Benchmarks are
 * not demo data — nothing works without them:
 *
 *   - alpha, beta, tracking error, information ratio and up/down capture are
 *     all measured against a benchmark return series;
 *   - the relative rotation graph is defined relative to one;
 *   - scenario replay needs a market series to propagate through betas.
 *
 * Each proxy has to exist as an *instrument*, not just as a `benchmarks` row,
 * because a return series needs somewhere to hang its prices.
 *
 * ISF.L is the whole GBX trap in one line: the FTSE 100 tracker quotes in pence,
 * so a multiplier of 1 would make the UK benchmark a hundred times the size of
 * the portfolio being compared to it.
 */
import { eq } from 'drizzle-orm';
import { db } from '../src/db';
import { benchmarks, instruments } from '../src/db/schema';
import { runJob } from './_util';

const PROXIES = [
  {
    code: 'SPX',
    name: 'S&P 500',
    symbol: 'SPY',
    proxyName: 'SPDR S&P 500 ETF Trust',
    currency: 'USD',
    quoteCurrency: 'USD',
    quoteMultiplier: '1',
    exchangeMic: 'XNYS',
    alpaca: 'SPY',
  },
  {
    code: 'FTSE100',
    name: 'FTSE 100',
    symbol: 'ISF.L',
    proxyName: 'iShares Core FTSE 100 UCITS ETF',
    currency: 'GBP',
    // Quoted in GBX. See the note above.
    quoteCurrency: 'GBP',
    quoteMultiplier: '0.01',
    exchangeMic: 'XLON',
    alpaca: null,
  },
  {
    code: 'ACWI',
    name: 'MSCI All Country World',
    symbol: 'ACWI',
    proxyName: 'iShares MSCI ACWI ETF',
    currency: 'USD',
    quoteCurrency: 'USD',
    quoteMultiplier: '1',
    exchangeMic: 'XNAS',
    alpaca: 'ACWI',
  },
] as const;

await runJob('seed-benchmarks', async () => {
  let instrumentsAdded = 0;
  let benchmarksAdded = 0;

  for (const p of PROXIES) {
    const [existing] = await db.select().from(instruments).where(eq(instruments.symbol, p.symbol));
    if (!existing) {
      await db.insert(instruments).values({
        symbol: p.symbol,
        name: p.proxyName,
        assetClass: 'etf',
        exchangeMic: p.exchangeMic,
        quoteCurrency: p.quoteCurrency,
        quoteMultiplier: p.quoteMultiplier,
        yahooSymbol: p.symbol,
        alpacaSymbol: p.alpaca,
        finnhubSymbol: p.symbol,
      });
      instrumentsAdded++;
      console.log(
        `[benchmarks] ${p.symbol.padEnd(7)} ${p.proxyName}` +
          (p.quoteMultiplier === '0.01' ? '  (quoted in pence)' : ''),
      );
    }

    const [row] = await db.select().from(benchmarks).where(eq(benchmarks.code, p.code));
    if (!row) {
      await db
        .insert(benchmarks)
        .values({ code: p.code, name: p.name, proxySymbol: p.symbol, currency: p.currency });
      benchmarksAdded++;
    }
  }

  console.log(
    `\n[benchmarks] Next: npm run backfill (fetches their price history), then the ` +
      'nightly analytics job can compute alpha, beta and the rotation graph.',
  );
  return { instrumentsAdded, benchmarksAdded };
});
