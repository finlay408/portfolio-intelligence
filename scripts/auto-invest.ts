/**
 * Fire due auto-invest rules and write the resulting trades (§8).
 *
 *   npm run auto-invest              # execute
 *   npm run auto-invest -- --dry-run # show what would fire
 */
import { eq } from 'drizzle-orm';
import { db } from '../src/db';
import { autoInvestRules, instruments, trades } from '../src/db/schema';
import { dec } from '../src/lib/decimal';
import { todayIso } from '../src/lib/dates';
import {
  dueDates,
  generateTrades,
  stampDutyFor,
  type AutoInvestRuleSpec,
} from '../src/lib/engine/auto-invest';
import { loadFx, loadPrices } from '../src/lib/engine/load';
import { args, runJob } from './_util';

const argv = args();
const dryRun = Boolean(argv['dry-run']);

await runJob('auto-invest', async () => {
  const today = todayIso();
  const ruleRows = await db.select().from(autoInvestRules).where(eq(autoInvestRules.isActive, true));
  const instrumentRows = await db.select().from(instruments);
  const instrumentById = new Map(instrumentRows.map((i) => [i.id, i]));

  let written = 0;
  const fired: string[] = [];
  const skipped: string[] = [];

  for (const row of ruleRows) {
    const rule: AutoInvestRuleSpec = {
      id: row.id,
      accountId: row.accountId,
      cadence: row.cadence as AutoInvestRuleSpec['cadence'],
      dayOfMonth: row.dayOfMonth,
      dayOfWeek: row.dayOfWeek,
      amount: dec(row.amount),
      currency: row.currency,
      allocation: row.allocation,
      fractional: row.fractional,
      activeFrom: row.activeFrom,
      activeTo: row.activeTo,
      isActive: row.isActive,
      lastExecutedOn: row.lastExecutedOn,
    };

    let due: ReturnType<typeof dueDates>;
    try {
      due = dueDates(rule, today);
    } catch (err) {
      skipped.push(`rule ${rule.id}: ${(err as Error).message}`);
      continue;
    }
    if (due.length === 0) continue;

    const legIds = rule.allocation.map((a) => a.instrument_id);
    const earliest = due[0]!.executeOn;
    const [prices, fx] = await Promise.all([
      loadPrices(legIds, earliest, today),
      loadFx(earliest, today),
    ]);

    for (const { target, executeOn } of due) {
      const generated = generateTrades(rule, executeOn, {
        priceOn: (id, date) => prices.priceOn(id, date)?.price ?? null,
        fxOn: (from, to, date) => fx.rateOn(from, to, date),
        quoteCurrencyOf: (id) => instrumentById.get(id)?.quoteCurrency ?? 'GBP',
      });

      for (const g of generated) {
        if (g.quantity.lessThanOrEqualTo(0)) {
          skipped.push(
            `rule ${rule.id} ${executeOn} instrument ${g.instrumentId}: ${g.note}` +
              ` (£${g.undeployed.toFixed(2)} undeployed)`,
          );
          continue;
        }
        const inst = instrumentById.get(g.instrumentId)!;
        const consideration = g.quantity.times(g.price);
        const stamp = stampDutyFor(inst.assetClass, inst.exchangeMic, consideration);

        const note =
          target === executeOn
            ? g.note
            : `${g.note} (target ${target}, rolled forward to the next session)`;

        if (dryRun) {
          fired.push(
            `[dry-run] rule ${rule.id}: buy ${g.quantity.toFixed(6)} of ${inst.symbol} ` +
              `@ ${g.price.toFixed(4)} ${g.currency} on ${executeOn}`,
          );
          continue;
        }

        await db.insert(trades).values({
          accountId: rule.accountId,
          instrumentId: g.instrumentId,
          tradeDate: executeOn,
          side: 'buy',
          quantity: g.quantity.toFixed(),
          price: g.price.toFixed(),
          tradeCurrency: g.currency,
          fxRate: g.fxRate.toFixed(),
          stampDuty: stamp.toFixed(),
          source: 'auto_invest',
          ruleId: rule.id,
          note,
        });
        written++;
        fired.push(`rule ${rule.id}: ${inst.symbol} x${g.quantity.toFixed(6)} on ${executeOn}`);
      }

      if (!dryRun) {
        await db
          .update(autoInvestRules)
          .set({ lastExecutedOn: executeOn })
          .where(eq(autoInvestRules.id, rule.id));
      }
    }
  }

  for (const line of fired) console.log(`[auto-invest] ${line}`);
  for (const line of skipped) console.warn(`[auto-invest] skipped ${line}`);

  return { rules: ruleRows.length, tradesWritten: written, skipped: skipped.length, dryRun };
});
