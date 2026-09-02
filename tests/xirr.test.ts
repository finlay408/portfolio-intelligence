/**
 * XIRR convergence, including the pathological flow sequences (CLAUDE.md §11).
 */
import { describe, expect, it } from 'vitest';
import { portfolioMwr, xirr } from '../src/lib/engine/xirr';

describe('xirr on well-behaved series', () => {
  it('solves a single-period doubling', () => {
    const r = xirr([
      { date: '2024-01-01', amount: -1000 },
      { date: '2025-01-01', amount: 2000 },
    ]);
    // 366 days in 2024, so slightly under 100%.
    expect(r).toBeCloseTo(Math.pow(2, 365 / 366) - 1, 6);
  });

  it('solves a flat return as zero', () => {
    const r = xirr([
      { date: '2024-01-01', amount: -1000 },
      { date: '2025-06-01', amount: 1000 },
    ]);
    expect(r).toBeCloseTo(0, 9);
  });

  it('handles monthly auto-invest contributions', () => {
    const flows = Array.from({ length: 24 }, (_, i) => ({
      date: `20${24 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-05`,
      amount: -500,
    }));
    flows.push({ date: '2026-01-05', amount: 13_500 });
    const r = xirr(flows);
    expect(r).not.toBeNull();
    // £12,000 in, £13,500 out over two years of drip-feeding: the
    // money-weighted return is well above the naive 12.5% total.
    expect(r!).toBeGreaterThan(0.1);
    expect(r!).toBeLessThan(0.3);
  });
});

describe('xirr on pathological series', () => {
  it('returns null when every flow has the same sign', () => {
    expect(
      xirr([
        { date: '2024-01-01', amount: -1000 },
        { date: '2024-06-01', amount: -1000 },
      ]),
    ).toBeNull();
  });

  it('returns null for a single flow', () => {
    expect(xirr([{ date: '2024-01-01', amount: -1000 }])).toBeNull();
  });

  it('converges on a near-total loss, where Newton diverges', () => {
    const r = xirr([
      { date: '2024-01-01', amount: -10_000 },
      { date: '2024-12-31', amount: 1 },
    ]);
    expect(r).not.toBeNull();
    expect(r!).toBeLessThan(-0.99);
    expect(Number.isFinite(r!)).toBe(true);
  });

  it('converges on a large deposit made days before the end', () => {
    // The classic Newton-Raphson breaker: almost all the capital arrives at the
    // very end, so the derivative near the root is enormous.
    const r = xirr([
      { date: '2024-01-01', amount: -100 },
      { date: '2024-12-20', amount: -1_000_000 },
      { date: '2024-12-31', amount: 1_010_000 },
    ]);
    expect(r).not.toBeNull();
    expect(Number.isFinite(r!)).toBe(true);
  });

  it('converges on alternating flows', () => {
    const r = xirr([
      { date: '2024-01-01', amount: -5000 },
      { date: '2024-03-01', amount: 3000 },
      { date: '2024-05-01', amount: -4000 },
      { date: '2024-08-01', amount: 2500 },
      { date: '2024-11-01', amount: -1000 },
      { date: '2025-01-01', amount: 5200 },
    ]);
    expect(r).not.toBeNull();
    expect(Number.isFinite(r!)).toBe(true);
  });

  it('handles flows that all fall on the same day', () => {
    expect(
      xirr([
        { date: '2024-01-01', amount: -1000 },
        { date: '2024-01-01', amount: 1100 },
      ]),
    ).toBeNull(); // zero elapsed time: no rate is defined
  });

  it('ignores zero-value flows rather than dividing by them', () => {
    const withZeros = xirr([
      { date: '2024-01-01', amount: -1000 },
      { date: '2024-06-01', amount: 0 },
      { date: '2025-01-01', amount: 1100 },
    ]);
    const without = xirr([
      { date: '2024-01-01', amount: -1000 },
      { date: '2025-01-01', amount: 1100 },
    ]);
    expect(withZeros).toBeCloseTo(without!, 9);
  });
});

describe('portfolioMwr sign convention', () => {
  it('treats deposits as money out of pocket', () => {
    const r = portfolioMwr(
      [
        { date: '2024-01-01', depositGbp: 20_000 },
        { date: '2024-04-01', depositGbp: 5_000 },
      ],
      { date: '2025-01-01', valueGbp: 27_500 },
    );
    expect(r).not.toBeNull();
    // £25,000 contributed, £27,500 at the end — a positive return, and one
    // larger than 10% because the second £5,000 was only invested for 9 months.
    expect(r!).toBeGreaterThan(0.1);
  });

  it('reports a loss as negative', () => {
    const r = portfolioMwr(
      [{ date: '2024-01-01', depositGbp: 10_000 }],
      { date: '2025-01-01', valueGbp: 9_000 },
    );
    expect(r!).toBeLessThan(0);
  });
});
