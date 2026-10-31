/**
 * Performance: how much you made, against the market, and where it came from
 * (CLAUDE.md §7.2, §7.3).
 *
 * TWR and MWR sit side by side at the top, as the brief requires. Every
 * attribution grid still reconciles to the total return; instead of a
 * paragraph saying so, each section's meta line carries a tick or the gap.
 */
import { Empty, Note, cn } from '@/components/ui/primitives';
import { CalendarBarChart } from '@/components/calendar-bar-chart';
import { Contributors } from '@/components/contributors';
import { JumpLinks, PageHead, RaceCard, Section, pts } from '@/components/scoreboard';
import { ValueChart } from '@/components/value-chart';
import { Decimal, ZERO } from '@/lib/decimal';
import { monthKey, quarterKey } from '@/lib/dates';
import { directionClass, money, percent } from '@/lib/format';
import { RESIDUAL_KEY, rankContributors, type AttributionResult } from '@/lib/engine/attribution';
import {
  parseWindow,
  performanceSeries,
  periodReturnsFromLevels,
  summariseAllWindows,
  summariseWindow,
  windowSpec,
} from '@/lib/engine/windows';
import { getAttribution, getMarketContext, getOverview } from '@/lib/portfolio';

export const dynamic = 'force-dynamic';

/** The grids worth a phone screen, in the order they are read. */
const GRIDS: Array<{ key: string; title: string; meta?: string; fx?: boolean }> = [
  { key: 'sector', title: 'By sector', meta: 'funds looked through' },
  { key: 'currency', title: 'By currency', meta: 'stock vs FX', fx: true },
  { key: 'revenueGeography', title: 'By revenue geography' },
  { key: 'theme', title: 'By theme' },
];

export default async function PerformancePage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string | string[] }>;
}) {
  const window = parseWindow((await searchParams).window);
  const spec = windowSpec(window);

  const [overview, market] = await Promise.all([getOverview(), getMarketContext('SPX')]);
  const bench = market.benchmark;
  const inputs = { benchmarks: bench?.levels ?? {}, riskFreeDaily: market.riskFreeDaily };
  const summary = summariseWindow(overview.twr.series, window, inputs);
  const allWindows = summariseAllWindows(overview.twr.series, inputs);
  const vsMarket = bench ? summary.benchmarks[bench.gbpLabel] : undefined;
  const attribution = await getAttribution(undefined, summary.from ?? undefined);

  if (attribution.needsRecompute) {
    return (
      <Note>
        Needs the cached daily snapshots. Run <code className="text-ink">npm run backfill</code> then{' '}
        <code className="text-ink">npm run recompute -- --from=inception</code>.
      </Note>
    );
  }

  const chartData = performanceSeries(overview.twr.series, window, bench?.levels ?? {}).map((p) => ({
    date: p.date,
    you: p.portfolio,
    market: bench ? (p.benchmarks[bench.gbpLabel] ?? null) : null,
  }));

  const ranked = rankContributors(attribution.grids.position!, 6);
  const toRows = (rows: Array<[string, { total: Decimal }]>) =>
    rows
      .filter(([k]) => k !== RESIDUAL_KEY)
      .map(([k, p]) => ({
        key: k,
        label: attribution.labels.get(k) ?? k,
        value: p.total.toNumber(),
        href: `/positions/${k}`,
      }));

  // Benchmark calendar returns over the same periods, so the bars pair up.
  const benchLevels = bench ? bench.levels[bench.gbpLabel]! : [];
  const inWindow = benchLevels.filter(
    (p) => (!summary.from || p.date >= summary.from) && (!summary.to || p.date <= summary.to),
  );
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

  const lastValue = overview.valueSeries.at(-1);
  const gainOnDeposits = lastValue ? lastValue.valueGbp - lastValue.netDepositsGbp : null;

  return (
    <div className="font-display mx-auto max-w-5xl space-y-4 pb-4">
      <PageHead title="Performance" window={window} basePath="/attribution" />

      <RaceCard
        data={chartData}
        windowLabel={spec.label}
        ret={attribution.totalReturn}
        mwr={overview.mwr}
        marketRet={vsMarket?.ret}
        active={vsMarket?.active}
      />

      <JumpLinks
        items={[
          ['#windows', 'Every window'],
          ['#moves', 'What moved'],
          ['#breakdown', 'Breakdown'],
          ['#calendar', 'Calendar'],
          ['#deposits', 'Deposits'],
        ]}
      />

      <div className="grid gap-4 md:grid-cols-2">
        {/* ---- every window ---- */}
        <Section id="windows" title="Every window" meta="you vs S&P 500 £">
          <WindowBars rows={allWindows} gbpLabel={bench?.gbpLabel ?? null} current={window} />
        </Section>

        {/* ---- contributors ---- */}
        <Section id="moves" title="What moved you" meta={`${spec.label} · ${reconciles(attribution.grids.position!)}`}>
          <div className="-mx-4">
            <Contributors
              rows={[
                ...toRows(ranked.top),
                ...toRows(ranked.bottom).filter((b) => !ranked.top.some(([k]) => k === b.key)).reverse(),
              ]}
            />
          </div>
        </Section>
      </div>

      {/* ---- breakdowns ---- */}
      <div id="breakdown" className="grid scroll-mt-16 gap-4 md:grid-cols-2">
        {GRIDS.map((g) => {
          const grid = attribution.grids[g.key];
          // A grid holding only the residual (themes not yet assigned) has nothing to show.
          if (!grid || [...grid.groups.keys()].every((k) => k === RESIDUAL_KEY)) return null;
          return (
            <Section key={g.key} title={g.title} meta={[g.meta, reconciles(grid)].filter(Boolean).join(' · ')}>
              <div className="-mx-4">
                <Contributors rows={gridRows(grid, attribution.labels, g.fx)} />
              </div>
            </Section>
          );
        })}
      </div>

      {/* ---- calendar ---- */}
      <Section id="calendar" title="Month by month" meta="you vs S&P 500 £">
        <div className="-mx-4">
          <CalendarBarChart rows={monthlyRows} benchmarkLabel={bench?.gbpLabel ?? null} />
        </div>
        {quarterlyRows.length > 1 && (
          <div className="-mx-4 border-t border-line/60 pt-2">
            <div className="px-4 text-[12px] text-muted">Quarterly</div>
            <CalendarBarChart rows={quarterlyRows} benchmarkLabel={bench?.gbpLabel ?? null} />
          </div>
        )}
        {attribution.years.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {attribution.years.map((y) => (
              <PeriodChip key={y.period} period={y.period} ret={y.ret} />
            ))}
          </div>
        )}
      </Section>

      {/* ---- value against deposits ---- */}
      {overview.valueSeries.length > 1 && (
        <Section
          id="deposits"
          title="Value vs money put in"
          meta={
            gainOnDeposits === null ? undefined : (
              <span className={directionClass(gainOnDeposits)}>
                {gainOnDeposits >= 0 ? '+' : ''}
                {money(gainOnDeposits)}
              </span>
            )
          }
        >
          <div className="-mx-4">
            <ValueChart data={overview.valueSeries} />
          </div>
        </Section>
      )}
    </div>
  );
}

