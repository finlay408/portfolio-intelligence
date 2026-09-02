/**
 * Positions, open and closed.
 *
 * Closed positions are a first-class view, not an archive: "what did I make on
 * things I no longer hold" is one of the questions the ledger exists to answer
 * (§7.1), and it is the one most trackers cannot answer at all.
 */
import Link from 'next/link';
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
import { ZERO } from '@/lib/decimal';
import { directionClass, money, percent, quantity, shortDate } from '@/lib/format';
import { getOverview } from '@/lib/portfolio';

export const dynamic = 'force-dynamic';

export default async function PositionsPage() {
  const overview = await getOverview();

  const closedRealised = overview.closed.reduce((a, p) => a.plus(p.realisedGbpAverage), ZERO);

  return (
    <div className="space-y-3">
      <Card
        title="Open positions"
        subtitle={`${overview.holdings.length} holdings · ${money(overview.marketValueGbp)}`}
        footnote="Cost basis shown on the average-cost method, which matches broker statements. FIFO and Section 104 figures are on each position's page."
      >
        {overview.holdings.length === 0 ? (
          <Empty>No open positions.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Symbol</Th>
                <Th align="right">Quantity</Th>
                <Th align="right">Avg cost</Th>
                <Th align="right">Price</Th>
                <Th align="right">Value</Th>
                <Th align="right">Unrealised</Th>
                <Th align="right">Asset ret.</Th>
                <Th align="right">FX ret.</Th>
                <Th align="right">Weight</Th>
                <Th>Held since</Th>
                <Th>Data</Th>
              </tr>
            </thead>
            <tbody>
              {overview.holdings.map((h) => (
                <Tr key={`${h.position.accountId}-${h.position.instrumentId}`}>
                  <Td>
                    <Link
                      href={`/positions/${h.position.instrumentId}`}
                      className="font-medium hover:text-accent"
                    >
                      {h.symbol}
                    </Link>
                    <div className="text-[11px] text-muted">
                      {h.sector ?? h.assetClass} · {h.exchangeMic ?? '—'}
                    </div>
                  </Td>
                  <Td align="right" numeric>
                    {quantity(h.position.quantity)}
                  </Td>
                  <Td align="right" numeric>
                    {h.position.avgUnitCostLocal.toFixed(2)}
                    <span className="ml-1 text-[10px] text-muted">{h.quoteCurrency}</span>
                  </Td>
                  <Td align="right" numeric>
                    {h.quote ? h.quote.price.toFixed(2) : '—'}
                  </Td>
                  <Td align="right" numeric>
                    {money(h.marketValueGbp)}
                  </Td>
                  <Td align="right" numeric className={directionClass(h.unrealisedGbp)}>
                    {money(h.unrealisedGbp)}
                    <div className="text-[10px]">
                      {percent(h.unrealisedPct, 1, { signed: true })}
                    </div>
                  </Td>
                  {/* The return split (§3.2) — without it, "alpha" is contaminated by GBP/USD. */}
                  <Td
                    align="right"
                    numeric
                    className={directionClass(h.decomposition?.assetReturnLocal)}
                  >
                    {percent(h.decomposition?.assetReturnLocal, 1, { signed: true })}
                  </Td>
                  <Td align="right" numeric className={directionClass(h.decomposition?.fxReturn)}>
                    {h.quoteCurrency === 'GBP'
                      ? '—'
                      : percent(h.decomposition?.fxReturn, 1, { signed: true })}
                  </Td>
                  <Td align="right" numeric>
                    {percent(h.weight, 1)}
                  </Td>
                  <Td>
                    <span className="text-[11px] text-muted">
                      {shortDate(h.position.openedOn)}
                    </span>
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
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card
        title="Closed positions"
        subtitle={`${overview.closed.length} closed · ${money(closedRealised)} realised`}
        footnote="Retained in full with their realised P&L and holding period. Nothing is ever deleted from the ledger."
      >
        {overview.closed.length === 0 ? (
          <Empty>Nothing closed yet.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Instrument</Th>
                <Th align="right">Realised (avg)</Th>
                <Th align="right">Realised (FIFO)</Th>
                <Th align="right">Realised (S104)</Th>
                <Th align="right">Dividends</Th>
                <Th align="right">Fees</Th>
                <Th>Opened</Th>
                <Th>Closed</Th>
                <Th align="right">Held</Th>
              </tr>
            </thead>
            <tbody>
              {overview.closed.map((p) => {
                const days =
                  p.openedOn && p.closedOn
                    ? Math.round(
                        (Date.parse(p.closedOn) - Date.parse(p.openedOn)) / 86_400_000,
                      )
                    : null;
                return (
                  <Tr key={`${p.accountId}-${p.instrumentId}`}>
                    <Td>
                      <Link
                        href={`/positions/${p.instrumentId}`}
                        className="font-medium hover:text-accent"
                      >
                        {overview.instrumentById.get(p.instrumentId)?.symbol ?? `#${p.instrumentId}`}
                      </Link>
                      <div className="max-w-48 truncate text-[11px] text-muted">
                        {overview.instrumentById.get(p.instrumentId)?.name ?? ''}
                      </div>
                    </Td>
                    <Td align="right" numeric className={directionClass(p.realisedGbpAverage)}>
                      {money(p.realisedGbpAverage, 2)}
                    </Td>
                    <Td align="right" numeric className={directionClass(p.realisedGbpFifo)}>
                      {money(p.realisedGbpFifo, 2)}
                    </Td>
                    <Td align="right" numeric className={directionClass(p.realisedGbpS104)}>
                      {money(p.realisedGbpS104, 2)}
                    </Td>
                    <Td align="right" numeric>
                      {money(p.dividendsGbp, 2)}
                    </Td>
                    <Td align="right" numeric>
                      {money(p.feesGbp, 2)}
                    </Td>
                    <Td>{shortDate(p.openedOn)}</Td>
                    <Td>{shortDate(p.closedOn)}</Td>
                    <Td align="right" numeric>
                      {days === null ? '—' : `${days}d`}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="Why the three realised figures differ">
        <div className="space-y-2 px-4 py-3 text-[12px] leading-relaxed text-ink-2">
          <p>
            <Badge>Average</Badge> matches your broker statement and is the display basis. Every
            share carries the same pooled cost.
          </p>
          <p>
            <Badge>FIFO</Badge> consumes the oldest lot first. After a partial sale it disagrees
            with average cost, and that disagreement is real, not a rounding error.
          </p>
          <p>
            <Badge>Section 104</Badge> is what HMRC requires for a GIA: same-day acquisitions
            first, then anything repurchased within 30 days (the bed-and-breakfast rule), then the
            pool. Inside an ISA there is no CGT, so this is computed but not owed.
          </p>
        </div>
      </Card>
    </div>
  );
}
