/**
 * Yahoo fund data — what an ETF actually holds.
 *
 * The gap this fills: `enrich` classifies an equity from Yahoo's search
 * endpoint, but a fund has no single sector and search correctly returns
 * nothing for one. VWRP is not "Financials"; it is 31% technology, 17%
 * financials and nine other things, and until now that landed in the exposure
 * grid as "Unclassified" — the largest holding in the portfolio contributing
 * nothing to the sector view.
 *
 * Yahoo's `topHoldings` module carries the real published breakdown, for LSE
 * UCITS lines as well as US listings, and costs nothing. It gives:
 *
 *   - sector weightings — the whole point, and it is the fund's actual split,
 *     not a guess from its name;
 *   - the asset mix (stock / bond / cash), which classifies a gilt tracker as a
 *     bond holding from its holdings rather than from a regex over its title;
 *   - the top ten holdings, used here only to sanity-check geography.
 *
 * What it does NOT give is a regional breakdown. There is no free feed for
 * that, so `revenue_regions` for funds stays a curated table in `enrich.ts` and
 * the top-ten listing venues are used to flag when that table looks wrong.
 *
 * ## The crumb
 *
 * Unlike the chart endpoint, `quoteSummary` requires a session: a cookie from
 * fc.yahoo.com plus a crumb minted against it. Both are free and keyless, and
 * both expire, so the session is cached and re-minted once on a 401. This is an
 * unofficial API and will break (§6); nothing outside this file knows it exists.
 */
import { fetchJson } from './http';
import { bucketFor } from './rate-limiter';
import { ProviderError } from './types';

const HOST = 'https://query1.finance.yahoo.com';

/** quoteSummary rejects the polite UA that the chart endpoint accepts. */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ---------------- Types ---------------- */

export interface FundHolding {
  /** Yahoo's symbol, suffix included: 'AAPL', 'HSBA.L'. Null for unlisted lines. */
  symbol: string | null;
  name: string;
  /** Fraction of the fund, 0..1. */
  weight: number;
}

export interface AssetMix {
  stock: number;
  bond: number;
  cash: number;
  other: number;
}

export interface FundProfile {
  symbol: string;
  family: string | null;
  /** Morningstar-style category. Frequently null for UCITS lines. */
  category: string | null;
  legalType: string | null;
  /** Decimal, not percent: 0.0022 is 22bp. */
  expenseRatio: number | null;
  /**
   * Equity sector weights only, 0..1, labelled exactly as Yahoo labels an
   * individual equity's sector so funds and stocks land in the same buckets.
   * Null when Yahoo has no breakdown — a bond fund, or simply no data.
   */
  sectorWeights: Record<string, number> | null;
  topHoldings: FundHolding[];
  assetMix: AssetMix;
}

/* ---------------- Session ---------------- */

interface Session {
  cookie: string;
  crumb: string;
}

let cached: Promise<Session> | null = null;

async function mintSession(): Promise<Session> {
  // fc.yahoo.com answers 404 and sets the A1/A3 cookies anyway. The status is
  // deliberately not checked; the cookie is the payload.
  const seed = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA } });
  const cookie = (seed.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]!)
    .join('; ');
  if (!cookie) {
    throw new ProviderError('yahoo', 'fundamentals', 'no session cookie from fc.yahoo.com');
  }

  const res = await fetch(`${HOST}/v1/test/getcrumb`, {
    headers: { 'User-Agent': UA, Cookie: cookie },
  });
  const crumb = (await res.text()).trim();
  // A consent redirect or a block page returns HTML, not a crumb.
  if (!crumb || crumb.length > 32 || crumb.includes('<')) {
    throw new ProviderError('yahoo', 'fundamentals', `getcrumb returned ${crumb.slice(0, 60)}`);
  }
  return { cookie, crumb };
}

function session(): Promise<Session> {
  cached ??= mintSession().catch((err) => {
    cached = null; // never cache a failure
    throw err;
  });
  return cached;
}

/* ---------------- Raw shapes ---------------- */

type YNum = { raw?: number; fmt?: string } | undefined;

interface RawTopHoldings {
  sectorWeightings?: Array<Record<string, YNum | number>>;
  holdings?: Array<{ symbol?: string; holdingName?: string; holdingPercent?: YNum }>;
  stockPosition?: YNum;
  bondPosition?: YNum;
  cashPosition?: YNum;
  otherPosition?: YNum;
  preferredPosition?: YNum;
  convertiblePosition?: YNum;
}

interface RawFundProfile {
  family?: string | null;
  categoryName?: string | null;
  legalType?: string | null;
  feesExpensesInvestment?: { annualReportExpenseRatio?: YNum };
}

interface QuoteSummaryResponse {
  quoteSummary?: {
    result?: Array<{ topHoldings?: RawTopHoldings; fundProfile?: RawFundProfile }>;
    error?: { code?: string; description?: string } | null;
  };
}

const num = (v: YNum | number | undefined): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const raw = v?.raw;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
};

/**
 * Yahoo's sector keys, mapped to the labels its own search endpoint returns for
 * an individual equity. The mapping is the whole reason a fund's technology
 * sleeve aggregates with a directly held NVDA rather than sitting in a parallel
 * bucket spelled differently.
 */
