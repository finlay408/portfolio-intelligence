/**
 * Light job: refresh quotes (CLAUDE.md §4.2).
 *
 * GitHub Actions calls this with `Authorization: Bearer $CRON_SECRET`. Heavy
 * work never comes through here — the nightly analytics rebuild runs Python
 * directly against Postgres, because it does not fit in a serverless timeout.
 *
 *   GET /api/cron/quotes?market=us
 */
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import { dataHealth, instruments, quotesLive, trades, watchlist } from '@/db/schema';
import { withCronAuth } from '@/lib/auth';
import { toEngineInstrument } from '@/lib/engine/load';
import { getQuotes, setHealthSink } from '@/lib/providers/registry';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const GET = withCronAuth(async (request: Request) => {
  const market = new URL(request.url).searchParams.get('market')?.toLowerCase() ?? 'all';

  setHealthSink(async (event) => {
    if (event.status === 'ok') return;
    await db.insert(dataHealth).values({
      provider: event.provider,
      capability: event.capability,
      instrumentId: event.instrumentId,
      status: event.status,
      detail: event.detail,
      servedBy: event.servedBy,
    });
  });

  const held = await db
    .selectDistinct({ id: trades.instrumentId })
    .from(trades)
    .where(eq(trades.isVoid, false));
  const watched = await db.selectDistinct({ id: watchlist.instrumentId }).from(watchlist);
  const ids = [...new Set([...held, ...watched].map((r) => r.id))];
  if (ids.length === 0) return Response.json({ ok: true, quotes: 0 });

  const rows = await db.select().from(instruments).where(inArray(instruments.id, ids));
  const targets = rows
    .filter((r) => {
      if (market === 'us') return r.exchangeMic === 'XNAS' || r.exchangeMic === 'XNYS';
      if (market === 'uk') return r.exchangeMic === 'XLON';
      return true;
    })
    .map(toEngineInstrument);

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

  return Response.json({
    ok: true,
    market,
    requested: targets.length,
    quotes: quotes.length,
    // A silent shortfall is the thing to notice, so it is reported explicitly.
    missing: targets.length - quotes.length,
  });
});
