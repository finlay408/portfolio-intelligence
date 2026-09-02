/**
 * Portfolio Greeks (Phase 5, CLAUDE.md §7.11).
 *
 * The figure worth reading here is beta-weighted delta. A raw net delta summed
 * across different underlyings is meaningless — 100 delta of a 0.5-beta utility
 * is not 100 delta of a 2.0-beta semiconductor — so the headline is stated in
 * benchmark-share equivalents.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  instruments,
  optionContracts,
  optionQuotes,
  pricesDaily,
  trades,
} from '@/db/schema';
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
import { ZERO, dec } from '@/lib/decimal';
import { directionClass, money, number as fmtNumber, shortDate } from '@/lib/format';
import {
  aggregateGreeks,
  blackScholes,
  type Greeks,
  type OptionPosition,
} from '@/lib/engine/greeks';
import { computePositions } from '@/lib/engine/positions';
import { loadLedger } from '@/lib/engine/load';
import { todayIso } from '@/lib/dates';

export const dynamic = 'force-dynamic';

const EMPTY_GREEKS: Greeks = {
  price: 0,
  delta: 0,
  gamma: 0,
  vega: 0,
  theta: 0,
  rho: 0,
  d1: 0,
  d2: 0,
};

export default async function OptionsPage() {
  const ledger = await loadLedger();
  const derived = computePositions(ledger.trades, ledger.corporateActions, ledger.cashFlows, {
    asOf: todayIso(),
    strict: false,
  });

  const optionInstrumentIds = derived.open
    .filter((p) => ledger.instrumentById.get(p.instrumentId)?.assetClass === 'option')
    .map((p) => p.instrumentId);

  if (optionInstrumentIds.length === 0) {
    return (
      <Card
        title="Options"
        subtitle="no open option positions"
        footnote="An option position is a trade against an instrument whose asset class is 'option' and whose symbol is the OCC symbol. `npm run options` ingests the chain and fills in any Greeks the provider does not supply."
      >
        <Empty>
          Nothing to show. The schema, the Black-Scholes engine and the chain ingestion are in
          place; this page fills in as soon as an option trade is recorded.
        </Empty>
      </Card>
    );
  }

  const symbols = optionInstrumentIds
    .map((id) => ledger.instrumentById.get(id)?.symbol)
    .filter((s): s is string => Boolean(s));

  const contractRows = await db
    .select({
      contract: optionContracts,
      underlyingSymbol: instruments.symbol,
      underlyingId: instruments.id,
    })
    .from(optionContracts)
    .innerJoin(instruments, eq(instruments.id, optionContracts.underlyingId))
    .where(inArray(optionContracts.occSymbol, symbols));

  const contractIds = contractRows.map((r) => r.contract.id);
  const quoteRows =
    contractIds.length === 0
      ? []
      : await db
          .select()
          .from(optionQuotes)
          .where(inArray(optionQuotes.contractId, contractIds))
          .orderBy(desc(optionQuotes.asOf))
          .limit(2000);

  // Latest quote per contract.
  const latestQuote = new Map<number, (typeof quoteRows)[number]>();
  for (const q of quoteRows) if (!latestQuote.has(q.contractId)) latestQuote.set(q.contractId, q);

  const underlyingIds = [...new Set(contractRows.map((r) => r.underlyingId))];
  const spotRows =
    underlyingIds.length === 0
      ? []
      : await db
          .select({
            instrumentId: pricesDaily.instrumentId,
            close: pricesDaily.close,
            priceDate: pricesDaily.priceDate,
          })
          .from(pricesDaily)
          .where(inArray(pricesDaily.instrumentId, underlyingIds))
          .orderBy(desc(pricesDaily.priceDate))
          .limit(500);

  const spotBy = new Map<number, number>();
  for (const row of spotRows) {
    if (!spotBy.has(row.instrumentId)) spotBy.set(row.instrumentId, dec(row.close).toNumber());
  }

  const positions: OptionPosition[] = [];
  for (const id of optionInstrumentIds) {
    const symbol = ledger.instrumentById.get(id)?.symbol;
    const row = contractRows.find((r) => r.contract.occSymbol === symbol);
    if (!row) continue;
    const quote = latestQuote.get(row.contract.id);
    const position = derived.open.find((p) => p.instrumentId === id)!;

    positions.push({
      contractId: row.contract.id,
      underlyingId: row.underlyingId,
      right: row.contract.right as 'C' | 'P',
      strike: dec(row.contract.strike).toNumber(),
      contracts: position.quantity.toNumber(),
      multiplier: row.contract.multiplier,
      underlyingSpot: spotBy.get(row.underlyingId) ?? 0,
      // Beta comes from the nightly scenario pack; 1.0 is the visible default
      // rather than a silent exclusion.
      underlyingBeta: 1,
      expiry: row.contract.expiry,
      source: (quote?.greeksSource as 'provider' | 'computed') ?? 'computed',
      greeks: quote
        ? {
            ...EMPTY_GREEKS,
            price: quote.last ? dec(quote.last).toNumber() : 0,
            delta: quote.delta ? dec(quote.delta).toNumber() : 0,
            gamma: quote.gamma ? dec(quote.gamma).toNumber() : 0,
            vega: quote.vega ? dec(quote.vega).toNumber() : 0,
            theta: quote.theta ? dec(quote.theta).toNumber() : 0,
            rho: quote.rho ? dec(quote.rho).toNumber() : 0,
          }
        : EMPTY_GREEKS,
    });
  }

  // SPY as the benchmark for beta-weighting.
  const [spy] = await db.select().from(instruments).where(eq(instruments.symbol, 'SPY')).limit(1);
  const benchmarkPrice = spy ? (spotBy.get(spy.id) ?? 0) : 0;
  const agg = aggregateGreeks(positions, benchmarkPrice || 1);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3 xl:grid-cols-6">
        {[
          <Stat
            key="bwd"
            label="Beta-weighted delta"
            value={fmtNumber(agg.betaWeightedDelta, 0)}
            sub="in benchmark shares"
            hint="The only delta figure comparable across underlyings. A raw net delta summed over different names means nothing."
          />,
          <Stat key="d" label="Net delta" value={fmtNumber(agg.netDelta, 0)} sub="raw shares" />,
          <Stat key="g" label="Net gamma" value={fmtNumber(agg.netGamma, 2)} />,
          <Stat
            key="t"
            label="Theta / day"
            value={money(agg.thetaPerDay, 2)}
            tone={agg.thetaPerDay < 0 ? 'down' : 'up'}
          />,
          <Stat key="v" label="Net vega" value={fmtNumber(agg.netVega, 0)} sub="per 1.00 of vol" />,
          <Stat key="r" label="Net rho" value={fmtNumber(agg.netRho, 0)} />,
        ].map((node, i) => (
          <div key={i} className="bg-surface">
            {node}
          </div>
        ))}
      </div>

      <Card
        title="Contracts"
        subtitle={`${positions.length} open · ${agg.providerCount} provider Greeks, ${agg.computedCount} computed`}
        footnote="Greeks are per share. Multiply by the multiplier and the contract count for the position figure — which is what the totals above already do."
      >
        <Table>
          <thead>
            <tr>
              <Th>Contract</Th>
              <Th align="right">Contracts</Th>
              <Th align="right">Strike</Th>
              <Th>Expiry</Th>
              <Th align="right">Delta</Th>
              <Th align="right">Gamma</Th>
              <Th align="right">Theta</Th>
              <Th align="right">Vega</Th>
              <Th>Greeks from</Th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => {
              const row = contractRows.find((r) => r.contract.id === p.contractId)!;
              return (
                <Tr key={p.contractId}>
                  <Td>
                    {row.underlyingSymbol} {p.right === 'C' ? 'call' : 'put'}
                    <div className="text-[11px] text-muted">{row.contract.occSymbol}</div>
                  </Td>
                  <Td align="right" numeric className={directionClass(p.contracts)}>
                    {p.contracts}
                  </Td>
                  <Td align="right" numeric>
                    {p.strike.toFixed(2)}
                  </Td>
                  <Td>{shortDate(p.expiry)}</Td>
                  <Td align="right" numeric>
                    {p.greeks.delta.toFixed(3)}
                  </Td>
                  <Td align="right" numeric>
                    {p.greeks.gamma.toFixed(4)}
                  </Td>
                  <Td align="right" numeric>
                    {(p.greeks.theta / 365).toFixed(3)}
                  </Td>
                  <Td align="right" numeric>
                    {(p.greeks.vega / 100).toFixed(3)}
                  </Td>
                  <Td>
                    <Badge tone={p.source === 'provider' ? 'neutral' : 'warn'}>{p.source}</Badge>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </Card>

      <Card
        title="Vega by expiry"
        subtitle="where the volatility exposure sits"
        footnote="Front-month vega and long-dated vega respond to different things. A book that looks vega-neutral in aggregate can be short front and long back."
      >
        {agg.vegaByExpiry.length === 0 ? (
          <Empty>No vega recorded.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Expiry</Th>
                <Th align="right">Vega</Th>
              </tr>
            </thead>
            <tbody>
              {agg.vegaByExpiry.map((v) => (
                <Tr key={v.expiry}>
                  <Td>{shortDate(v.expiry)}</Td>
                  <Td align="right" numeric className={directionClass(v.vega)}>
                    {fmtNumber(v.vega, 0)}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
