/**
 * Fill in the classification the price feed cannot supply.
 *
 *   npm run enrich                 # sector + industry + country, automatically
 *   npm run enrich -- --export     # write classification.csv for the rest
 *   npm run enrich -- --apply      # read it back
 *
 * Sector and industry come from Yahoo's search endpoint, which returns them for
 * equities without an API key. Country comes from the ISIN prefix, which is the
 * issuer's domicile and is free and exact.
 *
 * Three things no free feed can give you, which is why the CSV exists:
 *
 *   - **ETFs have no sector.** An all-world tracker is not "Financials"; it is
 *     the whole market. Yahoo correctly returns nothing, and guessing would be
 *     worse than leaving it blank.
 *
 *   - **Revenue geography.** The brief is blunt about this: listing country is
 *     nearly useless as a risk measure, and an LSE-listed miner with 90%
 *     Chilean revenue is not UK exposure. Nobody publishes revenue splits for
 *     free, so the honest options are to fill them in or leave them unmapped —
 *     and "Unmapped" on screen is the truthful answer, not a bug.
 *
 *   - **Themes.** "Critical Minerals" is your idea, not a data vendor's.
 *
 * The export pre-fills index ETFs with their approximate published index
 * weights, clearly as a starting point. Check them; they are round numbers, not
 * fund fact-sheet precision.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../src/db';
import { instrumentThemes, instruments, themes } from '../src/db/schema';
import { fetchJson } from '../src/lib/providers/http';
import { args, parseCsv, runJob } from './_util';

const argv = args();
const FILE = typeof argv.file === 'string' ? argv.file : 'classification.csv';

/* ---------------- Yahoo search: sector and industry ---------------- */

interface SearchQuote {
  symbol?: string;
  quoteType?: string;
  sector?: string;
  industry?: string;
  longname?: string;
}