const SECTOR_LABEL: Record<string, string> = {
  basic_materials: 'Basic Materials',
  communication_services: 'Communication Services',
  consumer_cyclical: 'Consumer Cyclical',
  consumer_defensive: 'Consumer Defensive',
  energy: 'Energy',
  financial_services: 'Financial Services',
  healthcare: 'Healthcare',
  industrials: 'Industrials',
  realestate: 'Real Estate',
  technology: 'Technology',
  utilities: 'Utilities',
};

/** Buckets for the part of a fund that is not equity. Not GICS sectors, but a
 *  gilt tracker's 98% belongs somewhere truthful in a sector table. */
export const FIXED_INCOME_BUCKET = 'Fixed Income';
export const CASH_BUCKET = 'Cash';
/**
 * Neither equity, bond nor cash: a physical commodity, a futures roll, a swap.
 * Yahoo reports a soybean fund and a carbon fund as 100% "other" with no
 * sectors at all, and "Alternatives" is what that is. It beats Unclassified,
 * which claims ignorance about something the provider has actually stated.
 */
export const ALTERNATIVES_BUCKET = 'Alternatives';

/* ---------------- Parsing ---------------- */

/** Pure: exported so the shape can be tested without a network call. */
export function parseFundProfile(
  symbol: string,
  result: { topHoldings?: RawTopHoldings; fundProfile?: RawFundProfile } | undefined,
): FundProfile | null {
  if (!result) return null;
  const top = result.topHoldings;
  const profile = result.fundProfile;

  const sectors: Record<string, number> = {};
  for (const entry of top?.sectorWeightings ?? []) {
    for (const [key, value] of Object.entries(entry)) {
      const label = SECTOR_LABEL[key];
      const weight = num(value);
      // Yahoo returns every sector including the zeros. A zero is not a bucket.
      if (label && weight !== null && weight > 0) {
        sectors[label] = (sectors[label] ?? 0) + weight;
      }
    }
  }

  const holdings: FundHolding[] = [];
  for (const h of top?.holdings ?? []) {
    const weight = num(h.holdingPercent);
    if (weight === null || weight <= 0) continue;
    holdings.push({
      symbol: h.symbol ?? null,
      name: h.holdingName ?? h.symbol ?? '',
      weight,
    });
  }

  // 'other' absorbs preferreds and convertibles so the mix stays a partition.
  const assetMix: AssetMix = {
    stock: num(top?.stockPosition) ?? 0,
    bond: num(top?.bondPosition) ?? 0,
    cash: num(top?.cashPosition) ?? 0,
    other:
      (num(top?.otherPosition) ?? 0) +
      (num(top?.preferredPosition) ?? 0) +
      (num(top?.convertiblePosition) ?? 0),
  };

  const hasAnything =
    Object.keys(sectors).length > 0 ||
    holdings.length > 0 ||
    assetMix.stock + assetMix.bond + assetMix.other > 0 ||
    assetMix.cash > 0;
  if (!hasAnything) return null;

  return {
    symbol,
    family: profile?.family ?? null,
    category: profile?.categoryName ?? null,
    legalType: profile?.legalType ?? null,
    expenseRatio: num(profile?.feesExpensesInvestment?.annualReportExpenseRatio),
    sectorWeights: Object.keys(sectors).length > 0 ? sectors : null,
    topHoldings: holdings,
    assetMix,
  };
}

/**
 * The full sector split to store on the instrument: the equity sleeve as Yahoo
 * reports it, plus the bond and cash sleeves as their own buckets.
 *
 * Without the extra buckets a 60/40 fund's bond half would be silently
 * redistributed across equity sectors by the grouper's normalisation, which
 * overstates every equity sector it touches. A gilt tracker gets a sector split
 * of 98% Fixed Income and stops reading as "Unclassified".
 */
export function fundSectorWeights(profile: FundProfile): Record<string, number> | null {
  const { stock, bond, cash, other } = profile.assetMix;
  let out: Record<string, number> = { ...(profile.sectorWeights ?? {}) };
  const equity = Object.values(out).reduce((a, b) => a + b, 0);

  // A bond fund with a sector list is reporting its ISSUERS' sectors, not an
  // equity allocation. Vanguard's Global Aggregate comes back as 100%
  // "Financial Services" because banks issue bonds — carrying that into the
  // equity sector grid would say the fund is half financials, which is not
  // merely imprecise but false. With no equity sleeve there is nothing to
  // classify, and Fixed Income is the whole answer.
  if (stock < 0.05) {
    out = {};
  } else if (equity > 0 && Math.abs(equity - stock) > 0.02) {
    // Otherwise Yahoo's sector weights cover the equity sleeve only, so they
    // are scaled onto it before the other sleeves are added alongside.
    for (const key of Object.keys(out)) out[key] = (out[key]! / equity) * stock;
  }

  // Below half a percent is rounding, not an allocation. The lower bound also
  // discards the negative cash a leveraged product reports (a 3x short gilt ETP
  // comes back as cash −100%, other 200%); a negative bucket would corrupt the
  // normalisation downstream and mean nothing in a weight table.
  if (bond > 0.005) out[FIXED_INCOME_BUCKET] = bond;
  if (cash > 0.005) out[CASH_BUCKET] = cash;
  if (other > 0.005) out[ALTERNATIVES_BUCKET] = other;

  const total = Object.values(out).reduce((a, b) => a + b, 0);
  if (total <= 0) return null;

  // A 3x product reports 300% notional and a futures fund 102%. The grouper
  // renormalises anyway, so the only thing storing more than 100% achieves is a
  // sector table that reads "300%". Under 100% is left alone: a fund whose
  // sleeves sum to 0.97 is telling you it does not account for all of itself.
  if (total > 1.005) {
    for (const key of Object.keys(out)) out[key] = out[key]! / total;
  }

  return out;
}

