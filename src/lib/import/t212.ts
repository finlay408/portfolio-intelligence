/**
 * Trading 212 export format — parsing and arithmetic, no I/O.
 *
 * Shared by the in-app upload (`src/lib/import/apply.ts`) and the CLI
 * (`scripts/import-t212.ts`) so there is exactly one reading of the format.
 *
 * Four things in this format will silently corrupt a portfolio, and each is
 * handled explicitly here rather than assumed:
 *
 *   1. `Exchange rate` INVERTS between trades and dividends. On a trade it is
 *      units of the price currency per GBP (divide); on a dividend it is GBP
 *      per unit (multiply). Get it backwards on a USD holding and the cost
 *      basis is out by a factor of 1.8.
 *
 *   2. Prices come in GBX for UK lines. `Currency (Price / share)` says so
 *      outright, which is better evidence than anything this codebase could
 *      infer, so it is trusted over Yahoo's label.
 *
 *   3. Trading 212 tickers are not Yahoo tickers. `BA` is BAE Systems, not
 *      Boeing. `RR` is Richtech Robotics, not Rolls-Royce. `NOV` appears twice
 *      in one account as two different companies. Securities are therefore
 *      keyed on ticker + ISIN, and resolved by ISIN.
 *
 *   4. `Total` on a dividend is the GROSS amount in GBP, while
 *      `Withholding tax` is in the local currency. Mixing them understates the
 *      dividend by the exchange rate.
 */
import { Decimal, dec } from '../decimal';
import { parseCsv } from './csv';

export interface T212Row {
  action: string;
  time: string;
  isin: string;
  ticker: string;
  name: string;
  id: string;
  shares: string;
  price: string;
  priceCurrency: string;
  exchangeRate: string;
  total: string;
  withholding: string;
  withholdingCurrency: string;
  stampDuty: string;
  conversionFee: string;
}

export const GBX = 'GBX';

/** Parse one export file. Throws if the header is not Trading 212's. */
export function parseT212Export(text: string): T212Row[] {
  const table = parseCsv(text);
  const header = (table[0] ?? []).map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);

  const idx = {
    action: col('Action'),
    time: col('Time (UTC)') >= 0 ? col('Time (UTC)') : col('Time'),
    isin: col('ISIN'),
    ticker: col('Ticker'),
    name: col('Name'),
    id: col('ID'),
    shares: col('No. of shares'),
    price: col('Price / share'),
    priceCurrency: col('Currency (Price / share)'),
    exchangeRate: col('Exchange rate'),
    total: col('Total'),
    withholding: col('Withholding tax'),
    withholdingCurrency: col('Currency (Withholding tax)'),
    stampDuty: col('Stamp duty reserve tax'),
    conversionFee: col('Currency conversion fee'),
  };

  if (idx.action < 0 || idx.time < 0 || idx.total < 0) {
    throw new Error(
      'this does not look like a Trading 212 export (no Action/Time/Total columns). ' +
        `Found: ${header.join(', ') || 'an empty file'}`,
    );
  }

  const at = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  return table
    .slice(1)
    .map((r) => ({
      action: at(r, idx.action),
      time: at(r, idx.time),
      isin: at(r, idx.isin),
      ticker: at(r, idx.ticker),
      name: at(r, idx.name),
      id: at(r, idx.id),
      shares: at(r, idx.shares),
      price: at(r, idx.price),
      priceCurrency: at(r, idx.priceCurrency).toUpperCase(),
      exchangeRate: at(r, idx.exchangeRate),
      total: at(r, idx.total),
      withholding: at(r, idx.withholding),
      withholdingCurrency: at(r, idx.withholdingCurrency).toUpperCase(),
      stampDuty: at(r, idx.stampDuty),
      conversionFee: at(r, idx.conversionFee),
    }))
    .filter((r) => r.action !== '');
}

/**
 * The broker's own ID where it gives one. Dividends carry none, so they get a
 * key built from every field that identifies the payment — two dividends on the
 * same line, same day, same rate and same holding are the same dividend.
 */
