/**
 * Holdings: what you own, how it is spread, and what you used to own.
 *
 * Merges what were three pages — open positions, exposure and closed
 * positions — because on a phone they are one question asked three ways.
 * Each holding still opens its own page with lots, FIFO and Section 104.
 *
 * Closed positions stay a first-class view (§7.1): "what did I make on things
 * I no longer hold" is a question most trackers cannot answer at all.
 * Geography is driven by revenue, never by listing venue (§5).
 */
import Link from 'next/link';
import { Empty, Insufficient, cn } from '@/components/ui/primitives';
import { JumpLinks, PageHead, Section, Tile, WeightBars } from '@/components/scoreboard';
import { ZERO } from '@/lib/decimal';
import { directionClass, money, percent, shortDate } from '@/lib/format';
import { getAnalytics, getOverview, type HoldingRow } from '@/lib/portfolio';
import type { ConcentrationSummary } from '@/lib/engine/concentration';

export const dynamic = 'force-dynamic';

interface StructurePayload {
  correlation: {
    instruments: string[];
    cluster_order: string[];
    matrix: Array<Array<number | null>>;
    average_pairwise: number | null;
  };
  rolling_correlation: { status: string; latest?: number | null; window?: number };
}

/** Two decimals, without the "-0.00" a tiny negative rounds to. */
const corr = (v: number | null) => (v === null ? '—' : (Math.abs(v) < 0.005 ? 0 : v).toFixed(2));

const weightRows = (s: ConcentrationSummary) =>
  s.rows.map((r) => ({ key: r.key, label: r.label, weight: r.weight.toNumber() }));

