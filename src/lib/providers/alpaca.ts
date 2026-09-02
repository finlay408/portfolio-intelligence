/**
 * Alpaca — real-time IEX quotes and daily bars for US listings.
 *
 * The free tier delivers IEX-consolidated data with no delay, which is the only
 * genuinely live source in the routing table. It covers US symbols only:
 * `supports()` returns false for anything without an `alpacaSymbol`, and the
 * resolver falls through to Yahoo for the LSE sleeve.
 */
import { dec } from '../decimal';
import type { EngineInstrument, IsoDate } from '../types';
import { fetchJson } from './http';
import { bucketFor } from './rate-limiter';
import type { Bar, PriceProvider, Quote } from './types';
import { ProviderError } from './types';

const DATA_HOST = 'https://data.alpaca.markets';

function credentials(): { 'APCA-API-KEY-ID': string; 'APCA-API-SECRET-KEY': string } {
  const key = process.env.ALPACA_KEY_ID;
  const secret = process.env.ALPACA_SECRET_KEY;
  if (!key || !secret) throw new ProviderError('alpaca', 'quote', 'ALPACA_KEY_ID/SECRET not set');
  return { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret };
}

interface SnapshotResponse {
  [symbol: string]: {
    latestTrade?: { p: number; t: string };
    latestQuote?: { bp: number; ap: number; t: string };
    dailyBar?: { c: number; o: number };
    prevDailyBar?: { c: number };
  };
}

interface BarsResponse {
  bars?: Record<
    string,
    Array<{ t: string; o: number; h: number; l: number; c: number; v: number }>
  >;
  next_page_token?: string | null;
}

export const alpacaProvider: PriceProvider = {
  name: 'alpaca',
  supports: (inst) => Boolean(inst.alpacaSymbol),
  delaySeconds: 0,
  capabilities: ['quote', 'bars', 'options'],

  async getQuote(insts: EngineInstrument[]): Promise<Quote[]> {
    const mapped = insts
      .map((i) => ({ inst: i, sym: i.alpacaSymbol }))
      .filter((x): x is { inst: EngineInstrument; sym: string } => Boolean(x.sym));
    if (mapped.length === 0) return [];

    await bucketFor('alpaca').take('interactive');
    const symbols = mapped.map((m) => m.sym).join(',');
    const body = await fetchJson<SnapshotResponse>(
      `${DATA_HOST}/v2/stocks/snapshots?symbols=${encodeURIComponent(symbols)}&feed=iex`,
      { provider: 'alpaca', capability: 'quote', headers: credentials() },
    );

    const out: Quote[] = [];
    for (const { inst, sym } of mapped) {
      const snap = body[sym];
      const price = snap?.latestTrade?.p ?? snap?.dailyBar?.c;
      if (price === undefined) continue;
      const prev = snap?.prevDailyBar?.c;
      out.push({
        instrumentId: inst.id,
        // US lines never carry a multiplier, but applying it costs nothing and
        // keeps the boundary rule absolute.
        price: dec(price).times(inst.quoteMultiplier),
        changePct: prev ? dec(price).div(prev).minus(1).times(100) : null,
        asOf: snap?.latestTrade?.t ? new Date(snap.latestTrade.t) : new Date(),
        delaySeconds: 0,
        provider: 'alpaca',
      });
    }
    return out;
  },

  async getDailyBars(inst: EngineInstrument, from: IsoDate, to: IsoDate): Promise<Bar[]> {
    const sym = inst.alpacaSymbol;
    if (!sym) return [];

    const out: Bar[] = [];
    let pageToken: string | null | undefined;

    do {
      await bucketFor('alpaca').take('batch');
      const qs = new URLSearchParams({
        symbols: sym,
        timeframe: '1Day',
        start: from,
        end: to,
        limit: '10000',
        adjustment: 'all', // split- and dividend-adjusted history
        feed: 'iex',
      });
      if (pageToken) qs.set('page_token', pageToken);

      const body = await fetchJson<BarsResponse>(`${DATA_HOST}/v2/stocks/bars?${qs}`, {
        provider: 'alpaca',
        capability: 'bars',
        headers: credentials(),
      });

      for (const b of body.bars?.[sym] ?? []) {
        out.push({
          date: b.t.slice(0, 10),
          open: dec(b.o).times(inst.quoteMultiplier),
          high: dec(b.h).times(inst.quoteMultiplier),
          low: dec(b.l).times(inst.quoteMultiplier),
          close: dec(b.c).times(inst.quoteMultiplier),
          // `adjustment=all` means the close IS the adjusted close here.
          adjClose: dec(b.c).times(inst.quoteMultiplier),
          volume: b.v,
          provider: 'alpaca',
        });
      }
      pageToken = body.next_page_token;
    } while (pageToken);

    return out;
  },
};

/* ---------------- Options chains (Phase 5) ---------------- */

export interface AlpacaOptionQuote {
  occSymbol: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
  openInterest: number | null;
  asOf: string;
}

interface OptionSnapshotResponse {
  snapshots?: Record<
    string,
    {
      latestQuote?: { bp: number; ap: number; t: string };
      latestTrade?: { p: number; t: string };
      greeks?: { delta: number; gamma: number; theta: number; vega: number; rho: number };
      impliedVolatility?: number;
      openInterest?: number;
    }
  >;
  next_page_token?: string | null;
}

/**
 * The indicative options feed is free and carries IV and the Greeks. Deep
 * in-the-money contracts frequently come back without them; those are filled by
 * the Black-Scholes fallback in `src/lib/engine/greeks.ts`, and the difference
 * is recorded in `option_quotes.greeks_source`.
 */
export async function getOptionChain(
  underlyingSymbol: string,
  opts: { expiryFrom?: IsoDate; expiryTo?: IsoDate } = {},
): Promise<AlpacaOptionQuote[]> {
  await bucketFor('alpaca').take('batch');
  const qs = new URLSearchParams({ feed: 'indicative', limit: '1000' });
  if (opts.expiryFrom) qs.set('expiration_date_gte', opts.expiryFrom);
  if (opts.expiryTo) qs.set('expiration_date_lte', opts.expiryTo);

  const body = await fetchJson<OptionSnapshotResponse>(
    `${DATA_HOST}/v1beta1/options/snapshots/${encodeURIComponent(underlyingSymbol)}?${qs}`,
    { provider: 'alpaca', capability: 'options', headers: credentials() },
  );

  return Object.entries(body.snapshots ?? {}).map(([occSymbol, s]) => ({
    occSymbol,
    bid: s.latestQuote?.bp ?? null,
    ask: s.latestQuote?.ap ?? null,
    last: s.latestTrade?.p ?? null,
    iv: s.impliedVolatility ?? null,
    delta: s.greeks?.delta ?? null,
    gamma: s.greeks?.gamma ?? null,
    theta: s.greeks?.theta ?? null,
    vega: s.greeks?.vega ?? null,
    rho: s.greeks?.rho ?? null,
    openInterest: s.openInterest ?? null,
    asOf: s.latestQuote?.t ?? s.latestTrade?.t ?? new Date().toISOString(),
  }));
}
