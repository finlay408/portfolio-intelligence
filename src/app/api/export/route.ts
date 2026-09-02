/**
 * CSV export (Phase 6).
 *
 *   /api/export?dataset=trades
 *   /api/export?dataset=positions
 *   /api/export?dataset=disposals&taxYear=2024/25
 *   /api/export?dataset=daily
 *
 * The disposals export exists for one reason: at the end of a tax year the
 * owner needs the Section 104 matching in a form they can hand to an
 * accountant. It is deliberately not a tax return — §13 rules that out — it is
 * the ledger's own working, exported.
 */
import { asc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { accounts, instruments, portfolioDaily, trades } from '@/db/schema';
import { requireOwner } from '@/lib/auth';
import { dec } from '@/lib/decimal';
import { todayIso, ukTaxYear } from '@/lib/dates';
import { loadLedger } from '@/lib/engine/load';
import { computePositions } from '@/lib/engine/positions';

export const dynamic = 'force-dynamic';

/** RFC 4180: quote anything containing a comma, quote or newline. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

function respond(filename: string, csv: string): Response {
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}

export async function GET(request: Request) {
  await requireOwner();

  const url = new URL(request.url);
  const dataset = url.searchParams.get('dataset') ?? 'trades';
  const accountId = url.searchParams.get('account')
    ? Number(url.searchParams.get('account'))
    : undefined;
  const taxYear = url.searchParams.get('taxYear');
  const stamp = todayIso();

  if (dataset === 'trades') {
    const rows = await db
      .select({ trade: trades, symbol: instruments.symbol, account: accounts.name })
      .from(trades)
      .innerJoin(instruments, eq(instruments.id, trades.instrumentId))
      .innerJoin(accounts, eq(accounts.id, trades.accountId))
      .orderBy(asc(trades.tradeDate), asc(trades.id));

    return respond(
      `trades-${stamp}.csv`,
      toCsv(
        [
          'trade_id',
          'account',
          'symbol',
          'trade_date',
          'side',
          'quantity',
          'price',
          'trade_currency',
          'fx_rate',
          'commission',
          'stamp_duty',
          'fx_fee',
          'other_fees',
          'consideration_gbp',
          'source',
          'is_void',
          'note',
        ],
        rows.map(({ trade, symbol, account }) => {
          const fees = dec(trade.commission)
            .plus(dec(trade.stampDuty))
            .plus(dec(trade.fxFee))
            .plus(dec(trade.otherFees));
          const gross = dec(trade.quantity).times(dec(trade.price));
          const net = trade.side === 'buy' ? gross.plus(fees) : gross.minus(fees);
          return [
            trade.id,
            account,
            symbol,
            trade.tradeDate,
            trade.side,
            trade.quantity,
            trade.price,
            trade.tradeCurrency,
            trade.fxRate,
            trade.commission,
            trade.stampDuty,
            trade.fxFee,
            trade.otherFees,
            net.times(dec(trade.fxRate)).toFixed(2),
            trade.source,
            trade.isVoid,
            trade.note,
          ];
        }),
      ),
    );
  }

  if (dataset === 'positions' || dataset === 'disposals') {
    const ledger = await loadLedger(accountId ? { accountId } : {});
    const derived = computePositions(
      ledger.trades,
      ledger.corporateActions,
      ledger.cashFlows,
      { asOf: todayIso(), accountId, strict: false },
    );
    const symbolOf = (id: number) => ledger.instrumentById.get(id)?.symbol ?? String(id);

    if (dataset === 'positions') {
      return respond(
        `positions-${stamp}.csv`,
        toCsv(
          [
            'account_id',
            'symbol',
            'quantity',
            'avg_unit_cost_local',
            'avg_unit_cost_gbp',
            'cost_basis_local',
            'cost_basis_gbp',
            'currency',
            'realised_gbp_average',
            'realised_gbp_fifo',
            'realised_gbp_s104',
            's104_pool_quantity',
            's104_pool_cost_gbp',
            'dividends_gbp',
            'fees_gbp',
            'opened_on',
            'closed_on',
            'is_open',
          ],
          derived.all.map((p) => [
            p.accountId,
            symbolOf(p.instrumentId),
            p.quantity.toFixed(),
            p.avgUnitCostLocal.toFixed(6),
            p.avgUnitCostGbp.toFixed(6),
            p.costBasisLocal.toFixed(2),
            p.costBasisGbp.toFixed(2),
            p.currency,
            p.realisedGbpAverage.toFixed(2),
            p.realisedGbpFifo.toFixed(2),
            p.realisedGbpS104.toFixed(2),
            p.s104.quantity.toFixed(),
            p.s104.costGbp.toFixed(2),
            p.dividendsGbp.toFixed(2),
            p.feesGbp.toFixed(2),
            p.openedOn,
            p.closedOn,
            p.isOpen,
          ]),
        ),
      );
    }

    // Disposals, tax-year filtered, HMRC matching methods only.
    const disposals = derived.all.flatMap((p) =>
      p.disposals
        .filter((d) => d.method !== 'fifo')
        .filter((d) => !taxYear || ukTaxYear(d.date) === taxYear)
        .map((d) => [
          p.accountId,
          symbolOf(p.instrumentId),
          d.date,
          ukTaxYear(d.date),
          d.method,
          d.quantity.toFixed(),
          d.proceedsGbp.toFixed(2),
          d.costGbp.toFixed(2),
          d.gainGbp.toFixed(2),
          d.matchedAgainstTradeId ?? '',
        ]),
    );

    return respond(
      `disposals-${taxYear?.replace('/', '-') ?? 'all'}-${stamp}.csv`,
      toCsv(
        [
          'account_id',
          'symbol',
          'disposal_date',
          'uk_tax_year',
          'matching_rule',
          'quantity',
          'proceeds_gbp',
          'cost_gbp',
          'gain_gbp',
          'matched_against_trade_id',
        ],
        disposals,
      ),
    );
  }

  if (dataset === 'daily') {
    const rows = await db
      .select()
      .from(portfolioDaily)
      .orderBy(asc(portfolioDaily.accountId), asc(portfolioDaily.snapDate));

    return respond(
      `portfolio-daily-${stamp}.csv`,
      toCsv(
        [
          'account_id',
          'snap_date',
          'market_value_gbp',
          'cost_basis_gbp',
          'cash_gbp',
          'net_flow_gbp',
          'twr_daily',
        ],
        rows.map((r) => [
          r.accountId,
          r.snapDate,
          r.marketValueGbp,
          r.costBasisGbp,
          r.cashGbp,
          r.netFlowGbp,
          r.twrDaily,
        ]),
      ),
    );
  }

  return Response.json(
    { error: `unknown dataset '${dataset}'`, available: ['trades', 'positions', 'disposals', 'daily'] },
    { status: 400 },
  );
}
