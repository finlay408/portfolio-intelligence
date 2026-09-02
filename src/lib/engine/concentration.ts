/**
 * Concentration and diversification (CLAUDE.md §7.8).
 *
 * Weight tables answer "how much do I own". The correlation work answers the
 * question that matters: ten positions across five sectors that all load on the
 * same factor are one bet, and only the correlation structure shows it.
 *
 * Weights use exact decimals. Correlations operate on daily returns — small
 * ratios where float error is irrelevant — so they use `number`.
 */
import { Decimal, ONE, ZERO, divOrZero } from '../decimal';

export interface WeightRow {
  key: string;
  label: string;
  weight: Decimal; // 0..1
  valueGbp: Decimal;
}

export interface ConcentrationSummary {
  rows: WeightRow[];
  /** Σ w². 1 = a single position, 1/n = perfectly equal weights. */
  hhi: Decimal;
  /**
   * 1 / HHI — the effective number of independent positions. A 20-stock
   * portfolio with an effective N of 6 is not diversified, and this is the
   * number that says so out loud.
   */
  effectiveN: Decimal | null;
  top1: Decimal;
  top5: Decimal;
  top10: Decimal;
  count: number;
}

export function summariseWeights(rows: WeightRow[]): ConcentrationSummary {
  const sorted = [...rows].sort((a, b) => b.weight.comparedTo(a.weight));
  const hhi = sorted.reduce<Decimal>((a, r) => a.plus(r.weight.times(r.weight)), ZERO);
  const cum = (n: number) =>
    sorted.slice(0, n).reduce<Decimal>((a, r) => a.plus(r.weight), ZERO);

  return {
    rows: sorted,
    hhi,
    effectiveN: hhi.isZero() ? null : ONE.div(hhi),
    top1: cum(1),
    top5: cum(5),
    top10: cum(10),
    count: sorted.length,
  };
}

/** Roll a set of instrument weights up into a grouped weight table. */
export function groupWeights(
  positions: Array<{ instrumentId: number; valueGbp: Decimal }>,
  grouper: (instrumentId: number) => Array<{ key: string; weight: Decimal }>,
  label: (key: string) => string = (k) => k,
): ConcentrationSummary {
  const totals = new Map<string, Decimal>();
  let total = ZERO;
  for (const p of positions) {
    total = total.plus(p.valueGbp);
    for (const b of grouper(p.instrumentId)) {
      totals.set(b.key, (totals.get(b.key) ?? ZERO).plus(p.valueGbp.times(b.weight)));
    }
  }
  const rows: WeightRow[] = [...totals.entries()].map(([key, valueGbp]) => ({
    key,
    label: label(key),
    valueGbp,
    weight: divOrZero(valueGbp, total),
  }));
  return summariseWeights(rows);
}

/* ---------------- Correlation structure ---------------- */

export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return Number.NaN;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i]!;
    sb += b[i]!;
  }
  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? Number.NaN : num / den;
}

export interface CorrelationMatrix {
  keys: string[];
  /** matrix[i][j], symmetric, 1 on the diagonal. */
  matrix: number[][];
}

/** Series must be aligned on the same dates before being passed in. */
export function correlationMatrix(series: Map<string, number[]>): CorrelationMatrix {
  const keys = [...series.keys()];
  const matrix = keys.map((ki) =>
    keys.map((kj) => (ki === kj ? 1 : pearson(series.get(ki)!, series.get(kj)!))),
  );
  return { keys, matrix };
}

/**
 * Average-linkage agglomerative clustering on distance = 1 - correlation.
 * The output is a leaf ordering: rendering the matrix in this order makes
 * blocks of mutually correlated holdings visible as squares on the diagonal.
 */
export function clusterOrder(cm: CorrelationMatrix): { order: number[]; merges: Array<[number, number, number]> } {
  const n = cm.keys.length;
  if (n === 0) return { order: [], merges: [] };

  const clusters: number[][] = Array.from({ length: n }, (_, i) => [i]);
  const alive = new Set<number>(clusters.map((_, i) => i));
  const merges: Array<[number, number, number]> = [];

  const distance = (a: number[], b: number[]): number => {
    let acc = 0;
    let count = 0;
    for (const i of a) {
      for (const j of b) {
        const c = cm.matrix[i]?.[j];
        if (c === undefined || Number.isNaN(c)) continue;
        acc += 1 - c;
        count++;
      }
    }
    return count === 0 ? 2 : acc / count;
  };

  while (alive.size > 1) {
    let best: [number, number, number] = [-1, -1, Number.POSITIVE_INFINITY];
    const ids = [...alive];
    for (let x = 0; x < ids.length; x++) {
      for (let y = x + 1; y < ids.length; y++) {
        const d = distance(clusters[ids[x]!]!, clusters[ids[y]!]!);
        if (d < best[2]) best = [ids[x]!, ids[y]!, d];
      }
    }
    if (best[0] < 0) break;
    merges.push(best);
    clusters[best[0]] = [...clusters[best[0]]!, ...clusters[best[1]]!];
    alive.delete(best[1]);
  }

  const root = [...alive][0];
  return { order: root === undefined ? [] : clusters[root]!, merges };
}

/**
 * Rolling average pairwise correlation. It rises in stress — the moment
 * diversification stops working is exactly the moment you need to see it.
 */
export function rollingAveragePairwiseCorrelation(
  series: Map<string, number[]>,
  window: number,
): Array<number | null> {
  const keys = [...series.keys()];
  const length = Math.max(0, ...keys.map((k) => series.get(k)!.length));
  const out: Array<number | null> = [];

  for (let end = 0; end < length; end++) {
    if (end + 1 < window || keys.length < 2) {
      out.push(null);
      continue;
    }
    const slice = new Map<string, number[]>();
    for (const k of keys) slice.set(k, series.get(k)!.slice(end + 1 - window, end + 1));
    let acc = 0;
    let count = 0;
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const c = pearson(slice.get(keys[i]!)!, slice.get(keys[j]!)!);
        if (!Number.isNaN(c)) {
          acc += c;
          count++;
        }
      }
    }
    out.push(count === 0 ? null : acc / count);
  }
  return out;
}
