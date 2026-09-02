/**
 * Relative Rotation Graph page (CLAUDE.md §7.7).
 *
 * Both individual holdings and theme aggregates, plotted against a benchmark.
 * The series come from `analytics_snapshots` — the JdK RS-Ratio and
 * RS-Momentum maths runs in the nightly Python job, not here.
 */
import { Card, Insufficient, Note, Table, Td, Th, Tr } from '@/components/ui/primitives';
import { RrgChart, type RrgSeries } from '@/components/rrg-chart';
import { shortDate } from '@/lib/format';
import { getAnalytics } from '@/lib/portfolio';

export const dynamic = 'force-dynamic';

interface RrgPayload {
  status: string;
  frequency: string;
  tail_length: number;
  smoothing: number;
  series: RrgSeries[];
  themes?: { status: string; series: RrgSeries[] };
  note: string;
}

const QUADRANT_ORDER = ['leading', 'weakening', 'lagging', 'improving'] as const;

export default async function RrgPage() {
  const rrg = await getAnalytics<RrgPayload>('rrg');

  if (!rrg || rrg.payload.status !== 'ok') {
    return (
      <Card title="Relative Rotation Graph">
        <Insufficient reason="RS-Ratio needs roughly 30 weekly observations before the rolling z-score means anything — about seven months of price history. Run the nightly analytics job once the backfill has enough data." />
      </Card>
    );
  }

  const payload = rrg.payload;

  return (
    <div className="space-y-3">
      <Card
        title="Holdings"
        subtitle={`${payload.frequency} bars · ${payload.tail_length}-period tails · ${payload.smoothing}-period smoothing`}
        action={`computed ${shortDate(rrg.snapDate)}`}
        footnote={payload.note}
      >
        <RrgChart series={payload.series} benchmarkLabel="the S&P 500" />
      </Card>

      {payload.themes && payload.themes.status === 'ok' && payload.themes.series.length > 0 && (
        <Card
          title="Themes"
          subtitle="weight-averaged constituent series, rebased to 100"
          footnote="Theme aggregates rotate more slowly than their constituents, which is what makes them readable — a single holding whipping between quadrants usually says more about its own volatility than about the theme."
        >
          <RrgChart series={payload.themes.series} benchmarkLabel="the S&P 500" height={440} />
        </Card>
      )}

      <Card
        title="Quadrant summary"
        footnote="Validate this against a published RRG for a name you know before trusting it — the normalisation constant is a convention, not a standard, and different vendors scale the axes differently."
      >
        <Table>
          <thead>
            <tr>
              <Th>Quadrant</Th>
              <Th>Holdings</Th>
              <Th>Reading</Th>
            </tr>
          </thead>
          <tbody>
            {QUADRANT_ORDER.map((quadrant) => {
              const members = payload.series.filter((s) => s.quadrant === quadrant);
              return (
                <Tr key={quadrant}>
                  <Td className="capitalize">{quadrant}</Td>
                  <Td>{members.length === 0 ? '—' : members.map((m) => m.label).join(', ')}</Td>
                  <Td>
                    <span className="whitespace-normal text-[11px] text-muted">
                      {
                        {
                          leading: 'Outperforming with positive relative momentum.',
                          weakening: 'Still ahead, but relative momentum has turned down.',
                          lagging: 'Underperforming with negative relative momentum.',
                          improving: 'Still behind, but relative momentum has turned up.',
                        }[quadrant]
                      }
                    </span>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </Card>

      <Note>
        RRG is a relative measure. In a falling market the leading quadrant contains whatever is
        falling least, and nothing here says anything about absolute direction.
      </Note>
    </div>
  );
}
