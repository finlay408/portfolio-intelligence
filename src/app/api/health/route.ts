/**
 * Liveness and freshness probe.
 *
 * Returns 200 only when the database answers and the ledger is readable. The
 * body reports how stale each moving part is, so a scheduled workflow can fail
 * on the response rather than on an exception.
 */
import { desc, sql } from 'drizzle-orm';
import { db } from '@/db';
import { jobRuns, portfolioDaily, quotesLive, trades } from '@/db/schema';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [[tradeCount], [latestSnapshot], [latestQuote], recentJobs] = await Promise.all([
      db.select({ n: sql<number>`count(*)::int` }).from(trades),
      db
        .select({ d: portfolioDaily.snapDate })
        .from(portfolioDaily)
        .orderBy(desc(portfolioDaily.snapDate))
        .limit(1),
      db.select({ t: quotesLive.asOf }).from(quotesLive).orderBy(desc(quotesLive.asOf)).limit(1),
      db.select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(10),
    ]);

    const failedJobs = recentJobs.filter((j) => j.status === 'failed');

    return Response.json({
      ok: true,
      trades: tradeCount?.n ?? 0,
      latestSnapshot: latestSnapshot?.d ?? null,
      latestQuoteAgeSeconds: latestQuote?.t
        ? Math.round((Date.now() - latestQuote.t.getTime()) / 1000)
        : null,
      recentFailedJobs: failedJobs.map((j) => ({ job: j.job, at: j.startedAt })),
    });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : 'database unreachable' },
      { status: 503 },
    );
  }
}
