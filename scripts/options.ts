/**
 * Option chain ingestion (Phase 5, §7.11).
 *
 *   npm run options
 *
 * How an option position is represented, given the schema in §5: it is an
 * ordinary `trades` row against an `instruments` row whose `asset_class` is
 * 'option' and whose `symbol` is the OCC symbol. `option_contracts` carries the
 * strike, expiry and right for that symbol. This keeps one ledger and one
 * position engine — an option is just an instrument with a multiplier of 100
 * and an expiry.
 *
 * Provider Greeks are taken where Alpaca supplies them. Deep in-the-money
 * contracts frequently come back without them; those are computed via
 * Black-Scholes and `greeks_source` records which is which, because a provider
 * Greek and a computed one are not the same number.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../src/db';
import {
  instruments,
  macroSeries,
  optionContracts,
  optionQuotes,
  pricesDaily,
  trades,
} from '../src/db/schema';
import { dec } from '../src/lib/decimal';
import { todayIso } from '../src/lib/dates';
import { blackScholes, impliedVolatility } from '../src/lib/engine/greeks';
import { getOptionChain } from '../src/lib/providers/alpaca';
import { args, runJob } from './_util';

const argv = args();

/** OCC: root (6, padded) + YYMMDD + C/P + strike x 1000 (8 digits). */
export function parseOccSymbol(occ: string): {
  root: string;
  expiry: string;
  right: 'C' | 'P';
  strike: number;
} | null {
  const match = /^([A-Z]{1,6})\s*(\d{6})([CP])(\d{8})$/.exec(occ.replace(/\s+/g, ''));
  if (!match) return null;
  const [, root, yymmdd, right, strike] = match as unknown as [string, string, string, 'C' | 'P', string];
  return {
    root,
    expiry: `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`,
    right,
    strike: Number(strike) / 1000,
  };
}

await runJob('options-chain', async () => {
  const today = todayIso();

  // Underlyings we actually hold options on, plus anything named explicitly.
  const heldOptionInstruments = await db
    .select({ id: instruments.id, symbol: instruments.symbol })
    .from(instruments)
    .innerJoin(trades, and(eq(trades.instrumentId, instruments.id), eq(trades.isVoid, false)))
    .where(eq(instruments.assetClass, 'option'));

  const explicit = typeof argv.underlying === 'string' ? argv.underlying.split(',') : [];
  const roots = new Set<string>(explicit);
  for (const row of heldOptionInstruments) {
    const parsed = parseOccSymbol(row.symbol);
    if (parsed) roots.add(parsed.root);
  }

  if (roots.size === 0) {
    console.log('[options] no option positions and no --underlying given; nothing to do');
    return { contracts: 0, quotes: 0 };
  }

  // Risk-free rate for the Black-Scholes fallback, from FRED.
  const [rf] = await db
    .select({ value: macroSeries.value })
    .from(macroSeries)
    .where(eq(macroSeries.seriesId, 'DGS10'))
    .orderBy(desc(macroSeries.obsDate))
    .limit(1);
  const rate = rf?.value ? dec(rf.value).div(100).toNumber() : 0.04;

  let contractCount = 0;
  let quoteCount = 0;
  let computedGreeks = 0;

  for (const root of roots) {
    const [underlying] = await db
      .select()
      .from(instruments)
      .where(eq(instruments.symbol, root))
      .limit(1);
    if (!underlying) {
      console.warn(`[options] no instrument row for underlying ${root}; skipping`);
      continue;
    }

    const [spotRow] = await db
      .select({ close: pricesDaily.close })
      .from(pricesDaily)
      .where(eq(pricesDaily.instrumentId, underlying.id))
      .orderBy(desc(pricesDaily.priceDate))
      .limit(1);
    const spot = spotRow ? dec(spotRow.close).toNumber() : null;

    const chain = await getOptionChain(root, { expiryFrom: today });
    const asOf = new Date();

    for (const contract of chain) {
      const parsed = parseOccSymbol(contract.occSymbol);
      if (!parsed) continue;

      const [stored] = await db
        .insert(optionContracts)
        .values({
          occSymbol: contract.occSymbol,
          underlyingId: underlying.id,
          expiry: parsed.expiry,
          strike: String(parsed.strike),
          right: parsed.right,
          multiplier: 100,
        })
        .onConflictDoUpdate({
          target: optionContracts.occSymbol,
          set: { underlyingId: underlying.id },
        })
        .returning({ id: optionContracts.id });
      if (!stored) continue;
      contractCount++;

      // Fill in what the provider did not supply.
      let { delta, gamma, theta, vega, rho, iv } = contract;
      let greeksSource: 'provider' | 'computed' = 'provider';

      const mid =
        contract.bid !== null && contract.ask !== null
          ? (contract.bid + contract.ask) / 2
          : contract.last;

      if ((delta === null || gamma === null) && spot && mid && mid > 0) {
        const years = Math.max(
          (Date.parse(parsed.expiry) - Date.now()) / 86_400_000 / 365,
          1 / 365 / 24,
        );
        const inputs = {
          spot,
          strike: parsed.strike,
          years,
          rate,
          right: parsed.right,
        };
        // Back-solve IV from the mid price, then take the Greeks at that vol.
        const solved = iv ?? impliedVolatility(mid, inputs);
        if (solved !== null) {
          const g = blackScholes({ ...inputs, volatility: solved });
          delta = g.delta;
          gamma = g.gamma;
          theta = g.theta;
          vega = g.vega;
          rho = g.rho;
          iv = solved;
          greeksSource = 'computed';
          computedGreeks++;
        }
      }

      await db
        .insert(optionQuotes)
        .values({
          contractId: stored.id,
          asOf,
          bid: contract.bid === null ? null : String(contract.bid),
          ask: contract.ask === null ? null : String(contract.ask),
          last: contract.last === null ? null : String(contract.last),
          iv: iv === null ? null : String(iv),
          delta: delta === null ? null : String(delta),
          gamma: gamma === null ? null : String(gamma),
          theta: theta === null ? null : String(theta),
          vega: vega === null ? null : String(vega),
          rho: rho === null ? null : String(rho),
          openInterest: contract.openInterest,
          greeksSource,
        })
        .onConflictDoNothing();
      quoteCount++;
    }

    console.log(`[options] ${root}: ${chain.length} contracts`);
  }

  return {
    underlyings: roots.size,
    contracts: contractCount,
    quotes: quoteCount,
    computedGreeks,
  };
});
