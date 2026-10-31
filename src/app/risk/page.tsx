/**
 * Risk (CLAUDE.md §7.4-§7.10), as figures rather than tables.
 *
 * Window descriptives are computed here from the cached TWR series, each beside
 * the S&P 500's own figure over the same days. Anything statistical —
 * regressions, VaR, factors, scenarios, liquidity — is read from
 * `analytics_snapshots`, written by the nightly Python job, and carries its
 * date in the section's meta line so a stale pack is visible.
 *
 * The brief's presentation rules still hold, in fewer words: alpha and beta
 * always carry their 95% range, scenario figures are labelled as estimates,
 * and VaR is withheld rather than guessed when history is short.
 */
import { Empty, Insufficient, Note, cn } from '@/components/ui/primitives';
import { Contributors } from '@/components/contributors';
import { DistributionChart } from '@/components/distribution-chart';
import { IntervalBar } from '@/components/interval-bar';
import { RollingChart, type RollingSeries } from '@/components/rolling-chart';
import { JumpLinks, PageHead, Section, Tile } from '@/components/scoreboard';
import {
  SPX_GBP,
  SPX_LOCAL,
  windowRegression,
  type RiskPayload,
  type VarPayload,
  type WindowBenchmarkStats,
} from '@/lib/analytics-types';
import { histogram, parseWindow, summariseWindow, windowReturns, windowSpec } from '@/lib/engine/windows';
import { money, percent, shortDate } from '@/lib/format';
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
    value_gbp: number;
    days_to_liquidate: Record<string, number | null>;
    flagged: boolean;
  }>;
}

/** A VaR figure is always a loss, whatever sign the method returned it in. */
const loss = (gbp: number | undefined | null) => (gbp === undefined || gbp === null ? null : -Math.abs(gbp));

const signedMoney = (v: number) => `${v > 0 ? '+' : ''}${money(v)}`;

