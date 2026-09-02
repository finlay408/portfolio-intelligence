/**
 * Seed the golden portfolio into the database.
 *
 * This is the same ledger the test suite asserts against by hand, so a freshly
 * seeded database renders positions, cost basis, realised P&L and the Section
 * 104 pooling whose correctness is already proven. Running it twice is safe:
 * every insert is keyed and upserted.
 *
 *   npm run seed                      # the fixture ledger, no market data
 *   npm run seed -- --demo-prices     # also map it onto real tickers
 *
 * By default the fixture instruments carry NO provider symbols. That is
 * deliberate. The fixture's trades are fictional and priced for hand
 * arithmetic — 5,000 shares at $2, 40 shares at $400 — and pointing them at
 * real tickers values a £8,000 position at £100,000, producing an 800% day and
 * a −78% TWR out of nothing. A portfolio tool that shows nonsense on first run
 * has already lost the argument, so the default is to show the figures that are
 * true and say plainly that there is no price history yet.
 *
 * `--demo-prices` maps them to real listings so the ingestion, FX, corporate
 * action and analytics pipeline can be exercised end to end. Use it to check
 * the machinery, never to read the P&L.
 */
import { sql } from 'drizzle-orm';
import { db } from '../src/db';
import {
  accounts,
  autoInvestRules,
  benchmarks,
  cashFlows,
  corporateActions,
  instrumentThemes,
  instruments,
  themes,
  trades,
  watchlist,
} from '../src/db/schema';
import {
  cashFlows as fixtureFlows,
  corporateActions as fixtureActions,
  instruments as fixtureInstruments,
  trades as fixtureTrades,
  INST,
  ISA,
  GIA,
} from '../tests/fixtures/golden-portfolio';
import { args, runJob } from './_util';

const argv = args();
const demoPrices = Boolean(argv['demo-prices']);

/**
 * Real listings the fixture instruments stand in for under `--demo-prices`.
 * The economics do not match — see the header — so this is a pipeline exercise,
 * not a portfolio.
 */
const PROVIDER_SYMBOLS: Record<number, { yahoo?: string; alpaca?: string; finnhub?: string }> = {
  [INST.AAPL]: { yahoo: 'AAPL', alpaca: 'AAPL', finnhub: 'AAPL' },
  [INST.RR]: { yahoo: 'RR.L', finnhub: 'RR.L' },
  [INST.SPLITCO]: { yahoo: 'NVDA', alpaca: 'NVDA', finnhub: 'NVDA' },
  [INST.REVCO]: { yahoo: 'PFE', alpaca: 'PFE', finnhub: 'PFE' },
  [INST.OLDCO]: { yahoo: 'FCX', alpaca: 'FCX', finnhub: 'FCX' },
  [INST.VUSA]: { yahoo: 'VUSA.L' },
  // Deliberately unmapped. S104CO exists to exercise the HMRC matching rules
  // with hand-checkable round numbers; pointing it at a real GBX-quoted listing
  // would mix fictional trades with real prices, and the multiplier guard in
  // the Yahoo provider correctly refuses that anyway.
  [INST.S104CO]: {},
};

const THEMES = [
  { name: 'Photonics', description: 'Optical computing and laser supply chain', colour: '#7c9cbf' },
  { name: 'Critical Minerals', description: 'Copper, lithium, rare earths', colour: '#b08968' },
  { name: 'Defence', description: 'Western rearmament', colour: '#6b8f71' },
  { name: 'Broad Market', description: 'Index exposure', colour: '#8d8d8d' },
];

const THEME_MEMBERSHIP: Array<[number, string, string]> = [
  [INST.AAPL, 'Photonics', '0.3'],
  [INST.RR, 'Defence', '0.7'],
  [INST.SPLITCO, 'Photonics', '1'],
  [INST.OLDCO, 'Critical Minerals', '1'],
  [INST.VUSA, 'Broad Market', '1'],
];

