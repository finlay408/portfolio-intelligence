/**
 * Portfolio Intelligence — database schema (CLAUDE.md §5).
 *
 * Rules enforced here rather than in application code:
 *   - every money/quantity column is `numeric`, never `double precision`.
 *     Drizzle returns `numeric` as a string; parse it with `dec()` from
 *     `@/lib/decimal`. Money never passes through `number` arithmetic.
 *   - `instruments.quote_multiplier` carries the GBX→GBP factor so pence
 *     handling is a schema fact, not an ad-hoc branch (§3.1).
 *   - `trades` is append-only. `is_void` plus a replacement row is the only
 *     correction mechanism; the app exposes no UPDATE or DELETE path.
 */
import {
  bigint,
  bigserial,
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/* ============================================================
 * REFERENCE DATA
 * ============================================================ */

export const accounts = pgTable('accounts', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(), // 'Stocks & Shares ISA', 'GIA', 'SIPP'
  wrapper: text('wrapper').notNull(), // 'ISA' | 'GIA' | 'SIPP'
  baseCurrency: char('base_currency', { length: 3 }).notNull().default('GBP'),
  broker: text('broker'),
  openedOn: date('opened_on'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const instruments = pgTable(
  'instruments',
  {
    id: serial('id').primaryKey(),
    symbol: text('symbol').notNull(), // canonical internal symbol
    isin: text('isin'),
    name: text('name').notNull(),
    assetClass: text('asset_class').notNull(), // equity|etf|investment_trust|option|cash|bond
    exchangeMic: text('exchange_mic'), // XNAS|XNYS|XLON
    /** Currency AFTER quoteMultiplier has been applied. GBX lines store 'GBP'. */
    quoteCurrency: char('quote_currency', { length: 3 }).notNull(),
    /** 0.01 for GBX-quoted LSE lines, 1 otherwise. See §3.1. */
    quoteMultiplier: numeric('quote_multiplier').notNull().default('1'),
    /** Listing venue. Nearly useless as a risk measure — see revenueRegions. */
    country: char('country', { length: 2 }),
    /** {"US":0.6,"EU":0.25,"APAC":0.15} — the true geographic exposure. */
    revenueRegions: jsonb('revenue_regions').$type<Record<string, number>>(),
    sector: text('sector'), // GICS sector
    /**
     * {"Technology":0.31,"Financial Services":0.17,...} — a fund's look-through
     * sector split. An all-world tracker has no single sector, and forcing one
     * on it is why funds used to fall into "Unclassified". Null for an ordinary
     * equity, which has `sector` instead.
     */
    sectorWeights: jsonb('sector_weights').$type<Record<string, number>>(),
    industry: text('industry'),
    isActive: boolean('is_active').notNull().default(true),
    // provider symbol mapping
    yahooSymbol: text('yahoo_symbol'), // 'AAPL', 'RR.L'
    alpacaSymbol: text('alpaca_symbol'), // US only, null for LSE
    finnhubSymbol: text('finnhub_symbol'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('instruments_symbol_key').on(t.symbol)],
);

export const themes = pgTable('themes', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(), // 'Photonics', 'Critical Minerals', 'Defence'
  description: text('description'),
  colour: text('colour'),
});

export const instrumentThemes = pgTable(
  'instrument_themes',
  {
    instrumentId: integer('instrument_id')
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    themeId: integer('theme_id')
      .notNull()
      .references(() => themes.id, { onDelete: 'cascade' }),
    /** Partial membership. Weights for one instrument must sum to <= 1. */
    weight: numeric('weight').notNull().default('1'),
  },
  (t) => [primaryKey({ columns: [t.instrumentId, t.themeId] })],
);

/* ============================================================
 * THE LEDGER — append-only, sole source of truth
 * ============================================================ */

export const trades = pgTable(
  'trades',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id),
    instrumentId: integer('instrument_id')
      .notNull()
      .references(() => instruments.id),
    tradeDate: date('trade_date').notNull(),
    settleDate: date('settle_date'),
    side: text('side').notNull(), // 'buy' | 'sell'
    quantity: numeric('quantity').notNull(),
    /** Per share, in tradeCurrency, POST-multiplier (never pence). */
    price: numeric('price').notNull(),
    tradeCurrency: char('trade_currency', { length: 3 }).notNull(),
    /** tradeCurrency -> GBP at execution. */
    fxRate: numeric('fx_rate').notNull(),
    commission: numeric('commission').notNull().default('0'),
    /** 0.5% on UK purchases; 0 on ETFs / investment trusts. */
    stampDuty: numeric('stamp_duty').notNull().default('0'),
    fxFee: numeric('fx_fee').notNull().default('0'),
    otherFees: numeric('other_fees').notNull().default('0'),
    source: text('source').notNull().default('manual'), // manual|auto_invest|import
    ruleId: integer('rule_id'), // set when source = 'auto_invest'
    note: text('note'),
    /**
     * The broker's own transaction ID when the row came from an export upload.
     * It is what makes re-uploading an overlapping export idempotent: the same
     * fill can never be recorded twice, however many files it appears in.
     */
    externalId: text('external_id'),
    /** Corrections: void, never delete. */
    isVoid: boolean('is_void').notNull().default(false),
    voidedBy: bigint('voided_by', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('trades_acct_inst_date_idx').on(t.accountId, t.instrumentId, t.tradeDate),
    check('trades_quantity_positive', sql`${t.quantity} > 0`),
    check('trades_side_valid', sql`${t.side} in ('buy','sell')`),
    uniqueIndex('trades_external_id_idx')
      .on(t.accountId, t.externalId)
      .where(sql`${t.externalId} is not null`),
  ],
);

export const cashFlows = pgTable('cash_flows', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  accountId: integer('account_id')
    .notNull()
    .references(() => accounts.id),
  flowDate: date('flow_date').notNull(),
  /** deposit|withdrawal|dividend|interest|fee|tax */
  kind: text('kind').notNull(),
  /** Signed, in flowCurrency. Deposits positive, withdrawals negative. */
  amount: numeric('amount').notNull(),
  flowCurrency: char('flow_currency', { length: 3 }).notNull(),
  fxRate: numeric('fx_rate').notNull(),
  instrumentId: integer('instrument_id').references(() => instruments.id), // dividends
  /** US dividends: 15% with a W-8BEN on file. */
  withholding: numeric('withholding').notNull().default('0'),
  note: text('note'),
  /** Broker transaction ID for uploaded rows; see `trades.externalId`. */
  externalId: text('external_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
(t) => [
  uniqueIndex('cash_flows_external_id_idx')
    .on(t.accountId, t.externalId)
    .where(sql`${t.externalId} is not null`),
]);

export const autoInvestRules = pgTable('auto_invest_rules', {
  id: serial('id').primaryKey(),
  accountId: integer('account_id')
    .notNull()
    .references(() => accounts.id),
  name: text('name').notNull(),
  cadence: text('cadence').notNull(), // monthly|weekly|fortnightly
  /** 1-28 only. Later days are ambiguous in February. */
  dayOfMonth: integer('day_of_month'),
  dayOfWeek: integer('day_of_week'), // 0-6, Sunday = 0
  amount: numeric('amount').notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  /** [{"instrument_id":12,"pct":0.5}, ...] — must sum to 1. */
  allocation: jsonb('allocation').$type<{ instrument_id: number; pct: number }[]>().notNull(),
  fractional: boolean('fractional').notNull().default(true),
  activeFrom: date('active_from').notNull(),
  activeTo: date('active_to'),
  isActive: boolean('is_active').notNull().default(true),
  lastExecutedOn: date('last_executed_on'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const corporateActions = pgTable(
  'corporate_actions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    instrumentId: integer('instrument_id')
      .notNull()
      .references(() => instruments.id),
    actionDate: date('action_date').notNull(), // ex-date
    /** split|reverse_split|dividend|special_dividend|spinoff|merger|ticker_change|delisting */
    kind: text('kind').notNull(),
    /** 4 for a 4:1 split, 0.1 for a 1:10 reverse. */
    ratio: numeric('ratio'),
    amount: numeric('amount'), // per-share, for dividends
    currency: char('currency', { length: 3 }),
    detail: jsonb('detail').$type<Record<string, unknown>>(), // spinoff / merger terms
    /** False until confirmed for anything moving a position > 15% (§6). */
    applied: boolean('applied').notNull().default(false),
    source: text('source'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('corp_actions_uniq').on(t.instrumentId, t.actionDate, t.kind)],
);

/* ============================================================
 * MARKET DATA
 * ============================================================ */

export const pricesDaily = pgTable(
  'prices_daily',
  {
    instrumentId: integer('instrument_id')
      .notNull()
      .references(() => instruments.id),
    priceDate: date('price_date').notNull(),
    open: numeric('open'),
    high: numeric('high'),
    low: numeric('low'),
    /** Raw close, POST-multiplier, in quoteCurrency. */
    close: numeric('close').notNull(),
    adjClose: numeric('adj_close'), // split & dividend adjusted
    volume: bigint('volume', { mode: 'number' }),
    provider: text('provider').notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.instrumentId, t.priceDate] })],
);

export const quotesLive = pgTable('quotes_live', {
  instrumentId: integer('instrument_id')
    .primaryKey()
    .references(() => instruments.id),
  price: numeric('price').notNull(),
  changePct: numeric('change_pct'),
  asOf: timestamp('as_of', { withTimezone: true }).notNull(),
  /** 0 for Alpaca US, ~900 for Yahoo LSE. The UI must render this. */
  delaySeconds: integer('delay_seconds').notNull(),
  provider: text('provider').notNull(),
});

export const fxRatesDaily = pgTable(
  'fx_rates_daily',
  {
    pair: text('pair').notNull(), // 'USDGBP'
    rateDate: date('rate_date').notNull(),
    rate: numeric('rate').notNull(),
    provider: text('provider').notNull(),
  },
  (t) => [primaryKey({ columns: [t.pair, t.rateDate] })],
);

export const benchmarks = pgTable('benchmarks', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(), // 'SPX','FTSE100','ACWI'
  name: text('name').notNull(),
  proxySymbol: text('proxy_symbol').notNull(), // 'SPY','ISF.L'
  currency: char('currency', { length: 3 }).notNull(),
});

export const factorReturns = pgTable(
  'factor_returns',
  {
    factorDate: date('factor_date').notNull(),
    factor: text('factor').notNull(), // Mkt-RF|SMB|HML|RMW|CMA|MOM|RF
    region: text('region').notNull(), // US|Developed|Europe
    ret: numeric('ret').notNull(), // decimal, not percent
  },
  (t) => [primaryKey({ columns: [t.factorDate, t.factor, t.region] })],
);

export const macroSeries = pgTable(
  'macro_series',
  {
    seriesId: text('series_id').notNull(), // FRED code: DGS10, T10Y2Y, VIXCLS, CPIAUCSL
    obsDate: date('obs_date').notNull(),
    value: numeric('value'),
  },
  (t) => [primaryKey({ columns: [t.seriesId, t.obsDate] })],
);

export const earningsEvents = pgTable(
  'earnings_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    instrumentId: integer('instrument_id')
      .notNull()
      .references(() => instruments.id),
    reportDate: date('report_date').notNull(),
    session: text('session'), // bmo|amc|unknown
    fiscalPeriod: text('fiscal_period'), // 'Q3 FY26'
    epsEstimate: numeric('eps_estimate'),
    epsActual: numeric('eps_actual'),
    revenueEstimate: numeric('revenue_estimate'),
    revenueActual: numeric('revenue_actual'),
    surprisePct: numeric('surprise_pct'),
    guidanceNote: text('guidance_note'),
    /** Optional LLM-generated bullets. Nullable by design — nothing depends on them. */
    keyPoints: jsonb('key_points').$type<string[]>(),
    filingUrl: text('filing_url'),
    confirmed: boolean('confirmed').notNull().default(false),
  },
  (t) => [unique('earnings_uniq').on(t.instrumentId, t.reportDate)],
);

export const fundamentals = pgTable(
  'fundamentals',
  {
    instrumentId: integer('instrument_id')
      .notNull()
      .references(() => instruments.id),
    asOf: date('as_of').notNull(),
    /** pe, ev_ebitda, fcf_yield, net_debt_ebitda, gross_margin, dividend_yield, adv_20d ... */
    metrics: jsonb('metrics').$type<Record<string, number | null>>().notNull(),
    provider: text('provider').notNull(),
  },
  (t) => [primaryKey({ columns: [t.instrumentId, t.asOf] })],
);

export const watchlist = pgTable(
  'watchlist',
  {
    id: serial('id').primaryKey(),
    instrumentId: integer('instrument_id')
      .notNull()
      .references(() => instruments.id)
      .unique(),
    thesis: text('thesis'),
    targetEntry: numeric('target_entry'),
    conviction: integer('conviction'),
    addedOn: date('added_on').notNull().defaultNow(),
    alertAbove: numeric('alert_above'),
    alertBelow: numeric('alert_below'),
  },
  (t) => [check('watchlist_conviction_range', sql`${t.conviction} between 1 and 5`)],
);

/* ============================================================
 * OPTIONS (Phase 5 — schema defined now)
 * ============================================================ */

export const optionContracts = pgTable('option_contracts', {
  id: serial('id').primaryKey(),
  occSymbol: text('occ_symbol').notNull().unique(),
  underlyingId: integer('underlying_id')
    .notNull()
    .references(() => instruments.id),
  expiry: date('expiry').notNull(),
  strike: numeric('strike').notNull(),
  right: char('right', { length: 1 }).notNull(), // 'C' | 'P'
  multiplier: integer('multiplier').notNull().default(100),
});

export const optionQuotes = pgTable(
  'option_quotes',
  {
    contractId: integer('contract_id')
      .notNull()
      .references(() => optionContracts.id),
    asOf: timestamp('as_of', { withTimezone: true }).notNull(),
    bid: numeric('bid'),
    ask: numeric('ask'),
    last: numeric('last'),
    iv: numeric('iv'),
    delta: numeric('delta'),
    gamma: numeric('gamma'),
    theta: numeric('theta'),
    vega: numeric('vega'),
    rho: numeric('rho'),
    openInterest: bigint('open_interest', { mode: 'number' }),
    /** 'provider' | 'computed' — deep ITM contracts often lack provider Greeks. */
    greeksSource: text('greeks_source').notNull(),
  },
  (t) => [primaryKey({ columns: [t.contractId, t.asOf] })],
);

/* ============================================================
 * CACHED ANALYTICS — rebuildable, never authoritative
 * ============================================================ */

export const portfolioDaily = pgTable(
  'portfolio_daily',
  {
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id),
    snapDate: date('snap_date').notNull(),
    marketValueGbp: numeric('market_value_gbp').notNull(),
    costBasisGbp: numeric('cost_basis_gbp').notNull(),
    cashGbp: numeric('cash_gbp').notNull().default('0'),
    /** Deposits - withdrawals that day. */
    netFlowGbp: numeric('net_flow_gbp').notNull().default('0'),
    twrDaily: numeric('twr_daily'),
    /** Full position snapshot, for audit and for the recompute diff. */
    holdings: jsonb('holdings').$type<unknown>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.snapDate] })],
);