/**
 * Asset class from what the fund holds, not from what it is called.
 *
 * `enrich` currently reads 'Gilt' or 'Treasury' out of the name, which misses
 * anything named for its index rather than its instrument. The holdings say it
 * outright. Only funds are reclassified: an operating company that happens to
 * hold bonds is still an equity.
 */
export function assetClassFromMix(mix: AssetMix, current: string): string {
  if (current !== 'etf' && current !== 'bond') return current;
  if (mix.bond >= 0.7) return 'bond';
  if (mix.stock >= 0.7) return 'etf';
  return current;
}

/**
 * Region of a holding, from its listing suffix. Coarse by construction — this
 * exists to catch a geography table that says US for a fund whose top ten are
 * all `.L`, not to measure anything.
 */
const SUFFIX_REGION: Record<string, string> = {
  L: 'UK',
  DE: 'EU', F: 'EU', PA: 'EU', AS: 'EU', BR: 'EU', MI: 'EU', MC: 'EU', LS: 'EU',
  VI: 'EU', SW: 'EU', ST: 'EU', CO: 'EU', HE: 'EU', OL: 'EU', IR: 'EU', WA: 'EU',
  T: 'APAC', HK: 'APAC', TW: 'APAC', AX: 'APAC', KS: 'APAC', KQ: 'APAC',
  SS: 'APAC', SZ: 'APAC', SI: 'APAC', NZ: 'APAC', NS: 'APAC', BO: 'APAC',
  SA: 'LATAM', MX: 'LATAM', BA: 'LATAM', SN: 'LATAM',
  JO: 'EMEA', TA: 'EMEA', IS: 'EMEA', CA: 'EMEA',
  TO: 'CA', V: 'CA',
};

export function regionOfSymbol(symbol: string | null): string | null {
  if (!symbol) return null;
  const dot = symbol.lastIndexOf('.');
  if (dot < 0) return 'US'; // a bare ticker on Yahoo is a US listing
  return SUFFIX_REGION[symbol.slice(dot + 1).toUpperCase()] ?? null;
}

/** Region shares of the top holdings, renormalised over the ones that resolve. */
export function topHoldingRegions(holdings: FundHolding[]): Record<string, number> {
  const out: Record<string, number> = {};
  let total = 0;
  for (const h of holdings) {
    const region = regionOfSymbol(h.symbol);
    if (!region) continue;
    out[region] = (out[region] ?? 0) + h.weight;
    total += h.weight;
  }
  if (total <= 0) return {};
  for (const key of Object.keys(out)) out[key] = out[key]! / total;
  return out;
}

/* ---------------- Fetch ---------------- */

async function request(symbol: string, s: Session): Promise<QuoteSummaryResponse> {
  const qs = new URLSearchParams({
    modules: 'topHoldings,fundProfile',
    crumb: s.crumb,
  }).toString();
  return fetchJson<QuoteSummaryResponse>(
    `${HOST}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?${qs}`,
    {
      provider: 'yahoo',
      capability: 'fundamentals',
      headers: { 'User-Agent': UA, Cookie: s.cookie },
    },
  );
}

/**
 * Fetch a fund's composition. Returns null when Yahoo has no fund data for the
 * symbol, which is the normal answer for an individual equity and for a handful
 * of thinly covered UCITS lines — a null is not an error and must not be
 * treated as one.
 */
export async function getFundProfile(symbol: string): Promise<FundProfile | null> {
  await bucketFor('yahoo').take('batch');

  let body: QuoteSummaryResponse;
  try {
    body = await request(symbol, await session());
  } catch (err) {
    // An expired crumb is a 401. Mint a new session and try once more; a second
    // failure is a real failure and is left to the caller and `data_health`.
    if (err instanceof ProviderError && (err.status === 401 || err.status === 403)) {
      cached = null;
      body = await request(symbol, await session());
    } else {
      throw err;
    }
  }

  const error = body.quoteSummary?.error;
  if (error) {
    if (error.code === 'Unauthorized') {
      cached = null;
      body = await request(symbol, await session());
    } else {
      throw new ProviderError(
        'yahoo',
        'fundamentals',
        `${error.code ?? 'error'}: ${error.description ?? ''} (${symbol})`,
      );
    }
  }

  return parseFundProfile(symbol, body.quoteSummary?.result?.[0]);
}
