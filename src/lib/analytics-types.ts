/**
 * Shapes of the `analytics_snapshots` payloads the pages read.
 *
 * Written by `analytics/risk.py` and friends; these types mirror them so a
 * renamed key in Python fails typecheck here rather than rendering "—".
 */
import type { WindowKey } from './engine/windows';

export interface Regression {
  alpha_annualised: number;
  alpha_stderr_annualised: number;
  alpha_tstat: number;
  alpha_ci95_low: number;
  alpha_ci95_high: number;
  beta: number;
  beta_stderr: number;
  beta_ci95_low: number;
  beta_ci95_high: number;
  r_squared: number;
  observations: number;
}

export interface SeriesPayload {
  dates: string[];
  values: Array<number | null>;
  latest: number | null;
}

export interface DrawdownPayload {
  depth: number | null;
  peak_date: string | null;
  trough_date: string | null;
  recovered_date: string | null;
  recovery_days: number | null;
  underwater_days: number | null;
}

export interface DescriptiveStats {
  annualised_return: number | null;
  annualised_volatility: number | null;
  sharpe: number | null;
  sortino: number | null;
  max_drawdown: DrawdownPayload;
}

export interface BenchmarkStats {
  regression: Regression | null;
  tracking_error: number | null;
  information_ratio: number | null;
  capture: { up_capture: number | null; down_capture: number | null; up_months: number; down_months: number };
  benchmark_annualised_return?: number | null;
  benchmark_annualised_volatility?: number | null;
  rolling_beta_63d?: SeriesPayload | null;
  rolling_beta_126d?: SeriesPayload | null;
}

export interface WindowBenchmarkStats {
  regression: Regression | null;
  regression_note: string | null;
  tracking_error: number | null;
  information_ratio: number | null;
  benchmark_cumulative_return: number | null;
}

export type WindowStats =
  | { status: 'insufficient'; observations: number }
  | (DescriptiveStats & {
      status: 'ok';
      observations: number;
      from: string;
      to: string;
      cumulative_return: number;
      benchmarks: Record<string, WindowBenchmarkStats>;
    });

export interface RiskPayload {
  observations: number;
  since_inception: DescriptiveStats & {
    calmar: number | null;
    skew: number | null;
    excess_kurtosis: number | null;
    positive_days_pct: number | null;
    worst_day: number | null;
    best_day: number | null;
  };
  rolling: Record<string, SeriesPayload | null>;
  rolling_windows?: number[];
  /** Absent on payloads written before trailing windows existed. */
  windows?: Partial<Record<WindowKey, WindowStats>>;
  benchmarks: Record<string, BenchmarkStats>;
}

export interface VarPayload {
  status: string;
  message?: string;
  observations?: number;
  primary?: { var_95_1d_gbp: number; cvar_95_1d_gbp: number };
  methods?: Record<
    string,
    Record<
      string,
      {
        var: Record<string, { fraction: number; gbp: number }>;
        cvar: Record<string, { fraction: number; gbp: number }>;
      }
    >
  >;
  component?: {
    status: string;
    positions?: Array<{
      instrument_id: number;
      weight: number;
      component_var_gbp: number;
      share_of_var: number | null;
      standalone_vol_annualised: number;
    }>;
    diversification_benefit?: number | null;
  };
}

/** The benchmark key the Python job writes for the GBP-translated S&P 500 (§3.3). */
export const SPX_GBP = 'SPX_gbp';
export const SPX_LOCAL = 'SPX_local';

/** The regression for a window, or since-inception when the window has none. */
export function windowRegression(
  risk: RiskPayload | null | undefined,
  window: WindowKey,
  benchmark = SPX_GBP,
): { regression: Regression; scope: 'window' | 'inception'; note: string | null } | null {
  const w = risk?.windows?.[window];
  if (w && w.status === 'ok') {
    const b = w.benchmarks[benchmark];
    if (b?.regression) return { regression: b.regression, scope: 'window', note: null };
    const fallback = risk?.benchmarks?.[benchmark]?.regression;
    if (fallback) return { regression: fallback, scope: 'inception', note: b?.regression_note ?? null };
    return null;
  }
  const fallback = risk?.benchmarks?.[benchmark]?.regression;
  return fallback ? { regression: fallback, scope: 'inception', note: null } : null;
}
