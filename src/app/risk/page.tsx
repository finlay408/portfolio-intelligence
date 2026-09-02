/**
 * The risk pack (CLAUDE.md §7.4-§7.10).
 *
 * Everything here is read from `analytics_snapshots`, written by the nightly
 * Python job. The page computes nothing, which is what keeps it fast, and it
 * shows the computation timestamp so a stale pack is visible rather than
 * assumed current.
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
import { estimate, money, number as fmtNumber, percent, shortDate } from '@/lib/format';
import { getAnalytics, getOverview } from '@/lib/portfolio';

export const dynamic = 'force-dynamic';

interface RiskPayload {
  observations: number;
  since_inception: {
    annualised_return: number | null;
    annualised_volatility: number | null;
    sharpe: number | null;
    sortino: number | null;
    calmar: number | null;
    skew: number | null;
    excess_kurtosis: number | null;
    positive_days_pct: number | null;
    worst_day: number | null;
    best_day: number | null;
    max_drawdown: {
      depth: number | null;
      peak_date: string | null;
      trough_date: string | null;
      recovered_date: string | null;
      recovery_days: number | null;
    };
  };
  benchmarks: Record<
    string,
    {
      regression: {
        alpha_annualised: number;
        alpha_stderr_annualised: number;
        alpha_tstat: number;
        alpha_ci95_low: number;
        alpha_ci95_high: number;
        beta: number;
        beta_stderr: number;
        r_squared: number;
        observations: number;
      } | null;
      tracking_error: number | null;
      information_ratio: number | null;
      capture: { up_capture: number | null; down_capture: number | null; up_months: number; down_months: number };
    }
  >;
}

interface VarPayload {
  status: string;
  message?: string;
  observations?: number;
  methods?: Record<
    string,
    Record<string, { var: Record<string, { fraction: number; gbp: number }>; cvar: Record<string, { fraction: number; gbp: number }> }>
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

export default async function RiskPage() {
  const [overview, risk, varPack, factors, scenarios, liquidity] = await Promise.all([
    getOverview(),
    getAnalytics<RiskPayload>('risk'),
    getAnalytics<VarPayload>('var'),
    getAnalytics<FactorPayload>('factor'),
    getAnalytics<ScenarioPayload>('scenario'),
    getAnalytics<LiquidityPayload>('liquidity'),
  ]);

  if (!risk) {
    return (
      <Note>
        The nightly analytics job has not run yet. Run{' '}
        <code className="text-ink">python analytics/run_nightly.py</code> after{' '}
        <code className="text-ink">npm run recompute -- --from=inception</code>.
      </Note>
    );
  }

  const si = risk.payload.since_inception;
  const symbolOf = (id: number) =>
    overview.holdings.find((h) => h.position.instrumentId === id)?.symbol ?? `#${id}`;

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-muted">
        Computed {shortDate(risk.snapDate)} from {risk.payload.observations} daily observations ·
        risk-free rate is SONIA, not US T-bills
      </p>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4 xl:grid-cols-8">
        {[
          ['Ann. return', percent(si.annualised_return, 1, { signed: true })],
          ['Volatility', percent(si.annualised_volatility, 1)],
          ['Sharpe', si.sharpe?.toFixed(2) ?? '—'],
          ['Sortino', si.sortino?.toFixed(2) ?? '—'],
          ['Calmar', si.calmar?.toFixed(2) ?? '—'],
          ['Max DD', percent(si.max_drawdown.depth, 1)],
          ['Skew', si.skew?.toFixed(2) ?? '—'],
          ['Excess kurtosis', si.excess_kurtosis?.toFixed(2) ?? '—'],
        ].map(([label, value]) => (
          <div key={label} className="bg-surface">
            <Stat label={label!} value={value!} />
          </div>
        ))}
      </div>

      {/* ---- benchmarks, both SPX variants side by side ---- */}
      <Card
        title="Versus benchmarks"
        subtitle="GBP-translated and local-currency, side by side (§3.3)"
        footnote="The GBP series is the return you earned. The local-currency series is the right comparison for judging security selection, because it is not moved by GBP/USD."
      >
        <Table>
          <thead>
            <tr>
              <Th>Benchmark</Th>
              <Th align="right">Alpha (ann.)</Th>
              <Th align="right">Beta</Th>
              <Th align="right">R²</Th>
              <Th align="right">Tracking error</Th>
              <Th align="right">Info ratio</Th>
              <Th align="right">Up capture</Th>
              <Th align="right">Down capture</Th>
              <Th align="right">n</Th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(risk.payload.benchmarks).map(([name, b]) => (
              <Tr key={name}>
                <Td>
                  {name.replace('_', ' ')}
                  {name.endsWith('_gbp') && (
                    <Badge tone="accent" title="Default view: the return actually earned">
                      default
                    </Badge>
                  )}
                </Td>
                <Td align="right" numeric>
                  {b.regression
                    ? estimate(b.regression.alpha_annualised, b.regression.alpha_stderr_annualised)
                    : '—'}
                  {b.regression && Math.abs(b.regression.alpha_tstat) < 1.96 && (
                    <div className="text-[10px] text-muted">not significant</div>
                  )}
                </Td>
                <Td align="right" numeric>
                  {b.regression
                    ? `${b.regression.beta.toFixed(2)} ± ${(1.96 * b.regression.beta_stderr).toFixed(2)}`
                    : '—'}
                </Td>
                <Td align="right" numeric>
                  {b.regression ? percent(b.regression.r_squared, 0) : '—'}
                </Td>
                <Td align="right" numeric>
                  {percent(b.tracking_error, 1)}
                </Td>
                <Td align="right" numeric>
                  {b.information_ratio?.toFixed(2) ?? '—'}
                </Td>
                <Td align="right" numeric>
                  {b.capture.up_capture?.toFixed(2) ?? '—'}
                  <div className="text-[10px] text-muted">{b.capture.up_months}m</div>
                </Td>
                <Td align="right" numeric>
                  {b.capture.down_capture?.toFixed(2) ?? '—'}
                  <div className="text-[10px] text-muted">{b.capture.down_months}m</div>
                </Td>
                <Td align="right" numeric>
                  {b.regression?.observations ?? '—'}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>

      {/* ---- VaR ---- */}
      <div className="grid gap-3 xl:grid-cols-[1fr_1fr]">
        <Card
          title="Value at Risk"
          subtitle="three methods, 95% and 99%, 1 and 10 days"
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
                  <Th>Confidence</Th>
                  <Th>Horizon</Th>
                  <Th align="right">Historical</Th>
                  <Th align="right">Parametric</Th>
                  <Th align="right">Cornish-Fisher</Th>
                  <Th align="right">Expected shortfall</Th>
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
                      <Td align="right" numeric className="text-muted">
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
                  <Th align="right">Standalone vol</Th>
                  <Th align="right">Component VaR</Th>
                  <Th align="right">Share of risk</Th>
                </tr>
              </thead>
              <tbody>
                {varPack.payload.component.positions!.map((p) => (
                  <Tr key={p.instrument_id}>
                    <Td>{symbolOf(p.instrument_id)}</Td>
                    <Td align="right" numeric>
                      {percent(p.weight, 1)}
                    </Td>
                    <Td align="right" numeric>
                      {percent(p.standalone_vol_annualised, 1)}
                    </Td>
                    <Td align="right" numeric className="text-down">
                      {money(-Math.abs(p.component_var_gbp))}
                    </Td>
                    <Td align="right" numeric>
                      {percent(p.share_of_var, 0)}
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
        subtitle="Fama-French 5 plus momentum, Ken French Data Library"
        footnote={factors?.payload.caveat}
      >
        {!factors ? (
          <Empty>Run <code className="text-ink">python analytics/run_nightly.py --job=factors</code> first.</Empty>
        ) : (
          <div className="space-y-3 px-4 py-3">
            {Object.entries(factors.payload.fits).map(([region, fitted]) =>
              !fitted ? null : (
                <div key={region}>
                  <div className="mb-1.5 flex items-baseline gap-2">
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
                          <span className="ml-1 text-[10px] text-muted">
                            ±{(1.96 * l.stderr).toFixed(2)}
                          </span>
                        </div>
                        {Math.abs(l.tstat) < 1.96 && (
                          <div className="text-[9px] text-muted">n.s.</div>
                        )}
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
                  <Th align="right">Benchmark</Th>
                  <Th align="right">Portfolio β</Th>
                  <Th align="right">Modelled</Th>
                  <Th align="right">P&L</Th>
                </tr>
              </thead>
              <tbody>
                {scenarios.payload.historical.map((h) => (
                  <Tr key={h.key}>
                    <Td>{h.label}</Td>
                    <Td align="right" numeric>
                      {h.status === 'ok' ? percent(h.benchmark_return, 1, { signed: true }) : '—'}
                    </Td>
                    <Td align="right" numeric>
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
                  <Th>Venue</Th>
                  <Th align="right">Value</Th>
                  <Th align="right">ADV 20d</Th>
                  <Th align="right">@10%</Th>
                  <Th align="right">@20%</Th>
                  <Th align="right">@30%</Th>
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
                    <Td>{p.exchange_mic ?? '—'}</Td>
                    <Td align="right" numeric>
                      {money(p.value_gbp)}
                    </Td>
                    <Td align="right" numeric>
                      {p.adv_20d ? fmtNumber(p.adv_20d, 0) : 'unknown'}
                    </Td>
                    {['10pct', '20pct', '30pct'].map((rate) => (
                      <Td key={rate} align="right" numeric>
                        {p.days_to_liquidate[rate] === null
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