/** 'gbpusd_up_10' → 'GBP/USD up 10'. The keys come from analytics/scenarios.py. */
const shockLabel = (key: string) => {
  const words = key.replace(/_/g, ' ').replace(/^gbpusd/, 'GBP/USD').replace(/^vix/, 'VIX');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

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

  const bench = market.benchmark;
  const inputs = { benchmarks: bench?.levels ?? {}, riskFreeDaily: market.riskFreeDaily };
  const summary = summariseWindow(overview.twr.series, window, inputs);
  const vsMarket = bench ? summary.benchmarks[bench.gbpLabel] : undefined;
  const returns = windowReturns(overview.twr.series, window);
  const bins = histogram(returns, Math.min(24, Math.max(8, Math.round(returns.length / 6))));
  const symbolOf = (id: number) => overview.instrumentById.get(id)?.symbol ?? `#${id}`;

  const regression = windowRegression(risk?.payload, window, SPX_GBP);
  const r = regression?.regression;

  // ---- VaR ----
  const varOk = varPack?.payload.status === 'ok' ? varPack.payload : null;
  // Keyed by confidence ('95', '99') then horizon ('1d', '10d') in analytics/var.py.
  const historical = (conf: string, horizon: string) => varOk?.methods?.[conf]?.[horizon]?.var.historical?.gbp;
  const var95 = loss(varOk?.primary?.var_95_1d_gbp);
  const cvar95 = loss(varOk?.primary?.cvar_95_1d_gbp);
  const var99 = loss(historical('99', '1d'));
  const var95_10 = loss(historical('95', '10d'));
  const windowVar = summary.var95 === null ? null : summary.var95 * overview.totalValueGbp.toNumber();

  const tail =
    varPack?.payload.component?.status === 'ok'
      ? [...varPack.payload.component.positions!].sort((a, b) => (b.share_of_var ?? 0) - (a.share_of_var ?? 0))
      : [];

  // ---- the benchmark comparisons, window first, inception if the window cannot fit ----
  const windowStats = risk?.payload.windows?.[window];
  const benchmarkStats = (key: string): { stats: WindowBenchmarkStats | null; scope: 'window' | 'inception' } => {
    if (windowStats && windowStats.status === 'ok' && windowStats.benchmarks[key]) {
      return { stats: windowStats.benchmarks[key]!, scope: 'window' };
    }
    const b = risk?.payload.benchmarks[key];
    return {
      stats: b
        ? {
            regression: b.regression,
            regression_note: null,
            tracking_error: b.tracking_error,
            information_ratio: b.information_ratio,
            benchmark_cumulative_return: null,
          }
        : null,
      scope: 'inception',
    };
  };

  const rollingSeries: RollingSeries[] = [];
  if (risk) {
    const rolling = risk.payload.rolling ?? {};
    for (const w of [21, 63, 252]) {
      const vol = rolling[`vol_${w}d`];
      if (vol) rollingSeries.push({ key: `vol${w}`, label: 'Volatility', window: w, dates: vol.dates, values: vol.values, format: 'percent' });
    }
    for (const w of [63, 126]) {
      const s = rolling[`sharpe_${w}d`];
      if (s) rollingSeries.push({ key: `sharpe${w}`, label: 'Sharpe', window: w, dates: s.dates, values: s.values, format: 'ratio', reference: 0 });
    }
    const spx = risk.payload.benchmarks[SPX_GBP];
    for (const w of [63, 126] as const) {
      const b = spx?.[`rolling_beta_${w}d`];
      if (b) rollingSeries.push({ key: `beta${w}`, label: 'Beta vs S&P 500 £', window: w, dates: b.dates, values: b.values, format: 'ratio', reference: 1 });
    }
  }

  const stressRows = scenarios
    ? [
        ...scenarios.payload.historical
          .filter((h) => h.status === 'ok' && h.modelled_pnl_gbp !== undefined)
          .map((h) => ({
            key: h.key,
            label: h.label,
            value: h.modelled_pnl_gbp!,
            sub: `${percent(h.modelled_return, 1, { signed: true })} · S&P ${percent(h.benchmark_return, 1, { signed: true })}`,
          })),
      ]
    : [];
  const shockRows = scenarios
    ? Object.entries(scenarios.payload.shocks).map(([name, s]) => ({
        key: name,
        label: shockLabel(name),
        value: s.modelled_pnl_gbp,
        sub: percent(s.modelled_return, 1, { signed: true }),
      }))
    : [];

  return (
    <div className="font-display mx-auto max-w-5xl space-y-4 pb-4">
      <PageHead title="Risk" window={window} basePath="/risk" />

      {summary.observations < 20 && (
        <Note>Only {summary.observations} days in this window, so annualised figures are withheld.</Note>
      )}

      {/* ---- headline figures, each beside the index ---- */}
      <section className="grid grid-cols-2 gap-2.5 md:grid-cols-3">
        <Tile
          label="Volatility"
          value={percent(summary.volatility, 1)}
          sub={vsMarket?.volatility == null ? spec.label : `S&P ${percent(vsMarket.volatility, 1)}`}
        />
        <Tile
          label="Sharpe"
          value={summary.sharpe === null ? '—' : summary.sharpe.toFixed(2)}
          sub={vsMarket?.sharpe == null ? spec.label : `S&P ${vsMarket.sharpe.toFixed(2)}`}
        />
        <Tile
          label="Max drawdown"
          value={percent(summary.maxDrawdown?.depth ?? null, 1)}
          valueTone={summary.maxDrawdown?.depth.isNegative() ? 'text-down' : undefined}
          sub={vsMarket?.maxDrawdown == null ? spec.label : `S&P ${percent(vsMarket.maxDrawdown, 1)}`}
        />
        <Tile
          label="Sortino"
          value={summary.sortino === null || !Number.isFinite(summary.sortino) ? '—' : summary.sortino.toFixed(2)}
          sub={`worst day ${percent(summary.worstDay, 1)}`}
        />
        <Tile
          label="Beta"
          value={r ? r.beta.toFixed(2) : '—'}
          sub={r ? `± ${(1.96 * r.beta_stderr).toFixed(2)} · R² ${percent(r.r_squared, 0)}` : 'awaiting nightly job'}
        />
        <Tile
          label="Alpha / yr"
          value={r ? percent(r.alpha_annualised, 1, { signed: true }) : '—'}
          sub={
            r ? (
              <IntervalBar
                point={r.alpha_annualised}
                low={r.alpha_ci95_low}
                high={r.alpha_ci95_high}
                format={(v) => percent(v, 0, { signed: true })}
              />
            ) : (
              'awaiting nightly job'
            )
          }
        />
      </section>
      {regression?.scope === 'inception' && (
        <p className="px-1 text-[11px] text-muted">Beta and alpha are since inception — too few days in {spec.label}.</p>
      )}

      <JumpLinks
        items={[
          ['#bad-days', 'Bad days'],
          ['#tail', 'Tail risk'],
          ['#stress', 'Stress'],
          ['#benchmarks', '£ vs $'],
          ['#rolling', 'Rolling'],
          ['#factors', 'Factors'],
          ['#liquidity', 'Liquidity'],
        ]}
      />

      <div className="grid gap-4 md:grid-cols-2">
        {/* ---- VaR ---- */}
        <Section id="bad-days" title="Bad days" meta={varPack ? `historical · ${shortDate(varPack.snapDate)}` : undefined}>
          {varOk ? (
            <>
              <div className="flex items-end justify-between">
                <div>
                  <div className="text-[12px] text-muted">1 day in 20 loses more than</div>
                  <div className="text-[32px] font-semibold leading-tight tracking-tight">{money(var95)}</div>
                </div>
                <div className="text-right">
                  <div className="text-[12px] text-muted">Average of those days</div>
                  <div className="text-[20px] font-semibold text-down">{money(cvar95)}</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-[11px] text-muted">1 in 100 days</div>
                  <div className="text-[17px] font-semibold">{money(var99)}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted">Over 10 days, 1 in 20</div>
                  <div className="text-[17px] font-semibold">{money(var95_10)}</div>
                </div>
              </div>
            </>
          ) : windowVar !== null ? (
            <div>
              <div className="text-[12px] text-muted">1 day in 20 · {spec.label} window</div>
              <div className="text-[32px] font-semibold leading-tight tracking-tight">{money(windowVar)}</div>
              <div className="text-[11px] text-muted">Full VaR needs a year of history.</div>
            </div>
          ) : (
            <Insufficient reason={varPack?.payload.message ?? 'VaR needs at least 252 days of history.'} />
          )}
          <div className="-mx-4">
            <DistributionChart bins={bins} var95={summary.var95} observations={returns.length} />
          </div>
        </Section>

        {/* ---- component VaR ---- */}
        <Section id="tail" title="Who carries the tail" meta="share of the bad-day loss">
          {tail.length === 0 ? (
            <Insufficient reason="Needs 60 overlapping days across the holdings." />
          ) : (
            <ul className="space-y-2.5">
              {tail.slice(0, 10).map((p) => (
                <li key={p.instrument_id} className="grid grid-cols-[4.5rem_1fr_3rem] items-center gap-3 text-[13px]">
                  <span className="truncate font-medium">{symbolOf(p.instrument_id)}</span>
                  <span className="h-2 rounded-full bg-surface-2">
                    <span
                      className="block h-full rounded-full bg-down/70"
                      style={{ width: `${Math.max(0, Math.min(1, p.share_of_var ?? 0)) * 100}%` }}
                    />
                  </span>
                  <span className="text-right">{percent(p.share_of_var, 0)}</span>
                  <span className="col-span-3 -mt-1.5 text-[11px] text-muted">
                    {percent(p.weight, 1)} of value · {money(-Math.abs(p.component_var_gbp))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* ---- scenarios ---- */}
        <Section id="stress" title="Stress tests" meta="estimates via beta, not forecasts">
          {!scenarios ? (
            <Empty>Awaiting the nightly job.</Empty>
          ) : (
            <>
              {stressRows.length > 0 && (
                <div className="-mx-4">
                  <div className="px-4 pb-1 text-[12px] text-muted">If history repeated</div>
                  <Contributors rows={stressRows} format={signedMoney} wideLabels />
                </div>
              )}
              {shockRows.length > 0 && (
                <div className="-mx-4">
                  <div className="px-4 pb-1 text-[12px] text-muted">If one thing moved</div>
                  <Contributors rows={shockRows} format={signedMoney} wideLabels />
                </div>
              )}
            </>
          )}
        </Section>

        {/* ---- GBP vs local benchmark ---- */}
        <Section id="benchmarks" title="S&P in £ and $" meta={risk ? `nightly · ${shortDate(risk.snapDate)}` : undefined}>
          {!risk ? (
            <Insufficient reason="The nightly analytics job has not run yet." />
          ) : (
            <div className="space-y-4">
              {[
                [SPX_GBP, 'In pounds', 'what you earned'],
                [SPX_LOCAL, 'In dollars', 'stock picking, FX removed'],
              ].map(([key, title, note]) => {
                const { stats, scope } = benchmarkStats(key!);
                const reg = stats?.regression;
                const capture = risk.payload.benchmarks[key!]?.capture;
                return (
                  <div key={key} className="space-y-2">
                    <div className="flex items-baseline justify-between">
                      <span className="text-[14px] font-semibold">{title}</span>
                      <span className="text-[11px] text-muted">
                        {note}
                        {scope === 'inception' && ' · since inception'}
                      </span>
                    </div>
                    {reg ? (
                      <>
                        <div className="flex items-baseline justify-between text-[12px]">
                          <span className="text-muted">Alpha / yr</span>
                          <span>{percent(reg.alpha_annualised, 1, { signed: true })}</span>
                        </div>
                        <IntervalBar
                          point={reg.alpha_annualised}
                          low={reg.alpha_ci95_low}
                          high={reg.alpha_ci95_high}
                          format={(v) => percent(v, 0, { signed: true })}
                        />
                      </>
                    ) : (
                      <div className="text-[12px] text-muted">{stats?.regression_note ?? 'No regression yet.'}</div>
                    )}
                    <div className="grid grid-cols-4 gap-2 text-[12px]">
                      <Mini label="Beta" value={reg ? reg.beta.toFixed(2) : '—'} />
                      <Mini label="Track. err." value={percent(stats?.tracking_error, 1)} />
                      <Mini label="Info ratio" value={stats?.information_ratio?.toFixed(2) ?? '—'} />
                      <Mini
                        label="Capture ↑/↓"
                        value={
                          capture
                            ? `${capture.up_capture?.toFixed(2) ?? '—'}/${capture.down_capture?.toFixed(2) ?? '—'}`
                            : '—'
                        }
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Section>
      </div>

      {/* ---- rolling ---- */}
      <Section id="rolling" title="Rolling" meta="is today like the average?">
        {!risk ? (
          <Empty>Awaiting the nightly job.</Empty>
        ) : (
          <div className="-mx-4">
            <RollingChart series={rollingSeries} />
          </div>
        )}
      </Section>

      <div className="grid gap-4 md:grid-cols-2">
        {/* ---- factors ---- */}
        <Section id="factors" title="Factor tilts" meta={factors ? `since inception · ${shortDate(factors.snapDate)}` : undefined}>
          {!factors ? (
            <Empty>Awaiting the nightly job.</Empty>
          ) : (
            Object.entries(factors.payload.fits).map(([region, fitted]) =>
              !fitted ? null : (
                <div key={region} className="-mx-4">
                  <div className="flex justify-between px-4 pb-1 text-[12px] text-muted">
                    <span>{region}</span>
                    <span>R² {percent(fitted.r_squared, 0)}</span>
                  </div>
                  <Contributors
                    rows={fitted.loadings.map((l) => ({
                      key: l.factor,
                      label: l.factor,
                      value: l.coefficient,
                      sub: Math.abs(l.tstat) < 1.96 ? 'not significant' : undefined,
                    }))}
                    format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`}
                  />
                </div>
              ),
            )
          )}
        </Section>

        {/* ---- liquidity ---- */}
        <Section id="liquidity" title="Days to sell" meta="at 10% of daily volume">
          {!liquidity ? (
            <Empty>Awaiting the nightly job.</Empty>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2">
                {['50pct', '90pct', '100pct'].map((key) => (
                  <div key={key}>
                    <div className="text-[11px] text-muted">{key.replace('pct', '%')} of it</div>
                    <div className="text-[20px] font-semibold">
                      {liquidity.payload.aggregate[key] === null ? '—' : `${liquidity.payload.aggregate[key]}d`}
                    </div>
                  </div>
                ))}
              </div>
              {liquidity.payload.flagged_count > 0 && (
                <ul className="space-y-1 text-[13px]">
                  {liquidity.payload.positions
                    .filter((p) => p.flagged)
                    .map((p) => (
                      <li key={p.instrument_id} className="flex justify-between">
                        <span className="font-medium">{p.symbol ?? symbolOf(p.instrument_id)}</span>
                        <span className="text-warn">{p.days_to_liquidate['10pct']?.toFixed(1) ?? '—'} days</span>
                      </li>
                    ))}
                </ul>
              )}
            </>
          )}
        </Section>
      </div>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className={cn('min-w-0')}>
      <div className="truncate text-[10px] text-muted">{label}</div>
      <div className="font-semibold">{value}</div>
    </div>
  );
}
