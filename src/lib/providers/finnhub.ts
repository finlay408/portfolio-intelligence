/**
 * Finnhub — quote fallback and the earnings calendar.
 *
 * 60 requests a minute on the free tier. LSE coverage is patchy, so it sits
 * behind Yahoo for UK lines but ahead of it for the earnings calendar, where
 * Yahoo has no usable endpoint.
 */
import { dec } from '../decimal';
import type { EngineInstrument, IsoDate } from '../types';
import { fetchJson } from './http';
import { bucketFor } from './rate-limiter';
import type { Bar, EarningsEvent, PriceProvider, Quote } from './types';
import { ProviderError } from './types';

const HOST = 'https://finnhub.io/api/v1';

function token(): string {
  const t = process.env.FINNHUB_API_KEY;
  if (!t) throw new ProviderError('finnhub', 'quote', 'FINNHUB_API_KEY not set');
  return t;
}

interface QuoteResponse {
  c: number; // current
  d: number | null; // change
  dp: number | null; // percent change
  pc: number; // previous close
  t: number; // unix seconds
}

interface EarningsCalendarResponse {
  earningsCalendar?: Array<{
    symbol: string;
    date: string;
    hour?: string; // 'bmo' | 'amc' | ''
    quarter?: number;
    year?: number;
    epsEstimate?: number | null;
    epsActual?: number | null;
    revenueEstimate?: number | null;
    revenueActual?: number | null;
  }>;
}

export const finnhubProvider: PriceProvider = {
  name: 'finnhub',
  supports: (inst) => Boolean(inst.finnhubSymbol),
  delaySeconds: 60,
  capabilities: ['quote', 'earnings'],

  async getQuote(insts: EngineInstrument[]): Promise<Quote[]> {
    const out: Quote[] = [];
    for (const inst of insts) {
      const sym = inst.finnhubSymbol;
      if (!sym) continue;
      await bucketFor('finnhub').take('interactive');
      const body = await fetchJson<QuoteResponse>(
        `${HOST}/quote?symbol=${encodeURIComponent(sym)}&token=${token()}`,
        { provider: 'finnhub', capability: 'quote' },
      );
      if (!body.c) continue;
      out.push({
        instrumentId: inst.id,
        price: dec(body.c).times(inst.quoteMultiplier),
        changePct: body.dp === null || body.dp === undefined ? null : dec(body.dp),
        asOf: body.t ? new Date(body.t * 1000) : new Date(),
        delaySeconds: 60,
        provider: 'finnhub',
      });
    }
    return out;
  },

  async getDailyBars(): Promise<Bar[]> {
    // Historical candles moved behind Finnhub's paid tier. Declaring this
    // honestly keeps the resolver from burning a request to discover it.
    throw new ProviderError('finnhub', 'bars', 'daily candles are not on the free tier');
  },

  async getEarnings(
    insts: EngineInstrument[],
    from: IsoDate,
    to: IsoDate,
  ): Promise<EarningsEvent[]> {
    const bySymbol = new Map<string, EngineInstrument>();
    for (const i of insts) {
      const sym = i.finnhubSymbol;
      if (sym) bySymbol.set(sym.toUpperCase(), i);
    }
    if (bySymbol.size === 0) return [];

    await bucketFor('finnhub').take('batch');
    const body = await fetchJson<EarningsCalendarResponse>(
      `${HOST}/calendar/earnings?from=${from}&to=${to}&token=${token()}`,
      { provider: 'finnhub', capability: 'earnings' },
    );

    const out: EarningsEvent[] = [];
    for (const e of body.earningsCalendar ?? []) {
      const inst = bySymbol.get(e.symbol.toUpperCase());
      if (!inst) continue;
      out.push({
        instrumentId: inst.id,
        reportDate: e.date,
        session: e.hour === 'bmo' || e.hour === 'amc' ? e.hour : 'unknown',
        fiscalPeriod: e.quarter && e.year ? `Q${e.quarter} FY${String(e.year).slice(2)}` : null,
        epsEstimate: e.epsEstimate ?? null,
        epsActual: e.epsActual ?? null,
        revenueEstimate: e.revenueEstimate ?? null,
        revenueActual: e.revenueActual ?? null,
        provider: 'finnhub',
      });
    }
    return out;
  },
};
