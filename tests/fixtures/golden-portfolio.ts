/**
 * The golden portfolio (CLAUDE.md §11).
 *
 * 31 trades across two accounts and two currencies, spanning buys, partial
 * sells, full closes, a 4:1 split, a 1:10 reverse split, a dividend, a ticker
 * change, a bed-and-breakfast repurchase and a same-day round trip.
 *
 * Every expected value in `expected` below was computed by hand from these
 * inputs. When a test here fails, the engine is wrong — not the fixture.
 */
import { Decimal } from '../../src/lib/decimal';
import type {
  EngineCashFlow,
  EngineCorporateAction,
  EngineInstrument,
  EngineTrade,
} from '../../src/lib/types';

export const ISA = 1;
export const GIA = 2;

export const INST = {
  AAPL: 1,
  RR: 2, // Rolls-Royce, LSE, quoted in GBX
  SPLITCO: 3, // 4:1 split
  REVCO: 4, // 1:10 reverse split
  OLDCO: 5, // ticker change, no position effect
  VUSA: 6, // GBP-quoted LSE ETF, auto-invest
  S104CO: 7, // GIA holding exercising the HMRC matching rules
} as const;

const d = (v: string | number) => new Decimal(v);

let nextId = 1;

interface TradeSpec {
  account: number;
  instrument: number;
  date: string;
  side: 'buy' | 'sell';
  qty: string | number;
  price: string | number;
  ccy: string;
  fx: string | number;
  commission?: string | number;
  stampDuty?: string | number;
  source?: string;
}

function t(spec: TradeSpec): EngineTrade {
  return {
    id: nextId++,
    accountId: spec.account,
    instrumentId: spec.instrument,
    tradeDate: spec.date,
    side: spec.side,
    quantity: d(spec.qty),
    price: d(spec.price),
    tradeCurrency: spec.ccy,
    fxRate: d(spec.fx),
    commission: d(spec.commission ?? 0),
    stampDuty: d(spec.stampDuty ?? 0),
    fxFee: d(0),
    otherFees: d(0),
    source: spec.source ?? 'manual',
  };
}

/* ---------------- Instruments ---------------- */

export const instruments: EngineInstrument[] = [
  {
    id: INST.AAPL,
    symbol: 'AAPL',
    name: 'Apple Inc.',
    assetClass: 'equity',
    exchangeMic: 'XNAS',
    quoteCurrency: 'USD',
    quoteMultiplier: d(1),
    country: 'US',
    revenueRegions: { US: 0.42, EU: 0.24, APAC: 0.34 },
    sector: 'Information Technology',
    industry: 'Technology Hardware',
  },
  {
    id: INST.RR,
    symbol: 'RR.L',
    name: 'Rolls-Royce Holdings plc',
    assetClass: 'equity',
    exchangeMic: 'XLON',
    // GBX line: quoted in pence, normalised at ingestion, so the engine and
    // everything downstream see GBP.
    quoteCurrency: 'GBP',
    quoteMultiplier: d('0.01'),
    country: 'GB',
    revenueRegions: { US: 0.35, EU: 0.3, UK: 0.2, APAC: 0.15 },
    sector: 'Industrials',
    industry: 'Aerospace & Defence',
  },
  {
    id: INST.SPLITCO,
    symbol: 'SPLT',
    name: 'Split Corp',
    assetClass: 'equity',
    exchangeMic: 'XNAS',
    quoteCurrency: 'USD',
    quoteMultiplier: d(1),
    country: 'US',
    revenueRegions: { US: 1 },
    sector: 'Information Technology',
    industry: 'Semiconductors',
  },
  {
    id: INST.REVCO,
    symbol: 'REVC',
    name: 'Reverse Corp',
    assetClass: 'equity',
    exchangeMic: 'XNAS',
    quoteCurrency: 'USD',
    quoteMultiplier: d(1),
    country: 'US',
    revenueRegions: { US: 0.8, EU: 0.2 },
    sector: 'Health Care',
    industry: 'Biotechnology',
  },
  {
    id: INST.OLDCO,
    symbol: 'NEWC',
    name: 'Renamed Corp (formerly OLDC)',
    assetClass: 'equity',
    exchangeMic: 'XNYS',
    quoteCurrency: 'USD',
    quoteMultiplier: d(1),
    country: 'US',
    revenueRegions: { US: 0.6, EU: 0.4 },
    sector: 'Materials',
    industry: 'Metals & Mining',
  },
  {
    id: INST.VUSA,
    symbol: 'VUSA.L',
    name: 'Vanguard S&P 500 UCITS ETF',
    assetClass: 'etf',
    exchangeMic: 'XLON',
    // Quotes in GBP on the LSE, not GBX. Do not infer from the .L suffix.
    quoteCurrency: 'GBP',
    quoteMultiplier: d(1),
    country: 'IE',
    revenueRegions: { US: 1 },
    sector: null,
    industry: null,
  },
  {
    id: INST.S104CO,
    symbol: 'S104',
    name: 'Pooling Test plc',
    assetClass: 'equity',
    exchangeMic: 'XLON',
    quoteCurrency: 'GBP',
    quoteMultiplier: d(1),
    country: 'GB',
    revenueRegions: { UK: 1 },
    sector: 'Financials',
    industry: 'Asset Management',
  },
];

