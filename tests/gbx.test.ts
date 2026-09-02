/**
 * GBX conversion, both directions (CLAUDE.md §11).
 *
 * "A price of 2450.0 for a UK stock means £24.50." That sentence is the whole
 * test, and it is the single most common bug in UK portfolio software.
 */
import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/lib/decimal';
import {
  applyMultiplier,
  guessQuoteConvention,
  normaliseBar,
  sanityCheckMultiplier,
  toRawQuote,
} from '../src/lib/providers/normalise';
import type { EngineInstrument } from '../src/lib/types';

const gbxLine: EngineInstrument = {
  id: 1,
  symbol: 'RR.L',
  name: 'Rolls-Royce Holdings plc',
  assetClass: 'equity',
  exchangeMic: 'XLON',
  quoteCurrency: 'GBP',
  quoteMultiplier: new Decimal('0.01'),
  country: 'GB',
  revenueRegions: null,
  sector: 'Industrials',
  industry: 'Aerospace & Defence',
};

// Many LSE-listed ETFs quote in GBP on the same exchange. The suffix tells you
// nothing; the instrument row does.
const gbpLine: EngineInstrument = {
  ...gbxLine,
  id: 2,
  symbol: 'VUSA.L',
  name: 'Vanguard S&P 500 UCITS ETF',
  assetClass: 'etf',
  quoteMultiplier: new Decimal(1),
};

describe('GBX normalisation at the ingestion boundary', () => {
  it('converts a known LSE close from pence to pounds', () => {
    expect(applyMultiplier(2450.0, gbxLine).toFixed()).toBe('24.5');
  });

  it('leaves a GBP-quoted LSE line alone', () => {
    expect(applyMultiplier(2450.0, gbpLine).toFixed()).toBe('2450');
  });

  it('round-trips back to the provider value', () => {
    const normalised = applyMultiplier(2450.0, gbxLine);
    expect(toRawQuote(normalised, gbxLine).toFixed()).toBe('2450');
  });

  it('converts every price field of a bar but never the volume', () => {
    const bar = normaliseBar(
      {
        date: '2025-06-02',
        open: 2400,
        high: 2475.5,
        low: 2390,
        close: 2450,
        adjClose: 2445,
        volume: 12_345_678,
      },
      gbxLine,
      'yahoo',
    );
    expect(bar.open!.toFixed()).toBe('24');
    expect(bar.high!.toFixed()).toBe('24.755');
    expect(bar.low!.toFixed()).toBe('23.9');
    expect(bar.close.toFixed()).toBe('24.5');
    expect(bar.adjClose!.toFixed()).toBe('24.45');
    expect(bar.volume).toBe(12_345_678);
  });

  it('is exact for a price that binary floating point cannot represent', () => {
    // 0.1 + 0.2 territory: 1234.56 pence must be exactly £12.3456.
    expect(applyMultiplier(1234.56, gbxLine).toFixed()).toBe('12.3456');
    expect(applyMultiplier(1234.56, gbxLine).equals(new Decimal('12.3456'))).toBe(true);
  });
});

describe('multiplier sanity check on first ingest', () => {
  it('accepts a correctly configured line', () => {
    const check = sanityCheckMultiplier(
      new Decimal('24.50'),
      new Decimal('24.55'), // reference from a second source
      gbxLine,
    );
    expect(check.ok).toBe(true);
  });

  it('catches a GBX line stored as GBP and names the fix', () => {
    const wrong: EngineInstrument = { ...gbxLine, quoteMultiplier: new Decimal(1) };
    const check = sanityCheckMultiplier(new Decimal('2450'), new Decimal('24.50'), wrong);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('GBX line stored as GBP');
    expect(check.suggestedMultiplier).toBeCloseTo(0.01, 10);
  });

  it('catches a multiplier applied twice', () => {
    const check = sanityCheckMultiplier(new Decimal('0.245'), new Decimal('24.50'), gbxLine);
    expect(check.ok).toBe(false);
    expect(check.suggestedMultiplier).toBeCloseTo(1, 10);
  });
});

describe('quote convention guessing is a hint, never a decision', () => {
  it('never claims confidence about an LSE line', () => {
    expect(guessQuoteConvention('XLON', 2450).confident).toBe(false);
    expect(guessQuoteConvention('XLON', 45).confident).toBe(false);
  });

  it('suggests pence for a three-figure LSE price', () => {
    expect(guessQuoteConvention('XLON', 2450).quoteMultiplier).toBe(0.01);
  });

  it('leaves US listings at 1', () => {
    expect(guessQuoteConvention('XNAS', 195).quoteMultiplier).toBe(1);
  });
});
