/**
 * Auto-invest rule expansion (CLAUDE.md §5, §8).
 *
 * Rules generate trades; trades are still the sole source of truth. Nothing
 * about a generated trade is special except its `source` and `rule_id`, so a
 * drip-fed position behaves identically to a manual one everywhere downstream.
 *
 * Two rules the schema comment demands and this module enforces:
 *   - `day_of_month` is capped at 28. Days 29-31 are ambiguous in February and
 *     the ambiguity would silently shift a contribution by up to three days.
 *   - a target date on a weekend or market holiday rolls FORWARD to the next
 *     session, and the generated trade records the date it actually executed.
 */
import { Decimal, ZERO, divOrZero } from '../decimal';
import { addDays, addMonths, dayOfWeek, rollForwardToTradingDay } from '../dates';
import type { IsoDate } from '../types';

export interface AutoInvestRuleSpec {
  id: number;
  accountId: number;
  cadence: 'monthly' | 'weekly' | 'fortnightly';
  dayOfMonth: number | null;
  dayOfWeek: number | null;
  amount: Decimal;
  currency: string;
  allocation: Array<{ instrument_id: number; pct: number }>;
  fractional: boolean;
  activeFrom: IsoDate;
  activeTo: IsoDate | null;
  isActive: boolean;
  lastExecutedOn: IsoDate | null;
}

export class RuleError extends Error {}

export function validateRule(rule: AutoInvestRuleSpec): void {
  if (rule.cadence === 'monthly') {
    if (rule.dayOfMonth === null) throw new RuleError('monthly rules need a day_of_month');
    if (rule.dayOfMonth < 1 || rule.dayOfMonth > 28) {
      throw new RuleError(
        `day_of_month ${rule.dayOfMonth} is outside 1-28; days 29-31 do not exist in every month`,
      );
    }
  } else if (rule.dayOfWeek === null) {
    throw new RuleError(`${rule.cadence} rules need a day_of_week`);
  }

  const total = rule.allocation.reduce((a, x) => a + x.pct, 0);
  if (Math.abs(total - 1) > 1e-9) {
    throw new RuleError(`allocation sums to ${total}, not 1`);
  }
  if (rule.allocation.some((a) => a.pct <= 0)) {
    throw new RuleError('allocation percentages must be positive');
  }
}

/**
 * Every date the rule should have fired in (from, to], rolled forward onto a
 * trading day. Catches up on any period missed while the scheduler was down.
 */
export function dueDates(
  rule: AutoInvestRuleSpec,
  to: IsoDate,
  mic = 'XLON',
): Array<{ target: IsoDate; executeOn: IsoDate }> {
  validateRule(rule);
  if (!rule.isActive) return [];

  const start = rule.lastExecutedOn ? addDays(rule.lastExecutedOn, 1) : rule.activeFrom;
  const end = rule.activeTo && rule.activeTo < to ? rule.activeTo : to;
  if (start > end) return [];

  const targets: IsoDate[] = [];

  if (rule.cadence === 'monthly') {
    const day = String(rule.dayOfMonth).padStart(2, '0');
    let cursor = `${start.slice(0, 7)}-${day}`;
    if (cursor < start) cursor = addMonths(cursor, 1);
    while (cursor <= end) {
      targets.push(cursor);
      cursor = addMonths(cursor, 1);
    }
  } else {
    const step = rule.cadence === 'weekly' ? 7 : 14;
    // Anchor the cycle on activeFrom so a fortnightly rule keeps its phase even
    // after a gap in execution.
    let cursor = rule.activeFrom;
    while (dayOfWeek(cursor) !== rule.dayOfWeek) cursor = addDays(cursor, 1);
    while (cursor < start) cursor = addDays(cursor, step);
    while (cursor <= end) {
      targets.push(cursor);
      cursor = addDays(cursor, step);
    }
  }

  return targets.map((target) => ({ target, executeOn: rollForwardToTradingDay(target, mic) }));
}

export interface GeneratedTrade {
  instrumentId: number;
  quantity: Decimal;
  price: Decimal;
  tradeDate: IsoDate;
  currency: string;
  fxRate: Decimal;
  /** Cash the rule could not deploy — whole-share rounding, or a missing price. */
  undeployed: Decimal;
  note: string;
}

export interface PricingContext {
  /** Close in the instrument's quote currency, on or before the date. */
  priceOn: (instrumentId: number, date: IsoDate) => Decimal | null;
  /** Rule currency -> instrument quote currency. */
  fxOn: (from: string, to: string, date: IsoDate) => Decimal | null;
  quoteCurrencyOf: (instrumentId: number) => string;
}

/**
 * Turn one firing of a rule into trades.
 *
 * A leg with no price is skipped and its cash reported as undeployed rather
 * than being silently redistributed across the other legs: the owner asked for
 * a specific allocation, and quietly overweighting whatever happened to have a
 * price is not that.
 */
export function generateTrades(
  rule: AutoInvestRuleSpec,
  executeOn: IsoDate,
  ctx: PricingContext,
): GeneratedTrade[] {
  validateRule(rule);
  const out: GeneratedTrade[] = [];

  for (const leg of rule.allocation) {
    const legCash = rule.amount.times(leg.pct);
    const quoteCcy = ctx.quoteCurrencyOf(leg.instrument_id);
    const price = ctx.priceOn(leg.instrument_id, executeOn);
    const fxRuleToQuote = ctx.fxOn(rule.currency, quoteCcy, executeOn);
    const fxQuoteToGbp = ctx.fxOn(quoteCcy, 'GBP', executeOn);

    if (!price || price.lessThanOrEqualTo(0) || !fxRuleToQuote || !fxQuoteToGbp) {
      out.push({
        instrumentId: leg.instrument_id,
        quantity: ZERO,
        price: price ?? ZERO,
        tradeDate: executeOn,
        currency: quoteCcy,
        fxRate: fxQuoteToGbp ?? ZERO,
        undeployed: legCash,
        note: 'no price or FX rate available on the execution date',
      });
      continue;
    }

    const cashInQuote = legCash.times(fxRuleToQuote);
    const rawQty = divOrZero(cashInQuote, price);
    const quantity = rule.fractional ? rawQty : rawQty.floor();
    const spent = quantity.times(price);
    const undeployedQuote = cashInQuote.minus(spent);

    out.push({
      instrumentId: leg.instrument_id,
      quantity,
      price,
      tradeDate: executeOn,
      currency: quoteCcy,
      fxRate: fxQuoteToGbp,
      undeployed: divOrZero(undeployedQuote, fxRuleToQuote),
      note: `auto-invest rule ${rule.id}`,
    });
  }

  return out;
}

/** UK stamp duty: 0.5% on purchases of UK shares, but not ETFs or trusts. */
export function stampDutyFor(
  assetClass: string,
  exchangeMic: string | null,
  consideration: Decimal,
): Decimal {
  if (exchangeMic !== 'XLON') return ZERO;
  if (assetClass === 'etf' || assetClass === 'investment_trust') return ZERO;
  return consideration.times('0.005');
}