/* ---------------- The ledger ---------------- */

const tradeSpecs: TradeSpec[] = [
  // --- AAPL: two buys then a partial sell. Average and FIFO diverge here. ---
  { account: ISA, instrument: INST.AAPL, date: '2024-01-15', side: 'buy', qty: 100, price: 150, ccy: 'USD', fx: '0.80', commission: 10 },
  { account: ISA, instrument: INST.AAPL, date: '2024-03-20', side: 'buy', qty: 50, price: 170, ccy: 'USD', fx: '0.78', commission: 10 },
  { account: ISA, instrument: INST.AAPL, date: '2024-06-10', side: 'sell', qty: 60, price: 190, ccy: 'USD', fx: '0.79', commission: 10 },

  // --- RR.L: GBX line, stamp duty on the UK purchase, then a full close. ---
  { account: ISA, instrument: INST.RR, date: '2024-02-01', side: 'buy', qty: 1000, price: '4.50', ccy: 'GBP', fx: 1, commission: 5, stampDuty: '22.50' },
  { account: ISA, instrument: INST.RR, date: '2024-08-01', side: 'sell', qty: 1000, price: '5.20', ccy: 'GBP', fx: 1, commission: 5 },

  // --- SPLITCO: bought pre-split, sold post-split. ---
  { account: ISA, instrument: INST.SPLITCO, date: '2024-02-15', side: 'buy', qty: 40, price: 400, ccy: 'USD', fx: '0.80' },
  { account: ISA, instrument: INST.SPLITCO, date: '2024-09-10', side: 'sell', qty: 60, price: 120, ccy: 'USD', fx: '0.75' },

  // --- REVCO: 1:10 reverse split, then a full close at a loss. ---
  { account: ISA, instrument: INST.REVCO, date: '2024-03-01', side: 'buy', qty: 5000, price: 2, ccy: 'USD', fx: '0.80' },
  { account: ISA, instrument: INST.REVCO, date: '2024-10-01', side: 'sell', qty: 500, price: 15, ccy: 'USD', fx: '0.80' },

  // --- OLDCO: ticker change mid-hold, position untouched. ---
  { account: ISA, instrument: INST.OLDCO, date: '2024-04-01', side: 'buy', qty: 200, price: 25, ccy: 'USD', fx: '0.80' },

  // --- VUSA: 15 auto-invest purchases of £500 (and three of £400). ---
  { account: ISA, instrument: INST.VUSA, date: '2024-01-05', side: 'buy', qty: 5, price: 80, ccy: 'GBP', fx: 1, source: 'auto_invest' },
  { account: ISA, instrument: INST.VUSA, date: '2024-02-05', side: 'buy', qty: 4, price: 100, ccy: 'GBP', fx: 1, source: 'auto_invest' },
  { account: ISA, instrument: INST.VUSA, date: '2024-03-05', side: 'buy', qty: '3.2', price: 125, ccy: 'GBP', fx: 1, source: 'auto_invest' },
  { account: ISA, instrument: INST.VUSA, date: '2024-04-05', side: 'buy', qty: 5, price: 100, ccy: 'GBP', fx: 1, source: 'auto_invest' },
  { account: ISA, instrument: INST.VUSA, date: '2024-05-07', side: 'buy', qty: 4, price: 125, ccy: 'GBP', fx: 1, source: 'auto_invest' },
  { account: ISA, instrument: INST.VUSA, date: '2024-06-05', side: 'buy', qty: '6.25', price: 80, ccy: 'GBP', fx: 1, source: 'auto_invest' },
  { account: ISA, instrument: INST.VUSA, date: '2024-07-05', side: 'buy', qty: 10, price: 50, ccy: 'GBP', fx: 1, source: 'auto_invest' },
  { account: ISA, instrument: INST.VUSA, date: '2024-08-05', side: 'buy', qty: '2.5', price: 200, ccy: 'GBP', fx: 1, source: 'auto_invest' },
  { account: ISA, instrument: INST.VUSA, date: '2024-09-05', side: 'buy', qty: 2, price: 250, ccy: 'GBP', fx: 1, source: 'auto_invest' },
  { account: ISA, instrument: INST.VUSA, date: '2024-10-07', side: 'buy', qty: 5, price: 100, ccy: 'GBP', fx: 1, source: 'auto_invest' },
  { account: ISA, instrument: INST.VUSA, date: '2024-11-05', side: 'buy', qty: 4, price: 125, ccy: 'GBP', fx: 1, source: 'auto_invest' },
  { account: ISA, instrument: INST.VUSA, date: '2024-12-05', side: 'buy', qty: '6.25', price: 80, ccy: 'GBP', fx: 1, source: 'auto_invest' },
  { account: ISA, instrument: INST.VUSA, date: '2025-01-06', side: 'buy', qty: 10, price: 50, ccy: 'GBP', fx: 1, source: 'auto_invest' },
  { account: ISA, instrument: INST.VUSA, date: '2025-02-05', side: 'buy', qty: '2.5', price: 200, ccy: 'GBP', fx: 1, source: 'auto_invest' },
  { account: ISA, instrument: INST.VUSA, date: '2025-03-05', side: 'buy', qty: 2, price: 250, ccy: 'GBP', fx: 1, source: 'auto_invest' },

  // --- S104CO in the GIA: pooling, a bed-and-breakfast repurchase and a
  //     same-day round trip. This is the HMRC matching test. ---
  { account: GIA, instrument: INST.S104CO, date: '2024-01-10', side: 'buy', qty: 1000, price: 2, ccy: 'GBP', fx: 1 },
  { account: GIA, instrument: INST.S104CO, date: '2024-02-10', side: 'buy', qty: 1000, price: 3, ccy: 'GBP', fx: 1 },
  { account: GIA, instrument: INST.S104CO, date: '2024-03-10', side: 'sell', qty: 1500, price: 4, ccy: 'GBP', fx: 1 },
  { account: GIA, instrument: INST.S104CO, date: '2024-03-20', side: 'buy', qty: 500, price: '3.50', ccy: 'GBP', fx: 1 },
  { account: GIA, instrument: INST.S104CO, date: '2024-05-10', side: 'buy', qty: 200, price: 3, ccy: 'GBP', fx: 1 },
  { account: GIA, instrument: INST.S104CO, date: '2024-05-10', side: 'sell', qty: 200, price: 6, ccy: 'GBP', fx: 1 },
];

