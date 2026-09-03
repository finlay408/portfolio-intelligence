/**
 * Attribution grids (CLAUDE.md §7.3).
 *
 * Each grid reconciles to the total portfolio return. The reconciliation gap is
 * printed rather than hidden — a grid that does not add up is a broken grid,
 * and the only way to know is to show the residual.
 *
 * The grids honour the same trailing window as the overview, so "what drove
 * the last quarter" and "what drove everything" are one page apart, not two
 * different tools.
 */
import { Card, Empty, Note, Table, Td, Th, Tr } from '@/components/ui/primitives';
import { CalendarBarChart } from '@/components/calendar-bar-chart';
import { Contributors } from '@/components/contributors';
import { WindowPicker } from '@/components/window-picker';
import { Decimal, ZERO } from '@/lib/decimal';
import { monthKey, quarterKey } from '@/lib/dates';
import { directionClass, money, percent, shortDate } from '@/lib/format';
import { RESIDUAL_KEY, rankContributors, type AttributionResult } from '@/lib/engine/attribution';
import {
  parseWindow,
  periodReturnsFromLevels,
  summariseWindow,
  windowSpec,
} from '@/lib/engine/windows';
import { getAttribution, getMarketContext, getOverview } from '@/lib/portfolio';

export const dynamic = 'force-dynamic';

const GRID_LABELS: Record<string, { title: string; subtitle?: string }> = {
  position: { title: 'By position' },
  theme: { title: 'By theme', subtitle: 'honouring partial membership weights' },
  sector: { title: 'By sector', subtitle: 'funds looked through to their holdings' },
  revenueGeography: {
    title: 'By revenue geography',
    subtitle: 'where the money is actually earned',
  },
  listingCountry: { title: 'By listing country', subtitle: 'the venue, not the exposure' },
  currency: { title: 'By currency' },
  assetClass: { title: 'By asset class' },
};

