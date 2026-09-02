/**
 * The daily snapshot builder — the bridge between the ledger and every
 * time-series metric.
 *
 * This is the "recompute from inception" path. It walks every trading day from
 * the first activity to the as-of date, derives positions on that date from the
 * ledger, values them at that date's prices and FX, and emits:
 *
 *   - `DailyPoint[]`  for the TWR chain
 *   - `PortfolioDay[]` for attribution, with per-instrument weights and the
 *     local/FX return split
 *   - cash balances derived from the ledger, never stored
 *
 * Cached snapshots in `portfolio_daily` are an optimisation. This function is
 * the definition, and `pnpm integrity-check` diffs one against the other.
 */
import { Decimal, ONE, ZERO, divOrZero } from '../decimal';
import { eachBusinessDay } from '../dates';
import type {
  EngineCashFlow,
  EngineCorporateAction,
  EngineInstrument,
  EngineTrade,
  IsoDate,
  Position,
} from '../types';
import type { InstrumentDay, PortfolioDay } from './attribution';
import { computePositions } from './positions';
import type { DailyPoint } from './twr';
import type { FxLookup, PriceLookup } from './valuation';

export interface SnapshotInput {
  trades: EngineTrade[];
  corporateActions: EngineCorporateAction[];
  cashFlows: EngineCashFlow[];
  instrumentById: Map<number, EngineInstrument>;
  prices: PriceLookup;
  fx: FxLookup;
  accountId?: number;
  from: IsoDate;
  to: IsoDate;
  /** Dates that actually have market data. Falls back to LSE business days. */
  tradingDays?: IsoDate[];
}

export interface UnvaluedPosition {
  instrumentId: number;
  reason: 'no_price' | 'no_fx_rate';
  currency: string;
}

export interface DailySnapshot {
  date: IsoDate;
  marketValueGbp: Decimal;
  costBasisGbp: Decimal;
  cashGbp: Decimal;
  totalValueGbp: Decimal;
  netFlowGbp: Decimal;
  positions: Array<{
    instrumentId: number;
    quantity: Decimal;
    priceLocal: Decimal | null;
    fxToGbp: Decimal;
    valueGbp: Decimal;
    costBasisGbp: Decimal;
  }>;
  /**
   * Positions held on this date that could not be valued. They are listed
   * rather than quietly counted as zero, because a portfolio that silently
   * omits a holding still produces a plausible-looking total.
   */
  unvalued: UnvaluedPosition[];
}

export interface SnapshotSeries {
  snapshots: DailySnapshot[];
  dailyPoints: DailyPoint[];
  attributionDays: PortfolioDay[];
}

/**
 * Cash derived from the ledger, GBP, on a given date.
 *
 * Deposits and dividends in; withdrawals, fees, taxes and purchases out; sale
 * proceeds back in. A portfolio without this cannot answer "am I ahead", and
 * money-weighted return is impossible (§5).
 */
export function cashOn(
  trades: EngineTrade[],
  flows: EngineCashFlow[],
  date: IsoDate,
  accountId?: number,
): Decimal {
  let cash = ZERO;

  for (const f of flows) {
    if (f.flowDate > date) continue;
    if (accountId !== undefined && f.accountId !== accountId) continue;
    // `amount` is signed, so a withdrawal already arrives negative. Withholding
    // never reaches the account.
    cash = cash.plus(f.amount.minus(f.withholding).times(f.fxRate));
  }

  for (const t of trades) {
    if (t.tradeDate > date) continue;
    if (accountId !== undefined && t.accountId !== accountId) continue;
    const fees = t.commission.plus(t.stampDuty).plus(t.fxFee).plus(t.otherFees);
    const gross = t.quantity.times(t.price);
    cash =
      t.side === 'buy'
        ? cash.minus(gross.plus(fees).times(t.fxRate))
        : cash.plus(gross.minus(fees).times(t.fxRate));
  }

  return cash;
}

/** External flows only — the numerator correction in the TWR formula. */
export function externalFlowOn(
  flows: EngineCashFlow[],
  date: IsoDate,
  accountId?: number,
): Decimal {
  return flows
    .filter(
      (f) =>
        f.flowDate === date &&
        (accountId === undefined || f.accountId === accountId) &&
        (f.kind === 'deposit' || f.kind === 'withdrawal'),
    )
    .reduce<Decimal>((a, f) => a.plus(f.amount.times(f.fxRate)), ZERO);
}