export const trades: EngineTrade[] = tradeSpecs.map(t);

export const corporateActions: EngineCorporateAction[] = [
  {
    id: 1,
    instrumentId: INST.SPLITCO,
    actionDate: '2024-06-03',
    kind: 'split',
    ratio: d(4),
    amount: null,
    currency: null,
    detail: null,
  },
  {
    id: 2,
    instrumentId: INST.REVCO,
    actionDate: '2024-07-01',
    kind: 'reverse_split',
    ratio: d('0.1'),
    amount: null,
    currency: null,
    detail: null,
  },
  {
    id: 3,
    instrumentId: INST.OLDCO,
    actionDate: '2024-05-15',
    kind: 'ticker_change',
    ratio: null,
    amount: null,
    currency: null,
    detail: { from: 'OLDC', to: 'NEWC' },
  },
  {
    id: 4,
    instrumentId: INST.AAPL,
    actionDate: '2024-05-01',
    kind: 'dividend',
    ratio: null,
    amount: d('0.24'),
    currency: 'USD',
    detail: null,
  },
];

export const cashFlows: EngineCashFlow[] = [
  {
    id: 1,
    accountId: ISA,
    flowDate: '2024-01-01',
    kind: 'deposit',
    amount: d(20000),
    flowCurrency: 'GBP',
    fxRate: d(1),
    instrumentId: null,
    withholding: d(0),
  },
  {
    id: 2,
    accountId: ISA,
    flowDate: '2024-04-01',
    kind: 'deposit',
    amount: d(5000),
    flowCurrency: 'GBP',
    fxRate: d(1),
    instrumentId: null,
    withholding: d(0),
  },
  {
    id: 3,
    accountId: GIA,
    flowDate: '2024-01-05',
    kind: 'deposit',
    amount: d(6000),
    flowCurrency: 'GBP',
    fxRate: d(1),
    instrumentId: null,
    withholding: d(0),
  },
  {
    // 150 AAPL shares at $0.24, 15% withheld under a W-8BEN, at the 1 May rate.
    id: 4,
    accountId: ISA,
    flowDate: '2024-05-01',
    kind: 'dividend',
    amount: d(36),
    flowCurrency: 'USD',
    fxRate: d('0.79'),
    instrumentId: INST.AAPL,
    withholding: d('5.40'),
  },
];

