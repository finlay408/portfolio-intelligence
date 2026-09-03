/**
 * The risk pack (CLAUDE.md §7.4-§7.10).
 *
 * Descriptive figures for the selected window are computed here from the
 * cached TWR series, so they are as current as the last recompute. Anything
 * statistical — regressions, VaR, factors, scenarios, liquidity — is read from
 * `analytics_snapshots`, written by the nightly Python job, and carries its
 * computation date so a stale pack is visible rather than assumed current.
 *
 * Two presentation rules the brief insists on and this page implements:
 *   - alpha and beta appear with their standard errors and R², never as bare
 *     point estimates;
 *   - scenario results are labelled as estimates, in the panel, not in a
 *     footnote nobody reads.
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
} from '@/components/ui/primitives';
import { DistributionChart } from '@/components/distribution-chart';
import { IntervalBar } from '@/components/interval-bar';
import { RollingChart, type RollingSeries } from '@/components/rolling-chart';
import { WindowPicker } from '@/components/window-picker';
import {
  SPX_GBP,
  type RiskPayload,
  type VarPayload,
  type WindowBenchmarkStats,
} from '@/lib/analytics-types';
import {
  histogram,
  parseWindow,
  summariseWindow,
  windowReturns,
  windowSpec,
} from '@/lib/engine/windows';
import { estimate, money, number as fmtNumber, percent, shortDate } from '@/lib/format';
import { getAnalytics, getMarketContext, getOverview } from '@/lib/portfolio';

export const dynamic = 'force-dynamic';

interface FactorPayload {
  caveat: string;
  fits: Record<
    string,
    {
      region: string;
      observations: number;
      r_squared: number;
      alpha_annualised: number;
      alpha_stderr_annualised: number;
      loadings: Array<{ factor: string; coefficient: number; stderr: number; tstat: number }>;
    } | null
  >;
}

interface ScenarioPayload {
  disclaimer: string;
  historical: Array<{
    key: string;
    label: string;
    status: string;
    modelled_return?: number;
    modelled_pnl_gbp?: number;
    modelled_trough?: number;
    portfolio_beta?: number;
    benchmark_return?: number;
  }>;
  shocks: Record<string, { modelled_return: number; modelled_pnl_gbp: number }>;
}

interface LiquidityPayload {
  flag_threshold_days: number;
  flagged_count: number;
  aggregate: Record<string, number | null | string>;
  positions: Array<{
    instrument_id: number;
    symbol: string | null;
    exchange_mic: string | null;
    value_gbp: number;
    adv_20d: number | null;
    days_to_liquidate: Record<string, number | null>;
    flagged: boolean;
    unknown_liquidity: boolean;
  }>;
  caveat: string;
}

/** A VaR figure is always a loss, so it is rendered negative regardless of the
 *  sign convention the method returned it in. */
function loss(gbp: number | undefined): string {
  return gbp === undefined ? '—' : money(-Math.abs(gbp));
}

const benchmarkName = (key: string) =>
  key.replace('_gbp', ' (GBP)').replace('_local', ' (local)').replace('SPX', 'S&P 500');

