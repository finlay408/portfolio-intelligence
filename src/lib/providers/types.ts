/**
 * Provider abstraction (CLAUDE.md §6).
 *
 * yfinance will break. That is a certainty, not a risk. Every external source
 * sits behind this interface so that swapping one out is a change to the
 * routing table in `registry.ts` and nothing else.
 */
import type { Decimal } from '../decimal';
import type { CorporateActionKind, EngineInstrument, IsoDate } from '../types';

/** Raw values as the provider returned them, before normalisation. */
export interface RawBar {
  date: IsoDate;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  adjClose: number | null;
  volume: number | null;
}

export interface Bar {
  date: IsoDate;
  open: Decimal | null;
  high: Decimal | null;
  low: Decimal | null;
  /** Post-multiplier, in the instrument's quote currency. Never pence. */
  close: Decimal;
  adjClose: Decimal | null;
  volume: number | null;
  provider: string;
}

export interface Quote {
  instrumentId: number;
  /** Post-multiplier, in the instrument's quote currency. */
  price: Decimal;
  changePct: Decimal | null;
  asOf: Date;
  /** 0 for a real-time feed, ~900 for Yahoo's delayed LSE data. */
  delaySeconds: number;
  provider: string;
}

export interface FxRate {
  pair: string; // 'USDGBP'
  date: IsoDate;
  rate: Decimal;
  provider: string;
}

export interface DetectedCorporateAction {
  instrumentId: number;
  actionDate: IsoDate;
  kind: CorporateActionKind;
  ratio: number | null;
  amount: number | null;
  currency: string | null;
  detail?: Record<string, unknown>;
  provider: string;
}

export interface EarningsEvent {
  instrumentId: number;
  reportDate: IsoDate;
  session: 'bmo' | 'amc' | 'unknown';
  fiscalPeriod: string | null;
  epsEstimate: number | null;
  epsActual: number | null;
  revenueEstimate: number | null;
  revenueActual: number | null;
  provider: string;
}

export type Capability =
  | 'quote'
  | 'bars'
  | 'fx'
  | 'corp_actions'
  | 'earnings'
  | 'fundamentals'
  | 'macro'
  | 'factors'
  | 'options';

export interface PriceProvider {
  readonly name: string;
  readonly supports: (inst: EngineInstrument) => boolean;
  readonly delaySeconds: number;
  readonly capabilities: readonly Capability[];

  getQuote(insts: EngineInstrument[]): Promise<Quote[]>;
  getDailyBars(inst: EngineInstrument, from: IsoDate, to: IsoDate): Promise<Bar[]>;
  getCorporateActions?(inst: EngineInstrument, from: IsoDate): Promise<DetectedCorporateAction[]>;
  getEarnings?(insts: EngineInstrument[], from: IsoDate, to: IsoDate): Promise<EarningsEvent[]>;
}

export interface FxProvider {
  readonly name: string;
  getDailyRates(pair: string, from: IsoDate, to: IsoDate): Promise<FxRate[]>;
  getLatestRate?(pair: string): Promise<FxRate | null>;
}

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly capability: Capability,
    message: string,
    readonly status?: number,
  ) {
    super(`[${provider}/${capability}] ${message}`);
    this.name = 'ProviderError';
  }
}

export class RateLimitError extends ProviderError {
  constructor(provider: string, capability: Capability, readonly retryAfterMs: number) {
    super(provider, capability, `rate limited, retry in ${retryAfterMs}ms`, 429);
    this.name = 'RateLimitError';
  }
}
