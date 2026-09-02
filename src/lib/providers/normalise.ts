/**
 * The ingestion boundary (CLAUDE.md §3.1).
 *
 * Yahoo returns LSE-listed instruments in GBX — pence. A close of 2450.0 for a
 * UK stock means £24.50. This is the single most common bug in UK portfolio
 * software, and the defence is structural: every raw price crosses this
 * boundary exactly once, gets multiplied by the instrument's `quoteMultiplier`,
 * and nothing downstream ever sees pence again.
 *
 * The multiplier is stored per instrument, not inferred from the `.L` suffix.
 * Many LSE-listed ETFs quote in GBP or USD on the same exchange as GBX-quoted
 * ordinary shares, so the suffix tells you nothing. `sanityCheckMultiplier`
 * exists to catch a mis-set flag on first ingest, before it silently
 * multiplies a portfolio by a hundred.
 */
import { Decimal, dec } from '../decimal';
import type { EngineInstrument } from '../types';
import type { Bar, RawBar } from './types';

export function applyMultiplier(raw: number, inst: EngineInstrument): Decimal {
  return dec(raw).times(inst.quoteMultiplier);
}

export function normaliseBar(raw: RawBar, inst: EngineInstrument, provider: string): Bar {
  const m = inst.quoteMultiplier;
  const conv = (v: number | null) => (v === null || v === undefined ? null : dec(v).times(m));
  return {
    date: raw.date,
    open: conv(raw.open),
    high: conv(raw.high),
    low: conv(raw.low),
    close: dec(raw.close).times(m),
    adjClose: conv(raw.adjClose),
    // Volume is a share count, not a price. It is never multiplied.
    volume: raw.volume,
    provider,
  };
}

/** Reverse the boundary — used only when displaying a provider's native value. */
export function toRawQuote(price: Decimal, inst: EngineInstrument): Decimal {
  if (inst.quoteMultiplier.isZero()) return price;
  return price.div(inst.quoteMultiplier);
}

export interface MultiplierCheck {
  ok: boolean;
  reason: string;
  suggestedMultiplier: number | null;
}

/**
 * Sanity-check a newly configured instrument against a known reference price.
 *
 * A GBX line mistakenly flagged as GBP is out by exactly 100, which is a wide
 * enough gap to detect without ambiguity. Anything within 20% of the reference
 * passes; a factor near 100 or 0.01 is reported with the fix.
 */
export function sanityCheckMultiplier(
  normalisedPrice: Decimal,
  referencePrice: Decimal,
  inst: EngineInstrument,
): MultiplierCheck {
  if (referencePrice.isZero() || normalisedPrice.isZero()) {
    return { ok: false, reason: 'zero price — cannot verify', suggestedMultiplier: null };
  }
  const ratio = normalisedPrice.div(referencePrice).toNumber();

  if (ratio > 0.8 && ratio < 1.2) {
    return { ok: true, reason: 'within 20% of the reference', suggestedMultiplier: null };
  }
  if (ratio > 50 && ratio < 200) {
    return {
      ok: false,
      reason: `price is ~${ratio.toFixed(0)}x the reference — this looks like a GBX line stored as GBP`,
      suggestedMultiplier: inst.quoteMultiplier.times('0.01').toNumber(),
    };
  }
  if (ratio > 0.005 && ratio < 0.02) {
    return {
      ok: false,
      reason: `price is ~1/${(1 / ratio).toFixed(0)} of the reference — the multiplier is applied twice, or the line is GBP not GBX`,
      suggestedMultiplier: inst.quoteMultiplier.times(100).toNumber(),
    };
  }
  return {
    ok: false,
    reason: `price is ${ratio.toFixed(3)}x the reference — unexplained`,
    suggestedMultiplier: null,
  };
}

/**
 * A first-pass guess for a new LSE instrument, used to pre-fill the instrument
 * form. It is a hint for a human to confirm, never an automatic decision:
 * getting this wrong is a 100x error in the portfolio value.
 */
export function guessQuoteConvention(
  exchangeMic: string | null,
  observedPrice: number,
): { quoteCurrency: string; quoteMultiplier: number; confident: boolean } {
  if (exchangeMic !== 'XLON') {
    return { quoteCurrency: 'USD', quoteMultiplier: 1, confident: exchangeMic !== null };
  }
  // LSE ordinary shares quote in pence and are almost always in the hundreds or
  // thousands. A three-figure "price" for a UK line is pence far more often
  // than it is a £900 share.
  if (observedPrice >= 100) {
    return { quoteCurrency: 'GBP', quoteMultiplier: 0.01, confident: false };
  }
  return { quoteCurrency: 'GBP', quoteMultiplier: 1, confident: false };
}
