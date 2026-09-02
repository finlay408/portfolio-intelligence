/**
 * Import a real portfolio from a CSV (Phase 1 onboarding).
 *
 *   npm run import -- --file=my-portfolio.csv --dry-run
 *   npm run import -- --file=my-portfolio.csv
 *
 * This exists because there is no other way in. The trade form needs an
 * instrument to already exist, and nothing in the UI creates one — which is
 * fine for the steady state (you add a holding rarely) but useless for putting
 * an existing portfolio in.
 *
 * What it does that typing would not:
 *
 *   - Looks every unknown ticker up on Yahoo and creates the instrument with
 *     the right name, exchange, currency and — the dangerous one — the right
 *     GBX multiplier. A UK line Yahoo reports as `GBp` is stored at 0.01, so
 *     "450" in your CSV means £4.50 and not £450.
 *   - Applies UK stamp duty at 0.5% on share purchases, and correctly does not
 *     on ETFs and investment trusts.
 *   - Fills a missing FX rate from the stored daily series for the trade date,
 *     rather than from today.
 *
 * Always run it with --dry-run first. It prints exactly what it would create
 * and, importantly, what it thinks each instrument is.
 */
import { and, eq, sql } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { db } from '../src/db';
import { accounts, cashFlows, instruments, trades } from '../src/db/schema';
import { dec } from '../src/lib/decimal';
import { stampDutyFor } from '../src/lib/engine/auto-invest';
import { loadFx } from '../src/lib/engine/load';
import { lookupInstrument } from '../src/lib/providers/yahoo';
import { args, parseCsv, runJob } from './_util';

const argv = args();

/* ---------------- CSV ---------------- */

const TRADE_KINDS = new Set(['buy', 'sell']);
const CASH_KINDS = new Set(['deposit', 'withdrawal', 'dividend', 'interest', 'fee', 'tax']);

interface Row {
  line: number;
  account: string;
  type: string;
  date: string;
  symbol: string;
  quantity: string;
  price: string;
  amount: string;
  currency: string;
  fxRate: string;
  fees: string;
  stampDuty: string;
  note: string;
}

function toRows(table: string[][]): Row[] {
  const header = (table[0] ?? []).map((h) => h.trim().toLowerCase().replace(/[\s_-]/g, ''));
  const index = (...names: string[]) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };

  const cols = {
    account: index('account'),
    type: index('type', 'side', 'action'),
    date: index('date', 'tradedate'),
    symbol: index('symbol', 'ticker'),
    quantity: index('quantity', 'qty', 'shares', 'units'),
    price: index('price', 'pricepershare'),
    amount: index('amount', 'value', 'total'),
    currency: index('currency', 'ccy'),
    fxRate: index('fxrate', 'fx', 'rate'),
    fees: index('fees', 'fee', 'commission'),
    stampDuty: index('stampduty', 'stamp'),
    note: index('note', 'notes', 'description'),
  };

  for (const required of ['account', 'type', 'date'] as const) {
    if (cols[required] < 0) {
      throw new Error(
        `CSV is missing a '${required}' column. Found: ${header.join(', ')}\n` +
          'See portfolio-template.csv for the expected shape.',
      );
    }
  }

  const at = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');

  return table.slice(1).map((r, n) => ({
    line: n + 2,
    account: at(r, cols.account),
    type: at(r, cols.type).toLowerCase(),
    date: at(r, cols.date),
    symbol: at(r, cols.symbol).toUpperCase(),
    quantity: at(r, cols.quantity),
    price: at(r, cols.price),
    amount: at(r, cols.amount),
    currency: at(r, cols.currency).toUpperCase(),
    fxRate: at(r, cols.fxRate),
    fees: at(r, cols.fees),
    stampDuty: at(r, cols.stampDuty),
    note: at(r, cols.note),
  }));
}

