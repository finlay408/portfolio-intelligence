/**
 * Yahoo Finance — the LSE workhorse and the universal fallback.
 *
 * Yahoo is free, keyless, covers both LSE and US listings, and is the only free
 * source that reliably carries `.L` history. It is also unofficial and will
 * break without notice (§6), which is why nothing outside this file knows it
 * exists.
 *
 * Two Yahoo-specific traps are handled here:
 *   - `meta.currency` comes back as 'GBp' for pence-quoted lines. That is the
 *     signal used to verify an instrument's `quoteMultiplier` on first ingest.
 *   - LSE quotes are delayed 15-20 minutes. `delaySeconds` says so, the UI
 *     renders it, and it is never presented as live.
 */
import { dec } from '../decimal';
import type { EngineInstrument, IsoDate } from '../types';
import { fetchJson } from './http';
import { normaliseBar } from './normalise';
import { bucketFor } from './rate-limiter';
import type {
  Bar,
  DetectedCorporateAction,
  PriceProvider,
  Quote,
  RawBar,
} from './types';
import { ProviderError } from './types';

const HOST = 'https://query1.finance.yahoo.com';

interface ChartResponse {
  chart: {
    result?: Array<{
      meta: {
        symbol?: string;
        currency?: string;
        longName?: string;
        shortName?: string;
        exchangeName?: string;
        fullExchangeName?: string;
        instrumentType?: string;
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
        regularMarketTime?: number;
        exchangeTimezoneName?: string;
      };
      timestamp?: number[];
      indicators: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
        adjclose?: Array<{ adjclose?: Array<number | null> }>;
      };
      events?: {
        splits?: Record<string, { date: number; numerator: number; denominator: number }>;
        dividends?: Record<string, { date: number; amount: number }>;
      };
    }>;
    error?: { code: string; description: string } | null;
  };
}

const iso = (epochSeconds: number): IsoDate =>
  new Date(epochSeconds * 1000).toISOString().slice(0, 10);

async function chart(
  symbol: string,
  params: Record<string, string>,
  capability: 'quote' | 'bars' | 'corp_actions',
): Promise<NonNullable<ChartResponse['chart']['result']>[number]> {
  await bucketFor('yahoo').take(capability === 'quote' ? 'interactive' : 'batch');
  const qs = new URLSearchParams(params).toString();
  const body = await fetchJson<ChartResponse>(
    `${HOST}/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}`,
    { provider: 'yahoo', capability },
  );
  const result = body.chart.result?.[0];
  if (!result) {
    throw new ProviderError(
      'yahoo',
      capability,
      body.chart.error?.description ?? `no data for ${symbol}`,
    );
  }
  return result;
}

/**
 * The canonical `symbol` is internal. Falling back to it when `yahooSymbol` is
 * unset produces a 404 that looks like a delisting, so an unmapped instrument
 * is reported as unmapped instead.
 */
function symbolOf(inst: EngineInstrument): string {
  if (!inst.yahooSymbol) {
    throw new ProviderError(
      'yahoo',
      'quote',
      `${inst.symbol} has no yahoo_symbol set; set it on the instrument row`,
    );
  }
  return inst.yahooSymbol;
}

