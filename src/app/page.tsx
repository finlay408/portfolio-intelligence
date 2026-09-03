/**
 * The overview (CLAUDE.md §12).
 *
 * "One dense overview screen. Total value, day change, TWR/MWR, Sharpe, max DD,
 * top movers, concentration warning, upcoming earnings — visible without
 * scrolling."
 *
 * Every performance figure here is computed over a selectable trailing window
 * (default 3M) rather than since inception, because a since-inception Sharpe
 * describes the portfolio's whole life and the owner wants to know what it is
 * doing now. The window is in the URL, so the page stays server-rendered.
 *
 * Every figure is a link into its own derivation. TWR and MWR are always shown
 * together and always labelled, because presenting only one of them is the
 * most common analytical error in retail portfolio tools (§7.2).
 */
import Link from 'next/link';
import {
  Badge,
  Card,
  Empty,
  FreshnessBadge,
  Insufficient,
  Note,
  Stat,
  Table,
  Td,
  Th,
  Tr,
  WeightBar,
} from '@/components/ui/primitives';
import { AllocationDonut } from '@/components/allocation-donut';
import { Contributors } from '@/components/contributors';
import { IntervalBar } from '@/components/interval-bar';
import { PerformanceChart } from '@/components/performance-chart';
import { ValueChart } from '@/components/value-chart';
import { WindowPicker } from '@/components/window-picker';
import { SPX_GBP, windowRegression, type RiskPayload, type VarPayload } from '@/lib/analytics-types';
import { RESIDUAL_KEY, rankContributors } from '@/lib/engine/attribution';
import {
  parseWindow,
  performanceSeries,
  summariseAllWindows,
  summariseWindow,
  windowSpec,
  type WindowSummary,
} from '@/lib/engine/windows';
import { directionClass, money, percent, shortDate } from '@/lib/format';
import {
  getAnalytics,
  getAttribution,
  getMarketContext,
  getOverview,
  getPendingActions,
  getUpcomingEarnings,
  type HoldingRow,
} from '@/lib/portfolio';

export const dynamic = 'force-dynamic';

/** Percentage-point difference, e.g. "+1.8 pts". */
const pts = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v)
    ? '—'
    : `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)} pts`;

