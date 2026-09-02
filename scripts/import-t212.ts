/**
 * Trading 212 export importer.
 *
 *   npm run import:t212 -- --dir=./exports --resolve   # 1. build the symbol map
 *   npm run import:t212 -- --dir=./exports --dry-run   # 2. check what it would do
 *   npm run import:t212 -- --dir=./exports             # 3. commit it
 *
 * Point `--dir` at a folder of `from_*.csv` files straight out of Trading 212
 * (History → Export). Multiple files are concatenated and de-duplicated on the
 * broker's own transaction ID, so overlapping date ranges are safe.
 *
 * Four things in this format will silently corrupt a portfolio, and each is
 * handled explicitly below rather than assumed:
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
 *      in one account as two different companies. Resolution is therefore by
 *      ISIN, not ticker — see `--resolve`.
 *
 *   4. `Total` on a dividend is the GROSS amount in GBP, while
 *      `Withholding tax` is in the local currency. Mixing them understates the
 *      dividend by the exchange rate.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../src/db';
import { accounts, cashFlows, instruments, trades } from '../src/db/schema';
import { Decimal, dec } from '../src/lib/decimal';
import { fetchJson } from '../src/lib/providers/http';
import { lookupInstrument } from '../src/lib/providers/yahoo';
import { args, parseCsv, runJob } from './_util';

const argv = args();

/* ---------------- reading the export ---------------- */

interface T212Row {
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

function readExport(text: string): T212Row[] {
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
      'this does not look like a Trading 212 export (no Action/Time/Total columns).\n' +
        `Found: ${header.join(', ')}`,
    );
  }

  const at = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  return table.slice(1).map((r) => ({
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
  }));
}

