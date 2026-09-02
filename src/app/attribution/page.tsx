/**
 * Attribution grids (CLAUDE.md §7.3).
 *
 * Each grid reconciles to the total portfolio return. The reconciliation gap is
 * printed rather than hidden — a grid that does not add up is a broken grid,
 * and the only way to know is to show the residual.
 */
import { Card, Empty, Note, Table, Td, Th, Tr, WeightBar } from '@/components/ui/primitives';
import { Decimal, ZERO } from '@/lib/decimal';
import { directionClass, money, percent } from '@/lib/format';
import { RESIDUAL_KEY, type AttributionResult } from '@/lib/engine/attribution';
import { getAttribution, getOverview } from '@/lib/portfolio';

export const dynamic = 'force-dynamic';

const GRID_LABELS: Record<string, { title: string; subtitle?: string }> = {
  position: { title: 'By position' },
  theme: { title: 'By theme', subtitle: 'honouring partial membership weights' },
  sector: { title: 'By sector', subtitle: 'GICS' },
  revenueGeography: {
    title: 'By revenue geography',
    subtitle: 'where the money is actually earned',
  },
  listingCountry: { title: 'By listing country', subtitle: 'the venue, not the exposure' },
  currency: { title: 'By currency' },
  assetClass: { title: 'By asset class' },
};

export default async function AttributionPage() {
  const [attribution, overview] = await Promise.all([getAttribution(), getOverview()]);

  if (attribution.needsRecompute) {
    return (
      <Note>
        Attribution needs the cached daily snapshots. Run{' '}
        <code className="text-ink">npm run backfill</code> then{' '}
        <code className="text-ink">npm run recompute -- --from=inception</code>.
      </Note>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-4">
        <Cell
          label="Total return (TWR)"
          value={percent(attribution.totalReturn, 2, { signed: true })}
          sub={`${attribution.days} trading days`}
        />
        <Cell
          label="Money-weighted (XIRR)"
          value={overview.mwr === null ? '—' : percent(overview.mwr, 2, { signed: true })}
          sub="annualised, reflects contribution timing"
        />
        <Cell
          label="Net deposits"
          value={money(overview.netDepositsGbp)}
          sub="the capital at work"
        />
        <Cell
          label="Reconciliation gap"
          value={attribution.grids.position!.reconciliationGap.abs().lessThan('1e-12')
            ? 'exact'
            : percent(attribution.grids.position!.reconciliationGap, 6)}
          sub="grid total vs compounded return"
        />
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

function Cell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-surface px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className="tabular mt-1 text-xl leading-none">{value}</div>
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
              {showFx && <Th align="right">Asset</Th>}
              {showFx && <Th align="right">FX</Th>}
              <Th className="w-32" />
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
                  <Td align="right" numeric className={directionClass(parts.asset)}>
                    {percent(parts.asset, 2, { signed: true })}
                  </Td>
                )}
                {showFx && (
                  <Td align="right" numeric className={directionClass(parts.fx)}>
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
    <div className="flex h-1.5 w-28 items-center">
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
