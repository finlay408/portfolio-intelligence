/**
 * Detect, validate and queue corporate actions (§6, §8).
 *
 *   npm run corp-actions
 *
 * Nothing is applied blindly. A detected split is cross-checked against the
 * price gap across its ex-date, and anything that would move a position by more
 * than 15% is written with `applied = false` for confirmation in the UI.
 */
import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { db } from '../src/db';
import { corporateActions, instruments, pricesDaily, trades } from '../src/db/schema';
import { dec } from '../src/lib/decimal';
import { addDays, todayIso } from '../src/lib/dates';
import { describeVerdict, validateAction } from '../src/lib/engine/corporate-actions';
import { toEngineInstrument } from '../src/lib/engine/load';
import { getCorporateActions } from '../src/lib/providers/registry';
import { args, runJob } from './_util';

const argv = args();

await runJob('corp-actions', async () => {
  const lookbackDays = Number(argv.lookback ?? 30);
  const from = addDays(todayIso(), -lookbackDays);

  const held = await db
    .selectDistinct({ id: trades.instrumentId })
    .from(trades)
    .where(eq(trades.isVoid, false));
  if (held.length === 0) return { detected: 0 };

  const rows = await db
    .select()
    .from(instruments)
    .where(
      inArray(
        instruments.id,
        held.map((h) => h.id),
      ),
    );

  let detected = 0;
  let autoApplied = 0;
  let queued = 0;

  for (const row of rows) {
    const inst = toEngineInstrument(row);
    let actions;
    try {
      actions = await getCorporateActions(inst, from);
    } catch (err) {
      console.error(`[corp-actions] ${inst.symbol}: ${(err as Error).message}`);
      continue;
    }

    for (const action of actions) {
      detected++;

      // Prices either side of the ex-date, for the ratio cross-check.
      const [priorRow] = await db
        .select({ close: pricesDaily.close })
        .from(pricesDaily)
        .where(
          and(
            eq(pricesDaily.instrumentId, inst.id),
            lte(pricesDaily.priceDate, addDays(action.actionDate, -1)),
          ),
        )
        .orderBy(desc(pricesDaily.priceDate))
        .limit(1);

      const [exRow] = await db
        .select({ open: pricesDaily.open, close: pricesDaily.close })
        .from(pricesDaily)
        .where(
          and(
            eq(pricesDaily.instrumentId, inst.id),
            gte(pricesDaily.priceDate, action.actionDate),
          ),
        )
        .orderBy(pricesDaily.priceDate)
        .limit(1);

      const verdict = validateAction(action, {
        priorClose: priorRow ? dec(priorRow.close) : null,
        exDateOpen: exRow ? dec(exRow.open ?? exRow.close) : null,
        positionValueGbp: null,
      });

      if (verdict.verdict === 'rejected') {
        console.warn(
          `[corp-actions] ${inst.symbol} ${action.actionDate} ${action.kind}: ` +
            describeVerdict(verdict),
        );
        continue;
      }

      const applied = verdict.verdict === 'auto_apply';
      applied ? autoApplied++ : queued++;

      await db
        .insert(corporateActions)
        .values({
          instrumentId: inst.id,
          actionDate: action.actionDate,
          kind: action.kind,
          ratio: action.ratio === null ? null : String(action.ratio),
          amount: action.amount === null ? null : String(action.amount),
          currency: action.currency,
          detail: {
            ...action.detail,
            validation: {
              verdict: verdict.verdict,
              reasons: verdict.reasons,
              implied_ratio: verdict.impliedRatio?.toFixed(4) ?? null,
            },
          },
          applied,
          source: action.provider,
        })
        // Never downgrade a human decision: an action already confirmed stays
        // applied even if a later detection would have queued it.
        .onConflictDoNothing();

      console.log(
        `[corp-actions] ${inst.symbol} ${action.actionDate} ${action.kind}: ` +
          describeVerdict(verdict),
      );
    }
  }

  if (queued > 0) {
    console.log(`\n${queued} action(s) need confirmation at /corporate-actions before they apply.`);
  }

  return { detected, autoApplied, queued };
});