async function readAll(dir: string): Promise<T212Row[]> {
  const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.csv'));
  if (files.length === 0) throw new Error(`no CSV files in ${dir}`);

  const seen = new Set<string>();
  const rows: T212Row[] = [];
  for (const f of files.sort()) {
    const parsed = readExport(await readFile(path.join(dir, f), 'utf8'));
    let added = 0;
    for (const r of parsed) {
      if (!r.action) continue;
      // Exports overlap at the boundaries; the broker's own ID de-duplicates.
      const key = r.id || `${r.action}|${r.time}|${r.ticker}|${r.total}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(r);
      added++;
    }
    console.log(`[t212] ${f}: ${parsed.length} rows, ${added} new`);
  }
  return rows.sort((a, b) => a.time.localeCompare(b.time));
}

/* ---------------- action mapping ---------------- */

type Kind = 'buy' | 'sell' | 'deposit' | 'withdrawal' | 'dividend' | 'interest' | 'fee' | 'skip';

function classify(action: string): Kind {
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

const GBX = 'GBX';

/**
 * Local currency -> GBP, in the direction this codebase stores it.
 *
 * Trading 212 quotes the rate one way round on a trade and the other way round
 * on a dividend. This is the single most dangerous line in the file, so it is
 * derived from the row's own arithmetic rather than trusted blindly: the caller
 * checks the result against `Total`.
 */
function fxToGbp(row: T212Row, kind: Kind): Decimal | null {
  const raw = dec(row.exchangeRate || '0');
  if (raw.isZero()) return row.priceCurrency === 'GBP' ? dec(1) : null;

  // Prices in GBX are divided by 100 on the way in, so the rate must absorb the
  // same factor and a UK line ends up at exactly 1.
  const penceFactor = row.priceCurrency === GBX ? dec(100) : dec(1);

  return kind === 'dividend'
    ? raw.times(penceFactor) // dividends quote GBP per unit
    : penceFactor.div(raw); // trades quote units per GBP
}

/* ---------------- symbol resolution ---------------- */

interface Resolved {
  t212Ticker: string;
  isin: string;
  name: string;
  currency: string;
  yahooSymbol: string;
  yahooCurrency: string;
  quoteCurrency: string;
  quoteMultiplier: string;
  exchangeMic: string | null;
  assetClass: string;
  status: 'ok' | 'currency-mismatch' | 'unresolved';
}

/** Yahoo's currency label for a pence-quoted line. */
const isPence = (c: string) => c === 'GBp' || c === GBX;

function currenciesAgree(t212: string, yahoo: string): boolean {
  if (isPence(t212) && isPence(yahoo)) return true;
  return t212.toUpperCase() === yahoo.toUpperCase();
}

/**
 * Candidate Yahoo symbols, best first.
 *
 * The suffix guess goes first on purpose. An ETF's ISIN is shared by every
 * share class, so an ISIN search for a GBP-quoted line happily returns the USD
 * one — same fund, wrong currency, and a cost basis that will never reconcile.
 * `TICKER.L` picks the listing actually traded.
 */
function candidateSymbols(ticker: string, currency: string): string[] {
  if (currency === GBX || currency === 'GBP') return [`${ticker}.L`];
  if (currency === 'EUR') {
    return [`${ticker}.AS`, `${ticker}.DE`, `${ticker}.PA`, `${ticker}.MI`, `${ticker}.CO`, `${ticker}.F`];
  }
  // A USD line is usually a US listing, but plenty of Irish-domiciled UCITS
  // ETFs trade in USD on the LSE (IUUS, DTLA). The bare ticker is tried first
  // and wins immediately for a US stock, so the extra candidate costs nothing.
  return [ticker, `${ticker}.L`];
}

interface SearchQuote {
  symbol?: string;
  longname?: string;
  shortname?: string;
}

async function searchByIsin(isin: string): Promise<string[]> {
  try {
    const body = await fetchJson<{ quotes?: SearchQuote[] }>(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(isin)}&quotesCount=6&newsCount=0`,
      { provider: 'yahoo', capability: 'quote' },
    );
    return (body.quotes ?? [])
      .map((q) => q.symbol)
      .filter((s): s is string => Boolean(s))
      // Stuttgart/Frankfurt cross-listings are quoted in EUR whatever the
      // original currency, and are never the line that was traded.
      .filter((s) => !s.endsWith('.SG') && !s.endsWith('.F'));
  } catch {
    return [];
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function resolveOne(ticker: string, isin: string, currency: string, name: string): Promise<Resolved> {
  const base: Omit<Resolved, 'yahooSymbol' | 'yahooCurrency' | 'quoteCurrency' | 'quoteMultiplier' | 'exchangeMic' | 'assetClass' | 'status'> =
    { t212Ticker: ticker, isin, name, currency };

  const tried: string[] = [];
  const candidates = [...candidateSymbols(ticker, currency), ...(await searchByIsin(isin))];

  let nearMiss: Resolved | null = null;

  for (const symbol of [...new Set(candidates)]) {
    tried.push(symbol);
    try {
      const found = await lookupInstrument(symbol);
      const agree = currenciesAgree(currency, found.rawCurrency ?? '');
      const candidate: Resolved = {
        ...base,
        yahooSymbol: found.yahooSymbol,
        yahooCurrency: found.rawCurrency ?? '?',
        // Trading 212's own currency label wins: it is what the trade was
        // actually priced in, and it is the number the cost basis depends on.
        quoteCurrency: currency === GBX ? 'GBP' : currency,
        quoteMultiplier: currency === GBX ? '0.01' : '1',
        exchangeMic: found.exchangeMic,
        assetClass: found.assetClass,
        status: agree ? 'ok' : 'currency-mismatch',
      };
      if (agree) return candidate;
      nearMiss ??= candidate;
    } catch {
      // try the next candidate
    }
    await sleep(120); // stay well inside Yahoo's tolerance
  }

  if (nearMiss) return nearMiss;
  return {
    ...base,
    yahooSymbol: '',
    yahooCurrency: '',
    quoteCurrency: currency === GBX ? 'GBP' : currency,
    quoteMultiplier: currency === GBX ? '0.01' : '1',
    exchangeMic: null,
    assetClass: 'equity',
    status: 'unresolved',
  };
}

const MAPPING_FILE = 't212-instruments.csv';

async function writeMapping(resolved: Resolved[]): Promise<void> {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  const lines = [
    't212_ticker,isin,name,t212_currency,yahoo_symbol,yahoo_currency,quote_currency,quote_multiplier,exchange_mic,asset_class,status',
    ...resolved.map((r) =>
      [
        r.t212Ticker, r.isin, r.name, r.currency, r.yahooSymbol, r.yahooCurrency,
        r.quoteCurrency, r.quoteMultiplier, r.exchangeMic ?? '', r.assetClass, r.status,
      ].map((v) => esc(String(v))).join(','),
    ),
  ];
  await writeFile(MAPPING_FILE, lines.join('\n') + '\n', 'utf8');
}

async function readMapping(): Promise<Map<string, Resolved>> {
  const table = parseCsv(await readFile(MAPPING_FILE, 'utf8'));
  const header = (table[0] ?? []).map((h) => h.trim());
  const c = (n: string) => header.indexOf(n);
  const out = new Map<string, Resolved>();
  for (const r of table.slice(1)) {
    if (!r[c('t212_ticker')]) continue;
    const item: Resolved = {
      t212Ticker: r[c('t212_ticker')]!.trim(),
      isin: (r[c('isin')] ?? '').trim(),
      name: (r[c('name')] ?? '').trim(),
      currency: (r[c('t212_currency')] ?? '').trim().toUpperCase(),
      yahooSymbol: (r[c('yahoo_symbol')] ?? '').trim(),
      yahooCurrency: (r[c('yahoo_currency')] ?? '').trim(),
      quoteCurrency: (r[c('quote_currency')] ?? 'GBP').trim().toUpperCase(),
      quoteMultiplier: (r[c('quote_multiplier')] ?? '1').trim(),
      exchangeMic: (r[c('exchange_mic')] ?? '').trim() || null,
      assetClass: (r[c('asset_class')] ?? 'equity').trim(),
      status: ((r[c('status')] ?? 'ok').trim() as Resolved['status']) || 'ok',
    };
    out.set(`${item.t212Ticker}|${item.isin}`, item);
  }
  return out;
}

/* ---------------- main ---------------- */

await runJob('import-t212', async () => {
  const dir = typeof argv.dir === 'string' ? argv.dir : '.';
  const dryRun = Boolean(argv['dry-run']);
  const resolveOnly = Boolean(argv.resolve);
  const accountName = typeof argv.account === 'string' ? argv.account : 'Trading 212 ISA';
  const wrapper = typeof argv.wrapper === 'string' ? argv.wrapper : 'ISA';

  const rows = await readAll(dir);
  console.log(`[t212] ${rows.length} unique transactions, ${rows[0]?.time.slice(0, 10)} to ${rows.at(-1)?.time.slice(0, 10)}\n`);

  // ---- phase 1: resolve symbols ----
  const securities = new Map<string, { ticker: string; isin: string; currency: string; name: string }>();
  for (const r of rows) {
    if (!r.ticker || !r.isin) continue;
    // Keyed on ISIN+currency, not ticker: one ticker can be two securities, and
    // one security can trade in two currencies.
    securities.set(`${r.ticker}|${r.isin}`, {
      ticker: r.ticker, isin: r.isin, currency: r.priceCurrency, name: r.name,
    });
  }

  if (resolveOnly) {
    console.log(`[t212] resolving ${securities.size} securities against Yahoo...\n`);
    const resolved: Resolved[] = [];
    let n = 0;
    for (const s of securities.values()) {
      const r = await resolveOne(s.ticker, s.isin, s.currency, s.name);
      resolved.push(r);
      n++;
      const flag = r.status === 'ok' ? ' ' : r.status === 'currency-mismatch' ? '~' : '!';
      console.log(
        `  ${flag} ${String(n).padStart(3)}/${securities.size} ${s.ticker.padEnd(7)} ${s.currency.padEnd(4)} -> ` +
          `${(r.yahooSymbol || 'UNRESOLVED').padEnd(12)} ${r.yahooCurrency.padEnd(5)} ${r.name.slice(0, 38)}`,
      );
    }
    resolved.sort((a, b) => a.status.localeCompare(b.status) || a.t212Ticker.localeCompare(b.t212Ticker));
    await writeMapping(resolved);

    const bad = resolved.filter((r) => r.status !== 'ok');
    console.log(`\n[t212] wrote ${MAPPING_FILE}`);
    console.log(`[t212] ${resolved.length - bad.length} resolved cleanly, ${bad.length} need a look:`);
    for (const r of bad) {
      console.log(`   ${r.status === 'unresolved' ? '!' : '~'} ${r.t212Ticker.padEnd(7)} ${r.name.slice(0, 40).padEnd(42)} ` +
        `traded in ${r.currency}, Yahoo says ${r.yahooCurrency || 'nothing'}`);
    }
    console.log(
      `\nOpen ${MAPPING_FILE}, fix any wrong yahoo_symbol, then run with --dry-run.`,
    );
    return { phase: 'resolve', securities: resolved.length, needsReview: bad.length };
  }

  // ---- phase 2: import ----
  const mapping = await readMapping().catch(() => {
    throw new Error(`${MAPPING_FILE} not found — run with --resolve first.`);
  });

  const missing = [...securities.keys()].filter((k) => !mapping.has(k));
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} securities are not in ${MAPPING_FILE} (${missing.slice(0, 5).join(', ')}...).\n` +
        'Re-run with --resolve.',
    );
  }
  const unresolved = [...mapping.values()].filter((m) => !m.yahooSymbol);
  if (unresolved.length > 0) {
    console.warn(
      `[t212] ${unresolved.length} securities have no Yahoo symbol; they will be created ` +
        'without one and simply carry no price history until you set it.\n',
    );
  }

  // account
  const [existingAccount] = await db.select().from(accounts).where(eq(accounts.name, accountName));
  let accountId = existingAccount?.id ?? -1;
  if (!existingAccount) {
    console.log(`[t212] account "${accountName}" (${wrapper})${dryRun ? ' — dry run' : ''}`);
    if (!dryRun) {
      const [created] = await db
        .insert(accounts)
        .values({ name: accountName, wrapper, baseCurrency: 'GBP', broker: 'Trading 212' })
        .returning({ id: accounts.id });
      accountId = created!.id;
    }
  }

  // instruments
  const existing = await db.select().from(instruments);
  const idBySymbol = new Map(existing.map((i) => [i.symbol.toUpperCase(), i.id]));

  for (const m of mapping.values()) {
    const symbol = (m.yahooSymbol || m.t212Ticker).toUpperCase();
    if (idBySymbol.has(symbol)) continue;
    if (!dryRun) {
      const [created] = await db
        .insert(instruments)
        .values({
          symbol,
          isin: m.isin || null,
          name: m.name || symbol,
          assetClass: m.assetClass,
          exchangeMic: m.exchangeMic,
          quoteCurrency: m.quoteCurrency,
          quoteMultiplier: m.quoteMultiplier,
          yahooSymbol: m.yahooSymbol || null,
          alpacaSymbol: m.exchangeMic === 'XNAS' || m.exchangeMic === 'XNYS' ? m.t212Ticker : null,
          finnhubSymbol: m.yahooSymbol || null,
        })
        .onConflictDoNothing()
        .returning({ id: instruments.id });
      if (created) idBySymbol.set(symbol, created.id);
    } else {
      idBySymbol.set(symbol, -1);
    }
  }

  // transactions
  const counts: Record<string, number> = {};
  const problems: string[] = [];
  let checked = 0;
  let mismatched = 0;

  for (const r of rows) {
    const kind = classify(r.action);
    if (kind === 'skip') {
      counts.skipped = (counts.skipped ?? 0) + 1;
      continue;
    }
    const date = r.time.slice(0, 10);

    if (kind === 'buy' || kind === 'sell') {
      const m = mapping.get(`${r.ticker}|${r.isin}`);
      if (!m) {
        problems.push(`${date} ${r.ticker}: not in the mapping`);
        continue;
      }
      const rate = fxToGbp(r, kind);
      if (!rate) {
        problems.push(`${date} ${r.ticker}: no usable exchange rate`);
        continue;
      }

      // GBX -> GBP happens here, once, at the boundary.
      const divisor = r.priceCurrency === GBX ? dec(100) : dec(1);
      const quantity = dec(r.shares);
      const price = dec(r.price).div(divisor);
      const currency = m.quoteCurrency;

      // Fees are quoted in GBP by the broker; this codebase stores them in the
      // trade currency, so they are converted back.
      const feeGbp = dec(r.conversionFee || '0');
      const stampGbp = dec(r.stampDuty || '0');
      const toLocal = (gbp: Decimal) => (rate.isZero() ? gbp : gbp.div(rate));

      // Cross-check against the broker's own GBP total before writing.
      const gross = quantity.times(price).times(rate);
      const expected = dec(r.total || '0').abs();
      if (!expected.isZero()) {
        checked++;
        const drift = gross.minus(expected).abs().div(expected);
        if (drift.greaterThan('0.02')) {
          mismatched++;
          if (problems.length < 12) {
            problems.push(
              `${date} ${r.ticker}: computed £${gross.toFixed(2)} but the export says £${expected.toFixed(2)}`,
            );
          }
        }
      }

      if (!dryRun) {
        await db.insert(trades).values({
          accountId,
          instrumentId: idBySymbol.get((m.yahooSymbol || m.t212Ticker).toUpperCase())!,
          tradeDate: date,
          side: kind,
          quantity: quantity.toFixed(),
          price: price.toFixed(),
          tradeCurrency: currency,
          fxRate: rate.toFixed(),
          fxFee: toLocal(feeGbp).toFixed(),
          stampDuty: toLocal(stampGbp).toFixed(),
          source: 'import',
          note: `Trading 212 ${r.action}${r.id ? ` #${r.id.slice(0, 8)}` : ''}`,
        });
      }
      counts[kind] = (counts[kind] ?? 0) + 1;
      continue;
    }

    // ---- cash ----
    let amount: Decimal;
    let currency = 'GBP';
    let rate = dec(1);
    let withholding = dec(0);
    let instrumentId: number | null = null;

    if (kind === 'dividend') {
      const m = mapping.get(`${r.ticker}|${r.isin}`);
      const divisor = r.priceCurrency === GBX ? dec(100) : dec(1);
      const fx = fxToGbp(r, kind);
      if (!m || !fx) {
        problems.push(`${date} ${r.ticker}: dividend could not be priced`);
        continue;
      }
      // Gross in the local currency; the broker's Total is the gross in GBP.
      amount = dec(r.shares).times(dec(r.price).div(divisor));
      currency = m.quoteCurrency;
      rate = fx;
      const whDivisor = r.withholdingCurrency === GBX ? dec(100) : dec(1);
      withholding = dec(r.withholding || '0').div(whDivisor);
      instrumentId = idBySymbol.get((m.yahooSymbol || m.t212Ticker).toUpperCase()) ?? null;
    } else {
      // Deposits, withdrawals, interest and fees are already GBP.
      amount = dec(r.total || '0');
    }

    // Withdrawals and fees are stored negative whatever sign the export used.
    const magnitude = amount.abs();
    const signed = kind === 'withdrawal' || kind === 'fee' ? magnitude.negated() : magnitude;

    if (!dryRun) {
      await db.insert(cashFlows).values({
        accountId,
        flowDate: date,
        kind,
        amount: signed.toFixed(),
        flowCurrency: currency,
        fxRate: rate.toFixed(),
        instrumentId,
        withholding: withholding.toFixed(),
        note: `Trading 212 ${r.action}`,
      });
    }
    counts[kind] = (counts[kind] ?? 0) + 1;
  }

  console.log('\n[t212] ' + (dryRun ? 'WOULD import' : 'imported') + ':');
  for (const [k, v] of Object.entries(counts).sort()) console.log(`         ${String(v).padStart(5)}  ${k}`);
  console.log(`\n[t212] cross-checked ${checked} trades against the broker's GBP totals — ` +
    `${mismatched} disagreed by more than 2%.`);

  if (problems.length > 0) {
    console.warn(`\n[t212] ${problems.length} issue(s):`);
    for (const p of problems.slice(0, 15)) console.warn('   ' + p);
  }

  if (dryRun) {
    console.log('\n[t212] Dry run — nothing written. Re-run without --dry-run to commit.');
  } else {
    console.log('\n[t212] Next: npm run backfill && npm run recompute -- --from=inception');
  }

  return { dryRun, ...counts, checked, mismatched, problems: problems.length };
});
