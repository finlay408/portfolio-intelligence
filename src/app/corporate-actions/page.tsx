/**
 * The corporate action confirmation queue (CLAUDE.md §6).
 *
 * A bad split ratio from a scraped source silently destroys cost basis across
 * all history, so anything that would move a position by more than 15%, and
 * anything whose reported ratio disagrees with the price gap across its
 * ex-date, waits here for a human.
 */
import { desc, eq } from 'drizzle-orm';
import Link from 'next/link';
import { db } from '@/db';
import { corporateActions, instruments } from '@/db/schema';
import { Badge, Card, Empty, Note, Table, Td, Th, Tr } from '@/components/ui/primitives';
import { ActionDecision } from '@/components/action-decision';
import { dec } from '@/lib/decimal';
import { shortDate } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface Validation {
  verdict?: string;
  reasons?: string[];
  implied_ratio?: string | null;
}

export default async function CorporateActionsPage() {
  const rows = await db
    .select({ action: corporateActions, symbol: instruments.symbol, name: instruments.name })
    .from(corporateActions)
    .innerJoin(instruments, eq(instruments.id, corporateActions.instrumentId))
    .orderBy(desc(corporateActions.actionDate))
    .limit(200);

  const pending = rows.filter((r) => !r.action.applied);
  const applied = rows.filter((r) => r.action.applied);

  return (
    <div className="space-y-3">
      <Note>
        Actions are never applied blindly. A reported split ratio is cross-checked against the
        price gap between the prior close and the ex-date open — a genuine 4:1 split shows a ~75%
        price drop. Where the two disagree, or where the action restructures the holding, it waits
        here.
      </Note>

      <Card
        title="Awaiting confirmation"
        subtitle={`${pending.length} action(s)`}
        footnote="Applying an action changes cost basis across all history. Every dependent figure corrects itself on the next `npm run recompute`."
      >
        {pending.length === 0 ? (
          <Empty>Nothing waiting. The nightly detection job queues anything it cannot verify.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Instrument</Th>
                <Th>Ex-date</Th>
                <Th>Kind</Th>
                <Th align="right">Reported</Th>
                <Th align="right">Implied by price</Th>
                <Th>Why it is here</Th>
                <Th>Decision</Th>
              </tr>
            </thead>
            <tbody>
              {pending.map(({ action, symbol, name }) => {
                const validation = ((action.detail ?? {}) as { validation?: Validation })
                  .validation;
                return (
                  <Tr key={action.id}>
                    <Td>
                      <Link
                        href={`/positions/${action.instrumentId}`}
                        className="font-medium hover:text-accent"
                      >
                        {symbol}
                      </Link>
                      <div className="max-w-40 truncate text-[11px] text-muted">{name}</div>
                    </Td>
                    <Td>{shortDate(action.actionDate)}</Td>
                    <Td>{action.kind.replace('_', ' ')}</Td>
                    <Td align="right" numeric>
                      {action.ratio ? `${dec(action.ratio).toFixed(4)}:1` : '—'}
                      {action.amount && (
                        <div className="text-[10px] text-muted">
                          {dec(action.amount).toFixed(4)} {action.currency}
                        </div>
                      )}
                    </Td>
                    <Td align="right" numeric>
                      {validation?.implied_ratio ? `${validation.implied_ratio}:1` : '—'}
                    </Td>
                    <Td>
                      <div className="max-w-80 text-[11px] leading-relaxed text-ink-2">
                        {validation?.reasons?.join('; ') ?? 'queued for confirmation'}
                      </div>
                    </Td>
                    <Td>
                      <ActionDecision
                        id={action.id}
                        suggestedRatio={action.ratio ?? validation?.implied_ratio ?? ''}
                        needsRatio={action.kind === 'split' || action.kind === 'reverse_split'}
                      />
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="Applied" subtitle={`${applied.length} action(s) in effect`}>
        {applied.length === 0 ? (
          <Empty>None applied yet.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Instrument</Th>
                <Th>Ex-date</Th>
                <Th>Kind</Th>
                <Th align="right">Ratio</Th>
                <Th align="right">Amount</Th>
                <Th>Source</Th>
              </tr>
            </thead>
            <tbody>
              {applied.map(({ action, symbol }) => (
                <Tr key={action.id}>
                  <Td>
                    <Link
                      href={`/positions/${action.instrumentId}`}
                      className="font-medium hover:text-accent"
                    >
                      {symbol}
                    </Link>
                  </Td>
                  <Td>{shortDate(action.actionDate)}</Td>
                  <Td>{action.kind.replace('_', ' ')}</Td>
                  <Td align="right" numeric>
                    {action.ratio ? dec(action.ratio).toFixed(4) : '—'}
                  </Td>
                  <Td align="right" numeric>
                    {action.amount ? dec(action.amount).toFixed(4) : '—'}
                  </Td>
                  <Td>
                    <Badge>{action.source ?? 'manual'}</Badge>
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