async function classify(symbol: string): Promise<{ sector: string | null; industry: string | null; isEtf: boolean } | null> {
  try {
    const body = await fetchJson<{ quotes?: SearchQuote[] }>(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=4&newsCount=0`,
      { provider: 'yahoo', capability: 'quote' },
    );
    // Match the exact symbol; a fuzzy first hit would classify the wrong company.
    const hit = (body.quotes ?? []).find((q) => q.symbol?.toUpperCase() === symbol.toUpperCase());
    if (!hit) return null;
    return {
      sector: hit.sector ?? null,
      industry: hit.industry ?? null,
      isEtf: (hit.quoteType ?? '').toUpperCase() !== 'EQUITY',
    };
  } catch {
    return null;
  }
}

/**
 * The issuer's domicile, from the ISIN prefix.
 *
 * Note what this is NOT: where the revenue comes from. It is recorded because
 * the brief asks for listing country to be shown alongside revenue geography,
 * never instead of it.
 */
function countryFromIsin(isin: string | null): string | null {
  if (!isin || isin.length < 2) return null;
  const prefix = isin.slice(0, 2).toUpperCase();
  return /^[A-Z]{2}$/.test(prefix) ? prefix : null;
}

/* ---------------- ETF geography starting points ---------------- */

/**
 * Approximate published index weights, as a first draft for the CSV.
 *
 * Deliberately round. These are a starting point to correct, not a data feed —
 * an index's geographic split drifts every quarter and no free source tracks it.
 */
const ETF_GEOGRAPHY: Array<[RegExp, Record<string, number>]> = [
  // Order matters: the most specific pattern has to win. "Global Aggregate
  // Bond" must not be caught by the broad /world/ rule at the bottom.
  [/emerging/i, { APAC: 0.75, LATAM: 0.09, EMEA: 0.16 }],
  [/all[- ]?world|acwi|global equity|global aggregate/i, { US: 0.64, EU: 0.13, APAC: 0.15, UK: 0.04, Other: 0.04 }],
  [/developed europe|msci europe|stoxx|euro(?!pe mid)/i, { EU: 0.75, UK: 0.25 }],
  [/europe mid/i, { EU: 0.8, UK: 0.2 }],
  // "U.K. Gilt" carries full stops, and 3x short gilts are still UK exposure.
  [/ftse ?100|u\.?k\.? ?gilt|gilts?\b|uk equity|gbp .*bond/i, { UK: 1 }],
  [/north america|s&p ?500|nasdaq|us treasury|usd tips|usd .*bond|treasury bond/i, { US: 1 }],
  [/japan/i, { APAC: 1 }],
  [/asia pacific|taiwan|china|korea/i, { APAC: 1 }],
  [/defence|defense/i, { US: 0.55, EU: 0.3, UK: 0.1, APAC: 0.05 }],
  [/gold|commodity|carbon|soybean|oil|silver/i, { Global: 1 }],
  [/world/i, { US: 0.7, EU: 0.12, APAC: 0.13, UK: 0.05 }],
];

function inferGeography(name: string): Record<string, number> | null {
  for (const [pattern, regions] of ETF_GEOGRAPHY) {
    if (pattern.test(name)) return regions;
  }
  return null;
}

/**
 * A gilt tracker is a bond holding. The importer labels every fund 'etf',
 * which collapses the asset-class grid into one meaningless row — and the
 * equity/bond split is the first thing anyone wants from it.
 */
function inferAssetClass(name: string, current: string): string {
  if (current !== 'etf') return current;
  if (/\bgilt|treasury|bond|tips\b|fixed income|aggregate/i.test(name)) return 'bond';
  return 'etf';
}

/**
 * A single-sector ETF genuinely has a sector — an S&P 500 Energy tracker is
 * energy exposure. A broad index tracker does not, and inventing one for it
 * would be worse than the blank.
 */
const ETF_SECTOR: Array<[RegExp, string]> = [
  [/energy sector|oil ?& ?gas/i, 'Energy'],
  [/health ?care sector/i, 'Healthcare'],
  [/utilities sector/i, 'Utilities'],
  [/technology sector|semiconductor/i, 'Technology'],
  [/financials? sector/i, 'Financial Services'],
  [/defence|defense/i, 'Industrials'],
];

function inferSector(name: string): string | null {
  for (const [pattern, sector] of ETF_SECTOR) {
    if (pattern.test(name)) return sector;
  }
  return null;
}

const regionsToText = (r: Record<string, number> | null): string =>
  r ? Object.entries(r).map(([k, v]) => `${k}:${v}`).join(';') : '';

function textToRegions(text: string): Record<string, number> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const out: Record<string, number> = {};
  for (const part of trimmed.split(';')) {
    const [key, value] = part.split(':');
    if (!key?.trim()) continue;
    const n = Number(value ?? '1');
    if (Number.isFinite(n) && n > 0) out[key.trim()] = n;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/* ---------------- CSV ---------------- */

const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
const HEADER = 'symbol,name,asset_class,sector,industry,country,revenue_regions,themes';

await runJob('enrich', async () => {
  const rows = await db.select().from(instruments).orderBy(instruments.symbol);
  if (rows.length === 0) throw new Error('no instruments — import a portfolio first');

  /* ---------- --apply ---------- */
  if (argv.apply) {
    const table = parseCsv(await readFile(FILE, 'utf8'));
    const header = (table[0] ?? []).map((h) => h.trim().toLowerCase());
    const c = (n: string) => header.indexOf(n);
    if (c('symbol') < 0) throw new Error(`${FILE} has no 'symbol' column`);

    const bySymbol = new Map(rows.map((r) => [r.symbol.toUpperCase(), r]));
    const themeNames = new Set<string>();
    const memberships: Array<{ instrumentId: number; theme: string; weight: number }> = [];
    let updated = 0;

    for (const row of table.slice(1)) {
      const symbol = (row[c('symbol')] ?? '').trim().toUpperCase();
      const instrument = bySymbol.get(symbol);
      if (!symbol || !instrument) continue;

      const get = (n: string) => (c(n) >= 0 ? (row[c(n)] ?? '').trim() : '');
      const regions = textToRegions(get('revenue_regions'));

      // asset_class is editable too: the importer calls every fund an 'etf',
      // but a gilt tracker is a bond holding and belongs in a different row of
      // the asset-class grid.
      const assetClass = get('asset_class');
      const VALID = ['equity', 'etf', 'investment_trust', 'option', 'cash', 'bond'];
      if (assetClass && !VALID.includes(assetClass)) {
        throw new Error(
          `${symbol}: asset_class '${assetClass}' is not one of ${VALID.join(', ')}`,
        );
      }

      await db
        .update(instruments)
        .set({
          sector: get('sector') || null,
          industry: get('industry') || null,
          country: get('country') || null,
          revenueRegions: regions,
          ...(assetClass ? { assetClass } : {}),
        })
        .where(eq(instruments.id, instrument.id));
      updated++;

      // themes column: "Defence:0.7;Photonics:0.3" or just "Defence"
      for (const part of get('themes').split(';')) {
        const [name, weight] = part.split(':');
        const clean = (name ?? '').trim();
        if (!clean) continue;
        const w = Number(weight ?? '1');
        themeNames.add(clean);
        memberships.push({
          instrumentId: instrument.id,
          theme: clean,
          weight: Number.isFinite(w) && w > 0 ? Math.min(w, 1) : 1,
        });
      }
    }

    // themes
    if (themeNames.size > 0) {
      await db
        .insert(themes)
        .values([...themeNames].map((name) => ({ name })))
        .onConflictDoNothing();
    }
    const themeRows = await db.select().from(themes);
    const themeId = new Map(themeRows.map((t) => [t.name, t.id]));

    // Membership is rebuilt wholesale: the CSV is the statement of intent, so a
    // theme removed from a row must actually disappear.
    const touched = [...new Set(memberships.map((m) => m.instrumentId))];
    if (touched.length > 0) {
      await db.delete(instrumentThemes).where(inArray(instrumentThemes.instrumentId, touched));
      await db
        .insert(instrumentThemes)
        .values(
          memberships.map((m) => ({
            instrumentId: m.instrumentId,
            themeId: themeId.get(m.theme)!,
            weight: String(m.weight),
          })),
        )
        .onConflictDoNothing();
    }

    // Weights above 1 for one instrument would double-count it in every grid.
    const perInstrument = new Map<number, number>();
    for (const m of memberships) {
      perInstrument.set(m.instrumentId, (perInstrument.get(m.instrumentId) ?? 0) + m.weight);
    }
    const over = [...perInstrument.entries()].filter(([, w]) => w > 1.0001);
    if (over.length > 0) {
      console.warn(
        `\n[enrich] ${over.length} instrument(s) have theme weights summing above 1. ` +
          'They will be over-counted in the theme grid; the attribution residual will show it.',
      );
    }

    console.log(
      `[enrich] updated ${updated} instruments, ${themeNames.size} themes, ` +
        `${memberships.length} theme memberships`,
    );
    console.log('[enrich] Next: reload /exposure and /attribution — no recompute needed,\n' +
      '         classification is read live.');
    return { mode: 'apply', updated, themes: themeNames.size, memberships: memberships.length };
  }

  /* ---------- --export ---------- */
  if (argv.export) {
    const lines = [HEADER];
    for (const r of rows) {
      const isFund = r.assetClass === 'etf' || r.assetClass === 'bond';
      const geography = r.revenueRegions ?? (isFund ? inferGeography(r.name) : null);
      lines.push(
        [
          r.symbol,
          r.name,
          inferAssetClass(r.name, r.assetClass),
          r.sector ?? (isFund ? (inferSector(r.name) ?? '') : ''),
          r.industry ?? '',
          r.country ?? countryFromIsin(r.isin) ?? '',
          regionsToText(geography),
          '',
        ]
          .map((v) => esc(String(v)))
          .join(','),
      );
    }
    await writeFile(FILE, lines.join('\n') + '\n', 'utf8');

    const etfs = rows.filter((r) => r.assetClass === 'etf').length;
    console.log(`[enrich] wrote ${FILE} — ${rows.length} instruments (${etfs} ETFs)\n`);
    console.log('  revenue_regions   "US:0.6;EU:0.25;APAC:0.15"  — weights, any scale');
    console.log('  themes            "Defence:0.7;Photonics:0.3" or just "Defence"');
    console.log('\n  ETF geography is pre-filled from index weights as a STARTING POINT.');
    console.log('  Check it. Then: npm run enrich -- --apply');
    return { mode: 'export', instruments: rows.length, etfs };
  }

  /* ---------- default: automatic classification ---------- */
  let classified = 0;
  let countries = 0;
  const manual: string[] = [];

  for (const r of rows) {
    const symbol = r.yahooSymbol ?? r.symbol;
    const country = r.country ?? countryFromIsin(r.isin);
    const found = await classify(symbol);

    if (found?.sector) {
      await db
        .update(instruments)
        .set({ sector: found.sector, industry: found.industry, country })
        .where(eq(instruments.id, r.id));
      classified++;
      console.log(`  ${r.symbol.padEnd(10)} ${found.sector} / ${found.industry ?? '—'}`);
    } else {
      // ETFs and anything Yahoo will not classify. Country still applies.
      if (country && country !== r.country) {
        await db.update(instruments).set({ country }).where(eq(instruments.id, r.id));
      }
      manual.push(`${r.symbol} — ${r.name}`);
    }
    if (country) countries++;
    await new Promise((res) => setTimeout(res, 110)); // stay polite
  }

  console.log(`\n[enrich] ${classified} classified automatically, ${countries} countries from ISIN.`);
  if (manual.length > 0) {
    console.log(`\n[enrich] ${manual.length} need classifying by hand — mostly ETFs, which`);
    console.log('         genuinely have no single sector:');
    for (const m of manual.slice(0, 25)) console.log('           ' + m);
    if (manual.length > 25) console.log(`           ...and ${manual.length - 25} more`);
    console.log('\n         npm run enrich -- --export   then edit, then --apply');
  }

  return { mode: 'auto', classified, manual: manual.length };
});
