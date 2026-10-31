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
import type { ReactNode } from 'react';
import { Badge, Empty, FreshnessBadge, Note, Table, Td, Th, Tr, WeightBar, cn } from '@/components/ui/primitives';
import { Contributors } from '@/components/contributors';
import { ScoreChart, ScoreLegend } from '@/components/score-chart';
import { Sparkline } from '@/components/sparkline';
import { WindowPicker } from '@/components/window-picker';
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

/** Percentage-point difference, e.g. "+1.8 pts". */
const pts = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v)
    ? '—'
    : `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)} pts`;

/**
 * The macro tiles. `upIsBad` colours a move by what it does to this
 * portfolio rather than by its sign: a rising VIX or 10-year yield is a
 * headwind for equities, and a stronger pound shrinks every dollar holding.
 */
const MACRO: Array<{ id: string; label: string; unit: string; decimals: number; upIsBad: boolean | null }> = [
  { id: 'VIXCLS', label: 'VIX', unit: '', decimals: 1, upIsBad: true },
  { id: 'DGS10', label: 'US 10-year', unit: '%', decimals: 2, upIsBad: true },
  { id: 'DEXUSUK', label: 'GBP/USD', unit: '', decimals: 3, upIsBad: true },
  { id: 'IUDSOIA', label: 'SONIA', unit: '%', decimals: 2, upIsBad: null },
];

type Quadrant = RrgSeries['quadrant'];

const QUADRANTS: Array<{ key: Quadrant; label: string; tone: string; fill: string }> = [
  { key: 'leading', label: 'Leading', tone: 'text-up', fill: 'bg-up/10' },
  { key: 'weakening', label: 'Weakening', tone: 'text-warn', fill: 'bg-warn/10' },
  { key: 'lagging', label: 'Lagging', tone: 'text-down', fill: 'bg-down/10' },
  { key: 'improving', label: 'Improving', tone: 'text-accent', fill: 'bg-accent/10' },
];