export default async function RiskPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string | string[] }>;
}) {
  const window = parseWindow((await searchParams).window);
  const spec = windowSpec(window);

  const [overview, market, risk, varPack, factors, scenarios, liquidity] = await Promise.all([
    getOverview(),
    getMarketContext('SPX'),
    getAnalytics<RiskPayload>('risk'),
    getAnalytics<VarPayload>('var'),
    getAnalytics<FactorPayload>('factor'),
    getAnalytics<ScenarioPayload>('scenario'),
    getAnalytics<LiquidityPayload>('liquidity'),
  ]);

  const inputs = { benchmarks: market.benchmark?.levels ?? {}, riskFreeDaily: market.riskFreeDaily };
  const summary = summariseWindow(overview.twr.series, window, inputs);
  const returns = windowReturns(overview.twr.series, window);
  const bins = histogram(returns, Math.min(24, Math.max(8, Math.round(returns.length / 6))));

  const symbolOf = (id: number) =>
    overview.holdings.find((h) => h.position.instrumentId === id)?.symbol ?? `#${id}`;

  // The window's regressions from the nightly job, falling back to since
  // inception (and saying so) when the payload predates windows or the window
  // is too short to fit.
  const windowStats = risk?.payload.windows?.[window];
  const benchmarkRows: Array<[string, WindowBenchmarkStats | null, 'window' | 'inception']> = risk
    ? windowStats && windowStats.status === 'ok'
      ? Object.entries(windowStats.benchmarks).map(([k, b]) => [k, b, 'window'])
      : Object.entries(risk.payload.benchmarks).map(([k, b]) => [
          k,
          {
            regression: b.regression,
            regression_note: null,
            tracking_error: b.tracking_error,
            information_ratio: b.information_ratio,
            benchmark_cumulative_return: null,
          },
          'inception',
        ])
    : [];

  const rollingSeries: RollingSeries[] = [];
  if (risk) {
    const r = risk.payload.rolling ?? {};
    for (const w of [21, 63, 252]) {
      const vol = r[`vol_${w}d`];
      if (vol) rollingSeries.push({ key: `vol${w}`, label: 'Volatility', window: w, dates: vol.dates, values: vol.values, format: 'percent' });
    }
    for (const w of [63, 126]) {
      const s = r[`sharpe_${w}d`];
      if (s) rollingSeries.push({ key: `sharpe${w}`, label: 'Sharpe', window: w, dates: s.dates, values: s.values, format: 'ratio', reference: 0 });
    }
    const spx = risk.payload.benchmarks[SPX_GBP];
    for (const w of [63, 126] as const) {
      const b = spx?.[`rolling_beta_${w}d`];
      if (b) rollingSeries.push({ key: `beta${w}`, label: 'Beta vs S&P 500 (GBP)', window: w, dates: b.dates, values: b.values, format: 'ratio', reference: 1 });
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <WindowPicker current={window} basePath="/risk" />
        <span className="text-[11px] text-muted">
          {summary.from && summary.to
            ? `${shortDate(summary.from)} – ${shortDate(summary.to)} · ${summary.observations} trading days`
            : spec.description}
          {risk && ` · regressions computed ${shortDate(risk.snapDate)}`}
          {market.riskFreeSource ? ` · risk-free ${market.riskFreeSource}` : ' · risk-free 0 until FRED is loaded'}
        </span>
      </div>

      {/* ---- window descriptives, live from the TWR series ---- */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4 xl:grid-cols-8">
        {[
          ['Return', percent(summary.ret, 1, { signed: true })],
          ['Ann. return', summary.annualisedReturn === null ? '—' : percent(summary.annualisedReturn, 1, { signed: true })],
          ['Volatility', percent(summary.volatility, 1)],
          ['Sharpe', summary.sharpe?.toFixed(2) ?? '—'],
          ['Sortino', summary.sortino?.toFixed(2) ?? '—'],
          ['Max DD', percent(summary.maxDrawdown?.depth ?? null, 1)],
          ['Best day', percent(summary.bestDay, 2, { signed: true })],
          ['Worst day', percent(summary.worstDay, 2, { signed: true })],
        ].map(([label, value]) => (
          <div key={label} className="bg-surface">
            <Stat label={label!} value={value!} />
          </div>
        ))}
      </div>
      {summary.observations < 20 && (
        <Note>
          Only {summary.observations} daily returns in this window, so annualised figures are withheld.
          A Sharpe ratio on a fortnight of data is not a measurement.
        </Note>
      )}

      <div className="grid gap-3 xl:grid-cols-2 xl:items-start">
        {/* ---- distribution ---- */}
        <Card
          title="Daily return distribution"
          subtitle={`${spec.label} window · the shape behind the VaR figure`}
          footnote={`Skew ${fmtNumber(risk?.payload.since_inception.skew ?? null, 2)} and excess kurtosis ${fmtNumber(risk?.payload.since_inception.excess_kurtosis ?? null, 2)} since inception. Positive kurtosis means fatter tails than a normal distribution — more extreme days than the volatility figure implies.`}
        >
          <DistributionChart bins={bins} var95={summary.var95} observations={returns.length} />
        </Card>

        {/* ---- benchmarks for the window ---- */}
        <Card
          title="Versus benchmarks"
          subtitle={
            benchmarkRows[0]?.[2] === 'inception'
              ? `since inception — the ${spec.label} window has too few days for a regression`
              : `${spec.label} window · GBP-translated and local-currency side by side (§3.3)`
          }
          footnote="The GBP series is the return you earned. The local-currency series is the right comparison for judging security selection, because it is not moved by GBP/USD. Alpha is shown with its 95% range: read the range, not the midpoint."
        >
          {benchmarkRows.length === 0 ? (
            <Insufficient reason="The nightly analytics job has not run yet." />
          ) : (
            <div className="divide-y divide-line">
              {benchmarkRows.map(([name, b]) => (
                <div key={name} className="px-4 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="text-[12px] font-medium">
                      {benchmarkName(name)}
                      {name.endsWith('_gbp') && (
                        <Badge tone="accent" title="Default view: the return actually earned">
                          default
                        </Badge>
                      )}
                    </div>
                    <div className="text-[11px] text-muted">
                      {b?.regression ? `n=${b.regression.observations} · R² ${percent(b.regression.r_squared, 0)}` : (b?.regression_note ?? '—')}
                    </div>
                  </div>
                  {b?.regression && (
                    <div className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2">
                      <div>
                        <div className="flex items-baseline justify-between text-[11px] text-muted">
                          <span>Alpha, annualised</span>
                          <span className="tabular text-ink">
                            {estimate(b.regression.alpha_annualised, b.regression.alpha_stderr_annualised)}
                          </span>
                        </div>
                        <IntervalBar
                          className="mt-1"
                          point={b.regression.alpha_annualised}
                          low={b.regression.alpha_ci95_low}
                          high={b.regression.alpha_ci95_high}
                          format={(v) => percent(v, 0, { signed: true })}
                        />
                      </div>
                      <div>
                        <div className="flex items-baseline justify-between text-[11px] text-muted">
                          <span>Beta</span>
                          <span className="tabular text-ink">
                            {b.regression.beta.toFixed(2)} ± {(1.96 * b.regression.beta_stderr).toFixed(2)}
                          </span>
                        </div>
                        <IntervalBar
                          className="mt-1"
                          point={b.regression.beta}
                          low={b.regression.beta_ci95_low}
                          high={b.regression.beta_ci95_high}
                          format={(v) => v.toFixed(2)}
                        />
                      </div>
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
                    <span>
                      Tracking error <span className="tabular text-ink">{percent(b?.tracking_error, 1)}</span>
                    </span>
                    <span>
                      Information ratio <span className="tabular text-ink">{b?.information_ratio?.toFixed(2) ?? '—'}</span>
                    </span>
                    {risk?.payload.benchmarks[name]?.capture && (
                      <span>
                        Capture up/down (monthly, inception){' '}
                        <span className="tabular text-ink">
                          {risk.payload.benchmarks[name]!.capture.up_capture?.toFixed(2) ?? '—'} /{' '}
                          {risk.payload.benchmarks[name]!.capture.down_capture?.toFixed(2) ?? '—'}
                        </span>
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* ---- rolling ---- */}
      <Card
        title="Rolling risk"
        subtitle="is the portfolio today the one the headline figures describe?"
        footnote="Each point is the statistic over the trailing window ending that day. A flat line means the since-inception figure is representative; a line that has moved means it is not, and the right-hand edge is the number to trust."
      >
        {!risk ? (
          <Empty>Awaiting the nightly job.</Empty>
        ) : (
          <RollingChart series={rollingSeries} />
        )}
      </Card>

      {/* ---- VaR ---- */}
      <div className="grid gap-3 xl:grid-cols-[1fr_1fr]">
        <Card
          title="Value at Risk"
          subtitle="three methods, 95% and 99%, 1 and 10 days · since inception"
          footnote="Historical is the primary figure. Parametric understates the tail — it is shown for contrast. Cornish-Fisher adjusts the normal quantile for skew and kurtosis and is the best compromise. 10-day figures use square-root-of-time scaling, which assumes independence and is therefore optimistic."
        >
          {varPack?.payload.status !== 'ok' || !varPack.payload.methods ? (
            <Insufficient
              reason={
                varPack?.payload.message ??
                'VaR needs at least 252 daily observations. Below that it measures nothing.'
              }
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Conf.</Th>
                  <Th>Horizon</Th>
                  <Th align="right">Historical</Th>
                  <Th align="right" className="hidden sm:table-cell">Parametric</Th>
                  <Th align="right">Cornish-Fisher</Th>
                  <Th align="right">Exp. shortfall</Th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(varPack.payload.methods).flatMap(([confidence, horizons]) =>
                  Object.entries(horizons).map(([horizon, data]) => (
                    <Tr key={`${confidence}-${horizon}`}>
                      <Td>{confidence}%</Td>
                      <Td>{horizon}</Td>
                      <Td align="right" numeric className="text-down">
                        {loss(data.var.historical?.gbp)}
                      </Td>
                      <Td align="right" numeric className="hidden text-muted sm:table-cell">
                        {loss(data.var.parametric?.gbp)}
                      </Td>
                      <Td align="right" numeric>
                        {loss(data.var.cornish_fisher?.gbp)}
                      </Td>
                      <Td align="right" numeric className="text-down">
                        {loss(data.cvar.historical?.gbp)}
                      </Td>
                    </Tr>
                  )),
                )}
              </tbody>
            </Table>
          )}
        </Card>

        <Card
          title="Component VaR"
          subtitle="which position carries the tail risk"
          footnote="Components sum to the portfolio VaR, so a share of 40% means that holding is 40% of the tail. This is the actionable output of the VaR section."
        >
          {varPack?.payload.component?.status !== 'ok' ? (
            <Insufficient reason="Needs at least 60 overlapping daily observations across the holdings." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Position</Th>
                  <Th align="right">Weight</Th>
                  <Th align="right" className="hidden sm:table-cell">Standalone vol</Th>
                  <Th align="right">Component VaR</Th>
                  <Th align="right">Share</Th>
                </tr>
              </thead>
              <tbody>
                {varPack.payload.component.positions!.map((p) => (
                  <Tr key={p.instrument_id}>
                    <Td>{symbolOf(p.instrument_id)}</Td>
                    <Td align="right" numeric>
                      {percent(p.weight, 1)}
                    </Td>
                    <Td align="right" numeric className="hidden sm:table-cell">
                      {percent(p.standalone_vol_annualised, 1)}
                    </Td>
                    <Td align="right" numeric className="text-down">
                      {money(-Math.abs(p.component_var_gbp))}
                    </Td>
                    <Td align="right" numeric>
                      <div className="flex items-center justify-end gap-2">
                        <div className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-surface-2 sm:block">
                          <div className="h-full bg-down/70" style={{ width: `${Math.max(0, Math.min(1, p.share_of_var ?? 0)) * 100}%` }} />
                        </div>
                        {percent(p.share_of_var, 0)}
                      </div>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>

      {/* ---- factors ---- */}
      <Card
        title="Factor exposures"
        subtitle="Fama-French 5 plus momentum, Ken French Data Library · since inception"
        footnote={factors?.payload.caveat}
      >
        {!factors ? (
          <Empty>Run <code className="text-ink">python analytics/run_nightly.py --job=factors</code> first.</Empty>
        ) : (
          <div className="space-y-3 px-4 py-3">
            {Object.entries(factors.payload.fits).map(([region, fitted]) =>
              !fitted ? null : (
                <div key={region}>
                  <div className="mb-1.5 flex flex-wrap items-baseline gap-2">
                    <span className="text-[12px] font-medium">{region}</span>
                    <span className="text-[11px] text-muted">
                      R² {percent(fitted.r_squared, 0)} · n={fitted.observations} · alpha{' '}
                      {estimate(fitted.alpha_annualised, fitted.alpha_stderr_annualised)}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {fitted.loadings.map((l) => (
                      <div
                        key={l.factor}
                        className="rounded border border-line px-2 py-1"
                        title={`t = ${l.tstat.toFixed(2)}`}
                      >
                        <div className="text-[10px] text-muted">{l.factor}</div>
                        <div className="tabular text-[12px]">
                          {l.coefficient.toFixed(2)}
                          <span className="ml-1 text-[10px] text-muted">±{(1.96 * l.stderr).toFixed(2)}</span>
                        </div>
                        {Math.abs(l.tstat) < 1.96 && <div className="text-[9px] text-muted">n.s.</div>}
                      </div>
                    ))}
                  </div>
                </div>
              ),
            )}
          </div>
        )}
      </Card>

      {/* ---- scenarios ---- */}
      <div className="grid gap-3 xl:grid-cols-2">
        <Card
          title="Historical replay"
          subtitle="today's holdings through past stress windows"
          footnote={scenarios?.payload.disclaimer}
        >
          {!scenarios ? (
            <Empty>Awaiting the nightly job.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Window</Th>
                  <Th align="right" className="hidden sm:table-cell">Benchmark</Th>
                  <Th align="right" className="hidden sm:table-cell">Portfolio β</Th>
                  <Th align="right">Modelled</Th>
                  <Th align="right">P&L</Th>
                </tr>
              </thead>
              <tbody>
                {scenarios.payload.historical.map((h) => (
                  <Tr key={h.key}>
                    <Td className="whitespace-normal">{h.label}</Td>
                    <Td align="right" numeric className="hidden sm:table-cell">
                      {h.status === 'ok' ? percent(h.benchmark_return, 1, { signed: true }) : '—'}
                    </Td>
                    <Td align="right" numeric className="hidden sm:table-cell">
                      {h.portfolio_beta?.toFixed(2) ?? '—'}
                    </Td>
                    <Td align="right" numeric className="text-down">
                      {h.status === 'ok' ? percent(h.modelled_return, 1, { signed: true }) : 'no history'}
                    </Td>
                    <Td align="right" numeric className="text-down">
                      {h.status === 'ok' ? money(h.modelled_pnl_gbp!) : '—'}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card
          title="Factor shocks"
          subtitle="propagated through betas — estimates, not forecasts"
          footnote={scenarios?.payload.disclaimer}
        >
          {!scenarios ? (
            <Empty>Awaiting the nightly job.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Shock</Th>
                  <Th align="right">Modelled return</Th>
                  <Th align="right">P&L</Th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(scenarios.payload.shocks).map(([name, s]) => (
                  <Tr key={name}>
                    <Td>{name.replace(/_/g, ' ')}</Td>
                    <Td align="right" numeric className={s.modelled_return < 0 ? 'text-down' : 'text-up'}>
                      {percent(s.modelled_return, 1, { signed: true })}
                    </Td>
                    <Td align="right" numeric className={s.modelled_pnl_gbp < 0 ? 'text-down' : 'text-up'}>
                      {money(s.modelled_pnl_gbp)}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>

      {/* ---- liquidity ---- */}
      <Card
        title="Liquidity stress"
        subtitle={
          liquidity
            ? `days to liquidate · ${liquidity.payload.flagged_count} position(s) over ${liquidity.payload.flag_threshold_days} days`
            : undefined
        }
        footnote={liquidity?.payload.caveat}
      >
        {!liquidity ? (
          <Empty>Awaiting the nightly job.</Empty>
        ) : (
          <>
            <div className="flex flex-wrap gap-4 border-b border-line px-4 py-2 text-[12px]">
              {['50pct', '90pct', '100pct'].map((key) => (
                <span key={key}>
                  <span className="text-muted">{key.replace('pct', '%')} of book: </span>
                  <span className="tabular">
                    {liquidity.payload.aggregate[key] === null
                      ? 'unknown'
                      : `${liquidity.payload.aggregate[key]} days`}
                  </span>
                </span>
              ))}
            </div>
            <Table>
              <thead>
                <tr>
                  <Th>Position</Th>
                  <Th className="hidden sm:table-cell">Venue</Th>
                  <Th align="right">Value</Th>
                  <Th align="right" className="hidden sm:table-cell">ADV 20d</Th>
                  <Th align="right">@10%</Th>
                  <Th align="right" className="hidden sm:table-cell">@20%</Th>
                  <Th align="right" className="hidden sm:table-cell">@30%</Th>
                </tr>
              </thead>
              <tbody>
                {liquidity.payload.positions.map((p) => (
                  <Tr key={p.instrument_id}>
                    <Td>
                      {p.symbol ?? symbolOf(p.instrument_id)}
                      {p.flagged && (
                        <Badge tone="warn" title="More than five days to exit at 10% participation">
                          illiquid
                        </Badge>
                      )}
                    </Td>
                    <Td className="hidden sm:table-cell">{p.exchange_mic ?? '—'}</Td>
                    <Td align="right" numeric>
                      {money(p.value_gbp)}
                    </Td>
                    <Td align="right" numeric className="hidden sm:table-cell">
                      {p.adv_20d ? fmtNumber(p.adv_20d, 0) : 'unknown'}
                    </Td>
                    {(['10pct', '20pct', '30pct'] as const).map((rate, i) => (
                      <Td key={rate} align="right" numeric className={i > 0 ? 'hidden sm:table-cell' : undefined}>
                        {p.days_to_liquidate[rate] === null || p.days_to_liquidate[rate] === undefined
                          ? '—'
                          : `${p.days_to_liquidate[rate]!.toFixed(1)}d`}
                      </Td>
                    ))}
                  </Tr>
                ))}
              </tbody>
            </Table>
          </>
        )}
      </Card>
    </div>
  );
}