export default async function HoldingsPage() {
  const [overview, structure] = await Promise.all([
    getOverview(),
    getAnalytics<StructurePayload>('structure'),
  ]);

  const c = overview.concentration;
  const closedRealised = overview.closed.reduce((a, p) => a.plus(p.realisedGbpAverage), ZERO);
  const closedSorted = [...overview.closed].sort((a, b) => (b.closedOn ?? '').localeCompare(a.closedOn ?? ''));
  const symbolOf = (id: string) =>
    overview.instrumentById.get(Number(id))?.symbol ?? `#${id}`;
  const avgCorrelation = structure?.payload.correlation.average_pairwise ?? null;
  const rollingCorrelation = structure?.payload.rolling_correlation.latest ?? null;

  return (
    <div className="font-display mx-auto max-w-5xl space-y-4 pb-4">
      <PageHead
        title="Holdings"
        action={
          <Link href="/trades" className="rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-canvas">
            Trades &amp; upload
          </Link>
        }
      />

      <section className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
        <Tile label="Invested" value={money(overview.marketValueGbp)} sub={`${money(overview.cashGbp)} cash`} />
        <Tile
          label="Unrealised"
          value={money(overview.unrealisedGbp)}
          valueTone={directionClass(overview.unrealisedGbp)}
          sub={percent(
            overview.costBasisGbp.isZero() ? null : overview.unrealisedGbp.div(overview.costBasisGbp),
            1,
            { signed: true },
          )}
        />
        <Tile
          label="Realised"
          value={money(overview.realisedGbp)}
          valueTone={directionClass(overview.realisedGbp)}
          sub={`${money(overview.dividendsGbp)} dividends`}
          href="#closed"
        />
        <Tile
          label="Effective N"
          value={c.effectiveN === null ? '—' : c.effectiveN.toFixed(1)}
          sub={
            <span className={c.effectiveN !== null && c.effectiveN.lessThan(6) ? 'text-warn' : undefined}>
              of {c.count} · top 5 {percent(c.top5, 0)}
            </span>
          }
          href="#exposure"
        />
      </section>

      <JumpLinks
        items={[
          ['#open', 'Open'],
          ['#exposure', 'Exposure'],
          ['#correlation', 'Correlation'],
          ['#closed', 'Closed'],
        ]}
      />

      {/* ---- open positions ---- */}
      <Section id="open" title="Open" meta={`${overview.holdings.length} · by weight`}>
        {overview.holdings.length === 0 ? (
          <Empty>No open positions.</Empty>
        ) : (
          <ul className="-mx-4 divide-y divide-line/60 md:grid md:grid-cols-2 md:divide-y-0">
            {overview.holdings.map((h) => (
              <HoldingItem key={`${h.position.accountId}-${h.position.instrumentId}`} h={h} />
            ))}
          </ul>
        )}
      </Section>

      {/* ---- exposure ---- */}
      <div id="exposure" className="grid scroll-mt-16 gap-4 md:grid-cols-2">
        <Section title="Sector" meta="funds looked through">
          <WeightBars rows={weightRows(overview.bySector)} />
        </Section>
        <Section title="Where revenue is earned" meta="not listing venue">
          <WeightBars rows={weightRows(overview.byRevenueGeography)} />
        </Section>
        <Section title="Currency">
          <WeightBars rows={weightRows(overview.byCurrency)} />
        </Section>
        {overview.byTheme.rows.length > 0 && (
          <Section title="Theme">
            <WeightBars rows={weightRows(overview.byTheme)} />
          </Section>
        )}
      </div>

      {/* ---- correlation ---- */}
      <Section
        id="correlation"
        title="Correlation"
        meta={structure ? `nightly · ${shortDate(structure.snapDate)}` : undefined}
      >
        {!structure || structure.payload.correlation.instruments.length < 2 ? (
          <Insufficient reason="Needs two holdings with 60 overlapping days of prices." />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-[12px] text-muted">Average pairwise</div>
                <div className="text-[24px] font-semibold">{corr(avgCorrelation)}</div>
              </div>
              <div>
                <div className="text-[12px] text-muted">
                  Last {structure.payload.rolling_correlation.window ?? 63} days
                </div>
                <div
                  className={cn(
                    'text-[24px] font-semibold',
                    rollingCorrelation !== null && avgCorrelation !== null && rollingCorrelation > avgCorrelation + 0.05 && 'text-warn',
                  )}
                >
                  {corr(rollingCorrelation)}
                </div>
              </div>
            </div>
            <CorrelationHeatmap payload={structure.payload} symbolOf={symbolOf} />
          </>
        )}
      </Section>

      {/* ---- closed ---- */}
      <Section
        id="closed"
        title="Closed"
        meta={
          <span>
            {overview.closed.length} · <span className={directionClass(closedRealised)}>{money(closedRealised)}</span>
          </span>
        }
      >
        {closedSorted.length === 0 ? (
          <Empty>Nothing closed yet.</Empty>
        ) : (
          <>
            <ul className="-mx-4 divide-y divide-line/60">
              {closedSorted.slice(0, 10).map((p) => (
                <ClosedItem key={`${p.accountId}-${p.instrumentId}`} p={p} symbol={symbolOf(String(p.instrumentId))} />
              ))}
            </ul>
            {closedSorted.length > 10 && (
              <details className="group -mx-4">
                <summary className="cursor-pointer list-none px-4 py-2 text-[13px] text-accent">
                  <span className="group-open:hidden">Show {closedSorted.length - 10} more</span>
                  <span className="hidden group-open:inline">Show fewer</span>
                </summary>
                <ul className="divide-y divide-line/60">
                  {closedSorted.slice(10).map((p) => (
                    <ClosedItem key={`${p.accountId}-${p.instrumentId}`} p={p} symbol={symbolOf(String(p.instrumentId))} />
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </Section>
    </div>
  );
}

/** One holding: value, today, gain split into the stock's own move and the currency's (§3.2). */
function HoldingItem({ h }: { h: HoldingRow }) {
  const foreign = h.quoteCurrency !== 'GBP';
  return (
    <li>
      <Link href={`/positions/${h.position.instrumentId}`} className="block px-4 py-3 active:bg-surface-2/60">
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0">
            <span className="text-[15px] font-semibold">{h.symbol}</span>
            <span className="ml-2 truncate text-[11px] text-muted">{h.sector ?? h.assetClass}</span>
          </div>
          <span className="shrink-0 text-[15px] font-semibold">{money(h.marketValueGbp)}</span>
        </div>
        <div className="mt-1 flex items-baseline justify-between gap-3 text-[12px]">
          <span className={directionClass(h.quote?.changePct)}>
            {percent(h.quote?.changePct, 2, { signed: true })} today
            {h.quote?.isStale && <span className="ml-1.5 text-warn">close</span>}
          </span>
          <span className={directionClass(h.unrealisedGbp)}>
            {money(h.unrealisedGbp)} · {percent(h.unrealisedPct, 1, { signed: true })}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-3">
          <span className="h-1.5 flex-1 rounded-full bg-surface-2">
            <span
              className="block h-full rounded-full bg-accent"
              style={{ width: `${Math.min(100, h.weight.toNumber() * 100 * 2)}%` }}
            />
          </span>
          <span className="w-10 text-right text-[11px] text-muted">{percent(h.weight, 1)}</span>
          {foreign && h.decomposition && (
            <span className="text-[11px] text-muted">
              stock <span className={directionClass(h.decomposition.assetReturnLocal)}>{percent(h.decomposition.assetReturnLocal, 0, { signed: true })}</span>
              {' · '}FX <span className={directionClass(h.decomposition.fxReturn)}>{percent(h.decomposition.fxReturn, 0, { signed: true })}</span>
            </span>
          )}
        </div>
      </Link>
    </li>
  );
}

function ClosedItem({
  p,
  symbol,
}: {
  p: HoldingsClosed;
  symbol: string;
}) {
  const days =
    p.openedOn && p.closedOn ? Math.round((Date.parse(p.closedOn) - Date.parse(p.openedOn)) / 86_400_000) : null;
  return (
    <li>
      <Link
        href={`/positions/${p.instrumentId}`}
        className="flex items-baseline justify-between gap-3 px-4 py-2.5 text-[13px] active:bg-surface-2/60"
      >
        <span className="min-w-0">
          <span className="font-medium">{symbol}</span>
          <span className="ml-2 text-[11px] text-muted">
            {shortDate(p.closedOn)}
            {days !== null && ` · ${days}d`}
          </span>
        </span>
        <span className={cn('shrink-0 font-semibold', directionClass(p.realisedGbpAverage))}>
          {money(p.realisedGbpAverage)}
        </span>
      </Link>
    </li>
  );
}

type HoldingsClosed = Awaited<ReturnType<typeof getOverview>>['closed'][number];

/**
 * Clustered correlation matrix. Ordered by cluster so blocks on the diagonal
 * are holdings that move together. High correlation is shaded like a loss
 * because here the colour marks concentration risk, not direction.
 */
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
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="border-separate border-spacing-0.5">
        <thead>
          <tr>
            <th />
            {order.map((id) => (
              <th
                key={id}
                className="h-14 w-6 align-bottom text-[9px] font-normal text-muted"
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
              <th className="pr-1.5 text-right text-[9px] font-normal text-muted">{symbolOf(rowId)}</th>
              {order.map((colId) => {
                const value = matrix[indexOf.get(rowId)!]?.[indexOf.get(colId)!] ?? null;
                return (
                  <td
                    key={colId}
                    title={`${symbolOf(rowId)} / ${symbolOf(colId)}: ${value === null ? 'n/a' : value.toFixed(2)}`}
                    className="h-6 w-6 rounded-[3px]"
                    style={{
                      backgroundColor:
                        value === null
                          ? 'transparent'
                          : // srgb, not oklch: mixing red into a blue-grey in oklch swings the hue through purple.
                            `color-mix(in srgb, var(--color-${value >= 0 ? 'down' : 'up'}) ${Math.round(Math.abs(value) * 70)}%, var(--color-surface-2))`,
                    }}
                  />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