export const analyticsSnapshots = pgTable(
  'analytics_snapshots',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    accountId: integer('account_id').references(() => accounts.id),
    snapDate: date('snap_date').notNull(),
    /** risk|factor|attribution|rrg|liquidity|scenario */
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('analytics_snapshots_uniq').on(t.accountId, t.snapDate, t.kind)],
);

/* ============================================================
 * OPERATIONAL — provider degradation must be visible (§6)
 * ============================================================ */

export const dataHealth = pgTable(
  'data_health',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    provider: text('provider').notNull(),
    /** quote|bars|fx|corp_actions|earnings|macro|factors|options */
    capability: text('capability').notNull(),
    instrumentId: integer('instrument_id').references(() => instruments.id),
    /** ok|degraded|failed|rate_limited */
    status: text('status').notNull(),
    detail: text('detail'),
    /** Which provider actually served the request after fallthrough. */
    servedBy: text('served_by'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('data_health_occurred_idx').on(t.occurredAt)],
);

/**
 * Every broker export that has been uploaded, kept verbatim.
 *
 * The ledger is the source of truth (§2), but the export is the source of the
 * ledger, and keeping it means any row can be traced back to the broker's own
 * statement. It also makes the two-step upload (preview, then commit) possible
 * on a serverless host, where nothing survives between requests but the
 * database.
 */
