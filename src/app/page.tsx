/**
 * The overview (CLAUDE.md §12) — a scoreboard, read on a phone.
 *
 * The owner opens this page and little else, so it carries a headline figure
 * from every other page — risk, attribution, rotation, macro — and almost no
 * prose. Each figure sits beside the S&P 500's equivalent over the same days,
 * because "is that good?" is always answered by "compared with what?". The
 * explanations live one tap away on the page each section links to.
 *
 * Every performance figure is computed over a selectable trailing window
 * (default 3M), carried in the URL so the page stays server-rendered. TWR and
 * MWR are still shown together and labelled (§7.2); uncertainty is still
 * shown (beta carries its range); stale data is still flagged.
 */
import Link from 'next/link';
import { Badge, Empty, FreshnessBadge, Note, Table, Td, Th, Tr, WeightBar, cn } from '@/components/ui/primitives';
import { Contributors } from '@/components/contributors';
import { JumpLinks, MacroCard, RaceCard, Section, Tile, VersusBar } from '@/components/scoreboard';
import { WindowPicker } from '@/components/window-picker';
import { MACRO_HEADLINE, QUADRANTS, quadrantMoves } from '@/lib/market-views';
import type { RrgSeries } from '@/components/rrg-chart';
import { SPX_GBP, windowRegression, type RiskPayload, type VarPayload } from '@/lib/analytics-types';
import { RESIDUAL_KEY, rankContributors } from '@/lib/engine/attribution';
import { parseWindow, performanceSeries, summariseWindow, windowSpec } from '@/lib/engine/windows';
import { directionClass, money, percent, shortDate } from '@/lib/format';
import {
  getAnalytics,
  getAttribution,
  getMacroTiles,
  getMarketContext,
  getOverview,
  getPendingActions,
  getUpcomingEarnings,
  type HoldingRow,
} from '@/lib/portfolio';