/** Which quadrant a single RRG point sits in; 100/100 is the crosshair. */
function quadrantOf(p: { rs_ratio: number; rs_momentum: number }): Quadrant {
  if (p.rs_ratio >= 100) return p.rs_momentum >= 100 ? 'leading' : 'weakening';
  return p.rs_momentum >= 100 ? 'improving' : 'lagging';
}

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
    getMacroTiles(MACRO.map((m) => m.id)),
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
  const moved = rotation
    .map((s) => {
      const now = quadrantOf(s.tail.at(-1)!);
      const before = s.tail.length > 1 ? quadrantOf(s.tail.at(-2)!) : now;
      return now === before ? null : { label: s.label, now };
    })
    .filter((m): m is { label: string; now: Quadrant } => m !== null);

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
          <span className="inline-flex items-center gap-1.5 rounded-full bg-surface px-2.5 py-1 text-[11px] text-ink-2">
            <span className={cn('h-1.5 w-1.5 rounded-full', stale ? 'bg-warn' : 'bg-up')} />
            {stale ? 'Some closing prices' : delayed ? 'Live · LSE delayed' : 'Live'}
          </span>
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
      <section className="space-y-3 rounded-2xl bg-surface p-4">
        <div className="flex items-baseline justify-between">
          <ScoreLegend marketLabel="S&P 500 £" />
          <span className={cn('text-[14px] font-semibold', directionClass(vsMarket?.active))}>
            {pts(vsMarket?.active)}
          </span>
        </div>
        <ScoreChart data={chartData} marketLabel="S&P 500 £" />
        <div className="grid grid-cols-3 gap-2">
          <Figure label={`TWR · ${spec.label}`} value={percent(summary.ret, 1, { signed: true })} tone={directionClass(summary.ret)} href="/attribution" />
          <Figure label="MWR · all" value={percent(overview.mwr, 1, { signed: true })} tone={directionClass(overview.mwr)} href="/attribution" />
          <Figure label={`S&P £ · ${spec.label}`} value={percent(vsMarket?.ret, 1, { signed: true })} tone="text-ink-2" />
        </div>
      </section>

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
          href="/exposure"
        />
      </section>

      {pending.length > 0 && (
        <Link href="/corporate-actions" className="block">
          <Badge tone="warn">{pending.length} corporate action(s) awaiting confirmation</Badge>
        </Link>
      )}

      {/* ---- jump links ---- */}
      <nav aria-label="Sections" className="no-scrollbar -mx-3 flex gap-2 overflow-x-auto px-3 md:hidden">
        {[
          ['#risk', 'Risk'],
          ['#moves', 'What moved'],
          ['#rotation', 'Rotation'],
          ['#macro', 'Macro'],
          ['#holdings', 'Holdings'],
        ].map(([href, label]) => (
          <a key={href} href={href} className="shrink-0 rounded-full bg-surface px-3.5 py-2 text-[13px] text-ink">
            {label}
          </a>
        ))}
      </nav>

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
        <Section id="rotation" title="Rotation vs S&P" href="/rrg" meta={rrg ? `weekly · ${shortDate(rrg.snapDate)}` : undefined}>
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
        <Section id="macro" title="Macro" href="/macro" meta="~1 month change">
          <div className="grid grid-cols-2 gap-2">
            {MACRO.map((spec) => {
              const tile = macro.find((t) => t.id === spec.id)!;
              // A move too small to show at this precision is no move.
              const change =
                tile.change !== null && Math.abs(tile.change) >= 0.5 * 10 ** -spec.decimals ? tile.change : null;
              const tone =
                change === null || change === 0 || spec.upIsBad === null
                  ? 'text-muted'
                  : (change > 0) === spec.upIsBad
                    ? 'text-down'
                    : 'text-up';
              return (
                <div key={spec.id} className="rounded-xl bg-surface-2/60 p-3">
                  <div className="text-[12px] text-muted">{spec.label}</div>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[20px] font-semibold">
                      {tile.latest === null ? '—' : `${tile.latest.toFixed(spec.decimals)}${spec.unit}`}
                    </span>
                    <span className={cn('text-[12px]', tone)}>
                      {change === null || change === 0
                        ? '—'
                        : `${change > 0 ? '▲' : '▼'} ${Math.abs(change).toFixed(spec.decimals)}`}
                    </span>
                  </div>
                  <Sparkline values={tile.recent} className="mt-1" />
                </div>
              );
            })}
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

      {earnings.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[12px]">
          <span className="text-muted">Earnings</span>
          {earnings.slice(0, 6).map((e) => (
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

/* ---------------- building blocks ---------------- */

function Section({
  id,
  title,
  href,
  meta,
  children,
}: {
  id: string;
  title: string;
  href: string;
  meta?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-16 space-y-3.5 rounded-2xl bg-surface p-4">
      <header className="flex items-baseline justify-between gap-3">
        <Link href={href} className="text-[17px] font-semibold hover:text-accent">
          {title} <span className="text-muted">›</span>
        </Link>
        {meta && <span className="truncate text-[11px] text-muted">{meta}</span>}
      </header>
      {children}
    </section>
  );
}

function Figure({ label, value, tone, href }: { label: string; value: string; tone: string; href?: string }) {
  const body = (
    <>
      <div className="text-[11px] tracking-wide text-muted">{label}</div>
      <div className={cn('text-[20px] font-semibold', tone)}>{value}</div>
    </>
  );
  return href ? <Link href={href}>{body}</Link> : <div>{body}</div>;
}

function Tile({
  label,
  value,
  valueTone,
  sub,
  href,
}: {
  label: string;
  value: string;
  valueTone?: string;
  sub: ReactNode;
  href: string;
}) {
  return (
    <Link href={href} className="flex flex-col gap-1 rounded-2xl bg-surface p-3.5 active:bg-surface-2">
      <span className="text-[12px] text-muted">{label}</span>
      <span className={cn('text-[28px] font-semibold leading-tight tracking-tight', valueTone)}>{value}</span>
      <span className="text-[12px] text-ink-2">{sub}</span>
    </Link>
  );
}

/** You as a bar, the index as a tick on the same scale. */
function VersusBar({
  label,
  you,
  market,
  scale,
}: {
  label: string;
  you: number | null;
  market: number | null;
  /** The value that fills the whole bar. */
  scale: number;
}) {
  const pos = (v: number) => `${Math.min(100, (Math.abs(v) / scale) * 100)}%`;
  return (
    <div className="space-y-2">
      <div className="flex justify-between text-[12px] text-ink-2">
        <span>{label}</span>
        <span>
          {percent(you, 1)} <span className="text-muted">vs S&amp;P</span> {percent(market, 1)}
        </span>
      </div>
      <div className="relative h-2 rounded-full bg-surface-2">
        {you !== null && <div className="absolute inset-y-0 left-0 rounded-full bg-ink" style={{ width: pos(you) }} />}
        {market !== null && <div className="absolute -top-1 h-4 w-0.5 bg-accent" style={{ left: pos(market) }} />}
      </div>
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