export function externalIdFor(row: T212Row): string {
  if (row.id) return row.id;
  return ['t212', row.action, row.time, row.isin, row.shares, row.price, row.total]
    .join('|')
    .toLowerCase();
}

/** Concatenate several files, drop rows seen twice, sort by time. */
export function mergeRows(files: T212Row[][]): T212Row[] {
  const seen = new Set<string>();
  const out: T212Row[] = [];
  for (const rows of files) {
    for (const r of rows) {
      const key = externalIdFor(r);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out.sort((a, b) => a.time.localeCompare(b.time));
}

export type Kind = 'buy' | 'sell' | 'deposit' | 'withdrawal' | 'dividend' | 'interest' | 'fee' | 'skip';

export function classify(action: string): Kind {
  const a = action.toLowerCase();
  if (a.includes('buy')) return 'buy';
  if (a.includes('sell')) return 'sell';
  if (a.startsWith('dividend')) return 'dividend';
  if (a.includes('interest')) return 'interest';
  if (a === 'deposit') return 'deposit';
  if (a === 'withdrawal') return 'withdrawal';
  if (a.includes('fee') || a.includes('charge')) return 'fee';
  // Card spending, currency conversions and the like are not portfolio events.
  return 'skip';
}

/**
 * Local currency -> GBP, in the direction this codebase stores it.
 *
 * Trading 212 quotes the rate one way round on a trade and the other way round
 * on a dividend. This is the single most dangerous function in the file, so the
 * caller checks the result against the broker's own `Total` rather than
 * trusting it.
 */
export function fxToGbp(row: T212Row, kind: Kind): Decimal | null {
  const raw = dec(row.exchangeRate || '0');
  if (raw.isZero()) return row.priceCurrency === 'GBP' ? dec(1) : null;

  // Prices in GBX are divided by 100 on the way in, so the rate must absorb the
  // same factor and a UK line ends up at exactly 1.
  const penceFactor = row.priceCurrency === GBX ? dec(100) : dec(1);

  return kind === 'dividend'
    ? raw.times(penceFactor) // dividends quote GBP per unit
    : penceFactor.div(raw); // trades quote units per GBP
}

/** Ticker and ISIN together: one ticker can be two companies. */
export const securityKey = (r: { ticker: string; isin: string }) => `${r.ticker}|${r.isin}`;

/** The currency the instrument row will carry, post-multiplier. */
export const quoteCurrencyOf = (priceCurrency: string) =>
  priceCurrency === GBX ? 'GBP' : priceCurrency;

export interface Security {
  ticker: string;
  isin: string;
  /** As printed in the export: GBX, GBP, USD, EUR... */
  currency: string;
  name: string;
}

/** Every distinct security the rows touch. */
export function securitiesIn(rows: T212Row[]): Map<string, Security> {
  const out = new Map<string, Security>();
  for (const r of rows) {
    if (!r.ticker || !r.isin) continue;
    out.set(securityKey(r), {
      ticker: r.ticker,
      isin: r.isin,
      currency: r.priceCurrency,
      name: r.name,
    });
  }
  return out;
}

export interface LedgerTrade {
  externalId: string;
  securityKey: string;
  date: string;
  side: 'buy' | 'sell';
  quantity: Decimal;
  /** Per share, post-multiplier, in `currency`. */
  price: Decimal;
  currency: string;
  fxRate: Decimal;
  /** In `currency`, like every fee column in `trades`. */
  fxFee: Decimal;
  stampDuty: Decimal;
  note: string;
  /** Broker's GBP total vs. ours; a drift over 2% is reported. */
  brokerTotalGbp: Decimal | null;
  computedTotalGbp: Decimal;
}

export interface LedgerFlow {
  externalId: string;
  securityKey: string | null;
  date: string;
  kind: 'deposit' | 'withdrawal' | 'dividend' | 'interest' | 'fee';
  /** Signed: withdrawals and fees negative. */
  amount: Decimal;
  currency: string;
  fxRate: Decimal;
  withholding: Decimal;
  note: string;
}

export interface LedgerEntries {
  trades: LedgerTrade[];
  flows: LedgerFlow[];
  /** Rows that could not be converted, with the reason. */
  problems: string[];
  /** Rows that are not portfolio events (card spending, conversions). */
  skipped: number;
  /** Trades cross-checked against the broker's GBP total, and how many drifted. */
  checked: number;
  mismatched: number;
  mismatches: string[];
}

export const MISMATCH_TOLERANCE = '0.02';

/**
 * Turn export rows into ledger entries.
 *
 * `quoteCurrencyFor` answers with the instrument's stored quote currency for a
 * security key, or undefined if the security is unknown — in which case the
 * currency printed in the export (GBX → GBP) is used.
 */
export function toLedgerEntries(
  rows: T212Row[],
  quoteCurrencyFor: (key: string) => string | undefined = () => undefined,
): LedgerEntries {
  const out: LedgerEntries = {
    trades: [],
    flows: [],
    problems: [],
    skipped: 0,
    checked: 0,
    mismatched: 0,
    mismatches: [],
  };

  for (const r of rows) {
    const kind = classify(r.action);
    if (kind === 'skip') {
      out.skipped++;
      continue;
    }
    const date = r.time.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      out.problems.push(`${r.action} with an unreadable time "${r.time}"`);
      continue;
    }
    const externalId = externalIdFor(r);
    const note = `Trading 212 ${r.action}`;

    if (kind === 'buy' || kind === 'sell') {
      if (!r.ticker || !r.isin) {
        out.problems.push(`${date} ${r.action}: no ticker or ISIN`);
        continue;
      }
      const rate = fxToGbp(r, kind);
      if (!rate) {
        out.problems.push(`${date} ${r.ticker}: no usable exchange rate`);
        continue;
      }
      const key = securityKey(r);
      const currency = quoteCurrencyFor(key) ?? quoteCurrencyOf(r.priceCurrency);

      // GBX -> GBP happens here, once, at the boundary.
      const divisor = r.priceCurrency === GBX ? dec(100) : dec(1);
      const quantity = dec(r.shares || '0');
      const price = dec(r.price || '0').div(divisor);
      if (quantity.lessThanOrEqualTo(0) || price.lessThanOrEqualTo(0)) {
        out.problems.push(`${date} ${r.ticker}: quantity or price missing`);
        continue;
      }

      // Fees are quoted in GBP by the broker; this codebase stores them in the
      // trade currency, so they are converted back.
      const toLocal = (gbp: Decimal) => (rate.isZero() ? gbp : gbp.div(rate));
      const feeGbp = dec(r.conversionFee || '0');
      const stampGbp = dec(r.stampDuty || '0');

      // Cross-check against the broker's own GBP total before anything is
      // written. This is what catches an inverted exchange rate.
      const gross = quantity.times(price).times(rate);
      const expected = r.total ? dec(r.total).abs() : null;
      if (expected && !expected.isZero()) {
        out.checked++;
        const drift = gross.minus(expected).abs().div(expected);
        if (drift.greaterThan(MISMATCH_TOLERANCE)) {
          out.mismatched++;
          out.mismatches.push(
            `${date} ${r.ticker}: computed £${gross.toFixed(2)} but the export says £${expected.toFixed(2)}`,
          );
        }
      }

      out.trades.push({
        externalId,
        securityKey: key,
        date,
        side: kind,
        quantity,
        price,
        currency,
        fxRate: rate,
        fxFee: toLocal(feeGbp),
        stampDuty: toLocal(stampGbp),
        note,
        brokerTotalGbp: expected,
        computedTotalGbp: gross,
      });
      continue;
    }

    // ---- cash ----
    if (kind === 'dividend') {
      if (!r.ticker || !r.isin) {
        out.problems.push(`${date} dividend with no ticker or ISIN`);
        continue;
      }
      const fx = fxToGbp(r, kind);
      if (!fx) {
        out.problems.push(`${date} ${r.ticker}: dividend could not be priced`);
        continue;
      }
      const key = securityKey(r);
      const divisor = r.priceCurrency === GBX ? dec(100) : dec(1);
      // Gross in the local currency; the broker's Total is the gross in GBP.
      const amount = dec(r.shares || '0').times(dec(r.price || '0').div(divisor));
      const whDivisor = r.withholdingCurrency === GBX ? dec(100) : dec(1);
      out.flows.push({
        externalId,
        securityKey: key,
        date,
        kind,
        amount: amount.abs(),
        currency: quoteCurrencyFor(key) ?? quoteCurrencyOf(r.priceCurrency),
        fxRate: fx,
        withholding: dec(r.withholding || '0').div(whDivisor),
        note,
      });
      continue;
    }

    // Deposits, withdrawals, interest and fees are already GBP.
    const magnitude = dec(r.total || '0').abs();
    if (magnitude.isZero()) {
      out.problems.push(`${date} ${r.action}: zero amount`);
      continue;
    }
    out.flows.push({
      externalId,
      securityKey: null,
      date,
      kind,
      // Withdrawals and fees are stored negative whatever sign the export used.
      amount: kind === 'withdrawal' || kind === 'fee' ? magnitude.negated() : magnitude,
      currency: 'GBP',
      fxRate: dec(1),
      withholding: dec(0),
      note,
    });
  }

  return out;
}

/* ---------------- de-duplication against what is already recorded ---------------- */

/**
 * Natural keys for rows recorded before broker IDs were stored.
 *
 * Quantities and prices go through Decimal so `1.1217948700` in the export and
 * `1.12179487` in Postgres are the same key. Everything that depends on the
 * exchange rate is left out on purpose: it is derived, and a rounding change
 * in the importer must not make an old row look new.
 */
export const tradeNaturalKey = (t: {
  instrumentId: number;
  date: string;
  side: string;
  quantity: Decimal;
  price: Decimal;
}) => [t.instrumentId, t.date, t.side, t.quantity.toFixed(), t.price.toFixed()].join('|');

export const flowNaturalKey = (f: {
  instrumentId: number | null;
  date: string;
  kind: string;
  amount: Decimal;
  currency: string;
}) => [f.instrumentId ?? '', f.date, f.kind, f.amount.toFixed(), f.currency].join('|');

export interface ExistingLedger {
  /** Broker IDs already stored, per table. */
  tradeIds: Set<string>;
  flowIds: Set<string>;
  /** Rows with no stored broker ID, counted by natural key. */
  tradeKeys: Map<string, number>;
  flowKeys: Map<string, number>;
}

export interface Plan<T> {
  insert: T[];
  /** Matched by broker ID. */
  duplicateById: number;
  /** Matched by natural key to a row recorded before IDs were kept. */
  duplicateByKey: number;
}

/**
 * Decide which entries are genuinely new.
 *
 * Natural-key matches are consumed as a multiset: two identical fills on the
 * same day are only both "already recorded" if the ledger holds two such rows.
 */
export function planInserts<T>(
  entries: T[],
  idOf: (e: T) => string,
  keyOf: (e: T) => string,
  ids: Set<string>,
  keys: Map<string, number>,
): Plan<T> {
  const remaining = new Map(keys);
  const plan: Plan<T> = { insert: [], duplicateById: 0, duplicateByKey: 0 };
  for (const e of entries) {
    if (ids.has(idOf(e))) {
      plan.duplicateById++;
      continue;
    }
    const key = keyOf(e);
    const left = remaining.get(key) ?? 0;
    if (left > 0) {
      remaining.set(key, left - 1);
      plan.duplicateByKey++;
      continue;
    }
    plan.insert.push(e);
  }
  return plan;
}
