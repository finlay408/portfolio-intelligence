/**
 * The resolver (CLAUDE.md §6).
 *
 * Routing is a table, not a set of conditionals scattered through call sites.
 * On failure the resolver falls through to the next provider silently — but it
 * records the degradation, because "stale data shown as fresh" is the failure
 * mode that loses trust, and a fallback that nobody can see is the same thing
 * with extra steps.
 */
import type { EngineInstrument, IsoDate } from '../types';
import { alpacaProvider } from './alpaca';
import { alphaVantageProvider } from './alphavantage';
import { finnhubProvider } from './finnhub';
import { exchangerateFx, fredFx, yahooFx } from './fx';
import { cache, TTL_MS } from './rate-limiter';
import type {
  Bar,
  Capability,
  DetectedCorporateAction,
  EarningsEvent,
  FxProvider,
  FxRate,
  PriceProvider,
  Quote,
} from './types';
import { yahooProvider } from './yahoo';

export interface HealthEvent {
  provider: string;
  capability: Capability;
  instrumentId: number | null;
  status: 'ok' | 'degraded' | 'failed' | 'rate_limited';
  detail: string | null;
  servedBy: string | null;
}

/** Set by the app and the jobs so degradation reaches `data_health`. */
export type HealthSink = (event: HealthEvent) => void | Promise<void>;

let healthSink: HealthSink = () => {};
export function setHealthSink(sink: HealthSink) {
  healthSink = sink;
}

const collected: HealthEvent[] = [];
async function record(event: HealthEvent) {
  collected.push(event);
  await healthSink(event);
}

/** Degradations observed in this process, for the UI's data-health banner. */
export function drainHealthEvents(): HealthEvent[] {
  return collected.splice(0, collected.length);
}

/* ---------------- Routing table (§6) ---------------- */

const US_QUOTE = [alpacaProvider, finnhubProvider, yahooProvider];
const US_BARS = [alpacaProvider, yahooProvider];
const LSE_QUOTE = [yahooProvider, finnhubProvider];
const LSE_BARS = [yahooProvider, alphaVantageProvider];

function isUs(inst: EngineInstrument): boolean {
  return inst.exchangeMic === 'XNAS' || inst.exchangeMic === 'XNYS';
}

export function quoteChainFor(inst: EngineInstrument): PriceProvider[] {
  return (isUs(inst) ? US_QUOTE : LSE_QUOTE).filter((p) => p.supports(inst));
}

export function barChainFor(inst: EngineInstrument): PriceProvider[] {
  return (isUs(inst) ? US_BARS : LSE_BARS).filter((p) => p.supports(inst));
}

/* ---------------- Resolution with recorded fallthrough ---------------- */

export interface ResolveResult<T> {
  value: T;
  servedBy: string;
  /** True when the primary provider failed and a fallback answered. */
  degraded: boolean;
}