export const yahooProvider: PriceProvider = {
  name: 'yahoo',
  // Yahoo covers everything the portfolio holds; it is last in the routing
  // order for US names only because Alpaca is real-time, not because Yahoo
  // lacks the data.
  supports: () => true,
  delaySeconds: 900,
  capabilities: ['quote', 'bars', 'corp_actions', 'fx'],

  async getQuote(insts: EngineInstrument[]): Promise<Quote[]> {
    const out: Quote[] = [];
    for (const inst of insts) {
      const r = await chart(symbolOf(inst), { range: '1d', interval: '1d' }, 'quote');
      const price = r.meta.regularMarketPrice;
      if (price === undefined) continue;

      // 'GBp' is Yahoo saying "this is pence". If the instrument is not
      // configured for it, the multiplier is wrong and the value would be 100x.
      assertCurrencyAgreement(inst, r.meta.currency);

      const prev = r.meta.chartPreviousClose ?? r.meta.previousClose;
      out.push({
        instrumentId: inst.id,
        price: dec(price).times(inst.quoteMultiplier),
        changePct: prev ? dec(price).div(prev).minus(1).times(100) : null,
        asOf: r.meta.regularMarketTime ? new Date(r.meta.regularMarketTime * 1000) : new Date(),
        // US names delivered by Yahoo are also delayed; only Alpaca is live.
        delaySeconds: 900,
        provider: 'yahoo',
      });
    }
    return out;
  },

  async getDailyBars(inst: EngineInstrument, from: IsoDate, to: IsoDate): Promise<Bar[]> {
    const r = await chart(
      symbolOf(inst),
      {
        period1: String(Math.floor(Date.parse(from) / 1000)),
        period2: String(Math.floor(Date.parse(to) / 1000) + 86_400),
        interval: '1d',
        events: 'div,split',
      },
      'bars',
    );
    assertCurrencyAgreement(inst, r.meta.currency);

    const ts = r.timestamp ?? [];
    const q = r.indicators.quote?.[0];
    const adj = r.indicators.adjclose?.[0]?.adjclose;
    const bars: Bar[] = [];

    for (let i = 0; i < ts.length; i++) {
      const close = q?.close?.[i];
      if (close === null || close === undefined) continue; // holiday / halted
      const raw: RawBar = {
        date: iso(ts[i]!),
        open: q?.open?.[i] ?? null,
        high: q?.high?.[i] ?? null,
        low: q?.low?.[i] ?? null,
        close,
        adjClose: adj?.[i] ?? null,
        volume: q?.volume?.[i] ?? null,
      };
      bars.push(normaliseBar(raw, inst, 'yahoo'));
    }
    return bars;
  },

  async getCorporateActions(
    inst: EngineInstrument,
    from: IsoDate,
  ): Promise<DetectedCorporateAction[]> {
    const r = await chart(
      symbolOf(inst),
      {
        period1: String(Math.floor(Date.parse(from) / 1000)),
        period2: String(Math.floor(Date.now() / 1000)),
        interval: '1d',
        events: 'div,split',
      },
      'corp_actions',
    );

    const out: DetectedCorporateAction[] = [];
    for (const s of Object.values(r.events?.splits ?? {})) {
      if (!s.denominator) continue;
      const ratio = s.numerator / s.denominator;
      out.push({
        instrumentId: inst.id,
        actionDate: iso(s.date),
        kind: ratio >= 1 ? 'split' : 'reverse_split',
        ratio,
        amount: null,
        currency: null,
        provider: 'yahoo',
      });
    }
    for (const d of Object.values(r.events?.dividends ?? {})) {
      out.push({
        instrumentId: inst.id,
        actionDate: iso(d.date),
        kind: 'dividend',
        ratio: null,
        // Dividends are quoted in the same units as the price, so a GBX line
        // reports pence per share here too.
        amount: dec(d.amount).times(inst.quoteMultiplier).toNumber(),
        currency: inst.quoteCurrency,
        provider: 'yahoo',
      });
    }
    return out.filter((a) => a.actionDate >= from);
  },
};

/**
 * Yahoo's own currency label is the cheapest available check on the
 * `quoteMultiplier`. A GBX line configured with multiplier 1 makes the
 * portfolio a hundred times too large; better to refuse the ingest.
 */
function assertCurrencyAgreement(inst: EngineInstrument, yahooCurrency?: string): void {
  if (!yahooCurrency) return;
  const isPence = yahooCurrency === 'GBp';
  const configuredForPence = inst.quoteMultiplier.equals('0.01');
  if (isPence && !configuredForPence) {
    throw new ProviderError(
      'yahoo',
      'bars',
      `${inst.symbol} is quoted in GBX but quote_multiplier is ${inst.quoteMultiplier.toFixed()}; ` +
        'set it to 0.01 before ingesting, or every value for this line will be 100x too large',
    );
  }
  if (!isPence && configuredForPence && yahooCurrency.toUpperCase() === 'GBP') {
    throw new ProviderError(
      'yahoo',
      'bars',
      `${inst.symbol} is quoted in GBP but quote_multiplier is 0.01; ` +
        'set it to 1, or every value for this line will be 100x too small',
    );
  }
}