export const importFiles = pgTable('import_files', {
  id: serial('id').primaryKey(),
  accountId: integer('account_id')
    .notNull()
    .references(() => accounts.id),
  broker: text('broker').notNull().default('trading212'),
  filename: text('filename').notNull(),
  /** Hex SHA-256 of the content; the same file uploaded twice is one row. */
  sha256: text('sha256').notNull(),
  content: text('content').notNull(),
  rowCount: integer('row_count').notNull(),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  /** What the commit wrote: counts, problems, new instruments. */
  summary: jsonb('summary').$type<Record<string, unknown>>(),
}, (t) => [unique('import_files_sha256_key').on(t.accountId, t.sha256)]);

export const jobRuns = pgTable('job_runs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  job: text('job').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  status: text('status').notNull().default('running'), // running|ok|failed
  detail: jsonb('detail').$type<Record<string, unknown>>(),
});

/* Convenience row types used across the engine. */
export type Account = typeof accounts.$inferSelect;
export type Instrument = typeof instruments.$inferSelect;
export type Trade = typeof trades.$inferSelect;
export type CashFlow = typeof cashFlows.$inferSelect;
export type CorporateAction = typeof corporateActions.$inferSelect;
export type PriceDaily = typeof pricesDaily.$inferSelect;
export type FxRateDaily = typeof fxRatesDaily.$inferSelect;
export type AutoInvestRule = typeof autoInvestRules.$inferSelect;
export type ImportFile = typeof importFiles.$inferSelect;
