/**
 * Refresh live quotes for held and watched instruments (§8).
 *
 *   npm run refresh-quotes -- --market=us
 *   npm run refresh-quotes -- --market=uk
 *
 * The delay each provider actually carries is stored alongside the price. The
 * UI renders it as a badge, because a number that is 20 minutes old, presented
 * as live, is worse than no number at all (§5).
 */
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../src/db';
import { instruments, quotesLive, trades, watchlist } from '../src/db/schema';
import { toEngineInstrument } from '../src/lib/engine/load';
import { getQuotes } from '../src/lib/providers/registry';
import { args, runJob } from './_util';

const argv = args();
const market = typeof argv.market === 'string' ? argv.market.toLowerCase() : 'all';

await runJob(`quotes-${market}`, async () => {
  const held = await db
    .selectDistinct({ id: trades.instrumentId })
    .from(trades)
    .where(eq(trades.isVoid, false));
  const watched = await db.selectDistinct({ id: watchlist.instrumentId }).from(watchlist);
  const ids = [...new Set([...held, ...watched].map((r) => r.id))];
  if (ids.length === 0) return { quotes: 0 };

  const rows = await db.select().from(instruments).where(inArray(instruments.id, ids));
  const targets = rows
    .filter((r) => {
      if (market === 'us') return r.exchangeMic === 'XNAS' || r.exchangeMic === 'XNYS';
      if (market === 'uk') return r.exchangeMic === 'XLON';
      return true;
    })
    .map(toEngineInstrument);

  if (targets.length === 0) return { quotes: 0, market };

  const quotes = await getQuotes(targets);
  for (const q of quotes) {
    await db
      .insert(quotesLive)
      .values({
        instrumentId: q.instrumentId,
        price: q.price.toFixed(),
        changePct: q.changePct?.toFixed() ?? null,
        asOf: q.asOf,
        delaySeconds: q.delaySeconds,
        provider: q.provider,
      })
      .onConflictDoUpdate({
        target: quotesLive.instrumentId,
        set: {
          price: sql.raw('excluded.price'),
          changePct: sql.raw('excluded.change_pct'),
          asOf: sql.raw('excluded.as_of'),
          delaySeconds: sql.raw('excluded.delay_seconds'),
          provider: sql.raw('excluded.provider'),
        },
      });
  }

  const missed = targets.length - quotes.length;
  if (missed > 0) {
    console.warn(
      `[quotes] ${missed} of ${targets.length} instruments returned no quote; ` +
        'they will fall back to their last daily close. See data_health.',
    );
  }

  return { market, requested: targets.length, quotes: quotes.length };
});
