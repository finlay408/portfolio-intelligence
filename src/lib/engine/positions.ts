/**
 * The position engine (CLAUDE.md §2, §7.1).
 *
 * Positions are never stored. This module derives every holding, cost basis and
 * realised gain from the trade ledger plus corporate actions, as a pure
 * function. Nothing here reads a database, a clock or a network.
 *
 * Three cost bases are maintained simultaneously, because each answers a
 * different question:
 *
 *   average cost — what the broker statement says; the display basis.
 *   FIFO lots    — the sequencing needed to reason about realised gains and
 *                  holding periods.
 *   Section 104  — what HMRC requires for a GIA, including the same-day and
 *                  30-day bed-and-breakfast matching rules.
 *
 * They disagree after a partial sale, and that disagreement is real, not a bug.
 */
import { Decimal, ZERO, dec, divOrZero, isZeroish } from '../decimal';
import type {
  Disposal,
  EngineCashFlow,
  EngineCorporateAction,
  EngineTrade,
  FifoLot,
  IsoDate,
  Position,
  PositionSet,
} from '../types';
import { daysBetween } from '../dates';

export class LedgerError extends Error {
  constructor(
    message: string,
    readonly context: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

export interface EngineOptions {
  /** Only consider events on or before this date. Defaults to the last event. */
  asOf?: IsoDate;
  /** Restrict to one account. Undefined means every account, merged per key. */
  accountId?: number;
  /**
   * Strict mode throws on a ledger that sells more than it holds. The nightly
   * jobs and tests run strict; the UI runs lenient so one bad row degrades a
   * single position rather than the whole dashboard.
   */
  strict?: boolean;
  /**
   * Skip Section 104 pooling. The daily snapshot builder calls this engine once
   * per date and never uses the tax figures, and the 30-day matching pass is
   * the expensive part. Tax views always leave this off.
   */
  skipTaxPooling?: boolean;
}

export interface EngineWarning {
  code: 'oversell' | 'unapplied_action' | 'missing_detail';
  instrumentId: number;
  accountId: number | null;
  date: IsoDate;
  message: string;
}

export interface EngineResult extends PositionSet {
  warnings: EngineWarning[];
}

interface PositionKey {
  accountId: number;
  instrumentId: number;
}

const keyOf = (k: PositionKey) => `${k.accountId}:${k.instrumentId}`;

/* ============================================================
 * Corporate action expansion
 * ============================================================
 * Splits are applied in-line during the chronological walk. Everything that
 * changes *which* instrument is held — spinoffs, mergers, delistings — is
 * expanded into synthetic trades first, so the main loop stays small.
 *
 * These require explicit `detail`. A missing field raises rather than guesses:
 * a silently wrong merger ratio destroys cost basis across all history.
 */
export function expandCorporateActions(
  trades: EngineTrade[],
  actions: EngineCorporateAction[],
): { trades: EngineTrade[]; splits: EngineCorporateAction[]; warnings: EngineWarning[] } {
  const warnings: EngineWarning[] = [];
  const splits: EngineCorporateAction[] = [];
  const synthetic: EngineTrade[] = [];
  // Synthetic trades get ids below the real ones so ordering stays stable.
  let syntheticId = -1;

  // Holdings by account at the moment each action fires are needed to size the
  // synthetic trades, so walk actions in date order against a running tally.
  const sorted = [...actions].sort((a, b) => a.actionDate.localeCompare(b.actionDate));

  for (const action of sorted) {
    switch (action.kind) {
      case 'split':
      case 'reverse_split':
        if (!action.ratio || action.ratio.lessThanOrEqualTo(0)) {
          warnings.push({
            code: 'missing_detail',
            instrumentId: action.instrumentId,
            accountId: null,
            date: action.actionDate,
            message: `${action.kind} with no usable ratio was skipped`,
          });
          break;
        }
        splits.push(action);
        break;

      case 'dividend':
      case 'special_dividend':
      case 'ticker_change':
        // No position effect. Dividends land in cash_flows; a ticker change is
        // a label change on the same instrument row.
        break;

      case 'spinoff': {
        const d = action.detail ?? {};
        const child = Number(d['spun_instrument_id']);
        const sharesPer = dec(d['shares_per_share'] as never);
        const costRatio = dec(d['cost_ratio'] as never); // share of basis moving to the child
        if (!child || sharesPer.lessThanOrEqualTo(0) || costRatio.lessThan(0) || costRatio.greaterThan(1)) {
          warnings.push({
            code: 'missing_detail',
            instrumentId: action.instrumentId,
            accountId: null,
            date: action.actionDate,
            message:
              'spinoff needs detail {spun_instrument_id, shares_per_share, cost_ratio}; skipped',
          });
          break;
        }
        for (const [accountId, held] of holdingsAt(trades, synthetic, action.instrumentId, action.actionDate)) {
          if (held.qty.lessThanOrEqualTo(0)) continue;
          const childQty = held.qty.times(sharesPer);
          const basisMoved = held.costLocal.times(costRatio);
          // Reduce the parent basis with a zero-quantity fee-style adjustment,
          // and open the child at the basis that moved across.
          synthetic.push(
            syntheticTrade(syntheticId--, accountId, action.instrumentId, action.actionDate, 'sell', {
              quantity: new Decimal('1e-18'), // negligible qty, carries the basis reduction
              price: ZERO,
              currency: held.currency,
              fxRate: held.fxRate,
              otherFees: basisMoved.negated(),
              note: 'spinoff basis transfer out',
            }),
          );
          synthetic.push(
            syntheticTrade(syntheticId--, accountId, child, action.actionDate, 'buy', {
              quantity: childQty,
              price: divOrZero(basisMoved, childQty),
              currency: held.currency,
              fxRate: held.fxRate,
              note: 'spinoff basis transfer in',
            }),
          );
        }
        break;
      }

      case 'merger': {
        const d = action.detail ?? {};
        const into = Number(d['into_instrument_id']);
        const ratio = dec(d['share_ratio'] as never); // acquirer shares per held share
        const cashPer = dec(d['cash_per_share'] as never);
        if (!into || ratio.lessThan(0)) {
          warnings.push({
            code: 'missing_detail',
            instrumentId: action.instrumentId,
            accountId: null,
            date: action.actionDate,
            message: 'merger needs detail {into_instrument_id, share_ratio, cash_per_share?}; skipped',
          });
          break;
        }
        for (const [accountId, held] of holdingsAt(trades, synthetic, action.instrumentId, action.actionDate)) {
          if (held.qty.lessThanOrEqualTo(0)) continue;
          const cashOut = held.qty.times(cashPer);
          const newQty = held.qty.times(ratio);
          // Dispose of the old line at the cash consideration plus the basis
          // that rolls into the acquirer.
          const rolledBasis = held.costLocal.minus(cashOut).greaterThan(0)
            ? held.costLocal.minus(cashOut)
            : ZERO;
          synthetic.push(
            syntheticTrade(syntheticId--, accountId, action.instrumentId, action.actionDate, 'sell', {
              quantity: held.qty,
              price: divOrZero(cashOut.plus(rolledBasis), held.qty),
              currency: held.currency,
              fxRate: held.fxRate,
              note: 'merger: old line closed',
            }),
          );
          if (newQty.greaterThan(0)) {
            synthetic.push(
              syntheticTrade(syntheticId--, accountId, into, action.actionDate, 'buy', {
                quantity: newQty,
                price: divOrZero(rolledBasis, newQty),
                currency: held.currency,
                fxRate: held.fxRate,
                note: 'merger: acquirer line opened',
              }),
            );
          }
        }
        break;
      }

      case 'delisting': {
        const price = dec((action.detail?.['price'] as never) ?? 0);
        for (const [accountId, held] of holdingsAt(trades, synthetic, action.instrumentId, action.actionDate)) {
          if (held.qty.lessThanOrEqualTo(0)) continue;
          synthetic.push(
            syntheticTrade(syntheticId--, accountId, action.instrumentId, action.actionDate, 'sell', {
              quantity: held.qty,
              price,
              currency: held.currency,
              fxRate: held.fxRate,
              note: 'delisting',
            }),
          );
        }
        break;
      }
    }
  }

  return { trades: [...trades, ...synthetic], splits, warnings };
}

function syntheticTrade(
  id: number,
  accountId: number,
  instrumentId: number,
  tradeDate: IsoDate,
  side: 'buy' | 'sell',
  o: {
    quantity: Decimal;
    price: Decimal;
    currency: string;
    fxRate: Decimal;
    otherFees?: Decimal;
    note?: string;
  },
): EngineTrade {
  return {
    id,
    accountId,
    instrumentId,
    tradeDate,
    side,
    quantity: o.quantity,
    price: o.price,
    tradeCurrency: o.currency,
    fxRate: o.fxRate,
    commission: ZERO,
    stampDuty: ZERO,
    fxFee: ZERO,
    otherFees: o.otherFees ?? ZERO,
    source: 'corporate_action',
  };
}

/** Crude running tally used only to size synthetic corporate-action trades. */
function holdingsAt(
  trades: EngineTrade[],
  synthetic: EngineTrade[],
  instrumentId: number,
  onDate: IsoDate,
): Map<number, { qty: Decimal; costLocal: Decimal; currency: string; fxRate: Decimal }> {
  const out = new Map<number, { qty: Decimal; costLocal: Decimal; currency: string; fxRate: Decimal }>();
  const rows = [...trades, ...synthetic]
    .filter((t) => t.instrumentId === instrumentId && t.tradeDate < onDate)
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate) || a.id - b.id);
  for (const t of rows) {
    const cur = out.get(t.accountId) ?? {
      qty: ZERO,
      costLocal: ZERO,
      currency: t.tradeCurrency,
      fxRate: t.fxRate,
    };
    const fees = t.commission.plus(t.stampDuty).plus(t.fxFee).plus(t.otherFees);
    if (t.side === 'buy') {
      cur.costLocal = cur.costLocal.plus(t.quantity.times(t.price)).plus(fees);
      cur.qty = cur.qty.plus(t.quantity);
    } else {
      const unit = divOrZero(cur.costLocal, cur.qty);
      cur.costLocal = cur.costLocal.minus(unit.times(t.quantity));
      cur.qty = cur.qty.minus(t.quantity);
    }
    cur.fxRate = t.fxRate;
    out.set(t.accountId, cur);
  }
  return out;
}