export default async function AttributionPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string | string[] }>;
}) {
  const window = parseWindow((await searchParams).window);
  const spec = windowSpec(window);

  const [overview, market] = await Promise.all([getOverview(), getMarketContext('SPX')]);
  const inputs = { benchmarks: market.benchmark?.levels ?? {}, riskFreeDaily: market.riskFreeDaily };
  const summary = summariseWindow(overview.twr.series, window, inputs);
  const attribution = await getAttribution(undefined, summary.from ?? undefined);

  if (attribution.needsRecompute) {
    return (
      <Note>
        Attribution needs the cached daily snapshots. Run{' '}
        <code className="text-ink">npm run backfill</code> then{' '}
        <code className="text-ink">npm run recompute -- --from=inception</code>.
      </Note>
    );
  }

  const gbp = market.benchmark ? summary.benchmarks[market.benchmark.gbpLabel] : undefined;
  const ranked = rankContributors(attribution.grids.position!, 8);
  const toRows = (rows: Array<[string, { total: Decimal }]>) =>
    rows
      .filter(([k]) => k !== RESIDUAL_KEY)
      .map(([k, p]) => ({
        key: k,
        label: attribution.labels.get(k) ?? k,
        value: p.total.toNumber(),
        href: `/positions/${k}`,
      }));

  // Benchmark calendar returns over the periods the portfolio has, so the bars pair up.
  const benchLevels = market.benchmark ? market.benchmark.levels[market.benchmark.gbpLabel]! : [];
  const inWindow = benchLevels.filter((p) => (!summary.from || p.date >= summary.from) && (!summary.to || p.date <= summary.to));
  const benchMonths = new Map(periodReturnsFromLevels(inWindow, monthKey).map((r) => [r.period, r.ret]));
  const benchQuarters = new Map(periodReturnsFromLevels(inWindow, quarterKey).map((r) => [r.period, r.ret]));
  const monthlyRows = attribution.months.map((m) => ({
    period: m.period,
    portfolio: m.ret.toNumber(),
    benchmark: benchMonths.get(m.period) ?? null,
  }));
  const quarterlyRows = attribution.quarters.map((q) => ({
    period: q.period,
    portfolio: q.ret.toNumber(),
    benchmark: benchQuarters.get(q.period) ?? null,
  }));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <WindowPicker current={window} basePath="/attribution" />
        <span className="text-[11px] text-muted">
          {shortDate(attribution.from)} – {shortDate(attribution.to)} · {attribution.days} trading days
        </span>
      </div>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-4">
        <Cell
          label={`Total return · ${spec.label}`}
          value={percent(attribution.totalReturn, 2, { signed: true })}
          sub="time-weighted, chain-linked"
          tone={directionClass(attribution.totalReturn)}
        />
        <Cell
          label="S&P 500 (GBP)"
          value={percent(gbp?.ret, 2, { signed: true })}
          sub={
            gbp?.active === null || gbp?.active === undefined
              ? 'same window'
              : `you ${gbp.active >= 0 ? 'beat' : 'trailed'} it by ${Math.abs(gbp.active * 100).toFixed(1)} pts`
          }
          tone={directionClass(gbp?.ret)}
        />
        <Cell
          label="Money-weighted (XIRR)"
          value={overview.mwr === null ? '—' : percent(overview.mwr, 2, { signed: true })}
          sub="annualised, since inception"
        />
        <Cell
          label="Reconciliation gap"
          value={
            attribution.grids.position!.reconciliationGap.abs().lessThan('1e-12')
              ? 'exact'
              : percent(attribution.grids.position!.reconciliationGap, 6)
          }
          sub="grid total vs compounded return"
        />
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <Card
          title="Biggest contributors"
          subtitle={`top and bottom positions over the ${spec.label} window`}
          footnote="Contribution is weight × return on each day, chain-linked across the window. It is the position's share of the portfolio return, not the position's own return."
        >
          <Contributors
            rows={[
              ...toRows(ranked.top),
              ...toRows(ranked.bottom).filter((b) => !ranked.top.some(([k]) => k === b.key)).reverse(),
            ]}
          />
        </Card>

        <Card
          title="Monthly returns"
          subtitle="portfolio beside the S&P 500 in GBP"
          footnote="Compounded within each month. The first month of a window may be partial, and the benchmark bar for it is measured over the same days."
        >
          <CalendarBarChart rows={monthlyRows} benchmarkLabel={market.benchmark?.gbpLabel ?? null} />
          {quarterlyRows.length > 1 && (
            <div className="border-t border-line">
              <div className="px-4 pt-2 text-[10px] uppercase tracking-wide text-muted">Quarterly</div>
              <CalendarBarChart rows={quarterlyRows} benchmarkLabel={market.benchmark?.gbpLabel ?? null} />
            </div>
          )}
        </Card>
      </div>

      <Note>
        TWR neutralises deposit timing and is the correct basis for comparison against an index.
        MWR is the return your capital actually earned. With regular auto-invest they diverge, and
        showing only one of them is the most common analytical error in retail portfolio tools.
      </Note>

      <div className="grid gap-3 xl:grid-cols-2">
        {Object.entries(GRID_LABELS).map(([key, meta]) => {
          const grid = attribution.grids[key];
          if (!grid) return null;
          return (
            <Grid
              key={key}
              title={meta.title}
              subtitle={meta.subtitle}
              grid={grid}
              labels={attribution.labels}
              showFx={key === 'currency' || key === 'position'}
            />
          );
        })}
      </div>

      <Card
        title="Calendar returns"
        subtitle="compounded within each period, chain-linked across them"
        footnote="Summing daily contributions over a year does not reconcile to the total return. These are compounded, which is why the months multiply back to the headline figure."
      >
        <div className="space-y-4 px-4 py-3">
          <Heatmap title="Monthly" rows={attribution.months} />
          <Heatmap title="Quarterly" rows={attribution.quarters} />
          <Heatmap title="Yearly" rows={attribution.years} />
        </div>
      </Card>
    </div>
  );
}

function Cell({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <div className="bg-surface px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`tabular mt-1 text-xl leading-none ${tone ?? ''}`}>{value}</div>
      {sub && <div className="mt-1 text-[11px] text-ink-2">{sub}</div>}
    </div>
  );
}