export function buildSeries(input: SnapshotInput): SnapshotSeries {
  const days =
    input.tradingDays && input.tradingDays.length > 0
      ? input.tradingDays.filter((d) => d >= input.from && d <= input.to)
      : eachBusinessDay(input.from, input.to, 'XLON');

  const snapshots: DailySnapshot[] = [];

  for (const date of days) {
    const derived = computePositions(input.trades, input.corporateActions, input.cashFlows, {
      asOf: date,
      accountId: input.accountId,
      strict: false,
      skipTaxPooling: true,
    });

    const rows: DailySnapshot['positions'] = [];
    const unvalued: UnvaluedPosition[] = [];
    let marketValueGbp = ZERO;
    let costBasisGbp = ZERO;

    for (const position of derived.all) {
      if (!position.isOpen) continue;
      const inst = input.instrumentById.get(position.instrumentId);
      const quoteCcy = inst?.quoteCurrency ?? 'GBP';
      const priceRow = input.prices.priceOn(position.instrumentId, date);

      // A missing FX rate is NOT 1.0. Defaulting a USD holding to parity
      // understates it by about a third and looks entirely plausible on screen,
      // which is precisely why it must be refused rather than guessed.
      const fxToGbp = quoteCcy === 'GBP' ? ONE : input.fx.rateOn(quoteCcy, 'GBP', date);

      if (!priceRow || !fxToGbp) {
        unvalued.push({
          instrumentId: position.instrumentId,
          reason: !priceRow ? 'no_price' : 'no_fx_rate',
          currency: quoteCcy,
        });
        costBasisGbp = costBasisGbp.plus(position.costBasisGbp);
        continue;
      }

      const valueGbp = priceRow.price.times(position.quantity).times(fxToGbp);
      rows.push({
        instrumentId: position.instrumentId,
        quantity: position.quantity,
        priceLocal: priceRow.price,
        fxToGbp,
        valueGbp,
        costBasisGbp: position.costBasisGbp,
      });
      marketValueGbp = marketValueGbp.plus(valueGbp);
      costBasisGbp = costBasisGbp.plus(position.costBasisGbp);
    }

    const cashGbp = cashOn(input.trades, input.cashFlows, date, input.accountId);
    snapshots.push({
      date,
      marketValueGbp,
      costBasisGbp,
      cashGbp,
      totalValueGbp: marketValueGbp.plus(cashGbp),
      netFlowGbp: externalFlowOn(input.cashFlows, date, input.accountId),
      positions: rows,
      unvalued,
    });
  }

  return {
    snapshots,
    dailyPoints: snapshots.map((s) => ({
      date: s.date,
      // A partially valued portfolio has no honest total, so the TWR chain gets
      // a gap rather than a number that understates it.
      marketValueGbp: s.unvalued.length > 0 ? null : s.totalValueGbp,
      netFlowGbp: s.netFlowGbp,
    })),
    attributionDays: toAttributionDays(snapshots),
  };
}

/**
 * Turn consecutive snapshots into the per-instrument weight and return rows
 * attribution needs.
 *
 * The weight is taken at the START of the day and the return is that day's
 * move, so a position bought today contributes nothing today — which is
 * correct, and is why `w_{i,t-1} × r_{i,t}` is the formula rather than
 * `w_{i,t} × r_{i,t}`.
 */
export function toAttributionDays(snapshots: DailySnapshot[]): PortfolioDay[] {
  const out: PortfolioDay[] = [];

  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1]!;
    const cur = snapshots[i]!;
    const prevByInstrument = new Map(prev.positions.map((p) => [p.instrumentId, p]));

    const instruments: InstrumentDay[] = [];
    for (const row of cur.positions) {
      const before = prevByInstrument.get(row.instrumentId);
      if (!before || before.valueGbp.isZero() || !before.priceLocal || !row.priceLocal) continue;

      instruments.push({
        instrumentId: row.instrumentId,
        weightStart: divOrZero(before.valueGbp, prev.totalValueGbp),
        localReturn: row.priceLocal.div(before.priceLocal).minus(ONE),
        fxReturn: before.fxToGbp.isZero() ? ZERO : row.fxToGbp.div(before.fxToGbp).minus(ONE),
      });
    }

    // The portfolio return for the day, flow-adjusted, so attribution and TWR
    // are two views of one number rather than two calculations that drift.
    const denominator = prev.totalValueGbp;
    const portfolioReturn = denominator.isZero()
      ? ZERO
      : cur.totalValueGbp.minus(prev.totalValueGbp).minus(cur.netFlowGbp).div(denominator);

    out.push({ date: cur.date, portfolioReturn, instruments });
  }

  return out;
}

/** Positions as of a single date, for the dashboard's live view. */
export function positionsOn(
  input: Omit<SnapshotInput, 'from' | 'to' | 'tradingDays'>,
  date: IsoDate,
): Position[] {
  return computePositions(input.trades, input.corporateActions, input.cashFlows, {
    asOf: date,
    accountId: input.accountId,
    strict: false,
  }).all;
}