export const dynamic = 'force-dynamic';

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string | string[] }>;
}) {
  const window = parseWindow((await searchParams).window);
  const spec = windowSpec(window);

  const [overview, market, risk, varPack, rrg, macro, pending, earnings] = await Promise.all([
    getOverview(),
    getMarketContext('SPX'),
    getAnalytics<RiskPayload>('risk'),
    getAnalytics<VarPayload>('var'),
    getAnalytics<{ status: string; series: RrgSeries[] }>('rrg'),
    getMacroTiles(MACRO_HEADLINE.map((m) => m.id)),
    getPendingActions(),
    getUpcomingEarnings(),
  ]);

  // ---- the window, you against the index ----
  const bench = market.benchmark;
  const inputs = { benchmarks: bench?.levels ?? {}, riskFreeDaily: market.riskFreeDaily };
  const summary = summariseWindow(overview.twr.series, window, inputs);
  const vsMarket = bench ? summary.benchmarks[bench.gbpLabel] : undefined;
  const chartData = performanceSeries(overview.twr.series, window, bench?.levels ?? {}).map((p) => ({
    date: p.date,
    you: p.portfolio,
    market: bench ? (p.benchmarks[bench.gbpLabel] ?? null) : null,
  }));

  // The index's last session in pounds, to put today's move in context.
  const gbpLevels = bench?.levels[bench.gbpLabel] ?? [];
  const marketDay =
    gbpLevels.length >= 2 ? gbpLevels.at(-1)!.level / gbpLevels.at(-2)!.level - 1 : null;

  const regression = windowRegression(risk?.payload, window, SPX_GBP);
  const effectiveN = overview.concentration.effectiveN;
  const concentrated = effectiveN !== null && effectiveN.lessThan(6);

  // ---- attribution over the same window ----
  const attribution = summary.from ? await getAttribution(undefined, summary.from) : null;
  const ranked = attribution ? rankContributors(attribution.grids.position!, 4) : null;
  const contributorRows = (rows: Array<[string, { total: { toNumber(): number } }]>) =>
    rows
      .filter(([k]) => k !== RESIDUAL_KEY)
      .map(([k, p]) => ({
        key: k,
        label: attribution?.labels.get(k) ?? k,
        value: p.total.toNumber(),
        href: `/positions/${k}`,
      }));

  // ---- risk ----
  const varOk = varPack?.payload.status === 'ok' ? varPack.payload.primary! : null;
  const badDay = varOk
    ? -Math.abs(varOk.var_95_1d_gbp)
    : summary.var95 !== null
      ? summary.var95 * overview.totalValueGbp.toNumber()
      : null;
  const badDayAvg = varOk ? -Math.abs(varOk.cvar_95_1d_gbp) : null;
  const tail =
    varPack?.payload.component?.status === 'ok'
      ? [...varPack.payload.component.positions!]
          .filter((p) => p.share_of_var !== null && p.share_of_var > 0)
          .sort((a, b) => b.share_of_var! - a.share_of_var!)
      : [];
  const tailTop = tail.slice(0, 3).map((p) => ({
    label: overview.instrumentById.get(p.instrument_id)?.symbol ?? `#${p.instrument_id}`,
    share: p.share_of_var!,
  }));
  const tailRest = tail.slice(3).reduce((a, p) => a + p.share_of_var!, 0);

  // ---- rotation ----
  const rotation = rrg?.payload.status === 'ok' ? rrg.payload.series.filter((s) => s.tail.length > 0) : [];
  const moved = quadrantMoves(rotation);

  // Earnings for what you hold now, not for every instrument ever traded.
  const held = new Set(overview.holdings.map((h) => h.position.instrumentId));
  const heldEarnings = earnings.filter((e) => held.has(e.event.instrumentId));

  // ---- freshness ----
  const quoted = overview.holdings.filter((h) => h.quote);
  const stale = quoted.some((h) => h.quote!.isStale);
  const delayed = quoted.some((h) => (h.quote!.delaySeconds ?? 0) > 0);

  return (
    <div className="font-display mx-auto max-w-5xl space-y-4 pb-4">
      {overview.needsRecompute && (
        <Note>
          No daily snapshots are cached yet. Run <code className="text-ink">npm run backfill</code> then{' '}
          <code className="text-ink">npm run recompute -- --from=inception</code>.
        </Note>
      )}
      {overview.warnings.length > 0 && (
        <Note>
          {overview.warnings.length} ledger warning(s) — affected positions may be wrong. {overview.warnings[0]}
        </Note>
      )}

      {/* ---- hero: what it is worth, and today against the index ---- */}
      <section className="space-y-1.5 pt-1">
        <div className="flex items-center justify-between">
          <span className="text-[12px] text-muted">{overview.accountName}</span>
          <Link
            href="/data-health"
            className="inline-flex items-center gap-1.5 rounded-full bg-surface px-2.5 py-1 text-[11px] text-ink-2"
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', stale ? 'bg-warn' : 'bg-up')} />
            {stale ? 'Some closing prices' : delayed ? 'Live · LSE delayed' : 'Live'}
          </Link>
        </div>
        <Link href="/positions" className="block">
          <div className="text-[44px] font-semibold leading-none tracking-tight sm:text-[52px]">
            {money(overview.totalValueGbp)}
          </div>
        </Link>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[15px]">
          <span className={cn('font-semibold', directionClass(overview.dayChangeGbp))}>
            {overview.dayChangeGbp === null
              ? '—'
              : `${overview.dayChangeGbp.greaterThanOrEqualTo(0) ? '+' : ''}${money(overview.dayChangeGbp)} today`}
          </span>
          <span className={directionClass(overview.dayChangePct)}>
            {percent(overview.dayChangePct, 2, { signed: true })}
          </span>
          {marketDay !== null && (
            <span className="text-[12px] text-muted">S&amp;P £ {percent(marketDay, 2, { signed: true })}</span>
          )}
        </div>
      </section>

      <WindowPicker current={window} basePath="/" size="full" />

      {/* ---- the race: you against the S&P 500 in pounds ---- */}
      <RaceCard
        data={chartData}
        windowLabel={spec.label}
        ret={summary.ret}
        mwr={overview.mwr}
        marketRet={vsMarket?.ret}
        active={vsMarket?.active}
        href="/attribution"
      />

      {/* ---- the four numbers that say how it is doing it ---- */}
      <section className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
        <Tile
          label="Sharpe"
          value={summary.sharpe === null ? '—' : summary.sharpe.toFixed(2)}
          sub={vsMarket?.sharpe == null ? `${spec.label}` : `S&P ${vsMarket.sharpe.toFixed(2)}`}
          href="/risk"
        />
        <Tile
          label="Max drawdown"
          value={percent(summary.maxDrawdown?.depth ?? null, 1)}
          valueTone={summary.maxDrawdown && summary.maxDrawdown.depth.isNegative() ? 'text-down' : undefined}
          sub={vsMarket?.maxDrawdown == null ? spec.label : `S&P ${percent(vsMarket.maxDrawdown, 1)}`}
          href="/risk"
        />
        <Tile
          label="Beta"
          value={regression ? regression.regression.beta.toFixed(2) : '—'}
          sub={
            regression ? (
              <span className="flex items-center gap-2">
                <span className="relative h-1.5 flex-1 rounded-full bg-surface-2">
                  <span
                    className="absolute inset-y-0 left-0 rounded-full bg-accent"
                    style={{ width: `${Math.min(100, Math.max(0, regression.regression.beta * 50))}%` }}
                  />
                  <span className="absolute -top-1 left-1/2 h-3.5 w-px bg-ink-2" />
                </span>
                <span>± {(1.96 * regression.regression.beta_stderr).toFixed(2)}</span>
              </span>
            ) : (
              'awaiting nightly job'
            )
          }
          href="/risk"
        />
        <Tile
          label="Effective N"
          value={effectiveN === null ? '—' : effectiveN.toFixed(1)}
          sub={<span className={concentrated ? 'text-warn' : undefined}>of {overview.concentration.count} holdings</span>}
          href="/positions#exposure"
        />
      </section>

      {pending.length > 0 && (
        <Link href="/corporate-actions" className="block">
          <Badge tone="warn">{pending.length} corporate action(s) awaiting confirmation</Badge>
        </Link>
      )}

      {/* ---- jump links ---- */}
      <JumpLinks
        items={[
          ['#risk', 'Risk'],
          ['#moves', 'What moved'],
          ['#rotation', 'Rotation'],
          ['#macro', 'Macro'],
          ['#holdings', 'Holdings'],
        ]}
      />

      <div className="grid gap-4 md:grid-cols-2">
        {/* ---- risk ---- */}
        <Section id="risk" title="Risk" href="/risk" meta={varPack ? `nightly · ${shortDate(varPack.snapDate)}` : undefined}>
          <div className="flex items-end justify-between">
            <div>
              <div className="text-[12px] text-muted">Bad day · 1 in 20</div>
              <div className="text-[32px] font-semibold leading-tight tracking-tight">{money(badDay)}</div>
            </div>
            {badDayAvg !== null && (
              <div className="text-right">
                <div className="text-[12px] text-muted">Worst 5% average</div>
                <div className="text-[20px] font-semibold text-down">{money(badDayAvg)}</div>
              </div>
            )}
          </div>
          {!varOk && badDay !== null && (
            <p className="text-[11px] text-muted">From the {spec.label} window — full VaR needs a year of history.</p>
          )}

          <VersusBar label="Volatility" you={summary.volatility} market={vsMarket?.volatility ?? null} scale={0.4} />

          {tailTop.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[12px] text-muted">Who carries the tail risk</div>
              <div className="flex h-6 overflow-hidden rounded-md text-[11px] font-semibold text-canvas">
                {tailTop.map((t, i) => (
                  <div
                    key={t.label}
                    className={cn('flex items-center overflow-hidden whitespace-nowrap px-1.5', ['bg-ink', 'bg-ink-2', 'bg-muted'][i])}
                    style={{ width: `${t.share * 100}%` }}
                  >
                    {t.label}
                  </div>
                ))}
                {tailRest > 0 && (
                  <div className="flex flex-1 items-center bg-surface-2 px-1.5 text-ink-2">
                    {tail.length - tailTop.length} others
                  </div>
                )}
              </div>
            </div>
          )}
        </Section>

        {/* ---- attribution ---- */}
        <Section id="moves" title="What moved you" href="/attribution" meta={`${spec.label} · share of return`}>
          {!ranked ? (
            <Empty>Needs cached daily snapshots.</Empty>
          ) : (
            <div className="-mx-4">
              <Contributors
                rows={[
                  ...contributorRows(ranked.top),
                  ...contributorRows(ranked.bottom)
                    .filter((b) => !ranked.top.some(([k]) => k === b.key))
                    .reverse(),
                ]}
              />
            </div>
          )}
        </Section>

        {/* ---- rotation ---- */}
        <Section id="rotation" title="Rotation vs S&P" href="/markets#rotation" meta={rrg ? `weekly · ${shortDate(rrg.snapDate)}` : undefined}>
          {rotation.length === 0 ? (
            <Empty>Needs about seven months of weekly prices.</Empty>
          ) : (
            <>
              <div className="grid grid-cols-4 gap-1.5 text-center">
                {QUADRANTS.map((q) => (
                  <div key={q.key} className={cn('rounded-xl px-1 py-2.5', q.fill)}>
                    <div className={cn('text-[24px] font-semibold leading-none', q.tone)}>
                      {rotation.filter((s) => s.quadrant === q.key).length}
                    </div>
                    <div className="mt-1 text-[11px] text-ink-2">{q.label}</div>
                  </div>
                ))}
              </div>
              {moved.length > 0 && (
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
                  <span className="text-muted">This week</span>
                  {moved.slice(0, 4).map((m) => (
                    <span key={m.label}>
                      {m.label} →{' '}
                      <span className={QUADRANTS.find((q) => q.key === m.now)!.tone}>
                        {QUADRANTS.find((q) => q.key === m.now)!.label}
                      </span>
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </Section>

        {/* ---- macro ---- */}
        <Section id="macro" title="Macro" href="/markets#macro" meta="~1 month change">
          <div className="grid grid-cols-2 gap-2">
            {MACRO_HEADLINE.map((spec) => (
              <MacroCard key={spec.id} spec={spec} tile={macro.find((t) => t.id === spec.id)!} />
            ))}
          </div>
        </Section>
      </div>

      {/* ---- holdings ---- */}
      <Section
        id="holdings"
        title="Holdings"
        href="/positions"
        meta={`${overview.holdings.length} open`}
      >
        {overview.holdings.length === 0 ? (
          <Empty>No open positions. Add trades to get started.</Empty>
        ) : (
          <>
            <ul className="-mx-4 divide-y divide-line/60 md:hidden">
              {overview.holdings.map((h) => (
                <HoldingCard key={`${h.position.accountId}-${h.position.instrumentId}`} h={h} />
              ))}
            </ul>
            <div className="-mx-4 hidden md:block">
              <Table>
                <thead>
                  <tr>
                    <Th>Symbol</Th>
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
      </Section>

      {heldEarnings.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[12px]">
          <span className="text-muted">Earnings</span>
          {heldEarnings.slice(0, 6).map((e) => (
            <span key={e.event.id}>
              <span className="font-medium">{e.symbol}</span>{' '}
              <span className="text-muted">{shortDate(e.event.reportDate)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** A holding on a phone: two lines, the numbers that matter, tappable. */
function HoldingCard({ h }: { h: HoldingRow }) {
  return (
    <li>
      <Link href={`/positions/${h.position.instrumentId}`} className="block px-4 py-2.5 active:bg-surface-2/60">
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-medium">{h.symbol}</span>
          <span className="tabular shrink-0 text-[13px]">{money(h.marketValueGbp)}</span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-3 text-[11px]">
          <span className={`tabular ${directionClass(h.quote?.changePct)}`}>
            {percent(h.quote?.changePct, 2, { signed: true })} today
            {h.quote?.isStale && <span className="ml-1.5 text-warn">close</span>}
          </span>
          <span className={`tabular ${directionClass(h.unrealisedGbp)}`}>
            {percent(h.unrealisedPct, 1, { signed: true })}
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
