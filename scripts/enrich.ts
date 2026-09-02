/**
 * Fill in the classification the price feed cannot supply.
 *
 *   npm run enrich                 # equities and funds, automatically
 *   npm run enrich -- --funds      # funds only (ETFs, gilt trackers, ITs)
 *   npm run enrich -- --export     # write classification.csv for the rest
 *   npm run enrich -- --apply      # read it back
 *
 * Sector and industry for an equity come from Yahoo's search endpoint, which
 * returns them without an API key. Country comes from the ISIN prefix, which is
 * the issuer's domicile and is free and exact.
 *
 * A fund has no single sector, so it gets a **look-through split** instead,
 * from Yahoo's `topHoldings` module (see `providers/yahoo-fund.ts`): VWRP is
 * stored as 31% technology, 17% financials and nine other buckets rather than
 * as a blank. That module also reports the stock/bond/cash mix, which decides
 * `asset_class` from what a fund holds instead of from a regex over its name.
 *
 * Two things still have no free feed, which is why the CSV exists:
 *
 *   - **Revenue geography.** The brief is blunt about this: listing country is
 *     nearly useless as a risk measure, and an LSE-listed miner with 90%
 *     Chilean revenue is not UK exposure. Nobody publishes revenue splits for
 *     free — not even for funds, where Yahoo gives sectors but no regions — so
 *     the honest options are to fill them in or leave them unmapped, and
 *     "Unmapped" on screen is the truthful answer, not a bug. The fund pass
 *     does cross-check the curated table against the top ten holdings' listing
 *     venues and complains when they disagree.
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
import {
  assetClassFromMix,
  fundSectorWeights,
  getFundProfile,
  regionOfSymbol,
  topHoldingRegions,
} from '../src/lib/providers/yahoo-fund';
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
 *
 * This is the fallback. The fund pass reads the same fact out of the actual
 * stock/bond/cash mix, which is right for a fund named after its index rather
 * than after what it holds; the regex only has the title to go on.
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

/* ---------------- Fund look-through ---------------- */

/** Anything whose sector is a property of its holdings rather than of itself. */
const FUND_CLASSES = new Set(['etf', 'bond', 'investment_trust']);

const byWeightDesc = (w: Record<string, number>): Array<[string, number]> =>
  Object.entries(w).sort((a, b) => b[1] - a[1]);

const topThree = (w: Record<string, number>): string =>
  byWeightDesc(w)
    .slice(0, 3)
    .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`)
    .join(', ');

interface FundPassResult {
  /** Symbols given a look-through split. */
  profiled: string[];
  /** "SYM — name" for funds Yahoo has no breakdown for. */
  missing: string[];
  failed: string[];
  geographyWarnings: string[];
}

/**
 * Ask Yahoo what each fund actually holds and store the look-through split.
 *
 * Three things are written: the sector weights, the asset class implied by the
 * stock/bond/cash mix, and — only when a fund is overwhelmingly one sector — the
 * scalar `sector`, so a semiconductor ETF still reads as Technology in the
 * positions table.
 *
 * `revenue_regions` is deliberately NOT written. Yahoo has no regional
 * breakdown, and the curated table in this file is a better answer than
 * anything derivable from ten holdings. What the holdings can do is contradict
 * it, and a contradiction is worth printing.
 */
async function profileFunds(
  rows: Array<typeof instruments.$inferSelect>,
): Promise<FundPassResult> {
  const funds = rows.filter((r) => FUND_CLASSES.has(r.assetClass));
  const out: FundPassResult = { profiled: [], missing: [], failed: [], geographyWarnings: [] };
  if (funds.length === 0) return out;

  console.log(`\n[enrich] fund look-through — ${funds.length} funds\n`);

  for (const r of funds) {
    const symbol = r.yahooSymbol ?? r.symbol;
    let profile;
    try {
      profile = await getFundProfile(symbol);
    } catch (err) {
      out.failed.push(`${r.symbol} — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!profile) {
      out.missing.push(`${r.symbol} — ${r.name}`);
      continue;
    }

    const weights = fundSectorWeights(profile);
    const assetClass = assetClassFromMix(profile.assetMix, r.assetClass);

    // A single-sector fund genuinely has a sector — an energy tracker is energy
    // exposure. A broad tracker does not, and inventing one for it would be
    // worse than the blank the look-through split already replaces.
    const dominant = weights ? byWeightDesc(weights)[0] : undefined;
    const sector = dominant && dominant[1] >= 0.9 ? dominant[0] : r.sector;

    await db
      .update(instruments)
      .set({ sectorWeights: weights, assetClass, sector })
      .where(eq(instruments.id, r.id));

    // A fund Yahoo knows the asset mix for but publishes no sector split for —
    // a commodity fund, typically — is still unclassified for the sector grid.
    if (weights) out.profiled.push(r.symbol);
    else out.missing.push(`${r.symbol} — ${r.name}`);

    const moved = assetClass !== r.assetClass ? `  [asset_class → ${assetClass}]` : '';
    console.log(`  ${r.symbol.padEnd(10)} ${weights ? topThree(weights) : 'no sector breakdown'}${moved}`);

    // Geography cross-check. The stored table is the answer; this only says
    // when the holdings disagree with it loudly enough to be worth a look.
    const implied = topHoldingRegions(profile.topHoldings);
    const impliedTop = byWeightDesc(implied)[0];
    const stored = r.revenueRegions;
    // Only for funds that hold a real basket. A commodity fund holding two
    // futures lines, or a swap-based ETP holding a single US-listed ADR, says
    // nothing about geography — and 'Global' is not a claim about any region.
    const resolvable = profile.topHoldings.filter((h) => regionOfSymbol(h.symbol)).length;
    if (
      impliedTop &&
      impliedTop[1] >= 0.6 &&
      resolvable >= 5 &&
      stored &&
      Object.keys(stored).length > 0 &&
      !('Global' in stored)
    ) {
      const total = Object.values(stored).reduce((a, b) => a + b, 0);
      const storedShare = total > 0 ? (stored[impliedTop[0]] ?? 0) / total : 0;
      if (storedShare < 0.2) {
        out.geographyWarnings.push(
          `${r.symbol}: top holdings are ${(impliedTop[1] * 100).toFixed(0)}% ${impliedTop[0]}-listed, ` +
            `but revenue_regions has ${impliedTop[0]} at ${(storedShare * 100).toFixed(0)}%`,
        );
      }
    }

    await new Promise((res) => setTimeout(res, 110)); // stay polite
  }

  return out;
}

