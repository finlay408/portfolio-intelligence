/**
 * Data health (CLAUDE.md §6).
 *
 * "On provider failure, fall through silently but record the degradation and
 * surface it in the UI. Stale data shown as fresh is the failure mode that
 * loses trust."
 *
 * This is that surface. It shows which provider actually served each request,
 * how old every quote is, and whether the scheduled jobs are still running.
 */
import { Badge, Card, Empty, Table, Td, Th, Tr } from '@/components/ui/primitives';
import { delayLabel, relativeTime } from '@/lib/format';
import { getDataHealth } from '@/lib/portfolio';

export const dynamic = 'force-dynamic';

const STATUS_TONE = {
  ok: 'up',
  degraded: 'warn',
  rate_limited: 'warn',
  failed: 'down',
} as const;

export default async function DataHealthPage() {
  const { events, jobs, quotes } = await getDataHealth();

  const staleQuotes = quotes.filter(
    (q) => Date.now() - q.asOf.getTime() > Math.max(q.delaySeconds, 900) * 1000 * 4,
  );

  return (
    <div className="space-y-3">
      <Card
        title="Quote freshness"
        subtitle={`${quotes.length} instruments · ${staleQuotes.length} older than expected`}
        footnote="The delay column is what each provider actually guarantees, not an assumption. Alpaca's IEX feed is real-time; Yahoo's LSE data is 15-20 minutes behind."
      >
        {quotes.length === 0 ? (
          <Empty>No quotes stored. Run the quote refresh job.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Instrument</Th>
                <Th>Provider</Th>
                <Th>Stated delay</Th>
                <Th>Last update</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {quotes.map((q) => {
                const ageSeconds = (Date.now() - q.asOf.getTime()) / 1000;
                const stale = ageSeconds > Math.max(q.delaySeconds, 900) * 4;
                return (
                  <Tr key={q.instrumentId}>
                    <Td>{q.symbol}</Td>
                    <Td>{q.provider}</Td>
                    <Td>{delayLabel(q.delaySeconds)}</Td>
                    <Td>{relativeTime(q.asOf)}</Td>
                    <Td>
                      {stale ? (
                        <Badge tone="warn">stale — the refresh job may not be running</Badge>
                      ) : (
                        <Badge tone="up">current</Badge>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Card
        title="Provider degradation"
        subtitle="last 48 hours"
        footnote="Only failures and fallthroughs are recorded — a successful primary request writes nothing. An empty table means every request was served by its primary provider."
      >
        {events.length === 0 ? (
          <Empty>No degradation recorded. Every request was served by its primary provider.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Provider</Th>
                <Th>Capability</Th>
                <Th>Status</Th>
                <Th>Served by</Th>
                <Th>Detail</Th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <Tr key={e.id}>
                  <Td>{relativeTime(e.occurredAt)}</Td>
                  <Td>{e.provider}</Td>
                  <Td>{e.capability}</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[e.status as keyof typeof STATUS_TONE] ?? 'neutral'}>
                      {e.status}
                    </Badge>
                  </Td>
                  <Td>{e.servedBy ?? '—'}</Td>
                  <Td>
                    <div className="max-w-[32rem] truncate text-[11px] text-muted" title={e.detail ?? ''}>
                      {e.detail ?? '—'}
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card
        title="Scheduled jobs"
        subtitle="most recent runs"
        footnote="The weekly integrity check recomputes every snapshot from inception and diffs it against the cache. It is what catches silent drift, and a failure there means the cached numbers can no longer be trusted."
      >
        {jobs.length === 0 ? (
          <Empty>No job runs recorded yet.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Job</Th>
                <Th>Started</Th>
                <Th>Duration</Th>
                <Th>Status</Th>
                <Th>Detail</Th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <Tr key={j.id}>
                  <Td>{j.job}</Td>
                  <Td>{relativeTime(j.startedAt)}</Td>
                  <Td>
                    {j.finishedAt
                      ? `${Math.round((j.finishedAt.getTime() - j.startedAt.getTime()) / 1000)}s`
                      : 'running'}
                  </Td>
                  <Td>
                    <Badge
                      tone={j.status === 'ok' ? 'up' : j.status === 'failed' ? 'down' : 'neutral'}
                    >
                      {j.status}
                    </Badge>
                  </Td>
                  <Td>
                    <div
                      className="max-w-[32rem] truncate text-[11px] text-muted"
                      title={JSON.stringify(j.detail)}
                    >
                      {j.detail ? JSON.stringify(j.detail) : '—'}
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
