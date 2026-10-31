/**
 * Presentation rules for market context, shared by the overview and the
 * Markets page so the same series reads the same way on both.
 */

export interface MacroSpec {
  id: string;
  label: string;
  unit: string;
  decimals: number;
  /**
   * Colours a move by what it does to this portfolio rather than by its sign:
   * a rising VIX or 10-year yield is a headwind for equities, and a stronger
   * pound shrinks every dollar holding. Null when neither direction is
   * clearly good or bad.
   */
  upIsBad: boolean | null;
}

export const MACRO_SERIES: MacroSpec[] = [
  { id: 'VIXCLS', label: 'VIX', unit: '', decimals: 1, upIsBad: true },
  { id: 'DGS10', label: 'US 10-year', unit: '%', decimals: 2, upIsBad: true },
  { id: 'DEXUSUK', label: 'GBP/USD', unit: '', decimals: 3, upIsBad: true },
  { id: 'IUDSOIA', label: 'SONIA', unit: '%', decimals: 2, upIsBad: null },
  { id: 'T10Y2Y', label: '10y − 2y', unit: '%', decimals: 2, upIsBad: null },
  { id: 'CPIAUCSL', label: 'US CPI', unit: '', decimals: 1, upIsBad: true },
];

/** The four the overview shows. */
export const MACRO_HEADLINE = MACRO_SERIES.slice(0, 4);

/** A change too small to show at the series' precision is no change. */
export function visibleChange(spec: MacroSpec, change: number | null): number | null {
  return change !== null && Math.abs(change) >= 0.5 * 10 ** -spec.decimals ? change : null;
}

/** Tailwind text colour for a macro move, by its effect on the portfolio. */
export function macroTone(spec: MacroSpec, change: number | null): string {
  if (change === null || spec.upIsBad === null) return 'text-muted';
  return change > 0 === spec.upIsBad ? 'text-down' : 'text-up';
}

export type Quadrant = 'leading' | 'weakening' | 'lagging' | 'improving';

export const QUADRANTS: Array<{ key: Quadrant; label: string; tone: string; fill: string }> = [
  { key: 'leading', label: 'Leading', tone: 'text-up', fill: 'bg-up/10' },
  { key: 'weakening', label: 'Weakening', tone: 'text-warn', fill: 'bg-warn/10' },
  { key: 'lagging', label: 'Lagging', tone: 'text-down', fill: 'bg-down/10' },
  { key: 'improving', label: 'Improving', tone: 'text-accent', fill: 'bg-accent/10' },
];

/** Which quadrant a single RRG point sits in; 100/100 is the crosshair. */
export function quadrantOf(p: { rs_ratio: number; rs_momentum: number }): Quadrant {
  if (p.rs_ratio >= 100) return p.rs_momentum >= 100 ? 'leading' : 'weakening';
  return p.rs_momentum >= 100 ? 'improving' : 'lagging';
}

/** Holdings whose quadrant changed between the last two weekly points. */
export function quadrantMoves(series: Array<{ label: string; tail: Array<{ rs_ratio: number; rs_momentum: number }> }>) {
  return series
    .filter((s) => s.tail.length > 1)
    .map((s) => ({ label: s.label, before: quadrantOf(s.tail.at(-2)!), now: quadrantOf(s.tail.at(-1)!) }))
    .filter((m) => m.before !== m.now);
}