function Grid({
  title,
  subtitle,
  grid,
  labels,
  showFx,
}: {
  title: string;
  subtitle?: string;
  grid: AttributionResult;
  labels: Map<string, string>;
  showFx?: boolean;
}) {
  const rows = [...grid.groups.entries()].sort((a, b) => b[1].total.comparedTo(a[1].total));
  const maxAbs = rows.reduce<Decimal>(
    (a, [, p]) => (p.total.abs().greaterThan(a) ? p.total.abs() : a),
    ZERO,
  );

  return (
    <Card
      title={title}
      subtitle={subtitle}
      footnote={
        grid.reconciliationGap.abs().lessThan('1e-12')
          ? 'Reconciles exactly to the total return.'
          : `Reconciliation gap: ${percent(grid.reconciliationGap, 6)}.`
      }
    >
      {rows.length === 0 ? (
        <Empty>Nothing to attribute in this window.</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Bucket</Th>
              <Th align="right">Contribution</Th>
              {showFx && <Th align="right" className="hidden sm:table-cell">Asset</Th>}
              {showFx && <Th align="right" className="hidden sm:table-cell">FX</Th>}
              <Th className="w-24 sm:w-32" />
            </tr>
          </thead>
          <tbody>
            {rows.map(([key, parts]) => (
              <Tr key={key}>
                <Td>
                  {key === RESIDUAL_KEY ? (
                    <span className="text-muted" title="Cash drag, fees, and anything the holdings do not explain. Never smeared across positions.">
                      Unexplained / cash
                    </span>
                  ) : (
                    (labels.get(key) ?? key)
                  )}
                </Td>
                <Td align="right" numeric className={directionClass(parts.total)}>
                  {percent(parts.total, 2, { signed: true })}
                </Td>
                {showFx && (
                  <Td align="right" numeric className={`hidden sm:table-cell ${directionClass(parts.asset)}`}>
                    {percent(parts.asset, 2, { signed: true })}
                  </Td>
                )}
                {showFx && (
                  <Td align="right" numeric className={`hidden sm:table-cell ${directionClass(parts.fx)}`}>
                    {parts.fx.isZero() ? '—' : percent(parts.fx, 2, { signed: true })}
                  </Td>
                )}
                <Td>
                  <ContributionBar value={parts.total} max={maxAbs} />
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

/** A diverging bar from a centre line: positive right, negative left. */
function ContributionBar({ value, max }: { value: Decimal; max: Decimal }) {
  const magnitude = max.isZero() ? 0 : value.abs().div(max).toNumber();
  const positive = value.greaterThanOrEqualTo(0);
  return (
    <div className="flex h-1.5 w-20 items-center sm:w-28">
      <div className="flex h-full w-1/2 justify-end">
        {!positive && (
          <div className="h-full rounded-l-full bg-down/70" style={{ width: `${magnitude * 100}%` }} />
        )}
      </div>
      <div className="h-full w-px bg-line-strong" />
      <div className="h-full w-1/2">
        {positive && (
          <div className="h-full rounded-r-full bg-up/70" style={{ width: `${magnitude * 100}%` }} />
        )}
      </div>
    </div>
  );
}

function Heatmap({ title, rows }: { title: string; rows: Array<{ period: string; ret: Decimal }> }) {
  if (rows.length === 0) return null;
  const maxAbs = rows.reduce<Decimal>(
    (a, r) => (r.ret.abs().greaterThan(a) ? r.ret.abs() : a),
    ZERO,
  );

  return (
    <div>
      <div className="mb-1.5 text-[11px] uppercase tracking-wide text-muted">{title}</div>
      <div className="flex flex-wrap gap-1">
        {rows.map((r) => {
          const intensity = maxAbs.isZero() ? 0 : r.ret.abs().div(maxAbs).toNumber();
          const up = r.ret.greaterThanOrEqualTo(0);
          return (
            <div
              key={r.period}
              title={`${r.period}: ${percent(r.ret, 2, { signed: true })}`}
              className="rounded border border-line px-2 py-1 text-center"
              style={{
                backgroundColor: `color-mix(in oklch, var(--color-${up ? 'up' : 'down'}) ${Math.round(intensity * 32)}%, transparent)`,
              }}
            >
              <div className="text-[10px] text-muted">{r.period}</div>
              <div className={`tabular text-[12px] ${directionClass(r.ret)}`}>
                {percent(r.ret, 1, { signed: true })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