await runJob('seed', async () => {
  // --- accounts ---
  await db
    .insert(accounts)
    .values([
      {
        id: ISA,
        name: 'Stocks & Shares ISA',
        wrapper: 'ISA',
        broker: 'Trading 212',
        openedOn: '2023-11-01',
      },
      {
        id: GIA,
        name: 'General Investment Account',
        wrapper: 'GIA',
        broker: 'Interactive Investor',
        openedOn: '2023-11-01',
      },
    ])
    .onConflictDoNothing();
  await db.execute(sql`select setval(pg_get_serial_sequence('accounts','id'), 100, true)`);

  // --- instruments ---
  await db
    .insert(instruments)
    .values(
      fixtureInstruments.map((i) => ({
        id: i.id,
        symbol: i.symbol,
        name: i.name,
        assetClass: i.assetClass,
        exchangeMic: i.exchangeMic,
        quoteCurrency: i.quoteCurrency,
        quoteMultiplier: i.quoteMultiplier.toFixed(),
        country: i.country,
        revenueRegions: i.revenueRegions,
        sector: i.sector,
        industry: i.industry,
        yahooSymbol: demoPrices ? (PROVIDER_SYMBOLS[i.id]?.yahoo ?? null) : null,
        alpacaSymbol: demoPrices ? (PROVIDER_SYMBOLS[i.id]?.alpaca ?? null) : null,
        finnhubSymbol: demoPrices ? (PROVIDER_SYMBOLS[i.id]?.finnhub ?? null) : null,
      })),
    )
    .onConflictDoNothing();
  await db.execute(sql`select setval(pg_get_serial_sequence('instruments','id'), 1000, true)`);

  // --- themes ---
  await db.insert(themes).values(THEMES).onConflictDoNothing();
  const themeRows = await db.select().from(themes);
  const themeIdByName = new Map(themeRows.map((t) => [t.name, t.id]));
  await db
    .insert(instrumentThemes)
    .values(
      THEME_MEMBERSHIP.map(([instrumentId, themeName, weight]) => ({
        instrumentId,
        themeId: themeIdByName.get(themeName)!,
        weight,
      })),
    )
    .onConflictDoNothing();

  // --- benchmark proxies ---
  // These must exist as instruments, not just as `benchmarks` rows: alpha, beta,
  // tracking error and the RRG all need a price series, and a price series
  // needs an instrument to hang off.
  //
  // ISF.L is quoted in GBX. That is the whole §3.1 trap in one row — the FTSE
  // 100 tracker at "1057.8" is £10.578, and getting it wrong would make the UK
  // benchmark a hundred times the portfolio.
  await db
    .insert(instruments)
    .values([
      {
        symbol: 'SPY',
        name: 'SPDR S&P 500 ETF Trust',
        assetClass: 'etf',
        exchangeMic: 'XNYS',
        quoteCurrency: 'USD',
        quoteMultiplier: '1',
        country: 'US',
        yahooSymbol: 'SPY',
        alpacaSymbol: 'SPY',
        finnhubSymbol: 'SPY',
      },
      {
        symbol: 'ISF.L',
        name: 'iShares Core FTSE 100 UCITS ETF',
        assetClass: 'etf',
        exchangeMic: 'XLON',
        quoteCurrency: 'GBP',
        quoteMultiplier: '0.01',
        country: 'IE',
        yahooSymbol: 'ISF.L',
      },
      {
        symbol: 'ACWI',
        name: 'iShares MSCI ACWI ETF',
        assetClass: 'etf',
        exchangeMic: 'XNAS',
        quoteCurrency: 'USD',
        quoteMultiplier: '1',
        country: 'US',
        yahooSymbol: 'ACWI',
        alpacaSymbol: 'ACWI',
      },
    ])
    .onConflictDoNothing();

  // --- benchmarks (§3.3: both SPX variants are derived from one proxy) ---
  await db
    .insert(benchmarks)
    .values([
      { code: 'SPX', name: 'S&P 500', proxySymbol: 'SPY', currency: 'USD' },
      { code: 'FTSE100', name: 'FTSE 100', proxySymbol: 'ISF.L', currency: 'GBP' },
      { code: 'ACWI', name: 'MSCI All Country World', proxySymbol: 'ACWI', currency: 'USD' },
    ])
    .onConflictDoNothing();

  // --- the ledger ---
  await db
    .insert(trades)
    .values(
      fixtureTrades.map((t) => ({
        id: t.id,
        accountId: t.accountId,
        instrumentId: t.instrumentId,
        tradeDate: t.tradeDate,
        side: t.side,
        quantity: t.quantity.toFixed(),
        price: t.price.toFixed(),
        tradeCurrency: t.tradeCurrency,
        fxRate: t.fxRate.toFixed(),
        commission: t.commission.toFixed(),
        stampDuty: t.stampDuty.toFixed(),
        fxFee: t.fxFee.toFixed(),
        otherFees: t.otherFees.toFixed(),
        source: t.source,
      })),
    )
    .onConflictDoNothing();
  await db.execute(sql`select setval(pg_get_serial_sequence('trades','id'), 10000, true)`);

  await db
    .insert(cashFlows)
    .values(
      fixtureFlows.map((f) => ({
        id: f.id,
        accountId: f.accountId,
        flowDate: f.flowDate,
        kind: f.kind,
        amount: f.amount.toFixed(),
        flowCurrency: f.flowCurrency,
        fxRate: f.fxRate.toFixed(),
        instrumentId: f.instrumentId,
        withholding: f.withholding.toFixed(),
      })),
    )
    .onConflictDoNothing();
  await db.execute(sql`select setval(pg_get_serial_sequence('cash_flows','id'), 10000, true)`);

  // Corporate actions land pre-applied because the fixture's figures were
  // computed with them. Anything detected later goes through validation (§6).
  await db
    .insert(corporateActions)
    .values(
      fixtureActions.map((a) => ({
        instrumentId: a.instrumentId,
        actionDate: a.actionDate,
        kind: a.kind,
        ratio: a.ratio?.toFixed() ?? null,
        amount: a.amount?.toFixed() ?? null,
        currency: a.currency,
        detail: a.detail,
        applied: true,
        source: 'seed',
      })),
    )
    .onConflictDoNothing();

  // --- auto-invest rule matching the VUSA drip in the fixture ---
  await db
    .insert(autoInvestRules)
    .values({
      accountId: ISA,
      name: 'Monthly VUSA drip',
      cadence: 'monthly',
      dayOfMonth: 5,
      amount: '500',
      currency: 'GBP',
      allocation: [{ instrument_id: INST.VUSA, pct: 1 }],
      fractional: true,
      activeFrom: '2024-01-01',
      lastExecutedOn: '2025-03-05',
    })
    .onConflictDoNothing();

  // --- watchlist ---
  await db
    .insert(watchlist)
    .values([
      {
        instrumentId: INST.S104CO,
        thesis: 'Fee compression is priced in; net flows are the swing factor.',
        targetEntry: '3.20',
        conviction: 3,
        alertBelow: '3.00',
      },
    ])
    .onConflictDoNothing();

  if (demoPrices) {
    console.warn(
      [
        '',
        '--demo-prices mapped the fixture onto real tickers. The ledger is fictional and',
        'priced for hand arithmetic, so market value, TWR and every risk figure derived',
        'from them will be nonsense. Positions, cost basis, realised P&L and the Section',
        '104 pooling remain correct.',
        '',
      ].join('\n'),
    );
  } else {
    console.log(
      [
        '',
        'Fixture seeded without provider symbols, so there is no price history and no',
        'market value yet. Positions, cost basis, realised P&L and the tax pooling are',
        'live and hand-verified. Add your own instruments with real yahoo_symbol values,',
        'or re-run with --demo-prices to exercise the data pipeline.',
        '',
      ].join('\n'),
    );
  }

  return {
    accounts: 2,
    instruments: fixtureInstruments.length,
    trades: fixtureTrades.length,
    cashFlows: fixtureFlows.length,
    demoPrices,
  };
});
