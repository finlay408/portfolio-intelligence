/**
 * Concentration and correlation (CLAUDE.md §7.8).
 *
 * The weight tables answer "how much do I own". The correlation heatmap,
 * ordered by cluster rather than alphabetically, answers the question that
 * matters: ten positions across five sectors that all load on the same factor
 * are one bet.
 */
import {
  Badge,
  Card,
  Empty,
  Insufficient,
  Note,
  Stat,
  Table,
  Td,
  Th,
  Tr,
  WeightBar,
} from '@/components/ui/primitives';
import { percent, money, number as fmtNumber } from '@/lib/format';
import { getAnalytics, getOverview } from '@/lib/portfolio';
import type { ConcentrationSummary } from '@/lib/engine/concentration';

export const dynamic = 'force-dynamic';

interface StructurePayload {
  concentration: { hhi: number | null; effective_n: number | null };
  correlation: {
    instruments: string[];
    cluster_order: string[];
    matrix: Array<Array<number | null>>;
    average_pairwise: number | null;
  };
  rolling_correlation: { status: string; latest?: number | null; window?: number };
  pca: {
    status: string;
    explained_variance_ratio?: number[];
    cumulative_explained?: number[];
    interpretation?: string;
  };
}

export default async function ExposurePage() {
  const [overview, structure] = await Promise.all([
    getOverview(),
    getAnalytics<StructurePayload>('structure'),
  ]);

  const c = overview.concentration;
  const symbolOf = (id: string) =>
    overview.holdings.find((h) => String(h.position.instrumentId) === id)?.symbol ?? `#${id}`;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3 xl:grid-cols-6">
        {[
          <Stat key="n" label="Positions" value={String(c.count)} />,
          <Stat
            key="eff"
            label="Effective N"
            value={c.effectiveN ? c.effectiveN.toFixed(1) : '—'}
            tone={c.effectiveN && c.effectiveN.lessThan(6) ? 'warn' : 'neutral'}
            sub="1 / HHI"
            hint="The number of equally weighted independent positions this portfolio behaves like. Much lower than the position count means concentration."
          />,
          <Stat key="hhi" label="HHI" value={c.hhi.toFixed(4)} sub="sum of squared weights" />,
          <Stat key="t1" label="Top 1" value={percent(c.top1, 1)} />,
          <Stat key="t5" label="Top 5" value={percent(c.top5, 1)} />,
          <Stat key="t10" label="Top 10" value={percent(c.top10, 1)} />,
        ].map((node, i) => (
          <div key={i} className="bg-surface">
            {node}
          </div>
        ))}
      </div>

      {c.effectiveN && c.effectiveN.lessThan(6) && (
        <Note>
          An effective N of {c.effectiveN.toFixed(1)} across {c.count} positions means this
          portfolio behaves like roughly {Math.round(c.effectiveN.toNumber())} equally weighted
          holdings. Position count is not diversification.
        </Note>
      )}

      <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
        <WeightTable title="By position" summary={c} />
        <WeightTable title="By sector" summary={overview.bySector} />
        <WeightTable title="By theme" summary={overview.byTheme} />
        <WeightTable
          title="By revenue geography"
          subtitle="where revenue is actually earned"
          summary={overview.byRevenueGeography}
        />
        <WeightTable
          title="By listing country"
          subtitle="the venue — nearly useless as a risk measure"
          summary={overview.byListingCountry}
        />
        <WeightTable title="By currency" summary={overview.byCurrency} />
      </div>

      <Note>
        Listing country and revenue geography are shown separately on purpose. An LSE-listed miner
        with 90% Chilean revenue is not UK exposure, and only the revenue view says so.
      </Note>

      {/* ---- correlation ---- */}
      <Card
        title="Correlation structure"
        subtitle="ordered by hierarchical cluster, not alphabetically"
        footnote={
          structure
            ? `Average pairwise correlation ${fmtNumber(structure.payload.correlation.average_pairwise, 2)}. Rolling ${structure.payload.rolling_correlation.window ?? 63}-day average: ${fmtNumber(structure.payload.rolling_correlation.latest ?? null, 2)}. Rising average correlation means diversification is failing.`
            : undefined
        }
      >
        {!structure || structure.payload.correlation.instruments.length < 2 ? (
          <Insufficient reason="Needs at least two holdings with 60 overlapping daily observations, computed by the nightly job." />
        ) : (
          <CorrelationHeatmap payload={structure.payload} symbolOf={symbolOf} />
        )}
      </Card>

      {/* ---- PCA ---- */}
      <Card
        title="Principal components"
        subtitle="how many independent bets are actually in here"
        footnote={structure?.payload.pca.interpretation}
      >
        {!structure || structure.payload.pca.status !== 'ok' ? (
          <Insufficient reason="Needs at least three holdings with a full year of overlapping history." />
        ) : (
          <div className="space-y-2 px-4 py-3">
            {structure.payload.pca.explained_variance_ratio!.map((v, i) => (
              <div key={i} className="grid grid-cols-[3rem_1fr_5rem] items-center gap-3">
                <span className="text-[12px] text-muted">PC{i + 1}</span>
                <WeightBar value={v} tone={i === 0 && v > 0.5 ? 'down' : 'accent'} />
                <span className="tabular text-right text-[12px]">
                  {percent(v, 1)}
                  <span className="ml-1 text-[10px] text-muted">
                    ({percent(structure.payload.pca.cumulative_explained![i], 0)} cum.)
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function WeightTable({
  title,
  subtitle,
  summary,
}: {
  title: string;
  subtitle?: string;
  summary: ConcentrationSummary;
}) {
  return (
    <Card
      title={title}
      subtitle={subtitle}
      action={summary.effectiveN ? `eff. N ${summary.effectiveN.toFixed(1)}` : undefined}
    >
      {summary.rows.length === 0 ? (
        <Empty>No holdings.</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Bucket</Th>
              <Th align="right">Value</Th>
              <Th align="right">Weight</Th>
              <Th className="w-24" />
            </tr>
          </thead>
          <tbody>
            {summary.rows.map((r) => (
              <Tr key={r.key}>
                <Td>{r.label}</Td>
                <Td align="right" numeric>
                  {money(r.valueGbp)}
                </Td>
                <Td align="right" numeric>
                  {percent(r.weight, 1)}
                </Td>
                <Td>
                  <WeightBar value={r.weight.toNumber()} />
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function CorrelationHeatmap({
  payload,
  symbolOf,
}: {
  payload: StructurePayload;
  symbolOf: (id: string) => string;
}) {
  const { instruments, cluster_order, matrix } = payload.correlation;
  const indexOf = new Map(instruments.map((id, i) => [id, i]));
  const order = cluster_order.filter((id) => indexOf.has(id));

  return (
    <div className="overflow-x-auto px-4 py-3">
      <table className="border-separate border-spacing-0.5">
        <thead>
          <tr>
            <th />
            {order.map((id) => (
              <th
                key={id}
                className="h-16 w-7 align-bottom text-[10px] text-muted"
                style={{ writingMode: 'vertical-rl' }}
              >
                {symbolOf(id)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {order.map((rowId) => (
            <tr key={rowId}>
              <th className="pr-2 text-right text-[10px] font-normal text-muted">
                {symbolOf(rowId)}
              </th>
              {order.map((colId) => {
                const value = matrix[indexOf.get(rowId)!]?.[indexOf.get(colId)!] ?? null;
                return (
                  <td
                    key={colId}
                    title={`${symbolOf(rowId)} / ${symbolOf(colId)}: ${value === null ? 'n/a' : value.toFixed(2)}`}
                    className="h-7 w-7 rounded-[2px] text-center text-[9px]"
                    style={{
                      backgroundColor:
                        value === null
                          ? 'transparent'
                          : `color-mix(in oklch, var(--color-${value >= 0 ? 'down' : 'up'}) ${Math.round(Math.abs(value) * 55)}%, transparent)`,
                    }}
                  >
                    {value === null ? '' : value.toFixed(1).replace('0.', '.')}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] leading-relaxed text-muted">
        Blocks on the diagonal are clusters of holdings that move together. Darker means more
        correlated — the colour here marks concentration risk, not direction, which is why high
        correlation is shaded the same way a loss is.
      </p>
    </div>
  );
}