/** "✓ reconciles" or the gap, so a grid that does not add up is visible at a glance. */
function reconciles(grid: AttributionResult): string {
  return grid.reconciliationGap.abs().lessThan('1e-12')
    ? '✓ reconciles'
    : `gap ${percent(grid.reconciliationGap, 4)}`;
}

function gridRows(grid: AttributionResult, labels: Map<string, string>, fx?: boolean) {
  return [...grid.groups.entries()]
    .sort((a, b) => b[1].total.comparedTo(a[1].total))
    .map(([key, parts]) => ({
      key,
      label: key === RESIDUAL_KEY ? 'Cash & other' : (labels.get(key) ?? key),
      value: parts.total.toNumber(),
      sub:
        fx && !parts.fx.isZero()
          ? `stock ${percent(parts.asset, 2, { signed: true })} · FX ${percent(parts.fx, 2, { signed: true })}`
          : undefined,
    }));
}

/**
 * Paired bars per window — you dark, the index light — on one shared scale
 * centred on zero, with the gap in points on the right.
 */
function WindowBars({
  rows,
  gbpLabel,
  current,
}: {
  rows: ReturnType<typeof summariseAllWindows>;
  gbpLabel: string | null;
  current: string;
}) {
  const values = rows.flatMap((w) => [w.ret?.toNumber() ?? 0, (gbpLabel && w.benchmarks[gbpLabel]?.ret) || 0]);
  const max = Math.max(...values.map(Math.abs), 1e-9);
  const bar = (v: number | null, tone: string) => {
    if (v === null) return <div className="h-2.5" />;
    const width = `${(Math.abs(v) / max) * 50}%`;
    return (
      <div className="relative h-2.5">
        <div className="absolute inset-y-0 left-1/2 w-px bg-line-strong" />
        <div
          className={cn('absolute inset-y-0 rounded-sm', tone)}
          style={v >= 0 ? { left: '50%', width } : { right: '50%', width }}
        />
      </div>
    );
  };

  return (
    <div className="space-y-3">
      {rows.map((w) => {
        const b = gbpLabel ? w.benchmarks[gbpLabel] : undefined;
        const you = w.ret?.toNumber() ?? null;
        return (
          <a
            key={w.key}
            href={w.key === '3m' ? '/attribution' : `/attribution?window=${w.key}`}
            className={cn('grid grid-cols-[2.25rem_1fr_4rem] items-center gap-x-3 gap-y-1', w.key === current && 'font-semibold')}
          >
            <span className="row-span-2 text-[13px]">{w.label}</span>
            {bar(you, 'bg-ink')}
            <span className={cn('text-right text-[13px]', directionClass(you))}>{percent(you, 1, { signed: true })}</span>
            {bar(b?.ret ?? null, 'bg-accent/60')}
            <span className="text-right text-[11px] text-muted">{pts(b?.active)}</span>
          </a>
        );
      })}
      <div className="flex gap-4 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-ink" />You</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-accent/60" />S&amp;P 500 £</span>
        <span className="ml-auto">gap</span>
      </div>
    </div>
  );
}

function PeriodChip({ period, ret }: { period: string; ret: Decimal }) {
  const up = ret.greaterThanOrEqualTo(ZERO);
  return (
    <span
      className="rounded-lg px-2.5 py-1.5 text-center"
      style={{
        backgroundColor: `color-mix(in oklch, var(--color-${up ? 'up' : 'down'}) 14%, transparent)`,
      }}
    >
      <span className="block text-[10px] text-muted">{period}</span>
      <span className={cn('text-[13px] font-semibold', directionClass(ret))}>{percent(ret, 1, { signed: true })}</span>
    </span>
  );
}
