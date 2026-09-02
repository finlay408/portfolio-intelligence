/**
 * The overview (CLAUDE.md §12).
 *
 * "One dense overview screen. Total value, day change, TWR/MWR, Sharpe, max DD,
 * top movers, concentration warning, upcoming earnings — visible without
 * scrolling."
 *
 * Every figure here is a link into its own derivation. TWR and MWR are always
 * shown together and always labelled, because presenting only one of them is
 * the most common analytical error in retail portfolio tools (§7.2).
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
import { ONE } from '@/lib/decimal';
import { directionClass, estimate, money, percent, shortDate } from '@/lib/format';
import { PerformanceChart } from '@/components/performance-chart';
import { drawdownSeries } from '@/lib/engine/twr';
import {
  getAnalytics,
  getOverview,
  getPendingActions,
  getUpcomingEarnings,
  type HoldingRow,
} from '@/lib/portfolio';

export const dynamic = 'force-dynamic';

interface RiskPayload {
  observations: number;
  since_inception: {
    annualised_return: number | null;
    annualised_volatility: number | null;
    sharpe: number | null;
    sortino: number | null;
    max_drawdown: { depth: number | null; trough_date: string | null };
  };
  benchmarks: Record<
    string,
    {
      regression: {
        alpha_annualised: number;
        alpha_stderr_annualised: number;
        alpha_tstat: number;
        beta: number;
        beta_stderr: number;
        r_squared: number;
        observations: number;
      } | null;
    }
  >;
}

interface VarPayload {
  status: string;
  message?: string;
  primary?: { var_95_1d_gbp: number; cvar_95_1d_gbp: number };
}

export default async function OverviewPage() {
  const [overview, risk, varPack, pending, earnings] = await Promise.all([
    getOverview(),
    getAnalytics<RiskPayload>('risk'),
    getAnalytics<VarPayload>('var'),
    getPendingActions(),
    getUpcomingEarnings(),
  ]);

  // Cumulative TWR paired with the drawdown beneath it: the shape of the
  // recovery is as informative as the depth.
  const drawdowns = drawdownSeries(overview.twr.series);
  const chartData = overview.twr.series.map((point, i) => ({
    date: point.date,
    cumulative: point.cumulative.minus(1).toNumber(),
    drawdown: drawdowns[i]?.drawdown.toNumber() ?? 0,
  }));

  const effectiveN = overview.concentration.effectiveN;
  const concentrated = effectiveN !== null && effectiveN.lessThan(6);
  const spxRegression = risk?.payload.benchmarks?.['SPX_gbp']?.regression ?? null;

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

      {/* ---- headline row ---- */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4 xl:grid-cols-8">
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
            tone={overview.dayChangeGbp?.greaterThan(0) ? 'up' : overview.dayChangeGbp?.lessThan(0) ? 'down' : 'neutral'}
          />,
          <Stat
            key="unreal"
            label="Unrealised"
            value={money(overview.unrealisedGbp)}
            sub={percent(
              overview.costBasisGbp.isZero()
                ? null
                : overview.unrealisedGbp.div(overview.costBasisGbp),
              1,
              { signed: true },
            )}
            tone={overview.unrealisedGbp.greaterThan(0) ? 'up' : overview.unrealisedGbp.lessThan(0) ? 'down' : 'neutral'}
            href="/positions"
          />,
          <Stat
            key="realised"
            label="Realised"
            value={money(overview.realisedGbp)}
            sub={`${money(overview.dividendsGbp)} dividends`}
            tone={overview.realisedGbp.greaterThan(0) ? 'up' : overview.realisedGbp.lessThan(0) ? 'down' : 'neutral'}
            href="/positions/closed"
          />,
          <Stat
            key="twr"
            label="TWR"
            value={percent(overview.twr.sinceInception, 1, { signed: true })}
            sub="since inception · time-weighted"
            hint="Neutralises the timing and size of deposits. This is the figure to compare against an index."
            href="/attribution"
          />,
          <Stat
            key="mwr"
            label="MWR"
            value={overview.mwr === null ? '—' : percent(overview.mwr, 1, { signed: true })}
            sub="annualised · money-weighted"
            hint="The return actually earned on your capital, reflecting contribution timing. With regular auto-invest this diverges from TWR."
            href="/attribution"
          />,
          <Stat
            key="sharpe"
            label="Sharpe"
            value={
              risk?.payload.since_inception.sharpe === null ||
              risk?.payload.since_inception.sharpe === undefined
                ? '—'
                : risk.payload.since_inception.sharpe.toFixed(2)
            }
            sub={
              risk
                ? `vol ${percent(risk.payload.since_inception.annualised_volatility, 1)}`
                : 'awaiting nightly job'
            }
            hint="Excess return per unit of volatility, against the GBP risk-free rate (SONIA)."
            href="/risk"
          />,
          <Stat
            key="dd"
            label="Max drawdown"
            value={percent(overview.twr.maxDrawdown?.depth ?? null, 1)}
            sub={
              overview.twr.maxDrawdown?.troughDate
                ? `trough ${shortDate(overview.twr.maxDrawdown.troughDate)}`
                : '—'
            }
            tone="neutral"
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
              <Badge tone="warn">
                {pending.length} corporate action(s) awaiting confirmation
              </Badge>
            </Link>
          )}
        </div>
      )}

      {chartData.length > 1 && (
        <Card
          title="Performance"
          subtitle="cumulative time-weighted return, and drawdown from the running peak"
          action={
            overview.twr.maxDrawdown?.recoveredDate
              ? `deepest drawdown recovered in ${overview.twr.maxDrawdown.recoveryDays} days`
              : overview.twr.maxDrawdown?.troughDate
                ? 'still under water from the deepest drawdown'
                : undefined
          }
          footnote="Flow-adjusted daily returns, chain-linked. Deposits move the value of the portfolio but not this line — that is the whole point of TWR."
        >
          <PerformanceChart data={chartData} />
        </Card>
      )}

      <div className="grid gap-3 xl:grid-cols-[2fr_1fr]">
        {/* ---- holdings ---- */}
        <Card
          title="Holdings"
          subtitle={`${overview.holdings.length} open positions · ${overview.accountName}`}
          action={<Link href="/positions" className="hover:text-ink">All positions →</Link>}
        >
          {overview.holdings.length === 0 ? (
            <Empty>No open positions. Add trades to get started.</Empty>
          ) : (
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
          )}
        </Card>

        <div className="space-y-3">
          {/* ---- alpha and beta, with their uncertainty ---- */}
          <Card
            title="Against the S&P 500"
            subtitle="GBP-translated — the return you would actually have earned"
            footnote={
              risk
                ? `Computed ${shortDate(risk.snapDate)} from ${risk.payload.observations} daily observations.`
                : undefined
            }
          >
            {!spxRegression ? (
              <Insufficient reason="The nightly analytics job has not produced a regression yet. It needs at least 30 overlapping daily observations for the portfolio and the benchmark." />
            ) : (
              <div className="divide-y divide-line">
                <div className="flex items-baseline justify-between px-4 py-2.5">
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-muted">Alpha</div>
                    <div className="mt-0.5 text-[11px] text-muted">annualised, Jensen&apos;s</div>
                  </div>
                  <div className="text-right">
                    <div className="tabular text-lg leading-none">
                      {estimate(
                        spxRegression.alpha_annualised,
                        spxRegression.alpha_stderr_annualised,
                      )}
                    </div>
                    <div className="mt-1 text-[11px] text-muted">
                      {Math.abs(spxRegression.alpha_tstat) >= 1.96
                        ? 'distinguishable from zero at 95%'
                        : 'not distinguishable from zero'}
                    </div>
                  </div>
                </div>
                <div className="flex items-baseline justify-between px-4 py-2.5">
                  <div className="text-[11px] uppercase tracking-wide text-muted">Beta</div>
                  <div className="text-right">
                    <div className="tabular text-lg leading-none">
                      {spxRegression.beta.toFixed(2)} ± {(1.96 * spxRegression.beta_stderr).toFixed(2)}
                    </div>
                    <div className="mt-1 text-[11px] text-muted">
                      R² {(spxRegression.r_squared * 100).toFixed(0)}% · n=
                      {spxRegression.observations}
                    </div>
                  </div>
                </div>
                <div className="px-4 py-2 text-[11px] leading-relaxed text-muted">
                  A concentrated portfolio measured over this many days produces a wide interval.
                  The range is the estimate; the midpoint alone is not.
                </div>
              </div>
            )}
          </Card>

          {/* ---- VaR ---- */}
          <Card title="Value at Risk" subtitle="1 day, historical, 95%">
            {!varPack || varPack.payload.status !== 'ok' ? (
              <Insufficient
                reason={
                  varPack?.payload.message ??
                  'VaR needs at least 252 daily observations — one year. A figure computed from less would be a guess dressed as a measurement.'
                }
              />
            ) : (
              <div className="grid grid-cols-2 divide-x divide-line">
                <div className="px-4 py-3">
                  <div className="text-[11px] uppercase tracking-wide text-muted">VaR 95%</div>
                  <div className="tabular mt-1 text-lg text-down">
                    {money(-Math.abs(varPack.payload.primary!.var_95_1d_gbp))}
                  </div>
                </div>
                <div className="px-4 py-3">
                  <div className="text-[11px] uppercase tracking-wide text-muted">
                    Expected shortfall
                  </div>
                  <div className="tabular mt-1 text-lg text-down">
                    {money(-Math.abs(varPack.payload.primary!.cvar_95_1d_gbp))}
                  </div>
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
                    <div
                      key={h.symbol}
                      className="flex items-center justify-between px-4 py-1.5 text-[12px]"
                    >
                      <span className="font-medium">{h.symbol}</span>
                      <span className={`tabular ${directionClass(h.quote?.changePct)}`}>
                        {percent(h.quote?.changePct, 2, { signed: true })}
                      </span>
                    </div>
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
                  <div
                    key={e.event.id}
                    className="flex items-center justify-between px-4 py-1.5 text-[12px]"
                  >
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
        <ExposureCard
          title="By sector"
          rows={overview.bySector.rows.slice(0, 6)}
          href="/exposure"
        />
        <ExposureCard
          title="By revenue geography"
          subtitle="true exposure, not listing venue"
          rows={overview.byRevenueGeography.rows.slice(0, 6)}
          href="/exposure"
        />
        <ExposureCard
          title="By currency"
          rows={overview.byCurrency.rows.slice(0, 6)}
          href="/exposure"
        />
      </div>
    </div>
  );
}

function HoldingRowView({ h }: { h: HoldingRow }) {
  return (
    <Tr>
      <Td>
        <Link
          href={`/positions/${h.position.instrumentId}`}
          className="font-medium hover:text-accent"
        >
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
  rows: Array<{ key: string; label: string; weight: ReturnType<typeof ONE.plus> }>;
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
      {rows.length === 0 ? (
        <Empty>No holdings.</Empty>
      ) : (
        <div className="space-y-1.5 px-4 py-3">
          {rows.map((r) => (
            <div key={r.key} className="grid grid-cols-[1fr_auto] items-center gap-2">
              <div className="min-w-0">
                <div className="truncate text-[12px]">{r.label}</div>
                <div className="mt-1">
                  <WeightBar value={r.weight.toNumber()} />
                </div>
              </div>
              <span className="tabular text-[12px] text-ink-2">{percent(r.weight, 1)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
