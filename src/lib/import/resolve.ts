/**
 * Turning a broker's security line into an `instruments` row.
 *
 * Trading 212 identifies a line by ticker + ISIN + price currency. None of
 * those is a Yahoo symbol, and the obvious guesses are wrong often enough to
 * matter (`BA` is BAE Systems). Resolution is by ISIN with the currency as the
 * tie-breaker, because an ETF's ISIN is shared by every one of its share
 * classes and only the currency says which one was actually traded.
 *
 * Everything here is keyless and hits Yahoo, so it runs once per NEW security
 * and never on a page load.
 */
import { fetchJson } from '../providers/http';
import { lookupInstrument } from '../providers/yahoo';
import {
  assetClassFromMix,
  fundSectorWeights,
  getFundProfile,
} from '../providers/yahoo-fund';
import { GBX, type Security } from './t212';

export interface ResolvedSecurity {
  ticker: string;
  isin: string;
  name: string;
  /** As traded: GBX, GBP, USD, EUR. */
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

export function currenciesAgree(t212: string, yahoo: string): boolean {
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
export function candidateSymbols(ticker: string, currency: string): string[] {
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
  quoteType?: string;
  sector?: string;
  industry?: string;
}

async function search(query: string, count: number): Promise<SearchQuote[]> {
  try {
    const body = await fetchJson<{ quotes?: SearchQuote[] }>(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=${count}&newsCount=0`,
      { provider: 'yahoo', capability: 'quote' },
    );
    return body.quotes ?? [];
  } catch {
    return [];
  }
}

export async function searchByIsin(isin: string): Promise<string[]> {
  return (await search(isin, 6))
    .map((q) => q.symbol)
    .filter((s): s is string => Boolean(s))
    // Stuttgart/Frankfurt cross-listings are quoted in EUR whatever the
    // original currency, and are never the line that was traded.
    .filter((s) => !s.endsWith('.SG') && !s.endsWith('.F'));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function resolveSecurity(s: Security): Promise<ResolvedSecurity> {
  const base = { ticker: s.ticker, isin: s.isin, name: s.name, currency: s.currency };
  const quoteCurrency = s.currency === GBX ? 'GBP' : s.currency;
  const quoteMultiplier = s.currency === GBX ? '0.01' : '1';

  const candidates = [...candidateSymbols(s.ticker, s.currency), ...(await searchByIsin(s.isin))];
  let nearMiss: ResolvedSecurity | null = null;

  for (const symbol of [...new Set(candidates)]) {
    try {
      const found = await lookupInstrument(symbol);
      const agree = currenciesAgree(s.currency, found.rawCurrency ?? '');
      const candidate: ResolvedSecurity = {
        ...base,
        yahooSymbol: found.yahooSymbol,
        yahooCurrency: found.rawCurrency ?? '?',
        // Trading 212's own currency label wins: it is what the trade was
        // actually priced in, and it is the number the cost basis depends on.
        quoteCurrency,
        quoteMultiplier,
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
    quoteCurrency,
    quoteMultiplier,
    exchangeMic: null,
    assetClass: 'equity',
    status: 'unresolved',
  };
}

/* ---------------- classification for a brand-new row ---------------- */

export interface Classification {
  sector: string | null;
  industry: string | null;
  sectorWeights: Record<string, number> | null;
  assetClass: string;
  country: string | null;
}

/**
 * The issuer's domicile, from the ISIN prefix. Not where the revenue comes
 * from; recorded so listing country can be shown beside revenue geography.
 */
export function countryFromIsin(isin: string | null): string | null {
  if (!isin || isin.length < 2) return null;
  const prefix = isin.slice(0, 2).toUpperCase();
  return /^[A-Z]{2}$/.test(prefix) ? prefix : null;
}

const FUND_CLASSES = new Set(['etf', 'bond', 'investment_trust']);

/**
 * What `npm run enrich` would do for one instrument, so a security that first
 * appears in an upload lands classified rather than as an "Unclassified" row
 * until someone remembers to run the script. Revenue geography is still left
 * blank: no free source has it, and guessing is the error §5 warns about.
 */
export async function classifyNew(r: ResolvedSecurity): Promise<Classification> {
  const out: Classification = {
    sector: null,
    industry: null,
    sectorWeights: null,
    assetClass: r.assetClass,
    country: countryFromIsin(r.isin),
  };
  if (!r.yahooSymbol) return out;

  if (FUND_CLASSES.has(r.assetClass)) {
    try {
      const profile = await getFundProfile(r.yahooSymbol);
      if (profile) {
        const weights = fundSectorWeights(profile);
        out.sectorWeights = weights;
        out.assetClass = assetClassFromMix(profile.assetMix, r.assetClass);
        const dominant = weights
          ? Object.entries(weights).sort((a, b) => b[1] - a[1])[0]
          : undefined;
        if (dominant && dominant[1] >= 0.9) out.sector = dominant[0];
      }
    } catch {
      // Classification is a nicety; the trade still records.
    }
    return out;
  }

  // Match the exact symbol; a fuzzy first hit would classify the wrong company.
  const hit = (await search(r.yahooSymbol, 4)).find(
    (q) => q.symbol?.toUpperCase() === r.yahooSymbol.toUpperCase(),
  );
  if (hit) {
    out.sector = hit.sector ?? null;
    out.industry = hit.industry ?? null;
  }
  return out;
}
