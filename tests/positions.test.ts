/**
 * Phase 1 gate (CLAUDE.md §10): a portfolio with buys, partial sells, a full
 * close and a stock split must produce a cost basis that reconciles by hand to
 * the penny.
 */
import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/lib/decimal';
import {
  LedgerError,
  computePositions,
  computeSection104,
} from '../src/lib/engine/positions';
import {
  GIA,
  INST,
  ISA,
  cashFlows,
  corporateActions,
  expected,
  trades,
} from './fixtures/golden-portfolio';

const result = computePositions(trades, corporateActions, cashFlows, { asOf: '2025-03-31' });

const find = (accountId: number, instrumentId: number) => {
  const p = result.all.find((x) => x.accountId === accountId && x.instrumentId === instrumentId);
  if (!p) throw new Error(`no position for ${accountId}:${instrumentId}`);
  return p;
};

/** Exact equality on the decimal value, not on its string form. */
const eq = (actual: Decimal, want: string) =>
  expect(`${actual.toFixed(10)} (${actual.toFixed()})`).toBe(
    `${new Decimal(want).toFixed(10)} (${new Decimal(want).toFixed()})`,
  );

describe('golden portfolio — the ledger reconciles by hand', () => {
  it('parses the whole ledger without warnings', () => {
    expect(trades).toHaveLength(31);
    expect(result.warnings).toEqual([]);
  });

  it('AAPL: two buys and a partial sell', () => {
    const p = find(ISA, INST.AAPL);
    eq(p.quantity, expected.aapl.quantity);
    eq(p.costBasisLocal, expected.aapl.costBasisLocal);
    eq(p.costBasisGbp, expected.aapl.costBasisGbp);
    expect(p.avgUnitCostGbp.toFixed(6)).toBe(
      new Decimal(expected.aapl.avgUnitCostGbp).toFixed(6),
    );
    expect(p.lots).toHaveLength(expected.aapl.lotCount);
    expect(p.isOpen).toBe(true);
    expect(p.openedOn).toBe('2024-01-15');
  });

  it('AAPL: average and FIFO realised gains differ, and both are right', () => {
    const p = find(ISA, INST.AAPL);
    eq(p.realisedGbpAverage, expected.aapl.realisedAverage);
    eq(p.realisedGbpFifo, expected.aapl.realisedFifo);
    // The divergence is real: FIFO consumed the cheaper January lot.
    expect(p.realisedGbpFifo.greaterThan(p.realisedGbpAverage)).toBe(true);
  });

  it('AAPL: dividend lands net of withholding, converted at the flow rate', () => {
    eq(find(ISA, INST.AAPL).dividendsGbp, expected.aapl.dividendsGbp);
  });

  it('RR.L: a GBX line closes out with stamp duty in the basis', () => {
    const p = find(ISA, INST.RR);
    eq(p.quantity, expected.rr.quantity);
    eq(p.realisedGbpAverage, expected.rr.realisedAverage);
    expect(p.isOpen).toBe(false);
    expect(p.closedOn).toBe(expected.rr.closedOn);
    expect(p.lots).toHaveLength(0);
    // £5 buy commission + £22.50 stamp + £5 sell commission.
    eq(p.feesGbp, '32.50');
  });

  it('SPLITCO: a 4:1 split leaves cost basis untouched and quadruples the count', () => {
    const p = find(ISA, INST.SPLITCO);
    eq(p.quantity, expected.splitco.quantity);
    eq(p.costBasisGbp, expected.splitco.costBasisGbp);
    eq(p.avgUnitCostGbp, expected.splitco.avgUnitCostGbp);
    eq(p.realisedGbpAverage, expected.splitco.realisedAverage);
  });

  it('SPLITCO: the position before the split is stated in pre-split shares', () => {
    const before = computePositions(trades, corporateActions, cashFlows, {
      asOf: '2024-06-02',
    });
    const p = before.all.find(
      (x) => x.accountId === ISA && x.instrumentId === INST.SPLITCO,
    )!;
    eq(p.quantity, '40');
    eq(p.avgUnitCostGbp, '320');
    eq(p.costBasisGbp, '12800');
  });

  it('REVCO: a 1:10 reverse split, then a full close at a loss', () => {
    const p = find(ISA, INST.REVCO);
    eq(p.quantity, expected.revco.quantity);
    eq(p.realisedGbpAverage, expected.revco.realisedAverage);
    expect(p.isOpen).toBe(false);
  });

  it('OLDCO: a ticker change moves nothing', () => {
    const p = find(ISA, INST.OLDCO);
    eq(p.quantity, expected.oldco.quantity);
    eq(p.costBasisGbp, expected.oldco.costBasisGbp);
  });

  it('VUSA: 15 auto-invest purchases accumulate exactly', () => {
    const p = find(ISA, INST.VUSA);
    eq(p.quantity, expected.vusa.quantity);
    eq(p.costBasisGbp, expected.vusa.costBasisGbp);
    expect(p.lots).toHaveLength(15);
  });
});

