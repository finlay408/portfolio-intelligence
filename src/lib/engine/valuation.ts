/**
 * Valuation and the GBP return decomposition (CLAUDE.md §3.2).
 *
 * The decomposition is an exact identity, not an approximation:
 *
 *   MV_gbp / cost_gbp - 1  =  (1 + a)(1 + f) - 1  =  a + f + a·f
 *
 * where a is the local-currency asset return and f is the FX return between the
 * cost-weighted acquisition rate and today's rate. The cross term a·f is small
 * but it is carried, so `assetReturnLocal + fxReturn + crossTerm` reconciles to
 * the GBP return to the last digit rather than to "about right".
 */
import { Decimal, ONE, ZERO, divOrZero, divOrNull } from '../decimal';
import type {
  IsoDate,
  PortfolioValuation,
  Position,
  ReturnDecomposition,
  ValuedPosition,
} from '../types';

/** Prices are always post-multiplier and in the instrument's quote currency. */
export interface PriceLookup {
  /** Most recent close on or before `date`, or null when there is none. */
  priceOn(instrumentId: number, date: IsoDate): { price: Decimal; date: IsoDate } | null;
}

export interface FxLookup {
  /** Units of `to` per one unit of `from`, on or before `date`. */
  rateOn(from: string, to: string, date: IsoDate): Decimal | null;
}

export class MapPriceLookup implements PriceLookup {
  /** instrumentId -> sorted [date, close][] */
  constructor(private readonly series: Map<number, Array<[IsoDate, Decimal]>>) {}

  priceOn(instrumentId: number, date: IsoDate) {
    const rows = this.series.get(instrumentId);
    if (!rows || rows.length === 0) return null;
    let lo = 0;
    let hi = rows.length - 1;
    let found: [IsoDate, Decimal] | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const row = rows[mid]!;
      if (row[0] <= date) {
        found = row;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found ? { price: found[1], date: found[0] } : null;
  }
}

export class MapFxLookup implements FxLookup {
  /** 'USDGBP' -> sorted [date, rate][] */
  constructor(private readonly series: Map<string, Array<[IsoDate, Decimal]>>) {}

  private lookup(pair: string, date: IsoDate): Decimal | null {
    const rows = this.series.get(pair);
    if (!rows || rows.length === 0) return null;
    let lo = 0;
    let hi = rows.length - 1;
    let found: Decimal | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const row = rows[mid]!;
      if (row[0] <= date) {
        found = row[1];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  rateOn(from: string, to: string, date: IsoDate): Decimal | null {
    if (from === to) return ONE;
    const direct = this.lookup(`${from}${to}`, date);
    if (direct) return direct;
    const inverse = this.lookup(`${to}${from}`, date);
    if (inverse && !inverse.isZero()) return ONE.div(inverse);
    // Cross via GBP, the base currency, which is always present in practice.
    const a = this.lookup(`${from}GBP`, date) ?? invert(this.lookup(`GBP${from}`, date));
    const b = this.lookup(`${to}GBP`, date) ?? invert(this.lookup(`GBP${to}`, date));
    if (a && b && !b.isZero()) return a.div(b);
    return null;
  }
}

function invert(v: Decimal | null): Decimal | null {
  return v && !v.isZero() ? ONE.div(v) : null;
}

export function decompose(
  position: Position,
  priceNow: Decimal,
  fxNow: Decimal,
): ReturnDecomposition | null {
  if (position.costBasisLocal.isZero() || position.quantity.isZero()) return null;

  const marketLocal = priceNow.times(position.quantity);
  const assetReturnLocal = marketLocal.div(position.costBasisLocal).minus(ONE);

  // The cost-weighted acquisition FX rate, recovered from the two cost bases.
  const fxAtCost = divOrNull(position.costBasisGbp, position.costBasisLocal);
  if (!fxAtCost || fxAtCost.isZero()) return null;
  const fxReturn = fxNow.div(fxAtCost).minus(ONE);
  const crossTerm = assetReturnLocal.times(fxReturn);

  return {
    assetReturnLocal,
    fxReturn,
    crossTerm,
    totalReturnGbp: assetReturnLocal.plus(fxReturn).plus(crossTerm),
  };
}

export interface ValueOptions {
  asOf: IsoDate;
  accountId?: number | null;
  cashGbp?: Decimal;
  /** Instrument metadata needed for the quote currency. */
  quoteCurrencyOf: (instrumentId: number) => string;
}

export function valuePortfolio(
  positions: Position[],
  prices: PriceLookup,
  fx: FxLookup,
  opts: ValueOptions,
): PortfolioValuation {
  const open = positions.filter((p) => p.isOpen);
  const rows: ValuedPosition[] = [];

  for (const position of open) {
    const quoteCcy = opts.quoteCurrencyOf(position.instrumentId);
    const priceRow = prices.priceOn(position.instrumentId, opts.asOf);
    // A missing rate is not parity — see the note in `snapshots.ts`. Without a
    // rate the position simply cannot be stated in GBP.
    const rate = quoteCcy === 'GBP' ? ONE : fx.rateOn(quoteCcy, 'GBP', opts.asOf);
    const fxToGbp = rate ?? ONE;
    const price = priceRow && rate ? priceRow.price : null;
    const marketValueGbp = price ? price.times(position.quantity).times(fxToGbp) : ZERO;

    rows.push({
      position,
      price,
      priceDate: priceRow?.date ?? null,
      fxToGbp,
      marketValueGbp,
      unrealisedGbp: marketValueGbp.minus(position.costBasisGbp),
      weight: ZERO, // filled below, once the total is known
      decomposition: price ? decompose(position, price, fxToGbp) : null,
    });
  }

  const marketValueGbp = rows.reduce<Decimal>((a, r) => a.plus(r.marketValueGbp), ZERO);
  for (const r of rows) r.weight = divOrZero(r.marketValueGbp, marketValueGbp);
  rows.sort((a, b) => b.marketValueGbp.comparedTo(a.marketValueGbp));

  const costBasisGbp = rows.reduce<Decimal>((a, r) => a.plus(r.position.costBasisGbp), ZERO);
  const realisedGbp = positions.reduce<Decimal>((a, p) => a.plus(p.realisedGbpAverage), ZERO);
  const cashGbp = opts.cashGbp ?? ZERO;

  return {
    asOf: opts.asOf,
    accountId: opts.accountId ?? null,
    positions: rows,
    marketValueGbp,
    costBasisGbp,
    unrealisedGbp: marketValueGbp.minus(costBasisGbp),
    realisedGbp,
    cashGbp,
    totalValueGbp: marketValueGbp.plus(cashGbp),
  };
}