/** Accept 2024-01-15, 15/01/2024 and 15-01-2024; reject anything ambiguous. */
function normaliseDate(raw: string, line: number): string {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (iso) return raw;
  const uk = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(raw);
  if (uk) {
    const [, d, m, y] = uk as unknown as [string, string, string, string];
    if (Number(m) > 12) throw new Error(`line ${line}: '${raw}' is not a valid date`);
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  throw new Error(
    `line ${line}: date '${raw}' is not recognised. Use YYYY-MM-DD (or DD/MM/YYYY).`,
  );
}

/* ---------------- Import ---------------- */

await runJob('import', async () => {
  const file = typeof argv.file === 'string' ? argv.file : 'my-portfolio.csv';
  const dryRun = Boolean(argv['dry-run']);
  const defaultWrapper = typeof argv.wrapper === 'string' ? argv.wrapper : 'ISA';

  const rows = toRows(parseCsv(await readFile(file, 'utf8')));
  if (rows.length === 0) throw new Error(`${file} has no data rows`);

  // ---- validate everything before writing anything ----
  const problems: string[] = [];
  for (const r of rows) {
    if (!TRADE_KINDS.has(r.type) && !CASH_KINDS.has(r.type)) {
      problems.push(
        `line ${r.line}: type '${r.type}' is not one of ` +
          `${[...TRADE_KINDS, ...CASH_KINDS].join(', ')}`,
      );
      continue;
    }
    try {
      r.date = normaliseDate(r.date, r.line);
    } catch (err) {
      problems.push((err as Error).message);
    }
    if (TRADE_KINDS.has(r.type)) {
      if (!r.symbol) problems.push(`line ${r.line}: a ${r.type} needs a symbol`);
      if (!r.quantity || !Number.isFinite(Number(r.quantity)) || Number(r.quantity) <= 0) {
        problems.push(`line ${r.line}: quantity '${r.quantity}' must be a positive number`);
      }
      if (!r.price || !Number.isFinite(Number(r.price))) {
        problems.push(`line ${r.line}: price '${r.price}' must be a number`);
      }
    } else if (!r.amount || !Number.isFinite(Number(r.amount))) {
      problems.push(`line ${r.line}: a ${r.type} needs an amount`);
    }
  }
  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s) — nothing was written:\n`);
    for (const p of problems.slice(0, 25)) console.error('  ' + p);
    if (problems.length > 25) console.error(`  ...and ${problems.length - 25} more`);
    throw new Error('fix the CSV and run again');
  }

  // ---- accounts ----
  const existingAccounts = await db.select().from(accounts);
  const accountId = new Map(existingAccounts.map((a) => [a.name.toLowerCase(), a.id]));

  for (const name of new Set(rows.map((r) => r.account))) {
    if (accountId.has(name.toLowerCase())) continue;
    // The wrapper drives the tax treatment, so it is inferred from the name
    // where possible and falls back to --wrapper rather than guessing silently.
    const upper = name.toUpperCase();
    const wrapper = upper.includes('ISA')
      ? 'ISA'
      : upper.includes('SIPP') || upper.includes('PENSION')
        ? 'SIPP'
        : upper.includes('GIA') || upper.includes('GENERAL')
          ? 'GIA'
          : defaultWrapper;

    console.log(`[import] account "${name}" -> ${wrapper}${dryRun ? ' (dry run)' : ''}`);
    if (!dryRun) {
      const [created] = await db
        .insert(accounts)
        .values({ name, wrapper, baseCurrency: 'GBP' })
        .returning({ id: accounts.id });
      accountId.set(name.toLowerCase(), created!.id);
    } else {
      accountId.set(name.toLowerCase(), -1);
    }
  }

  // ---- instruments ----
  const existingInstruments = await db.select().from(instruments);
  const instrumentId = new Map(existingInstruments.map((i) => [i.symbol.toUpperCase(), i.id]));
  const instrumentMeta = new Map(
    existingInstruments.map((i) => [
      i.symbol.toUpperCase(),
      { currency: i.quoteCurrency, multiplier: i.quoteMultiplier, assetClass: i.assetClass, mic: i.exchangeMic },
    ]),
  );

  const symbols = [...new Set(rows.filter((r) => r.symbol).map((r) => r.symbol))];
  const unresolved: string[] = [];

  for (const symbol of symbols) {
    if (instrumentId.has(symbol)) continue;
    try {
      const found = await lookupInstrument(symbol);
      const pence = found.quoteMultiplier === '0.01';
      console.log(
        `[import] ${symbol.padEnd(10)} ${found.name}\n` +
          `           ${found.assetClass} · ${found.exchangeMic ?? 'unknown venue'} · ` +
          `quoted in ${found.rawCurrency}` +
          (pence ? '  <-- PENCE: prices stored at 1/100' : '') +
          (found.lastPrice !== null
            ? `\n           last ${found.lastPrice} ${found.rawCurrency}` +
              (pence ? ` = £${(found.lastPrice / 100).toFixed(2)}` : '')
            : ''),
      );

      if (!dryRun) {
        const [created] = await db
          .insert(instruments)
          .values({
            symbol,
            name: found.name,
            assetClass: found.assetClass,
            exchangeMic: found.exchangeMic,
            quoteCurrency: found.quoteCurrency,
            quoteMultiplier: found.quoteMultiplier,
            yahooSymbol: found.yahooSymbol,
            alpacaSymbol:
              found.exchangeMic === 'XNAS' || found.exchangeMic === 'XNYS' ? symbol : null,
            finnhubSymbol: symbol,
          })
          .returning({ id: instruments.id });
        instrumentId.set(symbol, created!.id);
      } else {
        instrumentId.set(symbol, -1);
      }
      instrumentMeta.set(symbol, {
        currency: found.quoteCurrency,
        multiplier: found.quoteMultiplier,
        assetClass: found.assetClass,
        mic: found.exchangeMic,
      });
    } catch (err) {
      unresolved.push(`${symbol}: ${(err as Error).message}`);
    }
  }

  if (unresolved.length > 0) {
    console.error(`\n[import] could not resolve ${unresolved.length} symbol(s):`);
    for (const u of unresolved) console.error('  ' + u);
    console.error(
      '\nCheck the ticker on finance.yahoo.com — UK lines usually need a .L suffix\n' +
        '(RR.L, VUSA.L). Nothing was written.',
    );
    throw new Error('unresolved symbols');
  }

  // ---- fx ----
  const dates = rows.map((r) => r.date).sort();
  const fx = await loadFx(dates[0]!, dates.at(-1)!);
  const missingFx = new Set<string>();

  // ---- write ----
  let tradeCount = 0;
  let flowCount = 0;

  for (const r of rows) {
    const account = accountId.get(r.account.toLowerCase())!;

    if (TRADE_KINDS.has(r.type)) {
      const meta = instrumentMeta.get(r.symbol)!;
      const currency = r.currency || meta.currency;
      const quantity = dec(r.quantity);
      const price = dec(r.price);

      let fxRate = r.fxRate ? dec(r.fxRate) : null;
      if (!fxRate) {
        // The rate on the trade date, not today's — using today's would silently
        // restate the cost basis of every historical purchase.
        fxRate = fx.rateOn(currency, 'GBP', r.date);
        if (!fxRate) {
          missingFx.add(`${currency}GBP on ${r.date}`);
          continue;
        }
      }

      const consideration = quantity.times(price);
      const stamp = r.stampDuty
        ? dec(r.stampDuty)
        : r.type === 'buy'
          ? stampDutyFor(meta.assetClass, meta.mic, consideration)
          : dec(0);

      if (!dryRun) {
        await db.insert(trades).values({
          accountId: account,
          instrumentId: instrumentId.get(r.symbol)!,
          tradeDate: r.date,
          side: r.type,
          quantity: quantity.toFixed(),
          price: price.toFixed(),
          tradeCurrency: currency,
          fxRate: fxRate.toFixed(),
          commission: r.fees ? dec(r.fees).toFixed() : '0',
          stampDuty: stamp.toFixed(),
          source: 'import',
          note: r.note || null,
        });
      }
      tradeCount++;
      continue;
    }

    // cash flow
    const currency = r.currency || 'GBP';
    let fxRate = r.fxRate ? dec(r.fxRate) : null;
    if (!fxRate) {
      fxRate = currency === 'GBP' ? dec(1) : fx.rateOn(currency, 'GBP', r.date);
      if (!fxRate) {
        missingFx.add(`${currency}GBP on ${r.date}`);
        continue;
      }
    }

    // Withdrawals, fees and taxes are stored negative whatever sign the CSV
    // used, so a positive withdrawal cannot inflate the money-weighted return.
    const magnitude = dec(r.amount).abs();
    const signed =
      r.type === 'withdrawal' || r.type === 'fee' || r.type === 'tax'
        ? magnitude.negated()
        : magnitude;

    if (!dryRun) {
      await db.insert(cashFlows).values({
        accountId: account,
        flowDate: r.date,
        kind: r.type,
        amount: signed.toFixed(),
        flowCurrency: currency,
        fxRate: fxRate.toFixed(),
        instrumentId: r.symbol ? (instrumentId.get(r.symbol) ?? null) : null,
        note: r.note || null,
      });
    }
    flowCount++;
  }

  if (missingFx.size > 0) {
    console.warn(
      `\n[import] ${missingFx.size} row(s) skipped for want of an FX rate:\n` +
        [...missingFx].slice(0, 10).map((m) => '  ' + m).join('\n') +
        '\n\nRun `npm run backfill` to fetch the FX series, then import again —\n' +
        'or put an fx_rate column in the CSV.',
    );
  }

  console.log(
    `\n[import] ${dryRun ? 'WOULD create' : 'created'} ${tradeCount} trade(s) and ` +
      `${flowCount} cash flow(s).`,
  );
  if (dryRun) {
    console.log('[import] Dry run — nothing was written. Re-run without --dry-run to commit.');
  } else {
    console.log('[import] Next: npm run backfill && npm run recompute -- --from=inception');
  }

  return { file, dryRun, trades: tradeCount, cashFlows: flowCount, skipped: missingFx.size };
});
