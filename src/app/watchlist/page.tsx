/**
 * Watchlist — a thesis, a target, a conviction, and an alert.
 *
 * Deliberately small: the point is to record why something is interesting and
 * at what price, not to build a second portfolio view.
 */
import Link from 'next/link';
import { db } from '@/db';
import { instruments } from '@/db/schema';
import {
  Badge,
  Card,
  Empty,
  FreshnessBadge,
  Table,
  Td,
  Th,
  Tr,
} from '@/components/ui/primitives';
import { WatchlistForm } from '@/components/watchlist-form';
import { directionClass, percent } from '@/lib/format';
import { getWatchlist } from '@/lib/portfolio';

export const dynamic = 'force-dynamic';

export default async function WatchlistPage() {
  const [rows, instrumentRows] = await Promise.all([
    getWatchlist(),
    db.select().from(instruments).orderBy(instruments.symbol),
  ]);

  return (
    <div className="space-y-3">
      <Card
        title="Watchlist"
        subtitle={`${rows.length} tracked`}
        footnote="Quotes come from the same scheduled job as the portfolio, so the delay shown here is the real one."
      >
        {rows.length === 0 ? (
          <Empty>Nothing on the watchlist.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Instrument</Th>
                <Th align="right">Price</Th>
                <Th align="right">Target entry</Th>
                <Th align="right">Distance</Th>
                <Th align="center">Conviction</Th>
                <Th>Thesis</Th>
                <Th>Alerts</Th>
                <Th>Data</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.entry.id}>
                  <Td>
                    <Link
                      href={`/positions/${r.instrument.id}`}
                      className="font-medium hover:text-accent"
                    >
                      {r.instrument.symbol}
                    </Link>
                    <div className="max-w-48 truncate text-[11px] text-muted">
                      {r.instrument.name}
                    </div>
                  </Td>
                  <Td align="right" numeric>
                    {r.price ? r.price.toFixed(2) : '—'}
                    <span className="ml-1 text-[10px] text-muted">
                      {r.instrument.quoteCurrency}
                    </span>
                  </Td>
                  <Td align="right" numeric>
                    {r.target ? r.target.toFixed(2) : '—'}
                  </Td>
                  <Td align="right" numeric className={directionClass(r.distanceToTarget?.negated())}>
                    {percent(r.distanceToTarget, 1, { signed: true })}
                  </Td>
                  <Td align="center">
                    {r.entry.conviction ? (
                      <span className="tabular text-[12px]">{'●'.repeat(r.entry.conviction)}</span>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td>
                    <div className="max-w-96 whitespace-normal text-[11px] leading-relaxed text-ink-2">
                      {r.entry.thesis ?? '—'}
                    </div>
                  </Td>
                  <Td>
                    {r.alertTriggered ? (
                      <Badge tone="warn">triggered</Badge>
                    ) : r.entry.alertAbove || r.entry.alertBelow ? (
                      <span className="text-[11px] text-muted">
                        {r.entry.alertBelow && `< ${r.entry.alertBelow}`}
                        {r.entry.alertBelow && r.entry.alertAbove && ' · '}
                        {r.entry.alertAbove && `> ${r.entry.alertAbove}`}
                      </span>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td>
                    <FreshnessBadge
                      delaySeconds={r.quote?.delaySeconds ?? null}
                      provider={r.quote?.provider}
                      asOf={r.quote?.asOf.toISOString()}
                    />
                  </Td>
                  <Td>
                    <WatchlistForm mode="remove" id={r.entry.id} />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="Add to watchlist">
        <WatchlistForm
          mode="add"
          instruments={instrumentRows.map((i) => ({
            id: i.id,
            symbol: i.symbol,
            name: i.name,
          }))}
        />
      </Card>
    </div>
  );
}