/* ---------------- FX ----------------
 * Yahoo exposes currency pairs as `USDGBP=X`, which makes it a keyless source
 * of daily FX history. That matters more than a fallback usually would: FRED
 * needs an API key, so without this a fresh install has no FX series and a GBP
 * portfolio holding USD assets cannot be valued at all.
 */

export async function yahooFxRate(pair: string): Promise<number | null> {
  const r = await chart(`${pair}=X`, { range: '1d', interval: '1d' }, 'quote');
  return r.meta.regularMarketPrice ?? null;
}

export async function yahooFxHistory(
  pair: string,
  from: IsoDate,
  to: IsoDate,
): Promise<Array<{ date: IsoDate; rate: number }>> {
  const r = await chart(
    `${pair}=X`,
    {
      period1: String(Math.floor(Date.parse(from) / 1000)),
      period2: String(Math.floor(Date.parse(to) / 1000) + 86_400),
      interval: '1d',
    },
    'bars',
  );

  const ts = r.timestamp ?? [];
  const closes = r.indicators.quote?.[0]?.close ?? [];
  const out: Array<{ date: IsoDate; rate: number }> = [];
  for (let i = 0; i < ts.length; i++) {
    const close = closes[i];
    if (close === null || close === undefined || close <= 0) continue;
    out.push({ date: iso(ts[i]!), rate: close });
  }
  return out;
}


/* ---------------- Instrument lookup ---------------- */

export interface InstrumentLookup {
  yahooSymbol: string;
  name: string;
  /** Currency AFTER the multiplier — 'GBp' becomes GBP at 0.01. */
  quoteCurrency: string;
  quoteMultiplier: string;
  exchangeMic: string | null;
  assetClass: string;
  /** Yahoo's raw currency label, kept so a GBX line is auditable. */
  rawCurrency: string | null;
  lastPrice: number | null;
}

const EXCHANGE_MIC: Record<string, string> = {
  LSE: 'XLON',
  NMS: 'XNAS',
  NGM: 'XNAS',
  NCM: 'XNAS',
  NasdaqGS: 'XNAS',
  NYQ: 'XNYS',
  NYSE: 'XNYS',
  PCX: 'ARCX',
  ASE: 'XASE',
  BATS: 'BATS',
};

const ASSET_CLASS: Record<string, string> = {
  EQUITY: 'equity',
  ETF: 'etf',
  MUTUALFUND: 'etf',
  CURRENCY: 'cash',
  INDEX: 'equity',
};

/**
 * Resolve a ticker into everything `instruments` needs.
 *
 * The single most valuable field here is `currency`. Yahoo reports a
 * pence-quoted LSE line as `GBp` (lowercase p), and that one letter is the
 * difference between a position worth £4,500 and one worth £450,000. Reading it
 * from the provider is far safer than asking a human to remember which of their
 * UK holdings quote in pence — most people do not know, and the ones who think
 * they do are wrong about the ETFs.
 */
export async function lookupInstrument(symbol: string): Promise<InstrumentLookup> {
  const r = await chart(symbol, { range: '5d', interval: '1d' }, 'quote');
  const raw = r.meta.currency ?? null;
  const isPence = raw === 'GBp';

  return {
    yahooSymbol: r.meta.symbol ?? symbol,
    name: r.meta.longName ?? r.meta.shortName ?? symbol,
    quoteCurrency: isPence ? 'GBP' : (raw ?? 'USD').toUpperCase(),
    quoteMultiplier: isPence ? '0.01' : '1',
    exchangeMic:
      EXCHANGE_MIC[r.meta.exchangeName ?? ''] ??
      EXCHANGE_MIC[r.meta.fullExchangeName ?? ''] ??
      null,
    assetClass: ASSET_CLASS[r.meta.instrumentType ?? ''] ?? 'equity',
    rawCurrency: raw,
    lastPrice: r.meta.regularMarketPrice ?? null,
  };
}
