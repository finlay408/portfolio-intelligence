/**
 * Domain types for the analytics engine.
 *
 * These are deliberately independent of the Drizzle row types: the engine is a
 * pure function of its inputs, so the whole of it — position derivation, TWR,
 * attribution, VaR inputs — can be exercised in tests with no database at all.
 * `src/lib/engine/load.ts` is the only place that maps DB rows onto these.
 */
import type { Decimal } from './decimal';

export type IsoDate = string; // 'YYYY-MM-DD'
export type Currency = string; // ISO 4217, uppercase

export type Side = 'buy' | 'sell';
export type Wrapper = 'ISA' | 'GIA' | 'SIPP';

export type CorporateActionKind =
  | 'split'
  | 'reverse_split'
  | 'dividend'
  | 'special_dividend'
  | 'spinoff'
  | 'merger'
  | 'ticker_change'
  | 'delisting';

export type CashFlowKind =
  | 'deposit'
  | 'withdrawal'
  | 'dividend'
  | 'interest'
  | 'fee'
  | 'tax';

export interface EngineInstrument {
  id: number;
  symbol: string;
  name: string;
  assetClass: string;
  exchangeMic: string | null;
  /** Currency AFTER quoteMultiplier. */
  quoteCurrency: Currency;
  /** 0.01 for GBX lines. Applied at ingestion; the engine never sees pence. */
  quoteMultiplier: Decimal;
  country: string | null;
  revenueRegions: Record<string, number> | null;
  sector: string | null;
  industry: string | null;
  /**
   * Provider symbol mapping. The canonical `symbol` is internal and need not
   * match any provider's, so the resolver reads these — never `symbol` — and a
   * null here means the instrument is simply not routable to that provider.
   */
  yahooSymbol?: string | null;
  alpacaSymbol?: string | null;
  finnhubSymbol?: string | null;
}

export interface EngineTrade {
  id: number;
  accountId: number;
  instrumentId: number;
  tradeDate: IsoDate;
  side: Side;
  quantity: Decimal;
  /** Per share, in tradeCurrency, post-multiplier. */
  price: Decimal;
  tradeCurrency: Currency;
  /** tradeCurrency -> GBP at execution. */
  fxRate: Decimal;
  /**
   * All four fee columns are denominated in `tradeCurrency` and converted at
   * `fxRate`. This is a codebase-wide convention, not a schema constraint —
   * importers must normalise to it.
   */
  commission: Decimal;
  stampDuty: Decimal;
  fxFee: Decimal;
  otherFees: Decimal;
  source: string;
}

export interface EngineCorporateAction {
  id: number;
  instrumentId: number;
  actionDate: IsoDate;
  kind: CorporateActionKind;
  ratio: Decimal | null;
  amount: Decimal | null;
  currency: Currency | null;
  detail: Record<string, unknown> | null;
}

export interface EngineCashFlow {
  id: number;
  accountId: number;
  flowDate: IsoDate;
  kind: CashFlowKind;
  amount: Decimal;
  flowCurrency: Currency;
  fxRate: Decimal;
  instrumentId: number | null;
  withholding: Decimal;
}

/* ---------------- Position engine output ---------------- */

export interface FifoLot {
  /** Trade that opened the lot; survives splits. */
  tradeId: number;
  openedOn: IsoDate;
  quantity: Decimal;
  /** Per-share cost in trade currency, fees included, split-adjusted. */
  unitCostLocal: Decimal;
  /** Per-share cost in GBP at the acquisition fx rate, fees included. */
  unitCostGbp: Decimal;
  fxRateAtOpen: Decimal;
  currency: Currency;
}

export type DisposalMethod = 'fifo' | 'average' | 's104' | 'same_day' | 'thirty_day';

export interface Disposal {
  tradeId: number;
  date: IsoDate;
  quantity: Decimal;
  /** Net of sell-side fees. */
  proceedsGbp: Decimal;
  costGbp: Decimal;
  gainGbp: Decimal;
  method: DisposalMethod;
  /** Only set for lot-matched methods. */
  matchedAgainstTradeId?: number;
  /** Days held, lot-weighted, where the method identifies an acquisition. */
  holdingDays?: number;
}

export interface Position {
  instrumentId: number;
  accountId: number;
  quantity: Decimal;
  /** Average-cost view — matches broker statements. */
  avgUnitCostLocal: Decimal;
  avgUnitCostGbp: Decimal;
  costBasisLocal: Decimal;
  costBasisGbp: Decimal;
  /** FIFO lots, oldest first. Cost basis here always reconciles to costBasisGbp. */
  lots: FifoLot[];
  currency: Currency;
  /** Cumulative realised P&L under each method. */
  realisedGbpFifo: Decimal;
  realisedGbpAverage: Decimal;
  /** Section 104 (GIA only — computed regardless, per §7.1). */
  s104: { quantity: Decimal; costGbp: Decimal };
  realisedGbpS104: Decimal;
  disposals: Disposal[];
  openedOn: IsoDate | null;
  closedOn: IsoDate | null;
  isOpen: boolean;
  /** Total fees paid over the position's life, in GBP. */
  feesGbp: Decimal;
  /** Dividends received, GBP, net of withholding. */
  dividendsGbp: Decimal;
}

export interface PositionSet {
  asOf: IsoDate;
  byInstrument: Map<number, Position>;
  /** Every position ever held, including fully closed ones. */
  all: Position[];
  open: Position[];
  closed: Position[];
}

/* ---------------- Valuation ---------------- */

export interface ValuedPosition {
  position: Position;
  /** Last known close (or live quote) in quote currency, post-multiplier. */
  price: Decimal | null;
  priceDate: IsoDate | null;
  fxToGbp: Decimal;
  marketValueGbp: Decimal;
  unrealisedGbp: Decimal;
  /** Weight of portfolio market value, 0..1. */
  weight: Decimal;
  /** Return decomposition (§3.2). Null when the position has no cost basis. */
  decomposition: ReturnDecomposition | null;
}

export interface ReturnDecomposition {
  /** (price_now / cost_local) - 1 */
  assetReturnLocal: Decimal;
  /** (fx_now / fx_at_cost) - 1 */
  fxReturn: Decimal;
  /** assetReturnLocal * fxReturn — small, kept for exactness. */
  crossTerm: Decimal;
  /** Their sum, which equals the true GBP return. */
  totalReturnGbp: Decimal;
}

export interface PortfolioValuation {
  asOf: IsoDate;
  accountId: number | null;
  positions: ValuedPosition[];
  marketValueGbp: Decimal;
  costBasisGbp: Decimal;
  unrealisedGbp: Decimal;
  realisedGbp: Decimal;
  cashGbp: Decimal;
  totalValueGbp: Decimal;
}