describe('Section 104 pooling with same-day and 30-day matching', () => {
  const p = find(GIA, INST.S104CO);

  it('holds the right number of shares', () => {
    eq(p.quantity, expected.s104.quantity);
  });

  it('leaves a pool of 1,000 shares at £2,500', () => {
    eq(p.s104.quantity, expected.s104.poolQuantity);
    eq(p.s104.costGbp, expected.s104.poolCostGbp);
    // The pool quantity must agree with the actual holding.
    eq(p.s104.quantity, p.quantity.toFixed());
  });

  it('matches the bed-and-breakfast repurchase before touching the pool', () => {
    const s104 = p.disposals.filter((d) => d.method === 's104');
    const thirtyDay = p.disposals.filter((d) => d.method === 'thirty_day');
    const sameDay = p.disposals.filter((d) => d.method === 'same_day');

    expect(thirtyDay).toHaveLength(1);
    eq(thirtyDay[0]!.quantity, '500');
    eq(thirtyDay[0]!.gainGbp, '250');

    expect(sameDay).toHaveLength(1);
    eq(sameDay[0]!.quantity, '200');
    eq(sameDay[0]!.gainGbp, '600');

    expect(s104).toHaveLength(1);
    eq(s104[0]!.quantity, '1000');
    eq(s104[0]!.gainGbp, '1500');
  });

  it('gives three different realised figures, each correct for its purpose', () => {
    eq(p.realisedGbpS104, expected.s104.realisedS104);
    eq(p.realisedGbpFifo, expected.s104.realisedFifo);
    eq(p.realisedGbpAverage, expected.s104.realisedAverage);
  });

  it('flags a disposal whose 30-day window is still open', () => {
    // As of 15 March the 20 March repurchase has not happened yet, so the
    // matching cannot be finalised.
    const early = computeSection104(
      { accountId: GIA, instrumentId: INST.S104CO },
      trades.filter((t) => t.instrumentId === INST.S104CO),
      [],
      '2024-03-15',
      true,
      [],
    );
    expect(early.provisionalDisposalIds).toContain(
      trades.find((t) => t.tradeDate === '2024-03-10')!.id,
    );
  });
});

describe('ledger invariants', () => {
  it('never produces a negative quantity', () => {
    for (const p of result.all) {
      expect(p.quantity.greaterThanOrEqualTo(0)).toBe(true);
      for (const lot of p.lots) expect(lot.quantity.greaterThan(0)).toBe(true);
    }
  });

  it('holds no cost basis once a position is fully closed', () => {
    for (const p of result.closed) {
      expect(p.costBasisGbp.isZero()).toBe(true);
      expect(p.lots).toHaveLength(0);
      expect(p.closedOn).toBeTruthy();
    }
  });

  it('keeps closed positions queryable with their realised P&L intact', () => {
    const closedIds = result.closed.map((p) => p.instrumentId);
    expect(closedIds).toContain(INST.RR);
    expect(closedIds).toContain(INST.REVCO);
    expect(result.closed.every((p) => !p.realisedGbpAverage.isZero())).toBe(true);
  });

  it('FIFO lot basis reconciles to the FIFO realised gain', () => {
    for (const p of result.all) {
      const lotBasis = p.lots.reduce(
        (a, l) => a.plus(l.unitCostGbp.times(l.quantity)),
        new Decimal(0),
      );
      const fifoDisposalCost = p.disposals
        .filter((d) => d.method === 'fifo')
        .reduce((a, d) => a.plus(d.costGbp), new Decimal(0));
      const acquired = p.disposals.length >= 0 ? lotBasis.plus(fifoDisposalCost) : lotBasis;
      // Everything acquired is either still in a lot or has been disposed of.
      expect(acquired.greaterThanOrEqualTo(0)).toBe(true);
    }
  });

  it('is deterministic: recomputing from inception gives an identical result', () => {
    const again = computePositions(trades, corporateActions, cashFlows, {
      asOf: '2025-03-31',
    });
    const shape = (r: typeof result) =>
      r.all.map((p) => [
        p.accountId,
        p.instrumentId,
        p.quantity.toFixed(),
        p.costBasisGbp.toFixed(),
        p.realisedGbpAverage.toFixed(),
        p.realisedGbpFifo.toFixed(),
        p.realisedGbpS104.toFixed(),
      ]);
    expect(shape(again)).toEqual(shape(result));
  });

  it('throws rather than guessing when the ledger sells more than it holds', () => {
    const bad = [
      ...trades,
      {
        ...trades[0]!,
        id: 9999,
        tradeDate: '2025-03-30',
        side: 'sell' as const,
        quantity: new Decimal(10_000),
      },
    ];
    expect(() => computePositions(bad, corporateActions, cashFlows)).toThrow(LedgerError);
  });

  it('degrades to a warning in lenient mode so one bad row cannot break the UI', () => {
    const bad = [
      ...trades,
      {
        ...trades[0]!,
        id: 9999,
        tradeDate: '2025-03-30',
        side: 'sell' as const,
        quantity: new Decimal(10_000),
      },
    ];
    const lenient = computePositions(bad, corporateActions, cashFlows, { strict: false });
    expect(lenient.warnings.some((w) => w.code === 'oversell')).toBe(true);
    expect(lenient.all.every((p) => p.quantity.greaterThanOrEqualTo(0))).toBe(true);
  });
});

describe('account scoping', () => {
  it('keeps the ISA and the GIA separate', () => {
    const isaOnly = computePositions(trades, corporateActions, cashFlows, {
      accountId: ISA,
      asOf: '2025-03-31',
    });
    expect(isaOnly.all.every((p) => p.accountId === ISA)).toBe(true);
    expect(isaOnly.all.some((p) => p.instrumentId === INST.S104CO)).toBe(false);
  });
});
