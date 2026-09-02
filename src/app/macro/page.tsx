/**
 * Macro dashboard (Phase 6).
 *
 * FRED series only, refreshed daily. This is context, not signal: it exists so
 * that a drawdown can be read against what rates and volatility were doing at
 * the time, not so that anything here drives a decision.
 */
import { desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { macroSeries } from '@/db/schema';
import { Card, Empty, Stat, Table, Td, Th, Tr } from '@/components/ui/primitives';
import { dec } from '@/lib/decimal';
import { directionClass, number as fmtNumber, shortDate } from '@/lib/format';

export const dynamic = 'force-dynamic';

const SERIES: Array<{ id: string; label: string; unit: string; note: string }> = [
  { id: 'DGS10', label: 'US 10-year', unit: '%', note: 'Treasury constant maturity yield' },
  { id: 'T10Y2Y', label: '10y − 2y spread', unit: '%', note: 'Negative means an inverted curve' },
  { id: 'VIXCLS', label: 'VIX', unit: '', note: 'S&P 500 30-day implied volatility' },
  { id: 'IUDSOIA', label: 'SONIA', unit: '%', note: 'The GBP risk-free rate used for Sharpe' },
  { id: 'DEXUSUK', label: 'GBP/USD', unit: '', note: 'US dollars per pound' },
  { id: 'CPIAUCSL', label: 'US CPI', unit: 'index', note: 'Seasonally adjusted, 1982-84 = 100' },
];

export default async function MacroPage() {
  const rows = await db
    .select()
    .from(macroSeries)
    .where(
      inArray(
        macroSeries.seriesId,
        SERIES.map((s) => s.id),
      ),
    )
    .orderBy(desc(macroSeries.obsDate))
    .limit(4000);

  const bySeries = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = bySeries.get(row.seriesId) ?? [];
    list.push(row);
    bySeries.set(row.seriesId, list);
  }

  if (rows.length === 0) {
    return (
      <Card title="Macro">
        <Empty>
          No macro series stored. Run{' '}
          <code className="text-ink">python analytics/run_nightly.py --job=macro</code>.
        </Empty>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3 xl:grid-cols-6">
        {SERIES.map((spec) => {
          const series = bySeries.get(spec.id) ?? [];
          const latest = series[0];
          // A month ago, approximately — FRED series have different frequencies.
          const previous = series[Math.min(21, series.length - 1)];
          const change =
            latest?.value && previous?.value
              ? dec(latest.value).minus(dec(previous.value))
              : null;

          return (
            <div key={spec.id} className="bg-surface">
              <Stat
                label={spec.label}
                value={latest?.value ? `${fmtNumber(dec(latest.value), 2)}${spec.unit === '%' ? '%' : ''}` : '—'}
                sub={
                  change
                    ? `${change.greaterThanOrEqualTo(0) ? '+' : ''}${fmtNumber(change, 2)} over ~1 month`
                    : shortDate(latest?.obsDate)
                }
                tone={change ? (change.greaterThan(0) ? 'up' : change.lessThan(0) ? 'down' : 'neutral') : 'neutral'}
                hint={spec.note}
              />
            </div>
          );
        })}
      </div>

      {SERIES.map((spec) => {
        const series = (bySeries.get(spec.id) ?? []).slice(0, 12);
        if (series.length === 0) return null;
        return (
          <Card key={spec.id} title={spec.label} subtitle={`${spec.note} · FRED ${spec.id}`}>
            <Table>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th align="right">Value</Th>
                  <Th align="right">Change</Th>
                </tr>
              </thead>
              <tbody>
                {series.map((row, i) => {
                  const previous = series[i + 1];
                  const change =
                    row.value && previous?.value
                      ? dec(row.value).minus(dec(previous.value))
                      : null;
                  return (
                    <Tr key={row.obsDate}>
                      <Td>{shortDate(row.obsDate)}</Td>
                      <Td align="right" numeric>
                        {row.value ? fmtNumber(dec(row.value), 3) : '—'}
                      </Td>
                      <Td align="right" numeric className={directionClass(change)}>
                        {change ? fmtNumber(change, 3) : '—'}
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </Card>
        );
      })}
    </div>
  );
}