/* ---------------- Hand-computed expectations ----------------
 *
 * AAPL
 *   lot 1: 100 sh, 100×150 + 10 fee = $15,010 → ×0.80 = £12,008.00 (£120.08/sh)
 *   lot 2:  50 sh,  50×170 + 10 fee =  $8,510 → ×0.78 =  £6,637.80 (£132.756/sh)
 *   after both: 150 sh, $23,520 local, £18,645.80 GBP, avg £124.3053333.../sh
 *   sell 60 @ $190 less $10 = $11,390 → ×0.79 = £8,998.10 proceeds
 *     average basis: 60 × 124.3053333... = £7,458.32 → realised £1,539.78
 *     FIFO basis:    60 × 120.08         = £7,204.80 → realised £1,793.30
 *   remaining 90 sh: local $14,112, average GBP basis £11,187.48
 *
 * RR.L (GBX line, prices already normalised to GBP)
 *   buy  1,000 @ £4.50 + £22.50 stamp + £5 = £4,527.50
 *   sell 1,000 @ £5.20 − £5              = £5,195.00 → realised £667.50, closed
 *
 * SPLITCO
 *   buy 40 @ $400 = $16,000 → £12,800 (£320/sh)
 *   4:1 split → 160 sh at £80/sh, basis unchanged
 *   sell 60 @ $120 = $7,200 → ×0.75 = £5,400; basis 60 × 80 = £4,800 → £600
 *   remaining 100 sh, £8,000
 *
 * REVCO
 *   buy 5,000 @ $2 = $10,000 → £8,000 (£1.60/sh)
 *   1:10 reverse → 500 sh at £16/sh
 *   sell 500 @ $15 = $7,500 → £6,000 → realised −£2,000, closed
 *
 * VUSA — 15 purchases, £7,200 total, 71.7 units
 *
 * S104CO (GIA)
 *   pool after two buys: 2,000 sh / £5,000
 *   sell 1,500 @ £4 = £6,000:
 *     500 matched to the 20 Mar repurchase (30-day rule): 2,000 − 1,750 = £250
 *     1,000 from the pool at £2.50:                       4,000 − 2,500 = £1,500
 *   same-day 10 May round trip (200 @ £3 in, 200 @ £6 out): 1,200 − 600 = £600
 *   Section 104 realised total: £2,350; pool left 1,000 sh / £2,500
 *
 *   The same ledger under the other two bases, which is the point of the test:
 *     FIFO:    1,000×(4−2) + 500×(4−3) + 200×(6−3)                 = £3,100
 *     Average: 1,500×(4−2.50) + 200×(6−3.00)                       = £2,850
 */
export const expected = {
  aapl: {
    quantity: '90',
    costBasisLocal: '14112',
    costBasisGbp: '11187.48',
    avgUnitCostGbp: '124.3053333333333333333333333333333',
    realisedAverage: '1539.78',
    realisedFifo: '1793.30',
    lotCount: 2,
    dividendsGbp: '24.174', // (36 − 5.40) × 0.79
  },
  rr: { quantity: '0', realisedAverage: '667.50', isOpen: false, closedOn: '2024-08-01' },
  splitco: { quantity: '100', costBasisGbp: '8000', realisedAverage: '600', avgUnitCostGbp: '80' },
  revco: { quantity: '0', realisedAverage: '-2000', isOpen: false },
  oldco: { quantity: '200', costBasisGbp: '4000' },
  vusa: { quantity: '71.7', costBasisGbp: '7200' },
  s104: {
    quantity: '1000',
    poolQuantity: '1000',
    poolCostGbp: '2500',
    realisedS104: '2350',
    realisedFifo: '3100',
    realisedAverage: '2850',
  },
} as const;