function reportFundPass(result: FundPassResult): void {
  console.log(`\n[enrich] ${result.profiled.length} funds given a look-through sector split.`);

  if (result.geographyWarnings.length > 0) {
    console.log('\n[enrich] geography worth checking — the holdings disagree with the table:');
    for (const w of result.geographyWarnings) console.log('           ' + w);
  }
  if (result.missing.length > 0) {
    console.log(`\n[enrich] ${result.missing.length} funds have no breakdown at Yahoo:`);
    for (const m of result.missing.slice(0, 15)) console.log('           ' + m);
    if (result.missing.length > 15) console.log(`           ...and ${result.missing.length - 15} more`);
    console.log('           Fill sector_weights by hand: --export, then --apply.');
  }
  if (result.failed.length > 0) {
    console.log(`\n[enrich] ${result.failed.length} fund lookups failed (see data_health):`);
    for (const f of result.failed.slice(0, 10)) console.log('           ' + f);
  }
}

/* ---------------- CSV ---------------- */

const regionsToText = (r: Record<string, number> | null): string =>
  r
    ? Object.entries(r)
        .map(([k, v]) => `${k}:${Number(v.toFixed(4))}`)
        .join(';')
    : '';

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

const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
const HEADER =
  'symbol,name,asset_class,sector,sector_weights,industry,country,revenue_regions,themes';

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
          // Absent column, not blank cell: a CSV exported before the fund pass
          // existed has no sector_weights, and must not silently wipe one.
          ...(c('sector_weights') >= 0
            ? { sectorWeights: textToRegions(get('sector_weights')) }
            : {}),
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
          regionsToText(r.sectorWeights ?? null),
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
    console.log('  sector_weights    "Technology:0.31;Financial Services:0.17"  — funds only');
    console.log('  themes            "Defence:0.7;Photonics:0.3" or just "Defence"');
    console.log('\n  sector_weights comes from the fund pass. Overwrite it only if you have a');
    console.log('  better source than the fund\'s own published breakdown.');
    console.log('\n  ETF geography is pre-filled from index weights as a STARTING POINT.');
    console.log('  Check it. Then: npm run enrich -- --apply');
    return { mode: 'export', instruments: rows.length, etfs };
  }

  /* ---------- --funds: look-through only ---------- */
  if (argv.funds) {
    const result = await profileFunds(rows);
    reportFundPass(result);
    console.log('\n[enrich] Reload /exposure — classification is read live, no recompute needed.');
    return { mode: 'funds', profiled: result.profiled.length, missing: result.missing.length };
  }

  /* ---------- default: automatic classification ---------- */
  let classified = 0;
  let countries = 0;
  const manual: Array<{ symbol: string; label: string }> = [];

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
      // Funds and anything Yahoo will not classify. Country still applies, and
      // the fund pass below picks up most of what lands here.
      if (country && country !== r.country) {
        await db.update(instruments).set({ country }).where(eq(instruments.id, r.id));
      }
      manual.push({ symbol: r.symbol, label: `${r.symbol} — ${r.name}` });
    }
    if (country) countries++;
    await new Promise((res) => setTimeout(res, 110)); // stay polite
  }

  console.log(`\n[enrich] ${classified} classified automatically, ${countries} countries from ISIN.`);

  // Funds are re-read from the database: the equity pass above may have moved a
  // row's country, and the fund pass writes asset_class from the holdings.
  const fundPass = await profileFunds(await db.select().from(instruments).orderBy(instruments.symbol));
  reportFundPass(fundPass);

  // Still manual = the equity pass could not classify it AND the fund pass did
  // not give it a look-through split either.
  const resolved = new Set(fundPass.profiled);
  const remaining = manual.filter((m) => !resolved.has(m.symbol));

  if (remaining.length > 0) {
    console.log(`\n[enrich] ${remaining.length} still need classifying by hand:`);
    for (const m of remaining.slice(0, 25)) console.log('           ' + m.label);
    if (remaining.length > 25) console.log(`           ...and ${remaining.length - 25} more`);
    console.log('\n         npm run enrich -- --export   then edit, then --apply');
  }

  return {
    mode: 'auto',
    classified,
    fundsProfiled: fundPass.profiled.length,
    manual: remaining.length,
  };
});
