/**
 * Auto-invest scheduling and the market calendar (CLAUDE.md §5, §8).
 *
 * The two rules that matter: day_of_month is capped at 28, and a target date on
 * a weekend or market holiday rolls FORWARD to the next session.
 */
import { describe, expect, it } from 'vitest';
import { Decimal, ZERO } from '../src/lib/decimal';
import {
  easterSunday,
  isTradingDay,
  rollForwardToTradingDay,
  ukTaxYear,
  addMonths,
  eachBusinessDay,
} from '../src/lib/dates';
import {
  RuleError,
  dueDates,
  generateTrades,
  stampDutyFor,
  validateRule,
  type AutoInvestRuleSpec,
} from '../src/lib/engine/auto-invest';

const baseRule: AutoInvestRuleSpec = {
  id: 1,
  accountId: 1,
  cadence: 'monthly',
  dayOfMonth: 5,
  dayOfWeek: null,
  amount: new Decimal(500),
  currency: 'GBP',
  allocation: [{ instrument_id: 6, pct: 1 }],
  fractional: true,
  activeFrom: '2024-01-01',
  activeTo: null,
  isActive: true,
  lastExecutedOn: null,
};

describe('market calendar', () => {
  it('computes Easter correctly across the century', () => {
    expect(easterSunday(2024)).toBe('2024-03-31');
    expect(easterSunday(2025)).toBe('2025-04-20');
    expect(easterSunday(2026)).toBe('2026-04-05');
    expect(easterSunday(2038)).toBe('2038-04-25');
  });

  it('closes the LSE on Good Friday and Easter Monday', () => {
    expect(isTradingDay('2025-04-18', 'XLON')).toBe(false); // Good Friday
    expect(isTradingDay('2025-04-21', 'XLON')).toBe(false); // Easter Monday
    expect(isTradingDay('2025-04-22', 'XLON')).toBe(true);
  });

  it('closes the LSE on the bank holidays the US ignores, and vice versa', () => {
    // Late May bank holiday — a London closure, a normal US session it is not
    // (Memorial Day happens to coincide, so use August instead).
    expect(isTradingDay('2025-08-25', 'XLON')).toBe(false); // Summer bank holiday
    expect(isTradingDay('2025-08-25', 'XNAS')).toBe(true);
    expect(isTradingDay('2025-07-04', 'XNAS')).toBe(false); // Independence Day
    expect(isTradingDay('2025-07-04', 'XLON')).toBe(true);
    expect(isTradingDay('2025-11-27', 'XNAS')).toBe(false); // Thanksgiving
  });

  it('treats weekends as closed everywhere', () => {
    expect(isTradingDay('2025-06-07')).toBe(false);
    expect(isTradingDay('2025-06-08')).toBe(false);
    expect(isTradingDay('2025-06-09')).toBe(true);
  });

  it('rolls forward, never backward', () => {
    // 5 April 2025 is a Saturday.
    expect(rollForwardToTradingDay('2025-04-05')).toBe('2025-04-07');
    // Christmas Day 2025 is a Thursday; Boxing Day follows.
    expect(rollForwardToTradingDay('2025-12-25')).toBe('2025-12-29');
    // A normal session is returned unchanged.
    expect(rollForwardToTradingDay('2025-06-10')).toBe('2025-06-10');
  });

  it('handles month-end arithmetic without overflowing', () => {
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29'); // leap year
    expect(addMonths('2025-01-31', 1)).toBe('2025-02-28');
    expect(addMonths('2024-12-15', 1)).toBe('2025-01-15');
  });

  it('assigns the UK tax year from 6 April', () => {
    expect(ukTaxYear('2025-04-05')).toBe('2024/25');
    expect(ukTaxYear('2025-04-06')).toBe('2025/26');
    expect(ukTaxYear('2026-01-31')).toBe('2025/26');
  });

  it('enumerates business days without weekends or holidays', () => {
    const days = eachBusinessDay('2025-04-14', '2025-04-25', 'XLON');
    expect(days).not.toContain('2025-04-18'); // Good Friday
    expect(days).not.toContain('2025-04-19'); // Saturday
    expect(days).not.toContain('2025-04-21'); // Easter Monday
    expect(days).toContain('2025-04-22');
  });
});

describe('rule validation', () => {
  it('rejects a day_of_month above 28', () => {
    expect(() => validateRule({ ...baseRule, dayOfMonth: 31 })).toThrow(RuleError);
    expect(() => validateRule({ ...baseRule, dayOfMonth: 29 })).toThrow(/1-28/);
  });

  it('rejects an allocation that does not sum to 1', () => {
    expect(() =>
      validateRule({
        ...baseRule,
        allocation: [
          { instrument_id: 1, pct: 0.5 },
          { instrument_id: 2, pct: 0.3 },
        ],
      }),
    ).toThrow(/sums to/);
  });

  it('rejects a weekly rule with no day_of_week', () => {
    expect(() =>
      validateRule({ ...baseRule, cadence: 'weekly', dayOfMonth: null, dayOfWeek: null }),
    ).toThrow(RuleError);
  });
});

