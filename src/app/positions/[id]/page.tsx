/**
 * Position derivation (CLAUDE.md §12, "progressive depth").
 *
 * Every number on the overview is clickable and opens its full derivation, and
 * this is where that chain terminates: the individual trades, the FIFO lots
 * they became, the disposals matched against them, and the exact arithmetic
 * that turns a USD price into a GBP market value.
 */
import { eq, and, desc } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/db';
import { corporateActions, instruments, trades } from '@/db/schema';
import {
  Badge,
  Card,
  Empty,
  Stat,
  Table,
  Td,
  Th,
  Tr,
} from '@/components/ui/primitives';
import { ONE, ZERO, dec } from '@/lib/decimal';
import { currency, directionClass, money, percent, quantity, shortDate } from '@/lib/format';
import { getOverview } from '@/lib/portfolio';

export const dynamic = 'force-dynamic';

export default async function PositionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const instrumentId = Number(id);
  if (!Number.isInteger(instrumentId)) notFound();

  const [instrumentRows, tradeRows, actionRows, overview] = await Promise.all([
    db.select().from(instruments).where(eq(instruments.id, instrumentId)),
    db
      .select()
      .from(trades)
      .where(eq(trades.instrumentId, instrumentId))
      .orderBy(trades.tradeDate, trades.id),
    db
      .select()
      .from(corporateActions)
      .where(eq(corporateActions.instrumentId, instrumentId))
      .orderBy(desc(corporateActions.actionDate)),
    getOverview(),
  ]);

  const instrument = instrumentRows[0];
  if (!instrument) notFound();

  const holding = overview.holdings.find((h) => h.position.instrumentId === instrumentId);
  const position =
    holding?.position ?? overview.closed.find((p) => p.instrumentId === instrumentId);

  if (!position) {
    return (
      <Card title={instrument.symbol} subtitle={instrument.name}>
        <Empty>No trades recorded for this instrument.</Empty>
      </Card>
    );
  }

  const d = holding?.decomposition ?? null;
  const isGbx = dec(instrument.quoteMultiplier).equals('0.01');

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-tight">{instrument.symbol}</h1>
        <span className="text-[13px] text-muted">{instrument.name}</span>
        <Badge>{instrument.assetClass}</Badge>
        {instrument.exchangeMic && <Badge>{instrument.exchangeMic}</Badge>}
        <Badge tone={isGbx ? 'warn' : 'neutral'}>
          {isGbx ? 'quoted in GBX (pence)' : `quoted in ${instrument.quoteCurrency}`}
        </Badge>
        {position.isOpen ? <Badge tone="accent">open</Badge> : <Badge>closed</Badge>}
      </div>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3 lg:grid-cols-6">
        {[
          <Stat key="q" label="Quantity" value={quantity(position.quantity)} />,
          <Stat
            key="c"
            label="Cost basis"
            value={money(position.costBasisGbp)}
            sub={`${currency(position.costBasisLocal, instrument.quoteCurrency, 0)} local`}
          />,
          <Stat
            key="v"
            label="Market value"
            value={money(holding?.marketValueGbp ?? ZERO)}
            sub={holding?.quote ? `@ ${holding.quote.price.toFixed(2)}` : 'no quote'}
          />,
          <Stat
            key="u"
            label="Unrealised"
            value={money(holding?.unrealisedGbp ?? ZERO)}
            tone={holding?.unrealisedGbp.greaterThan(0) ? 'up' : holding?.unrealisedGbp.lessThan(0) ? 'down' : 'neutral'}
            sub={percent(holding?.unrealisedPct ?? null, 1, { signed: true })}
          />,
          <Stat
            key="r"
            label="Realised (avg)"
            value={money(position.realisedGbpAverage, 2)}
            tone={position.realisedGbpAverage.greaterThan(0) ? 'up' : position.realisedGbpAverage.lessThan(0) ? 'down' : 'neutral'}
          />,
          <Stat
            key="d"
            label="Dividends"
            value={money(position.dividendsGbp, 2)}
            sub={`${money(position.feesGbp, 2)} fees paid`}
          />,
        ].map((node, i) => (
          <div key={i} className="bg-surface">
            {node}
          </div>
        ))}
      </div>

      {/* ---- return decomposition (§3.2) ---- */}
      {d && (
        <Card
          title="Return decomposition"
          subtitle="asset move, currency move, and the cross term"
          footnote="These three sum exactly to the GBP return. Without the split, a comparison against the S&P 500 is contaminated by GBP/USD."
        >
          <div className="grid grid-cols-2 divide-line md:grid-cols-4 md:divide-x">
            <DecompCell label="Asset return (local)" value={d.assetReturnLocal} />
            <DecompCell label="FX return" value={d.fxReturn} />
            <DecompCell label="Cross term" value={d.crossTerm} decimals={3} />
            <DecompCell label="Total GBP return" value={d.totalReturnGbp} emphasis />
          </div>
          <div className="border-t border-line px-4 py-2 text-[11px] leading-relaxed text-muted">
            {percent(d.assetReturnLocal, 2, { signed: true })} +{' '}
            {percent(d.fxReturn, 2, { signed: true })} +{' '}
            {percent(d.crossTerm, 3, { signed: true })} ={' '}
            {percent(d.totalReturnGbp, 2, { signed: true })}
          </div>
        </Card>
      )}

      {/* ---- the three cost bases ---- */}
      <div className="grid gap-3 lg:grid-cols-2">
        <Card
          title="FIFO lots"
          subtitle={`${position.lots.length} open lots`}
          footnote="Split-adjusted. A 4:1 split multiplies the lot quantity and divides its unit cost; the total basis never moves."
        >
          {position.lots.length === 0 ? (
            <Empty>No open lots.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Opened</Th>
                  <Th align="right">Quantity</Th>
                  <Th align="right">Unit cost (local)</Th>
                  <Th align="right">Unit cost (GBP)</Th>
                  <Th align="right">FX at open</Th>
                  <Th align="right">Lot basis</Th>
                </tr>
              </thead>
              <tbody>
                {position.lots.map((lot, i) => (
                  <Tr key={`${lot.tradeId}-${i}`}>
                    <Td>{shortDate(lot.openedOn)}</Td>
                    <Td align="right" numeric>
                      {quantity(lot.quantity)}
                    </Td>
                    <Td align="right" numeric>
                      {lot.unitCostLocal.toFixed(4)}
                    </Td>
                    <Td align="right" numeric>
                      {lot.unitCostGbp.toFixed(4)}
                    </Td>
                    <Td align="right" numeric>
                      {lot.fxRateAtOpen.toFixed(4)}
                    </Td>
                    <Td align="right" numeric>
                      {money(lot.unitCostGbp.times(lot.quantity), 2)}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card
          title="Tax basis"
          subtitle="three methods, three answers"
          footnote="Section 104 applies to a GIA. Inside an ISA there is no CGT, but the engine computes it regardless so the two are always comparable."
        >
          <Table>
            <thead>
              <tr>
                <Th>Method</Th>
                <Th align="right">Quantity</Th>
                <Th align="right">Basis</Th>
                <Th align="right">Realised</Th>
              </tr>
            </thead>
            <tbody>
              <Tr>
                <Td>Average cost</Td>
                <Td align="right" numeric>
                  {quantity(position.quantity)}
                </Td>
                <Td align="right" numeric>
                  {money(position.costBasisGbp, 2)}
                </Td>
                <Td align="right" numeric className={directionClass(position.realisedGbpAverage)}>
                  {money(position.realisedGbpAverage, 2)}
                </Td>
              </Tr>
              <Tr>
                <Td>FIFO</Td>
                <Td align="right" numeric>
                  {quantity(position.lots.reduce((a, l) => a.plus(l.quantity), ZERO))}
                </Td>
                <Td align="right" numeric>
                  {money(
                    position.lots.reduce((a, l) => a.plus(l.unitCostGbp.times(l.quantity)), ZERO),
                    2,
                  )}
                </Td>
                <Td align="right" numeric className={directionClass(position.realisedGbpFifo)}>
                  {money(position.realisedGbpFifo, 2)}
                </Td>
              </Tr>
              <Tr>
                <Td>Section 104 pool</Td>
                <Td align="right" numeric>
                  {quantity(position.s104.quantity)}
                </Td>
                <Td align="right" numeric>
                  {money(position.s104.costGbp, 2)}
                </Td>
                <Td align="right" numeric className={directionClass(position.realisedGbpS104)}>
                  {money(position.realisedGbpS104, 2)}
                </Td>
              </Tr>
            </tbody>
          </Table>
        </Card>
      </div>

      {/* ---- the ledger behind it ---- */}
      <Card
        title="Trades"
        subtitle="the source of every figure above"
        action={<Link href="/trades" className="hover:text-ink">All trades →</Link>}
      >
        <Table>
          <thead>
            <tr>
              <Th>Date</Th>
              <Th>Side</Th>
              <Th align="right">Quantity</Th>
              <Th align="right">Price</Th>
              <Th align="right">FX</Th>
              <Th align="right">Fees</Th>
              <Th align="right">Consideration (GBP)</Th>
              <Th>Source</Th>
            </tr>
          </thead>
          <tbody>
            {tradeRows.map((t) => {
              const fees = dec(t.commission)
                .plus(dec(t.stampDuty))
                .plus(dec(t.fxFee))
                .plus(dec(t.otherFees));
              const gross = dec(t.quantity).times(dec(t.price));
              const net = t.side === 'buy' ? gross.plus(fees) : gross.minus(fees);
              return (
                <Tr key={t.id} className={t.isVoid ? 'opacity-40 line-through' : undefined}>
                  <Td>{shortDate(t.tradeDate)}</Td>
                  <Td>
                    <Badge tone={t.side === 'buy' ? 'accent' : 'neutral'}>{t.side}</Badge>
                  </Td>
                  <Td align="right" numeric>
                    {quantity(dec(t.quantity))}
                  </Td>
                  <Td align="right" numeric>
                    {dec(t.price).toFixed(4)}
                    <span className="ml-1 text-[10px] text-muted">{t.tradeCurrency}</span>
                  </Td>
                  <Td align="right" numeric>
                    {dec(t.fxRate).toFixed(4)}
                  </Td>
                  <Td align="right" numeric>
                    {fees.isZero() ? '—' : fees.toFixed(2)}
                    {!dec(t.stampDuty).isZero() && (
                      <div className="text-[10px] text-muted">
                        incl. {dec(t.stampDuty).toFixed(2)} stamp
                      </div>
                    )}
                  </Td>
                  <Td align="right" numeric>
                    {money(net.times(dec(t.fxRate)), 2)}
                  </Td>
                  <Td>
                    <span className="text-[11px] text-muted">{t.source}</span>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </Card>

      {/* ---- disposals ---- */}
      {position.disposals.length > 0 && (
        <Card
          title="Disposals"
          subtitle="every matched sale, by method"
          footnote="A single sale appears once per method. The FIFO rows and the tax rows describe the same shares under different rules."
        >
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Method</Th>
                <Th align="right">Quantity</Th>
                <Th align="right">Proceeds</Th>
                <Th align="right">Cost</Th>
                <Th align="right">Gain</Th>
                <Th align="right">Held</Th>
              </tr>
            </thead>
            <tbody>
              {position.disposals.map((disposal, i) => (
                <Tr key={i}>
                  <Td>{shortDate(disposal.date)}</Td>
                  <Td>
                    <Badge tone={disposal.method === 'fifo' ? 'neutral' : 'accent'}>
                      {disposal.method.replace('_', ' ')}
                    </Badge>
                  </Td>
                  <Td align="right" numeric>
                    {quantity(disposal.quantity)}
                  </Td>
                  <Td align="right" numeric>
                    {money(disposal.proceedsGbp, 2)}
                  </Td>
                  <Td align="right" numeric>
                    {money(disposal.costGbp, 2)}
                  </Td>
                  <Td align="right" numeric className={directionClass(disposal.gainGbp)}>
                    {money(disposal.gainGbp, 2)}
                  </Td>
                  <Td align="right" numeric>
                    {disposal.holdingDays === undefined ? '—' : `${disposal.holdingDays}d`}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {/* ---- corporate actions ---- */}
      {actionRows.length > 0 && (
        <Card title="Corporate actions">
          <Table>
            <thead>
              <tr>
                <Th>Ex-date</Th>
                <Th>Kind</Th>
                <Th align="right">Ratio</Th>
                <Th align="right">Amount</Th>
                <Th>Status</Th>
                <Th>Source</Th>
              </tr>
            </thead>
            <tbody>
              {actionRows.map((a) => (
                <Tr key={a.id}>
                  <Td>{shortDate(a.actionDate)}</Td>
                  <Td>{a.kind.replace('_', ' ')}</Td>
                  <Td align="right" numeric>
                    {a.ratio ? dec(a.ratio).toFixed(4) : '—'}
                  </Td>
                  <Td align="right" numeric>
                    {a.amount ? dec(a.amount).toFixed(4) : '—'}
                  </Td>
                  <Td>
                    {a.applied ? (
                      <Badge tone="up">applied</Badge>
                    ) : (
                      <Badge tone="warn">awaiting confirmation</Badge>
                    )}
                  </Td>
                  <Td>
                    <span className="text-[11px] text-muted">{a.source ?? '—'}</span>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}

function DecompCell({
  label,
  value,
  decimals = 2,
  emphasis,
}: {
  label: string;
  value: ReturnType<typeof ONE.plus>;
  decimals?: number;
  emphasis?: boolean;
}) {
  return (
    <div className="border-b border-line px-4 py-3 md:border-b-0">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div
        className={`tabular mt-1 ${emphasis ? 'text-lg' : 'text-base'} ${directionClass(value)}`}
      >
        {percent(value, decimals, { signed: true })}
      </div>
    </div>
  );
}
