/**
 * Alpha Vantage — LSE daily-bar fallback only.
 *
 * 25 requests a DAY. The token bucket marks this provider `batchOnly`, so an
 * interactive request cannot reach it: the entire budget belongs to the nightly
 * backfill. A user refreshing a page must never be able to exhaust tomorrow's
 * data (§6).
 */
import { dec } from '../decimal';
import type { EngineInstrument, IsoDate } from '../types';
import { fetchJson } from './http';
import { normaliseBar } from './normalise';
import { bucketFor } from './rate-limiter';
import type { Bar, PriceProvider, Quote } from './types';
import { ProviderError } from './types';

const HOST = 'https://www.alphavantage.co/query';

interface DailyResponse {
  'Time Series (Daily)'?: Record<
    string,
    {
      '1. open': string;
      '2. high': string;
      '3. low': string;
      '4. close': string;
      '5. adjusted close'?: string;
      '6. volume'?: string;
      '5. volume'?: string;
    }
  >;
  Note?: string;
  Information?: string;
  'Error Message'?: string;
}

export const alphaVantageProvider: PriceProvider = {
  name: 'alphavantage',
  supports: (inst) => inst.exchangeMic === 'XLON',
  delaySeconds: 86_400,
  capabilities: ['bars'],

  async getQuote(): Promise<Quote[]> {
    throw new ProviderError(
      'alphavantage',
      'quote',
      'reserved for the nightly bar backfill; quotes come from Yahoo or Finnhub',
    );
  },

  async getDailyBars(inst: EngineInstrument, from: IsoDate, to: IsoDate): Promise<Bar[]> {
    const key = process.env.ALPHAVANTAGE_API_KEY;
    if (!key) throw new ProviderError('alphavantage', 'bars', 'ALPHAVANTAGE_API_KEY not set');
    // Throws for an interactive caller — that is the point.
    await bucketFor('alphavantage').take('batch');

    const symbol = inst.yahooSymbol ?? inst.symbol;
    const qs = new URLSearchParams({
      function: 'TIME_SERIES_DAILY',
      symbol: symbol.replace(/\.L$/, '.LON'),
      outputsize: 'full',
      apikey: key,
    });

    const body = await fetchJson<DailyResponse>(`${HOST}?${qs}`, {
      provider: 'alphavantage',
      capability: 'bars',
    });

    // Alpha Vantage answers 200 with a prose "Note" when the budget is spent.
    const complaint = body.Note ?? body.Information ?? body['Error Message'];
    if (complaint) throw new ProviderError('alphavantage', 'bars', complaint);

    const series = body['Time Series (Daily)'] ?? {};
    return Object.entries(series)
      .filter(([date]) => date >= from && date <= to)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, row]) =>
        normaliseBar(
          {
            date,
            open: Number(row['1. open']),
            high: Number(row['2. high']),
            low: Number(row['3. low']),
            close: Number(row['4. close']),
            adjClose: row['5. adjusted close'] ? Number(row['5. adjusted close']) : null,
            volume: Number(row['6. volume'] ?? row['5. volume'] ?? 0) || null,
          },
          inst,
          'alphavantage',
        ),
      )
      .map((bar) => ({ ...bar, close: dec(bar.close) }));
  },
};
