/**
 * The ledger.
 *
 * Append-only and visibly so: voided rows stay on screen, struck through, with
 * the correction that replaced them still in sequence. Nothing here can be
 * edited, because a mutable ledger is what makes a tracker drift from reality
 * within six months (§2).
 */
import { desc, eq } from 'drizzle-orm';
import Link from 'next/link';
import { db } from '@/db';
import { accounts, cashFlows, instruments, trades } from '@/db/schema';
import { Badge, Card, Empty, Table, Td, Th, Tr } from '@/components/ui/primitives';
import { ImportForm } from '@/components/import-form';
import { TradeForm } from '@/components/trade-form';
import { VoidButton } from '@/components/void-button';
import { dec } from '@/lib/decimal';
import { todayIso } from '@/lib/dates';
import { directionClass, money, quantity, relativeTime, shortDate } from '@/lib/format';
import { listUploads } from '@/lib/import/apply';

export const dynamic = 'force-dynamic';
// A commit fetches price history for new instruments and rebuilds the cached
// series in-process; the default 10s would cut that short.
export const maxDuration = 60;

export default async function TradesPage() {
  const [instrumentRows, accountRows, uploads, tradeRows, flowRows] = await Promise.all([
    db.select().from(instruments).orderBy(instruments.symbol),
    db.select().from(accounts).orderBy(accounts.id),
    listUploads(12),
    db
      .select({
        trade: trades,
        symbol: instruments.symbol,
        accountName: accounts.name,
      })
      .from(trades)
      .innerJoin(instruments, eq(instruments.id, trades.instrumentId))
      .innerJoin(accounts, eq(accounts.id, trades.accountId))
      .orderBy(desc(trades.tradeDate), desc(trades.id))
      .limit(500),
    db
      .select({ flow: cashFlows, accountName: accounts.name })
      .from(cashFlows)
      .innerJoin(accounts, eq(accounts.id, cashFlows.accountId))
      .orderBy(desc(cashFlows.flowDate))
      .limit(100),
  ]);

  const accountOptions = accountRows.map((a) => ({ id: a.id, name: a.name, wrapper: a.wrapper }));

  return (
    <div className="space-y-3">
      <Card
        title="Upload a broker export"
        subtitle="Trading 212 → History → Export, any date range, overlaps are fine"
        footnote="Every row is matched against the ledger by the broker's transaction ID, so re-uploading a range you already imported records nothing twice. Nothing is written until you commit the preview."
      >
        <ImportForm accounts={accountOptions} />
      </Card>

      {uploads.length > 0 && (
        <Card title="Uploads" subtitle={`${uploads.length} most recent`}>
          <Table>
            <thead>
              <tr>
                <Th>File</Th>
                <Th>Uploaded</Th>
                <Th align="right">Rows</Th>
                <Th>Status</Th>
                <Th>Wrote</Th>
              </tr>
            </thead>
            <tbody>
              {uploads.map((u) => {
                const result = (u.summary?.result ?? null) as
                  | { written?: { trades: number; flows: number; instruments: number } }
                  | null;
                return (
                  <Tr key={u.id}>
                    <Td>
                      <span className="font-mono text-[11px]">{u.filename}</span>
                    </Td>
                    <Td>
                      <span className="text-[11px] text-muted">{relativeTime(u.uploadedAt)}</span>
                    </Td>
                    <Td align="right" numeric>
                      {u.rowCount}
                    </Td>
                    <Td>
                      {u.appliedAt ? (
                        <Badge tone="up">committed</Badge>
                      ) : (
                        <Badge tone="neutral">previewed only</Badge>
                      )}
                    </Td>
                    <Td>
                      <span className="text-[11px] text-muted">
                        {result?.written
                          ? `${result.written.trades} trades · ${result.written.flows} flows · ${result.written.instruments} instruments`
                          : '—'}
                      </span>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}

      <Card
        title="Record a trade"
        subtitle="for anything the export does not carry"
        footnote="Cached time series are rebuilt by `npm run recompute`; positions on every page update immediately, because they are derived from this ledger on read."
      >
        <TradeForm
          today={todayIso()}
          accounts={accountOptions}
          instruments={instrumentRows.map((i) => ({
            id: i.id,
            symbol: i.symbol,
            name: i.name,
            quoteCurrency: i.quoteCurrency,
            quoteMultiplier: dec(i.quoteMultiplier).toFixed(),
            exchangeMic: i.exchangeMic,
            assetClass: i.assetClass,
          }))}
        />
      </Card>

      <Card
        title="Trade ledger"
        subtitle={`${tradeRows.length} most recent`}
        footnote="Trades are never updated or deleted. To correct one, void it and record the replacement."
      >
        {tradeRows.length === 0 ? (
          <Empty>No trades yet.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Account</Th>
                <Th>Instrument</Th>
                <Th>Side</Th>
                <Th align="right">Quantity</Th>
                <Th align="right">Price</Th>
                <Th align="right">FX</Th>
                <Th align="right">Fees</Th>
                <Th align="right">Net GBP</Th>
                <Th>Source</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {tradeRows.map(({ trade, symbol, accountName }) => {
                const fees = dec(trade.commission)
                  .plus(dec(trade.stampDuty))
                  .plus(dec(trade.fxFee))
                  .plus(dec(trade.otherFees));
                const gross = dec(trade.quantity).times(dec(trade.price));
                const net = trade.side === 'buy' ? gross.plus(fees) : gross.minus(fees);
                return (
                  <Tr
                    key={trade.id}
                    className={trade.isVoid ? 'opacity-40 line-through' : undefined}
                  >
                    <Td>{shortDate(trade.tradeDate)}</Td>
                    <Td>
                      <span className="text-[11px] text-muted">{accountName}</span>
                    </Td>
                    <Td>
                      <Link
                        href={`/positions/${trade.instrumentId}`}
                        className="font-medium hover:text-accent"
                      >
                        {symbol}
                      </Link>
                    </Td>
                    <Td>
                      <Badge tone={trade.side === 'buy' ? 'accent' : 'neutral'}>
                        {trade.side}
                      </Badge>
                    </Td>
                    <Td align="right" numeric>
                      {quantity(dec(trade.quantity))}
                    </Td>
                    <Td align="right" numeric>
                      {dec(trade.price).toFixed(4)}
                      <span className="ml-1 text-[10px] text-muted">{trade.tradeCurrency}</span>
                    </Td>
                    <Td align="right" numeric>
                      {dec(trade.fxRate).toFixed(4)}
                    </Td>
                    <Td align="right" numeric>
                      {fees.isZero() ? '—' : fees.toFixed(2)}
                    </Td>
                    <Td align="right" numeric>
                      {money(net.times(dec(trade.fxRate)), 2)}
                    </Td>
                    <Td>
                      <span className="text-[11px] text-muted">{trade.source}</span>
                    </Td>
                    <Td>
                      {!trade.isVoid && <VoidButton id={trade.id} />}
                      {trade.isVoid && <Badge tone="warn">void</Badge>}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Card
        title="Cash flows"
        subtitle="deposits, withdrawals, dividends, fees"
        footnote="Deposits and withdrawals are what make money-weighted return and the true 'am I ahead' figure possible. Withdrawals, fees and taxes are stored negative."
      >
        {flowRows.length === 0 ? (
          <Empty>No cash flows recorded.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Account</Th>
                <Th>Kind</Th>
                <Th align="right">Amount</Th>
                <Th align="right">FX</Th>
                <Th align="right">Withholding</Th>
                <Th align="right">GBP</Th>
                <Th>Note</Th>
              </tr>
            </thead>
            <tbody>
              {flowRows.map(({ flow, accountName }) => {
                const gbp = dec(flow.amount).minus(dec(flow.withholding)).times(dec(flow.fxRate));
                return (
                  <Tr key={flow.id}>
                    <Td>{shortDate(flow.flowDate)}</Td>
                    <Td>
                      <span className="text-[11px] text-muted">{accountName}</span>
                    </Td>
                    <Td>{flow.kind}</Td>
                    <Td align="right" numeric>
                      {dec(flow.amount).toFixed(2)}
                      <span className="ml-1 text-[10px] text-muted">{flow.flowCurrency}</span>
                    </Td>
                    <Td align="right" numeric>
                      {dec(flow.fxRate).toFixed(4)}
                    </Td>
                    <Td align="right" numeric>
                      {dec(flow.withholding).isZero() ? '—' : dec(flow.withholding).toFixed(2)}
                    </Td>
                    <Td align="right" numeric className={directionClass(gbp)}>
                      {money(gbp, 2)}
                    </Td>
                    <Td>
                      <span className="text-[11px] text-muted">{flow.note ?? '—'}</span>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
