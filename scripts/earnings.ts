/**
 * Weekly earnings calendar refresh (§8).
 *
 *   npm run earnings -- --weeks=8
 */
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../src/db';
import { earningsEvents, instruments, trades, watchlist } from '../src/db/schema';
import { addDays, todayIso } from '../src/lib/dates';
import { toEngineInstrument } from '../src/lib/engine/load';
import { getEarnings } from '../src/lib/providers/registry';
import { args, runJob } from './_util';

const argv = args();

await runJob('earnings-calendar', async () => {
  const weeks = Number(argv.weeks ?? 8);
  const from = todayIso();
  const to = addDays(from, weeks * 7);

  const held = await db
    .selectDistinct({ id: trades.instrumentId })
    .from(trades)
    .where(eq(trades.isVoid, false));
  const watched = await db.selectDistinct({ id: watchlist.instrumentId }).from(watchlist);
  const ids = [...new Set([...held, ...watched].map((r) => r.id))];
  if (ids.length === 0) return { events: 0 };

  const rows = await db.select().from(instruments).where(inArray(instruments.id, ids));
  const events = await getEarnings(rows.map(toEngineInstrument), from, to);

  for (const e of events) {
    await db
      .insert(earningsEvents)
      .values({
        instrumentId: e.instrumentId,
        reportDate: e.reportDate,
        session: e.session,
        fiscalPeriod: e.fiscalPeriod,
        epsEstimate: e.epsEstimate === null ? null : String(e.epsEstimate),
        epsActual: e.epsActual === null ? null : String(e.epsActual),
        revenueEstimate: e.revenueEstimate === null ? null : String(e.revenueEstimate),
        revenueActual: e.revenueActual === null ? null : String(e.revenueActual),
        surprisePct:
          e.epsActual !== null && e.epsEstimate !== null && e.epsEstimate !== 0
            ? String(((e.epsActual - e.epsEstimate) / Math.abs(e.epsEstimate)) * 100)
            : null,
        // `confirmed` stays false until the company itself announces the date.
        // A provider's projected date moving by a week is normal and should not
        // look like a schedule change.
        confirmed: false,
      })
      .onConflictDoUpdate({
        target: [earningsEvents.instrumentId, earningsEvents.reportDate],
        set: {
          session: sql.raw('excluded.session'),
          epsEstimate: sql.raw('excluded.eps_estimate'),
          epsActual: sql.raw('excluded.eps_actual'),
          revenueEstimate: sql.raw('excluded.revenue_estimate'),
          revenueActual: sql.raw('excluded.revenue_actual'),
          surprisePct: sql.raw('excluded.surprise_pct'),
        },
      });
  }

  return { window: `${from} to ${to}`, instruments: rows.length, events: events.length };
});