/* ============================================================
 * Main derivation
 * ============================================================ */

export function computePositions(
  rawTrades: EngineTrade[],
  actions: EngineCorporateAction[] = [],
  cashFlows: EngineCashFlow[] = [],
  options: EngineOptions = {},
): EngineResult {
  const strict = options.strict ?? true;
  const expanded = expandCorporateActions(rawTrades, actions);
  const warnings = [...expanded.warnings];

  const asOf =
    options.asOf ??
    [...expanded.trades.map((t) => t.tradeDate), ...expanded.splits.map((s) => s.actionDate)]
      .sort()
      .at(-1) ??
    '1970-01-01';

  const trades = expanded.trades
    .filter((t) => t.tradeDate <= asOf)
    .filter((t) => options.accountId === undefined || t.accountId === options.accountId);
  const splits = expanded.splits.filter((s) => s.actionDate <= asOf);

  // Group by (account, instrument): a holding in an ISA and the same holding in
  // a GIA are different positions with different tax treatment.
  const groups = new Map<string, { key: PositionKey; trades: EngineTrade[] }>();
  for (const t of trades) {
    const k = keyOf(t);
    let g = groups.get(k);
    if (!g) {
      g = { key: { accountId: t.accountId, instrumentId: t.instrumentId }, trades: [] };
      groups.set(k, g);
    }
    g.trades.push(t);
  }

  const positions: Position[] = [];
  for (const g of groups.values()) {
    const relevantSplits = splits.filter((s) => s.instrumentId === g.key.instrumentId);
    positions.push(
      derivePosition(g.key, g.trades, relevantSplits, cashFlows, asOf, strict, warnings, {
        skipTaxPooling: options.skipTaxPooling ?? false,
      }),
    );
  }

  positions.sort((a, b) => a.instrumentId - b.instrumentId || a.accountId - b.accountId);
  const byInstrument = new Map<number, Position>();
  for (const p of positions) {
    // When several accounts hold the same instrument, byInstrument holds the
    // merged view; `all` keeps them separate.
    const existing = byInstrument.get(p.instrumentId);
    byInstrument.set(p.instrumentId, existing ? mergePositions(existing, p) : p);
  }

  return {
    asOf,
    byInstrument,
    all: positions,
    open: positions.filter((p) => p.isOpen),
    closed: positions.filter((p) => !p.isOpen),
    warnings,
  };
}