const toneOf = (v: number | null | undefined): 'up' | 'down' | 'neutral' =>
  v === null || v === undefined || v === 0 ? 'neutral' : v > 0 ? 'up' : 'down';

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string | string[] }>;
}) {
  const window = parseWindow((await searchParams).window);
  const spec = windowSpec(window);

  const [overview, market, risk, varPack, pending, earnings] = await Promise.all([
    getOverview(),
    getMarketContext('SPX'),
    getAnalytics<RiskPayload>('risk'),
    getAnalytics<VarPayload>('var'),
    getPendingActions(),
    getUpcomingEarnings(),
  ]);

  // ---- the window ----
  const bench = market.benchmark;
  const benchmarkKeys = bench ? [bench.gbpLabel, ...(bench.localLabel ? [bench.localLabel] : [])] : [];
  const inputs = { benchmarks: bench?.levels ?? {}, riskFreeDaily: market.riskFreeDaily };
  const summary = summariseWindow(overview.twr.series, window, inputs);
  const allWindows = summariseAllWindows(overview.twr.series, inputs);
  const chartData = performanceSeries(overview.twr.series, window, bench?.levels ?? {});
  const gbpBench = bench ? summary.benchmarks[bench.gbpLabel] : undefined;

  // Contributors over the same window, from the cached daily snapshots.
  const attribution = summary.from ? await getAttribution(undefined, summary.from) : null;
  const ranked = attribution ? rankContributors(attribution.grids.position!, 5) : null;
  const contributorRows = (rows: Array<[string, { total: { toNumber(): number } }]>) =>
    rows
      .filter(([k]) => k !== RESIDUAL_KEY)
      .map(([k, p]) => ({
        key: k,
        label: attribution?.labels.get(k) ?? k,
        value: p.total.toNumber(),
        href: `/positions/${k}`,
      }));

  const regression = windowRegression(risk?.payload, window, SPX_GBP);
  const effectiveN = overview.concentration.effectiveN;
  const concentrated = effectiveN !== null && effectiveN.lessThan(6);

  const windowLabel =
    summary.from && summary.to
      ? `${shortDate(summary.from)} – ${shortDate(summary.to)} · ${summary.observations} trading days`
      : spec.description;

  return (
    <div className="space-y-3">
      {overview.needsRecompute && (
        <Note>
          No daily snapshots are cached yet, so time-series figures are unavailable. Run{' '}
          <code className="text-ink">npm run backfill</code> then{' '}
          <code className="text-ink">npm run recompute -- --from=inception</code>.
        </Note>
      )}
      {overview.warnings.length > 0 && (
        <Note>
          {overview.warnings.length} ledger warning(s) — the affected positions are shown but may
          be wrong. {overview.warnings[0]}
        </Note>
      )}

      {/* ---- money row: what it is worth today ---- */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-4">
        {[
          <Stat
            key="total"
            label="Total value"
            value={money(overview.totalValueGbp)}
            sub={`${money(overview.marketValueGbp)} invested · ${money(overview.cashGbp)} cash`}
            href="/positions"
          />,
          <Stat
            key="day"
            label="Day change"
            value={money(overview.dayChangeGbp)}
            sub={percent(overview.dayChangePct, 2, { signed: true })}
            tone={toneOf(overview.dayChangeGbp?.toNumber())}
          />,
          <Stat
            key="unreal"
            label="Unrealised"
            value={money(overview.unrealisedGbp)}
            sub={percent(
              overview.costBasisGbp.isZero() ? null : overview.unrealisedGbp.div(overview.costBasisGbp),
              1,
              { signed: true },
            )}
            tone={toneOf(overview.unrealisedGbp.toNumber())}
            href="/positions"
          />,
          <Stat
            key="realised"
            label="Realised"
            value={money(overview.realisedGbp)}
            sub={`${money(overview.dividendsGbp)} dividends`}
            tone={toneOf(overview.realisedGbp.toNumber())}
            href="/positions/closed"
          />,
        ].map((node, i) => (
          <div key={i} className="bg-surface">
            {node}
          </div>
        ))}
      </div>

      {/* ---- the window ---- */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <WindowPicker current={window} basePath="/" />
        <span className="text-[11px] text-muted">{windowLabel}</span>
      </div>

      {/* ---- performance row: how it is doing over the window ---- */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3 xl:grid-cols-6">
        {[
          <Stat
            key="ret"
            label={`Return · ${spec.label}`}
            value={percent(summary.ret, 1, { signed: true })}
            sub="time-weighted (TWR)"
            tone={toneOf(summary.ret?.toNumber())}
            hint="Chain-linked daily returns with deposits neutralised. This is the figure to compare against an index."
            href="/attribution"
          />,
          <Stat
            key="active"
            label="vs S&P 500"
            value={pts(gbpBench?.active)}
            sub={
              gbpBench?.ret === null || gbpBench?.ret === undefined
                ? 'no benchmark data'
                : `index ${percent(gbpBench.ret, 1, { signed: true })} in GBP`
            }
            tone={toneOf(gbpBench?.active)}
            hint="Your return minus the S&P 500's return over the same days, both in pounds. Positive means you beat the index."
            href="/risk"
          />,
          <Stat
            key="sharpe"
            label="Sharpe"
            value={summary.sharpe === null ? '—' : summary.sharpe.toFixed(2)}
            sub={
              summary.sharpe === null
                ? `needs 20 days (${summary.observations})`
                : market.riskFreeSource
                  ? 'vs SONIA'
                  : 'risk-free 0 (FRED not loaded)'
            }
            hint="Return per unit of volatility, annualised. Above 1 is good; below 0 means you were paid nothing for the risk."
            href="/risk"
          />,
          <Stat
            key="vol"
            label="Volatility"
            value={percent(summary.volatility, 1)}
            sub="annualised"
            hint="How much the daily returns swing, scaled to a year. The S&P 500 is typically 15–20%."
            href="/risk"
          />,
          <Stat
            key="dd"
            label="Max drawdown"
            value={percent(summary.maxDrawdown?.depth ?? null, 1)}
            sub={
              summary.maxDrawdown?.troughDate
                ? summary.maxDrawdown.recoveredDate
                  ? `recovered in ${summary.maxDrawdown.recoveryDays}d`
                  : `trough ${shortDate(summary.maxDrawdown.troughDate)}`
                : 'within the window'
            }
            hint="The largest peak-to-trough fall inside this window."
            href="/risk"
          />,
          <Stat
            key="beta"
            label="Beta"
            value={regression ? regression.regression.beta.toFixed(2) : '—'}
            sub={
              !regression
                ? 'awaiting nightly job'
                : regression.scope === 'inception'
                  ? 'since inception · too few days'
                  : `± ${(1.96 * regression.regression.beta_stderr).toFixed(2)} · vs S&P 500`
            }
            hint="How much the portfolio moves for each 1% move in the S&P 500 (GBP). 0.5 means half as much."
            href="/risk"
          />,
        ].map((node, i) => (
          <div key={i} className="bg-surface">
            {node}
          </div>
        ))}
      </div>

      {/* ---- alerts strip ---- */}
      {(concentrated || pending.length > 0) && (
        <div className="flex flex-wrap items-center gap-2">
          {concentrated && (
            <Link href="/exposure" className="no-underline">
              <Badge tone="warn">
                Effective N is {effectiveN!.toFixed(1)} across {overview.concentration.count}{' '}
                positions — this is not a diversified portfolio
              </Badge>
            </Link>
          )}
          {pending.length > 0 && (
            <Link href="/corporate-actions" className="no-underline">
              <Badge tone="warn">{pending.length} corporate action(s) awaiting confirmation</Badge>
            </Link>
          )}
        </div>
      )}

      {/* ---- performance chart ---- */}
      {chartData.length > 1 && (
        <Card
          title="Performance"
          subtitle={`cumulative return since the start of the window, portfolio against the S&P 500 · drawdown beneath`}
          action={
            summary.maxDrawdown?.recoveredDate
              ? `deepest drawdown recovered in ${summary.maxDrawdown.recoveryDays} days`
              : summary.maxDrawdown?.troughDate
                ? 'still under water from the deepest drawdown'
                : undefined
          }
          footnote="Both lines start at zero on the first day of the window. The gap between them on the right-hand edge is the “vs S&P 500” figure above. Deposits move the value of the portfolio but not this line — that is the whole point of TWR."
        >
          <PerformanceChart data={chartData} benchmarkKeys={benchmarkKeys} />
        </Card>
      )}

      <div className="grid gap-3 xl:grid-cols-[3fr_2fr]">
        <div className="min-w-0 space-y-3">
          {/* ---- returns by window ---- */}
          <Card
            title="Returns by window"
            subtitle="the same figures over every window, so a good quarter is not mistaken for a good year"
            footnote={
              <>
                Money-weighted return (XIRR, annualised, since inception):{' '}
                <span className="tabular text-ink">
                  {overview.mwr === null ? '—' : percent(overview.mwr, 1, { signed: true })}
                </span>
                . This is what your capital actually earned, reflecting when deposits arrived. It is
                not comparable to an index; the time-weighted figures above are.
              </>
            }
          >
            <ReturnsTable rows={allWindows} current={window} gbpLabel={bench?.gbpLabel ?? null} localLabel={bench?.localLabel ?? null} />
          </Card>

          {/* ---- value vs deposits ---- */}
          {overview.valueSeries.length > 1 && (
            <Card
              title="Value against deposits"
              subtitle="total value in pounds, with the money you have put in"
              footnote="The shaded gap is the pound gain or loss on the capital deployed, including cash. It moves with deposits as well as markets, which is why it is not a return figure."
            >
              <ValueChart data={overview.valueSeries} />
            </Card>
          )}

          {/* ---- holdings ---- */}
          <Card
            title="Holdings"
            subtitle={`${overview.holdings.length} open positions · ${overview.accountName}`}
            action={<Link href="/positions" className="hover:text-ink">All positions →</Link>}
          >
            {overview.holdings.length === 0 ? (
              <Empty>No open positions. Add trades to get started.</Empty>
            ) : (
              <>
                <ul className="divide-y divide-line/60 md:hidden">
                  {overview.holdings.map((h) => (
                    <HoldingCard key={`${h.position.accountId}-${h.position.instrumentId}`} h={h} />
                  ))}
                </ul>
                <div className="hidden md:block">
                  <Table>
                    <thead>
                      <tr>
                        <Th>Symbol</Th>
                        <Th align="right">Price</Th>
                        <Th align="right">Day</Th>
                        <Th align="right">Value</Th>
                        <Th align="right">Unrealised</Th>
                        <Th align="right">Weight</Th>
                        <Th>Freshness</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.holdings.map((h) => (
                        <HoldingRowView key={`${h.position.accountId}-${h.position.instrumentId}`} h={h} />
                      ))}
                    </tbody>
                  </Table>
                </div>
              </>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-3">
          {/* ---- against the index, explained ---- */}
          <Card
            title="Against the S&P 500"
            subtitle="in pounds — the return you would actually have earned"
            footnote={
              risk
                ? `Alpha and beta computed ${shortDate(risk.snapDate)} by the nightly job${
                    regression?.scope === 'window'
                      ? ` over this ${spec.label} window (${regression.regression.observations} days)`
                      : regression
                        ? ` since inception (${regression.regression.observations} days)`
                        : ''
                  }. The plain comparison above it is live.`
                : undefined
            }
          >
            <div className="divide-y divide-line">
              {/* the plain comparison */}
              <div className="px-4 py-3">
                <div className="text-[11px] uppercase tracking-wide text-muted">
                  Plain comparison · {spec.label}
                </div>
                {gbpBench?.ret === null || gbpBench?.ret === undefined || summary.ret === null ? (
                  <p className="mt-1 text-[12px] text-muted">
                    No benchmark prices for this window yet.
                  </p>
                ) : (
                  <>
                    <div className="mt-1.5 grid grid-cols-3 gap-2 text-[12px]">
                      <div>
                        <div className="text-[10px] text-muted">You</div>
                        <div className={`tabular text-base ${directionClass(summary.ret)}`}>
                          {percent(summary.ret, 1, { signed: true })}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-muted">S&P 500 (GBP)</div>
                        <div className={`tabular text-base ${directionClass(gbpBench.ret)}`}>
                          {percent(gbpBench.ret, 1, { signed: true })}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-muted">Difference</div>
                        <div className={`tabular text-base ${directionClass(gbpBench.active)}`}>
                          {pts(gbpBench.active)}
                        </div>
                      </div>
                    </div>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                      {gbpBench.active !== null && gbpBench.active >= 0
                        ? 'You beat the index over this window.'
                        : 'The index beat you over this window.'}
                      {bench?.localLabel && summary.benchmarks[bench.localLabel]?.ret !== null && (
                        <>
                          {' '}
                          In dollars the index did{' '}
                          <span className="tabular">
                            {percent(summary.benchmarks[bench.localLabel]!.ret, 1, { signed: true })}
                          </span>
                          ; the rest is the pound moving.
                        </>
                      )}
                    </p>
                  </>
                )}
              </div>

              {/* alpha */}
              {!regression ? (
                <Insufficient reason="The nightly analytics job has not produced a regression yet. It needs at least 30 overlapping daily observations for the portfolio and the benchmark." />
              ) : (
                <>
                  <div className="px-4 py-3">
                    <div className="flex items-baseline justify-between">
                      <div className="text-[11px] uppercase tracking-wide text-muted">
                        Alpha · per year
                      </div>
                      <div className="tabular text-base">
                        {percent(regression.regression.alpha_annualised, 1, { signed: true })}
                      </div>
                    </div>
                    <IntervalBar
                      className="mt-2"
                      point={regression.regression.alpha_annualised}
                      low={regression.regression.alpha_ci95_low}
                      high={regression.regression.alpha_ci95_high}
                      format={(v) => percent(v, 0, { signed: true })}
                    />
                    <p className="mt-1 text-[11px] leading-relaxed text-muted">
                      Alpha is the part of your return the index does not explain: what is left after
                      allowing for how much of the market&apos;s movement you carry (beta). The dot is
                      the best estimate; the band is the 95% range.{' '}
                      {Math.abs(regression.regression.alpha_tstat) >= 1.96 ? (
                        <>
                          The band does not touch zero, so the sign is{' '}
                          {regression.regression.alpha_annualised >= 0 ? 'positive' : 'negative'} with
                          reasonable confidence.
                        </>
                      ) : (
                        <>
                          The band straddles zero, so the data cannot tell whether you are adding or
                          losing value against the index — a concentrated portfolio over{' '}
                          {regression.regression.observations} days simply has not produced enough
                          evidence either way.
                        </>
                      )}
                    </p>
                  </div>

                  {/* beta */}
                  <div className="px-4 py-3">
                    <div className="flex items-baseline justify-between">
                      <div className="text-[11px] uppercase tracking-wide text-muted">Beta</div>
                      <div className="tabular text-base">
                        {regression.regression.beta.toFixed(2)}{' '}
                        <span className="text-[11px] text-muted">
                          ± {(1.96 * regression.regression.beta_stderr).toFixed(2)}
                        </span>
                      </div>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted">
                      For every 1% the S&P 500 moves, the portfolio has moved about{' '}
                      <span className="tabular text-ink">{(regression.regression.beta * 100).toFixed(0)}%</span> as
                      much in the same direction. The index explains{' '}
                      <span className="tabular text-ink">{percent(regression.regression.r_squared, 0)}</span> of
                      the portfolio&apos;s day-to-day movement (R²); the rest is specific to what you hold.
                    </p>
                    {regression.note && <p className="mt-1 text-[11px] text-warn">{regression.note}</p>}
                  </div>
                </>
              )}
            </div>
          </Card>

          {/* ---- contributors over the window ---- */}
          <Card
            title="Contributors"
            subtitle={`what drove the ${spec.label} return`}
            action={<Link href="/attribution" className="hover:text-ink">Attribution →</Link>}
            footnote="Contribution is weight × return, so a small position that doubled and a large one that drifted 5% can sit side by side."
          >
            {!ranked ? (
              <Empty>Needs cached daily snapshots.</Empty>
            ) : (
              <Contributors
                rows={[
                  ...contributorRows(ranked.top),
                  ...contributorRows(ranked.bottom).filter(
                    (b) => !ranked.top.some(([k]) => k === b.key),
                  ).reverse(),
                ]}
              />
            )}
          </Card>

          {/* ---- VaR ---- */}
          <Card title="Value at Risk" subtitle="1 day, historical, 95% · from the nightly job">
            {!varPack || varPack.payload.status !== 'ok' ? (
              summary.var95 !== null ? (
                <div className="px-4 py-3">
                  <div className="text-[11px] uppercase tracking-wide text-muted">
                    Empirical, {spec.label} window
                  </div>
                  <div className="tabular mt-1 text-lg text-down">
                    {money(summary.var95 * overview.totalValueGbp.toNumber())}
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted">
                    On 95% of days in this window you lost less than this. A full-history VaR needs
                    252 days; {varPack?.payload.message ?? 'the nightly job has not produced one yet'}.
                  </p>
                </div>
              ) : (
                <Insufficient
                  reason={
                    varPack?.payload.message ??
                    'VaR needs at least 252 daily observations — one year. A figure computed from less would be a guess dressed as a measurement.'
                  }
                />
              )
            ) : (
              <div className="grid grid-cols-2 divide-x divide-line">
                <div className="px-4 py-3">
                  <div className="text-[11px] uppercase tracking-wide text-muted">VaR 95%</div>
                  <div className="tabular mt-1 text-lg text-down">
                    {money(-Math.abs(varPack.payload.primary!.var_95_1d_gbp))}
                  </div>
                  <div className="mt-1 text-[10px] text-muted">a 1-in-20 day loses more than this</div>
                </div>
                <div className="px-4 py-3">
                  <div className="text-[11px] uppercase tracking-wide text-muted">Expected shortfall</div>
                  <div className="tabular mt-1 text-lg text-down">
                    {money(-Math.abs(varPack.payload.primary!.cvar_95_1d_gbp))}
                  </div>
                  <div className="mt-1 text-[10px] text-muted">average loss on those days</div>
                </div>
              </div>
            )}
          </Card>

          {/* ---- movers ---- */}
          <Card title="Movers" subtitle="today">
            {overview.topMovers.length === 0 ? (
              <Empty>No live quotes yet — run the quote refresh job.</Empty>
            ) : (
              <div className="divide-y divide-line">
                {[...overview.topMovers.slice(0, 3), ...overview.bottomMovers.slice(0, 3)]
                  .filter((h, i, arr) => arr.findIndex((x) => x.symbol === h.symbol) === i)
                  .map((h) => (
                    <Link
                      key={h.symbol}
                      href={`/positions/${h.position.instrumentId}`}
                      className="flex items-center justify-between px-4 py-1.5 text-[12px] hover:bg-surface-2/60"
                    >
                      <span className="font-medium">{h.symbol}</span>
                      <span className={`tabular ${directionClass(h.quote?.changePct)}`}>
                        {percent(h.quote?.changePct, 2, { signed: true })}
                      </span>
                    </Link>
                  ))}
              </div>
            )}
          </Card>

          {/* ---- earnings ---- */}
          <Card title="Upcoming earnings" subtitle="next 30 days">
            {earnings.length === 0 ? (
              <Empty>Nothing scheduled, or the earnings job has not run.</Empty>
            ) : (
              <div className="divide-y divide-line">
                {earnings.slice(0, 6).map((e) => (
                  <div key={e.event.id} className="flex items-center justify-between px-4 py-1.5 text-[12px]">
                    <span className="font-medium">{e.symbol}</span>
                    <span className="text-muted">
                      {shortDate(e.event.reportDate)}
                      {e.event.session && e.event.session !== 'unknown' && (
                        <span className="ml-1 uppercase">{e.event.session}</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* ---- exposure strip ---- */}
      <div className="grid gap-3 md:grid-cols-3">
        <ExposureCard title="By sector" rows={overview.bySector.rows} href="/exposure" />
        <ExposureCard
          title="By revenue geography"
          subtitle="true exposure, not listing venue"
          rows={overview.byRevenueGeography.rows}
          href="/exposure"
        />
        <ExposureCard title="By currency" rows={overview.byCurrency.rows} href="/exposure" />
      </div>
    </div>
  );
}

function ReturnsTable({
  rows,
  current,
  gbpLabel,
  localLabel,
}: {
  rows: WindowSummary[];
  current: string;
  gbpLabel: string | null;
  localLabel: string | null;
}) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Window</Th>
          <Th align="right">Portfolio</Th>
          <Th align="right">S&P 500 (GBP)</Th>
          <Th align="right">Difference</Th>
          {localLabel && <Th align="right" className="hidden sm:table-cell">S&P 500 (USD)</Th>}
          <Th align="right" className="hidden sm:table-cell">Max DD</Th>
          <Th align="right" className="hidden sm:table-cell">Sharpe</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((w) => {
          const gbp = gbpLabel ? w.benchmarks[gbpLabel] : undefined;
          const local = localLabel ? w.benchmarks[localLabel] : undefined;
          const active = w.key === current;
          return (
            <Tr key={w.key} className={active ? 'bg-surface-2/50' : undefined}>
              <Td>
                <Link href={w.key === '3m' ? '/' : `/?window=${w.key}`} scroll={false} className={active ? 'font-medium' : 'hover:text-accent'}>
                  {w.label}
                </Link>
                <span className="ml-1.5 hidden text-[10px] text-muted sm:inline">{w.observations}d</span>
              </Td>
              <Td align="right" numeric className={directionClass(w.ret)}>
                {percent(w.ret, 1, { signed: true })}
              </Td>
              <Td align="right" numeric className={directionClass(gbp?.ret)}>
                {percent(gbp?.ret, 1, { signed: true })}
              </Td>
              <Td align="right" numeric className={directionClass(gbp?.active)}>
                {pts(gbp?.active)}
              </Td>
              {localLabel && (
                <Td align="right" numeric className={`hidden sm:table-cell ${directionClass(local?.ret)}`}>
                  {percent(local?.ret, 1, { signed: true })}
                </Td>
              )}
              <Td align="right" numeric className="hidden sm:table-cell">
                {percent(w.maxDrawdown?.depth ?? null, 1)}
              </Td>
              <Td align="right" numeric className="hidden sm:table-cell">
                {w.sharpe === null ? '—' : w.sharpe.toFixed(2)}
              </Td>
            </Tr>
          );
        })}
      </tbody>
    </Table>
  );
}

/** A holding on a phone: two lines, the numbers that matter, tappable. */
function HoldingCard({ h }: { h: HoldingRow }) {
  return (
    <li>
      <Link href={`/positions/${h.position.instrumentId}`} className="block px-3 py-2 active:bg-surface-2/60">
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0">
            <span className="font-medium">{h.symbol}</span>
            <span className="ml-1.5 truncate text-[11px] text-muted">{h.name}</span>
          </div>
          <span className="tabular shrink-0 text-[13px]">{money(h.marketValueGbp)}</span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-3 text-[11px]">
          <div className="flex items-center gap-2">
            <span className={`tabular ${directionClass(h.quote?.changePct)}`}>
              {percent(h.quote?.changePct, 2, { signed: true })} today
            </span>
            <FreshnessBadge
              delaySeconds={h.quote?.delaySeconds ?? null}
              provider={h.quote?.provider}
              asOf={h.quote?.asOf}
              kind={h.quote?.isStale ? 'close' : 'quote'}
            />
          </div>
          <span className={`tabular ${directionClass(h.unrealisedGbp)}`}>
            {money(h.unrealisedGbp)} · {percent(h.unrealisedPct, 1, { signed: true })}
          </span>
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <div className="flex-1">
            <WeightBar value={h.weight.toNumber()} />
          </div>
          <span className="tabular w-10 text-right text-[10px] text-muted">{percent(h.weight, 1)}</span>
        </div>
      </Link>
    </li>
  );
}

function HoldingRowView({ h }: { h: HoldingRow }) {
  return (
    <Tr>
      <Td>
        <Link href={`/positions/${h.position.instrumentId}`} className="font-medium hover:text-accent">
          {h.symbol}
        </Link>
        <div className="truncate text-[11px] text-muted">{h.name}</div>
      </Td>
      <Td align="right" numeric>
        {h.quote ? h.quote.price.toFixed(2) : '—'}
        <span className="ml-1 text-[10px] text-muted">{h.quoteCurrency}</span>
      </Td>
      <Td align="right" numeric className={directionClass(h.quote?.changePct)}>
        {percent(h.quote?.changePct, 2, { signed: true })}
      </Td>
      <Td align="right" numeric>
        {money(h.marketValueGbp)}
      </Td>
      <Td align="right" numeric className={directionClass(h.unrealisedGbp)}>
        {money(h.unrealisedGbp)}
        <div className="text-[10px]">{percent(h.unrealisedPct, 1, { signed: true })}</div>
      </Td>
      <Td align="right" numeric>
        <div>{percent(h.weight, 1)}</div>
        <div className="mt-1 w-16">
          <WeightBar value={h.weight.toNumber()} />
        </div>
      </Td>
      <Td>
        <FreshnessBadge
          delaySeconds={h.quote?.delaySeconds ?? null}
          provider={h.quote?.provider}
          asOf={h.quote?.asOf}
          kind={h.quote?.isStale ? 'close' : 'quote'}
        />
      </Td>
    </Tr>
  );
}

function ExposureCard({
  title,
  subtitle,
  rows,
  href,
}: {
  title: string;
  subtitle?: string;
  rows: Array<{ key: string; label: string; weight: { toNumber(): number } }>;
  href: string;
}) {
  return (
    <Card
      title={title}
      subtitle={subtitle}
      action={
        <Link href={href} className="hover:text-ink">
          Detail →
        </Link>
      }
    >
      <AllocationDonut rows={rows.map((r) => ({ key: r.key, label: r.label, weight: r.weight.toNumber() }))} />
    </Card>
  );
}
