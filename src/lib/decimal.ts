/**
 * Exact decimal arithmetic for every money and quantity value.
 *
 * Rationale (CLAUDE.md §5): floating point on cost basis produces drift that
 * compounds across hundreds of trades. Postgres stores `numeric`, Drizzle hands
 * it back as a string, and it stays a string or a Decimal all the way through
 * the engine. Conversion to `number` happens only at the presentation boundary
 * and for statistical work on *returns*, where the values are small ratios and
 * float error is irrelevant.
 */
import Decimal from 'decimal.js';

// 34 significant digits: comfortably beyond anything a share ledger needs, and
// enough that repeated pool-average divisions do not accumulate visible error.
Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_EVEN, toExpPos: 40, toExpNeg: -40 });

export type Numeric = Decimal.Value;

export function dec(v: Numeric | null | undefined): Decimal {
  if (v === null || v === undefined || v === '') return new Decimal(0);
  return new Decimal(v);
}

export const ZERO = new Decimal(0);
export const ONE = new Decimal(1);

/** Serialise for a Postgres `numeric` column. Never use `toNumber()` for this. */
export function toNumericString(v: Decimal): string {
  return v.toFixed();
}

/** Presentation boundary only. */
export function toNum(v: Decimal): number {
  return v.toNumber();
}

export function sum(values: Decimal[]): Decimal {
  return values.reduce<Decimal>((a, b) => a.plus(b), ZERO);
}

/** Safe divide: returns null rather than Infinity/NaN on a zero denominator. */
export function divOrNull(a: Decimal, b: Decimal): Decimal | null {
  if (b.isZero()) return null;
  return a.div(b);
}

/** Safe divide to zero — for weights where an empty portfolio means 0%. */
export function divOrZero(a: Decimal, b: Decimal): Decimal {
  if (b.isZero()) return ZERO;
  return a.div(b);
}

export function isZeroish(v: Decimal, epsilon = '1e-12'): boolean {
  return v.abs().lessThan(epsilon);
}

export { Decimal };