/** Sort key: on a shared date, splits apply first, then buys, then sells. */
function orderRank(kind: 'split' | 'buy' | 'sell'): number {
  return kind === 'split' ? 0 : kind === 'buy' ? 1 : 2;
}

type Event =
  | { date: IsoDate; rank: number; seq: number; kind: 'split'; action: EngineCorporateAction }
  | { date: IsoDate; rank: number; seq: number; kind: 'trade'; trade: EngineTrade };

function derivePosition(
  key: PositionKey,
  posTrades: EngineTrade[],
  splits: EngineCorporateAction[],
  cashFlows: EngineCashFlow[],
  asOf: IsoDate,
  strict: boolean,
  warnings: EngineWarning[],
  opts: { skipTaxPooling: boolean } = { skipTaxPooling: false },
): Position {
  const events: Event[] = [
    ...splits.map<Event>((a) => ({
      date: a.actionDate,
      rank: orderRank('split'),
      seq: a.id,
      kind: 'split',
      action: a,
    })),
    ...posTrades.map<Event>((t) => ({
      date: t.tradeDate,
      rank: orderRank(t.side),
      seq: t.id,
      kind: 'trade',
      trade: t,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.rank - b.rank || a.seq - b.seq);

  let quantity = ZERO;
  let costBasisLocal = ZERO; // average-cost basis, trade currency
  let costBasisGbp = ZERO; // average-cost basis, GBP
  let realisedFifo = ZERO;
  let realisedAverage = ZERO;
  let feesGbp = ZERO;
  let lots: FifoLot[] = [];
  const disposals: Disposal[] = [];
  let openedOn: IsoDate | null = null;
  let closedOn: IsoDate | null = null;
  let currency = 'GBP';

  for (const ev of events) {
    if (ev.kind === 'split') {
      const r = ev.action.ratio!;
      // Cost basis is untouched; only the share count and per-share cost move.
      quantity = quantity.times(r);
      lots = lots.map((l) => ({
        ...l,
        quantity: l.quantity.times(r),
        unitCostLocal: l.unitCostLocal.div(r),
        unitCostGbp: l.unitCostGbp.div(r),
      }));
      continue;
    }

    const t = ev.trade;
    currency = t.tradeCurrency;
    const fees = t.commission.plus(t.stampDuty).plus(t.fxFee).plus(t.otherFees);
    feesGbp = feesGbp.plus(fees.times(t.fxRate));

    if (t.side === 'buy') {
      // Buy-side fees increase the cost basis.
      const grossLocal = t.quantity.times(t.price);
      const totalLocal = grossLocal.plus(fees);
      const totalGbp = totalLocal.times(t.fxRate);
      const unitLocal = divOrZero(totalLocal, t.quantity);
      const unitGbp = divOrZero(totalGbp, t.quantity);

      if (quantity.isZero() && openedOn === null) openedOn = t.tradeDate;
      if (quantity.isZero() && closedOn !== null) {
        // Re-opened after a full close. Keep the original openedOn for the
        // realised history but restart the current holding period.
        openedOn = t.tradeDate;
        closedOn = null;
      }

      quantity = quantity.plus(t.quantity);
      costBasisLocal = costBasisLocal.plus(totalLocal);
      costBasisGbp = costBasisGbp.plus(totalGbp);
      if (t.quantity.greaterThan(0)) {
        lots.push({
          tradeId: t.id,
          openedOn: t.tradeDate,
          quantity: t.quantity,
          unitCostLocal: unitLocal,
          unitCostGbp: unitGbp,
          fxRateAtOpen: t.fxRate,
          currency: t.tradeCurrency,
        });
      }
      continue;
    }

    // ---- sell ----
    let sellQty = t.quantity;
    if (sellQty.greaterThan(quantity)) {
      const msg = `sell of ${sellQty.toFixed()} exceeds holding of ${quantity.toFixed()}`;
      if (strict) {
        throw new LedgerError(msg, {
          accountId: key.accountId,
          instrumentId: key.instrumentId,
          tradeId: t.id,
          date: t.tradeDate,
        });
      }
      warnings.push({
        code: 'oversell',
        instrumentId: key.instrumentId,
        accountId: key.accountId,
        date: t.tradeDate,
        message: msg,
      });
      sellQty = quantity;
    }
    if (sellQty.lessThanOrEqualTo(0)) {
      // Zero-quantity basis adjustment (spinoff transfer-out).
      costBasisLocal = costBasisLocal.plus(fees);
      costBasisGbp = costBasisGbp.plus(fees.times(t.fxRate));
      const scale = divOrZero(costBasisLocal, costBasisLocal.minus(fees));
      lots = lots.map((l) => ({
        ...l,
        unitCostLocal: l.unitCostLocal.times(scale),
        unitCostGbp: l.unitCostGbp.times(scale),
      }));
      continue;
    }

    // Sell-side fees reduce proceeds.
    const proceedsLocal = sellQty.times(t.price).minus(fees);
    const proceedsGbp = proceedsLocal.times(t.fxRate);

    // Average-cost realised gain (the broker-statement figure).
    //
    // Multiply before dividing. `basis × qty / held` is exact whenever the
    // arithmetic is exact; `(basis / held) × qty` rounds the per-share cost to
    // 34 digits first and leaves a residue in the pennies. That residue is
    // invisible on one trade and unacceptable after three hundred.
    const releasedGbp = divOrZero(costBasisGbp.times(sellQty), quantity);
    const releasedLocal = divOrZero(costBasisLocal.times(sellQty), quantity);
    realisedAverage = realisedAverage.plus(proceedsGbp.minus(releasedGbp));
    costBasisGbp = costBasisGbp.minus(releasedGbp);
    costBasisLocal = costBasisLocal.minus(releasedLocal);

    // FIFO realised gain, lot by lot.
    let remaining = sellQty;
    while (remaining.greaterThan(0) && lots.length > 0) {
      const lot = lots[0]!;
      const take = Decimal.min(remaining, lot.quantity);
      const costGbp = lot.unitCostGbp.times(take);
      const portionGbp = divOrZero(proceedsGbp.times(take), sellQty);
      realisedFifo = realisedFifo.plus(portionGbp.minus(costGbp));
      disposals.push({
        tradeId: t.id,
        date: t.tradeDate,
        quantity: take,
        proceedsGbp: portionGbp,
        costGbp,
        gainGbp: portionGbp.minus(costGbp),
        method: 'fifo',
        matchedAgainstTradeId: lot.tradeId,
        holdingDays: daysBetween(lot.openedOn, t.tradeDate),
      });
      lot.quantity = lot.quantity.minus(take);
      remaining = remaining.minus(take);
      if (isZeroish(lot.quantity)) lots.shift();
    }

    quantity = quantity.minus(sellQty);
    if (isZeroish(quantity)) {
      quantity = ZERO;
      costBasisGbp = ZERO;
      costBasisLocal = ZERO;
      lots = [];
      closedOn = t.tradeDate;
    }
  }

  const s104 = opts.skipTaxPooling
    ? { poolQuantity: ZERO, poolCostGbp: ZERO, realisedGbp: ZERO, disposals: [], provisionalDisposalIds: [] }
    : computeSection104(key, posTrades, splits, asOf, strict, warnings);

  const dividendsGbp = cashFlows
    .filter(
      (f) =>
        f.instrumentId === key.instrumentId &&
        f.accountId === key.accountId &&
        (f.kind === 'dividend' || f.kind === 'interest') &&
        f.flowDate <= asOf,
    )
    .reduce<Decimal>((a, f) => a.plus(f.amount.minus(f.withholding).times(f.fxRate)), ZERO);

  const isOpen = quantity.greaterThan(0);

  return {
    instrumentId: key.instrumentId,
    accountId: key.accountId,
    quantity,
    avgUnitCostLocal: divOrZero(costBasisLocal, quantity),
    avgUnitCostGbp: divOrZero(costBasisGbp, quantity),
    costBasisLocal,
    costBasisGbp,
    lots,
    currency,
    realisedGbpFifo: realisedFifo,
    realisedGbpAverage: realisedAverage,
    s104: { quantity: s104.poolQuantity, costGbp: s104.poolCostGbp },
    realisedGbpS104: s104.realisedGbp,
    disposals: [...disposals, ...s104.disposals],
    openedOn,
    closedOn: isOpen ? null : closedOn,
    isOpen,
    feesGbp,
    dividendsGbp,
  };
}

function mergePositions(a: Position, b: Position): Position {
  const quantity = a.quantity.plus(b.quantity);
  const costBasisGbp = a.costBasisGbp.plus(b.costBasisGbp);
  const costBasisLocal = a.costBasisLocal.plus(b.costBasisLocal);
  return {
    ...a,
    accountId: -1, // merged view spans accounts
    quantity,
    costBasisGbp,
    costBasisLocal,
    avgUnitCostGbp: divOrZero(costBasisGbp, quantity),
    avgUnitCostLocal: divOrZero(costBasisLocal, quantity),
    lots: [...a.lots, ...b.lots].sort((x, y) => x.openedOn.localeCompare(y.openedOn)),
    realisedGbpFifo: a.realisedGbpFifo.plus(b.realisedGbpFifo),
    realisedGbpAverage: a.realisedGbpAverage.plus(b.realisedGbpAverage),
    realisedGbpS104: a.realisedGbpS104.plus(b.realisedGbpS104),
    s104: {
      quantity: a.s104.quantity.plus(b.s104.quantity),
      costGbp: a.s104.costGbp.plus(b.s104.costGbp),
    },
    disposals: [...a.disposals, ...b.disposals],
    feesGbp: a.feesGbp.plus(b.feesGbp),
    dividendsGbp: a.dividendsGbp.plus(b.dividendsGbp),
    isOpen: quantity.greaterThan(0),
    openedOn: [a.openedOn, b.openedOn].filter(Boolean).sort()[0] ?? null,
  };
}

/* ============================================================
 * Section 104 pooling with same-day and 30-day matching
 * ============================================================
 * HMRC disposal matching order:
 *   1. acquisitions on the same day
 *   2. acquisitions in the 30 days FOLLOWING the disposal (bed & breakfast)
 *   3. the Section 104 pool, at pooled average cost
 *
 * Rule 2 looks forward, so a disposal inside the last 30 days of the ledger
 * cannot be finalised. Those disposals are returned flagged `provisional`
 * rather than being silently treated as pool disposals.
 *
 * Quantities are normalised to as-of share terms so a split does not disturb
 * the matching; total pooled cost is unaffected by splits either way.
 */
export interface Section104Result {
  poolQuantity: Decimal;
  poolCostGbp: Decimal;
  realisedGbp: Decimal;
  disposals: Disposal[];
  provisionalDisposalIds: number[];
}

export function computeSection104(
  key: PositionKey,
  posTrades: EngineTrade[],
  splits: EngineCorporateAction[],
  asOf: IsoDate,
  _strict: boolean,
  _warnings: EngineWarning[],
): Section104Result {
  // Normalise to as-of share terms: multiply by every split strictly after the
  // trade date. A trade on the ex-date is already in post-split terms.
  const factorFor = (d: IsoDate): Decimal =>
    splits
      .filter((s) => s.actionDate > d && s.actionDate <= asOf && s.ratio)
      .reduce<Decimal>((a, s) => a.times(s.ratio!), new Decimal(1));

  interface Acq {
    tradeId: number;
    date: IsoDate;
    qty: Decimal;
    remaining: Decimal;
    costGbp: Decimal; // total, fees included
  }
  interface Disp {
    tradeId: number;
    date: IsoDate;
    qty: Decimal;
    proceedsGbp: Decimal; // total, net of fees
  }

  const acqs: Acq[] = [];
  const disps: Disp[] = [];

  for (const t of [...posTrades].sort(
    (a, b) => a.tradeDate.localeCompare(b.tradeDate) || a.id - b.id,
  )) {
    if (t.tradeDate > asOf) continue;
    const f = factorFor(t.tradeDate);
    const qty = t.quantity.times(f);
    if (qty.lessThanOrEqualTo(0)) continue;
    const fees = t.commission.plus(t.stampDuty).plus(t.fxFee).plus(t.otherFees);
    if (t.side === 'buy') {
      const costGbp = t.quantity.times(t.price).plus(fees).times(t.fxRate);
      acqs.push({ tradeId: t.id, date: t.tradeDate, qty, remaining: qty, costGbp });
    } else {
      const proceedsGbp = t.quantity.times(t.price).minus(fees).times(t.fxRate);
      disps.push({ tradeId: t.id, date: t.tradeDate, qty, proceedsGbp });
    }
  }

  // Pass 1 — match disposals against same-day then 30-day-following acquisitions.
  interface Match {
    disposal: Disp;
    acq: Acq;
    qty: Decimal;
    method: 'same_day' | 'thirty_day';
  }
  const matches: Match[] = [];
  const matchedByDisposal = new Map<number, Decimal>();
  const provisional: number[] = [];

  for (const d of disps) {
    let unmatched = d.qty;
    const sameDay = acqs.filter((a) => a.date === d.date && a.remaining.greaterThan(0));
    const window = acqs
      .filter(
        (a) =>
          a.date > d.date &&
          daysBetween(d.date, a.date) <= 30 &&
          a.remaining.greaterThan(0),
      )
      .sort((x, y) => x.date.localeCompare(y.date) || x.tradeId - y.tradeId);

    for (const [pool, method] of [
      [sameDay, 'same_day'] as const,
      [window, 'thirty_day'] as const,
    ]) {
      for (const a of pool) {
        if (unmatched.lessThanOrEqualTo(0)) break;
        const take = Decimal.min(unmatched, a.remaining);
        if (take.lessThanOrEqualTo(0)) continue;
        a.remaining = a.remaining.minus(take);
        unmatched = unmatched.minus(take);
        matches.push({ disposal: d, acq: a, qty: take, method });
      }
    }
    matchedByDisposal.set(d.tradeId, d.qty.minus(unmatched));
    // The 30-day window is still open if the ledger ends inside it.
    if (unmatched.greaterThan(0) && daysBetween(d.date, asOf) < 30) {
      provisional.push(d.tradeId);
    }
  }

  // Pass 2 — walk chronologically. Acquisitions add only their unmatched share
  // to the pool; disposals take from the pool only what rule 3 covers.
  type Step = { date: IsoDate; seq: number; acq?: Acq; disp?: Disp };
  const timeline: Step[] = [
    ...acqs.map<Step>((a) => ({ date: a.date, seq: a.tradeId, acq: a })),
    ...disps.map<Step>((d) => ({ date: d.date, seq: d.tradeId, disp: d })),
  ].sort((a, b) => a.date.localeCompare(b.date) || (a.acq ? 0 : 1) - (b.acq ? 0 : 1) || a.seq - b.seq);

  let poolQty = ZERO;
  let poolCost = ZERO;
  let realised = ZERO;
  const disposalRows: Disposal[] = [];

  for (const step of timeline) {
    if (step.acq) {
      const a = step.acq;
      if (a.remaining.greaterThan(0)) {
        poolQty = poolQty.plus(a.remaining);
        poolCost = poolCost.plus(divOrZero(a.costGbp.times(a.remaining), a.qty));
      }
      continue;
    }
    const d = step.disp!;

    for (const m of matches.filter((x) => x.disposal.tradeId === d.tradeId)) {
      const cost = divOrZero(m.acq.costGbp.times(m.qty), m.acq.qty);
      const proceeds = divOrZero(d.proceedsGbp.times(m.qty), d.qty);
      realised = realised.plus(proceeds.minus(cost));
      disposalRows.push({
        tradeId: d.tradeId,
        date: d.date,
        quantity: m.qty,
        proceedsGbp: proceeds,
        costGbp: cost,
        gainGbp: proceeds.minus(cost),
        method: m.method,
        matchedAgainstTradeId: m.acq.tradeId,
      });
    }

    const fromPool = d.qty.minus(matchedByDisposal.get(d.tradeId) ?? ZERO);
    if (fromPool.greaterThan(0) && poolQty.greaterThan(0)) {
      const take = Decimal.min(fromPool, poolQty);
      const cost = divOrZero(poolCost.times(take), poolQty);
      const proceeds = divOrZero(d.proceedsGbp.times(take), d.qty);
      realised = realised.plus(proceeds.minus(cost));
      disposalRows.push({
        tradeId: d.tradeId,
        date: d.date,
        quantity: take,
        proceedsGbp: proceeds,
        costGbp: cost,
        gainGbp: proceeds.minus(cost),
        method: 's104',
      });
      poolQty = poolQty.minus(take);
      poolCost = poolCost.minus(cost);
      if (isZeroish(poolQty)) {
        poolQty = ZERO;
        poolCost = ZERO;
      }
    }
  }

  return {
    poolQuantity: poolQty,
    poolCostGbp: poolCost,
    realisedGbp: realised,
    disposals: disposalRows,
    provisionalDisposalIds: provisional,
  };
}

/** Total realised P&L across a position set, under the display (average) basis. */
export function totalRealisedGbp(set: PositionSet): Decimal {
  return set.all.reduce<Decimal>((a, p) => a.plus(p.realisedGbpAverage), ZERO);
}