async function tryChain<T>(
  chain: PriceProvider[],
  capability: Capability,
  instrumentId: number | null,
  run: (p: PriceProvider) => Promise<T>,
): Promise<ResolveResult<T>> {
  const failures: string[] = [];

  for (const provider of chain) {
    try {
      const value = await run(provider);
      const degraded = failures.length > 0;
      await record({
        provider: chain[0]!.name,
        capability,
        instrumentId,
        status: degraded ? 'degraded' : 'ok',
        detail: degraded ? failures.join('; ') : null,
        servedBy: provider.name,
      });
      return { value, servedBy: provider.name, degraded };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${provider.name}: ${message}`);
      await record({
        provider: provider.name,
        capability,
        instrumentId,
        status: message.includes('rate limit') ? 'rate_limited' : 'failed',
        detail: message,
        servedBy: null,
      });
    }
  }

  throw new Error(
    `every provider failed for ${capability}` +
      (instrumentId ? ` on instrument ${instrumentId}` : '') +
      `: ${failures.join('; ')}`,
  );
}

export async function getQuotes(insts: EngineInstrument[]): Promise<Quote[]> {
  const out: Quote[] = [];
  // Group by chain so Alpaca's batch snapshot endpoint is used as a batch.
  const us = insts.filter((i) => isUs(i) && alpacaProvider.supports(i));
  const rest = insts.filter((i) => !us.includes(i));

  if (us.length > 0) {
    const key = `quotes:us:${us.map((i) => i.id).join(',')}`;
    const cached = cache.get<Quote[]>(key);
    if (cached) {
      out.push(...cached);
    } else {
      const res = await tryChain(US_QUOTE, 'quote', null, (p) => p.getQuote(us));
      cache.set(key, res.value, res.servedBy === 'alpaca' ? TTL_MS.quoteRealtime : TTL_MS.quoteDelayed);
      out.push(...res.value);
    }
  }

  for (const inst of rest) {
    const key = `quote:${inst.id}`;
    const cached = cache.get<Quote[]>(key);
    if (cached) {
      out.push(...cached);
      continue;
    }
    try {
      const res = await tryChain(quoteChainFor(inst), 'quote', inst.id, (p) => p.getQuote([inst]));
      cache.set(key, res.value, TTL_MS.quoteDelayed);
      out.push(...res.value);
    } catch {
      // A single unquotable instrument must not blank the whole dashboard; the
      // failure is already in data_health and the position falls back to its
      // last daily close.
    }
  }

  return out;
}

export async function getDailyBars(
  inst: EngineInstrument,
  from: IsoDate,
  to: IsoDate,
): Promise<ResolveResult<Bar[]>> {
  return tryChain(barChainFor(inst), 'bars', inst.id, (p) => p.getDailyBars(inst, from, to));
}

export async function getCorporateActions(
  inst: EngineInstrument,
  from: IsoDate,
): Promise<DetectedCorporateAction[]> {
  const chain = [yahooProvider, finnhubProvider].filter((p) => p.getCorporateActions);
  const res = await tryChain(chain, 'corp_actions', inst.id, (p) =>
    p.getCorporateActions!(inst, from),
  );
  return res.value;
}

export async function getEarnings(
  insts: EngineInstrument[],
  from: IsoDate,
  to: IsoDate,
): Promise<EarningsEvent[]> {
  const chain = [finnhubProvider].filter((p) => p.getEarnings);
  if (chain.length === 0) return [];
  const res = await tryChain(chain, 'earnings', null, (p) => p.getEarnings!(insts, from, to));
  return res.value;
}

/* ---------------- FX ---------------- */

// Yahoo last but never absent: it is the only keyless daily FX source, and
// without any FX series a GBP portfolio holding USD assets is unvaluable.
const FX_DAILY_CHAIN: FxProvider[] = [fredFx, exchangerateFx, yahooFx];
const FX_LIVE_CHAIN: FxProvider[] = [exchangerateFx, yahooFx];

export async function getFxHistory(
  pair: string,
  from: IsoDate,
  to: IsoDate,
): Promise<ResolveResult<FxRate[]>> {
  const failures: string[] = [];
  for (const provider of FX_DAILY_CHAIN) {
    try {
      const value = await provider.getDailyRates(pair, from, to);
      if (value.length === 0) throw new Error('empty series');
      const degraded = failures.length > 0;
      await record({
        provider: FX_DAILY_CHAIN[0]!.name,
        capability: 'fx',
        instrumentId: null,
        status: degraded ? 'degraded' : 'ok',
        detail: degraded ? failures.join('; ') : null,
        servedBy: provider.name,
      });
      return { value, servedBy: provider.name, degraded };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${provider.name}: ${message}`);
      await record({
        provider: provider.name,
        capability: 'fx',
        instrumentId: null,
        status: 'failed',
        detail: message,
        servedBy: null,
      });
    }
  }
  throw new Error(`no FX source for ${pair}: ${failures.join('; ')}`);
}

export async function getLiveFx(pair: string): Promise<FxRate | null> {
  return cache.wrap(`fx:live:${pair}`, TTL_MS.quoteDelayed, async () => {
    for (const provider of FX_LIVE_CHAIN) {
      try {
        const rate = await provider.getLatestRate?.(pair);
        if (rate) return rate;
      } catch (err) {
        await record({
          provider: provider.name,
          capability: 'fx',
          instrumentId: null,
          status: 'failed',
          detail: err instanceof Error ? err.message : String(err),
          servedBy: null,
        });
      }
    }
    return null;
  });
}

/** Everything the routing table knows about, for the settings screen. */
export const ALL_PROVIDERS = [
  alpacaProvider,
  yahooProvider,
  finnhubProvider,
  alphaVantageProvider,
] as const;
