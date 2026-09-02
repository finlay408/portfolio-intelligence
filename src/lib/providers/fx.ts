/**
 * FX and macro series.
 *
 * FRED is the primary daily FX source and the only macro source. The one thing
 * to get right: FRED's `DEXUSUK` is *US dollars per pound* — a GBPUSD rate.
 * The portfolio needs USDGBP, so it is inverted here, once, at the boundary.
 * Storing it the wrong way round makes every US holding wrong by a factor of
 * roughly 1.6, which looks plausible enough to survive a casual glance.
 *
 * Yahoo is the keyless fallback for daily history. It matters more than a
 * fallback usually would: FRED needs a key and exchangerate.host now gates its
 * free tier, so without Yahoo a fresh install has no FX at all — and a GBP
 * portfolio holding USD assets with no FX series cannot be valued.
 */
import { Decimal, ONE, dec } from '../decimal';
import type { IsoDate } from '../types';
import { fetchJson } from './http';
import { bucketFor } from './rate-limiter';
import { yahooFxRate, yahooFxHistory } from './yahoo';
import type { FxProvider, FxRate } from './types';
import { ProviderError } from './types';

const FRED_HOST = 'https://api.stlouisfed.org/fred';

interface FredResponse {
  observations?: Array<{ date: string; value: string }>;
}

/** FRED series id, and whether the published rate needs inverting for our pair. */
const FRED_FX_SERIES: Record<string, { series: string; invert: boolean }> = {
  USDGBP: { series: 'DEXUSUK', invert: true }, // DEXUSUK is USD per GBP
  GBPUSD: { series: 'DEXUSUK', invert: false },
  // EURGBP has no single FRED series: it needs DEXUSEU and DEXUSUK crossed, not
  // one inverted. Left unmapped deliberately — the resolver falls through to
  // another provider rather than serving a wrong cross.
};

export const fredFx: FxProvider = {
  name: 'fred',

  async getDailyRates(pair: string, from: IsoDate, to: IsoDate): Promise<FxRate[]> {
    const spec = FRED_FX_SERIES[pair];
    if (!spec) throw new ProviderError('fred', 'fx', `no FRED series mapped for ${pair}`);
    const rows = await fredSeries(spec.series, from, to);
    return rows
      .filter((r) => !r.value.isZero())
      .map((r) => ({
        pair,
        date: r.date,
        rate: spec.invert ? ONE.div(r.value) : r.value,
        provider: 'fred',
      }));
  },
};

export async function fredSeries(
  seriesId: string,
  from: IsoDate,
  to: IsoDate,
): Promise<Array<{ date: IsoDate; value: Decimal }>> {
  const key = process.env.FRED_API_KEY;
  if (!key) throw new ProviderError('fred', 'macro', 'FRED_API_KEY not set');
  await bucketFor('fred').take('batch');

  const qs = new URLSearchParams({
    series_id: seriesId,
    api_key: key,
    file_type: 'json',
    observation_start: from,
    observation_end: to,
  });
  const body = await fetchJson<FredResponse>(`${FRED_HOST}/series/observations?${qs}`, {
    provider: 'fred',
    capability: 'macro',
  });

  return (body.observations ?? [])
    // FRED marks missing observations with '.', not with a null.
    .filter((o) => o.value !== '.' && o.value !== '')
    .map((o) => ({ date: o.date, value: dec(o.value) }));
}

/** Series the macro dashboard tracks (§6 routing table). */
export const MACRO_SERIES = {
  DGS10: 'US 10-year Treasury yield',
  T10Y2Y: 'US 10y-2y spread',
  VIXCLS: 'VIX',
  CPIAUCSL: 'US CPI',
  SOFR: 'SOFR',
  IUDSOIA: 'SONIA (Bank of England, daily)',
  DEXUSUK: 'USD per GBP',
} as const;

/**
 * The GBP risk-free rate for Sharpe (§7). SONIA, not US T-bills — a GBP-based
 * portfolio measured against a US risk-free rate has its Sharpe ratio moved by
 * the whole US-UK rate differential.
 */
export async function gbpRiskFreeDaily(
  from: IsoDate,
  to: IsoDate,
): Promise<Array<{ date: IsoDate; dailyRate: number }>> {
  const rows = await fredSeries('IUDSOIA', from, to);
  return rows.map((r) => ({
    // Annualised percent to a daily decimal rate.
    date: r.date,
    dailyRate: r.value.div(100).div(252).toNumber(),
  }));
}

/* ---------------- Intraday / fallback FX ---------------- */

interface ExchangeRateResponse {
  rates?: Record<string, number>;
  date?: string;
  success?: boolean;
}

export const exchangerateFx: FxProvider = {
  name: 'exchangerate.host',

  async getDailyRates(pair: string, from: IsoDate, to: IsoDate): Promise<FxRate[]> {
    const base = pair.slice(0, 3);
    const quote = pair.slice(3, 6);
    await bucketFor('exchangerate').take('batch');
    const qs = new URLSearchParams({ start_date: from, end_date: to, base, symbols: quote });
    const key = process.env.EXCHANGERATE_API_KEY;
    if (key) qs.set('access_key', key);

    const body = await fetchJson<{ rates?: Record<string, Record<string, number>> }>(
      `https://api.exchangerate.host/timeseries?${qs}`,
      { provider: 'exchangerate.host', capability: 'fx' },
    );

    return Object.entries(body.rates ?? {})
      .map(([date, r]) => ({ date, rate: r[quote] }))
      .filter((r): r is { date: string; rate: number } => typeof r.rate === 'number')
      .map((r) => ({ pair, date: r.date, rate: dec(r.rate), provider: 'exchangerate.host' }));
  },

  async getLatestRate(pair: string): Promise<FxRate | null> {
    const base = pair.slice(0, 3);
    const quote = pair.slice(3, 6);
    await bucketFor('exchangerate').take('interactive');
    const qs = new URLSearchParams({ base, symbols: quote });
    const key = process.env.EXCHANGERATE_API_KEY;
    if (key) qs.set('access_key', key);

    const body = await fetchJson<ExchangeRateResponse>(
      `https://api.exchangerate.host/latest?${qs}`,
      { provider: 'exchangerate.host', capability: 'fx' },
    );
    const rate = body.rates?.[quote];
    if (rate === undefined) return null;
    return {
      pair,
      date: body.date ?? new Date().toISOString().slice(0, 10),
      rate: dec(rate),
      provider: 'exchangerate.host',
    };
  },
};

/**
 * Yahoo's `USDGBP=X` style symbols. Keyless, and therefore the fallback that
 * keeps the £0/month constraint satisfiable on a fresh install with no API keys
 * at all.
 */
export const yahooFx: FxProvider = {
  name: 'yahoo',

  async getDailyRates(pair: string, from: IsoDate, to: IsoDate): Promise<FxRate[]> {
    const rows = await yahooFxHistory(pair, from, to);
    return rows.map((r) => ({ pair, date: r.date, rate: dec(r.rate), provider: 'yahoo' }));
  },

  async getLatestRate(pair: string): Promise<FxRate | null> {
    const rate = await yahooFxRate(pair);
    if (rate === null) return null;
    return {
      pair,
      date: new Date().toISOString().slice(0, 10),
      rate: dec(rate),
      provider: 'yahoo',
    };
  },
};