describe('due dates', () => {
  it('fires monthly on the target day', () => {
    const due = dueDates(baseRule, '2024-04-30');
    expect(due.map((d) => d.target)).toEqual([
      '2024-01-05',
      '2024-02-05',
      '2024-03-05',
      '2024-04-05',
    ]);
  });

  it('rolls a weekend target onto the next session and records both dates', () => {
    const due = dueDates(baseRule, '2024-05-31');
    const may = due.find((d) => d.target === '2024-05-05')!;
    // 5 May 2024 is a Sunday; the 6th is the early May bank holiday.
    expect(may.executeOn).toBe('2024-05-07');
    expect(may.executeOn).not.toBe(may.target);
  });

  it('catches up on periods missed while the scheduler was down', () => {
    const stale = { ...baseRule, lastExecutedOn: '2024-01-05' };
    const due = dueDates(stale, '2024-05-31');
    expect(due.map((d) => d.target)).toEqual([
      '2024-02-05',
      '2024-03-05',
      '2024-04-05',
      '2024-05-05',
    ]);
  });

  it('does not re-fire a period already executed', () => {
    const current = { ...baseRule, lastExecutedOn: '2024-04-05' };
    expect(dueDates(current, '2024-04-30')).toEqual([]);
  });

  it('respects activeTo', () => {
    const ending = { ...baseRule, activeTo: '2024-03-01' };
    expect(dueDates(ending, '2024-06-30').map((d) => d.target)).toEqual([
      '2024-01-05',
      '2024-02-05',
    ]);
  });

  it('keeps a fortnightly rule in phase after a gap', () => {
    const fortnightly: AutoInvestRuleSpec = {
      ...baseRule,
      cadence: 'fortnightly',
      dayOfMonth: null,
      dayOfWeek: 1, // Monday
      activeFrom: '2024-01-01', // itself a Monday
      lastExecutedOn: '2024-02-12',
    };
    const due = dueDates(fortnightly, '2024-04-01');
    // The cycle is anchored on 1 January, so it stays on the odd fortnights.
    expect(due.map((d) => d.target)).toEqual(['2024-02-26', '2024-03-11', '2024-03-25']);
  });

  it('returns nothing for an inactive rule', () => {
    expect(dueDates({ ...baseRule, isActive: false }, '2024-12-31')).toEqual([]);
  });
});

describe('trade generation', () => {
  const ctx = {
    priceOn: (id: number) => (id === 6 ? new Decimal(100) : new Decimal(50)),
    fxOn: (from: string, to: string) =>
      from === to ? new Decimal(1) : new Decimal(from === 'GBP' ? 1.25 : 0.8),
    quoteCurrencyOf: (id: number) => (id === 6 ? 'GBP' : 'USD'),
  };

  it('buys a fractional quantity for the full amount', () => {
    const [leg] = generateTrades(baseRule, '2024-01-05', ctx);
    expect(leg!.quantity.toFixed()).toBe('5');
    expect(leg!.undeployed.isZero()).toBe(true);
  });

  it('floors to whole shares and reports the undeployed cash', () => {
    const wholeShares = { ...baseRule, fractional: false, amount: new Decimal(550) };
    const [leg] = generateTrades(wholeShares, '2024-01-05', ctx);
    expect(leg!.quantity.toFixed()).toBe('5');
    expect(leg!.undeployed.toFixed()).toBe('50');
  });

  it('converts a GBP rule into a USD-quoted instrument', () => {
    const usd = { ...baseRule, allocation: [{ instrument_id: 1, pct: 1 }] };
    const [leg] = generateTrades(usd, '2024-01-05', ctx);
    // £500 x 1.25 = $625 at $50 a share.
    expect(leg!.quantity.toFixed()).toBe('12.5');
    expect(leg!.currency).toBe('USD');
    expect(leg!.fxRate.toFixed()).toBe('0.8');
  });

  it('skips a leg with no price rather than overweighting the others', () => {
    const twoLegs = {
      ...baseRule,
      allocation: [
        { instrument_id: 6, pct: 0.5 },
        { instrument_id: 99, pct: 0.5 },
      ],
    };
    const legs = generateTrades(twoLegs, '2024-01-05', {
      ...ctx,
      priceOn: (id: number) => (id === 6 ? new Decimal(100) : null),
    });
    expect(legs[0]!.quantity.toFixed()).toBe('2.5');
    expect(legs[1]!.quantity.isZero()).toBe(true);
    expect(legs[1]!.undeployed.toFixed()).toBe('250');
  });

  it('splits across a multi-leg allocation by weight', () => {
    const split = {
      ...baseRule,
      allocation: [
        { instrument_id: 6, pct: 0.6 },
        { instrument_id: 7, pct: 0.4 },
      ],
    };
    const legs = generateTrades(split, '2024-01-05', {
      ...ctx,
      quoteCurrencyOf: () => 'GBP',
      priceOn: () => new Decimal(100),
    });
    expect(legs[0]!.quantity.toFixed()).toBe('3');
    expect(legs[1]!.quantity.toFixed()).toBe('2');
  });
});

describe('stamp duty', () => {
  it('charges 0.5% on a UK share purchase', () => {
    expect(stampDutyFor('equity', 'XLON', new Decimal(10_000)).toFixed()).toBe('50');
  });

  it('exempts ETFs and investment trusts', () => {
    expect(stampDutyFor('etf', 'XLON', new Decimal(10_000))).toStrictEqual(ZERO);
    expect(stampDutyFor('investment_trust', 'XLON', new Decimal(10_000))).toStrictEqual(ZERO);
  });

  it('does not apply outside the LSE', () => {
    expect(stampDutyFor('equity', 'XNAS', new Decimal(10_000))).toStrictEqual(ZERO);
  });
});
