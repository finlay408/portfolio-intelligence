'use server';

/**
 * Server actions — the only write path in the app.
 *
 * The correction policy from §5 is enforced here rather than documented and
 * hoped for: there is no update and no delete. A wrong trade is voided and a
 * replacement inserted, which preserves the audit trail and keeps historical
 * snapshots explicable.
 */
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db';
import { cashFlows, corporateActions, instruments, trades, watchlist } from '@/db/schema';
import { requireOwner } from '@/lib/auth';
import { dec } from '@/lib/decimal';
import { stampDutyFor } from '@/lib/engine/auto-invest';

export interface ActionResult {
  ok: boolean;
  message: string;
}

const decimalString = z
  .string()
  .trim()
  .refine((v) => v !== '' && Number.isFinite(Number(v)), 'must be a number');

/**
 * An untouched HTML input submits an empty string, not nothing. `.optional()`
 * alone therefore never fires — the field IS present, it is just blank — and a
 * form left to its sensible defaults fails validation on the very fields that
 * were meant to be optional. Blank is normalised to absent first.
 */
const blankToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema);

const optionalDecimal = blankToUndefined(decimalString.optional());
const decimalWithDefault = (fallback: string) =>
  blankToUndefined(decimalString.optional()).transform((v) => (v as string | undefined) ?? fallback);
const optionalText = blankToUndefined(z.string().optional());

const tradeSchema = z.object({
  accountId: z.coerce.number().int().positive(),
  instrumentId: z.coerce.number().int().positive(),
  tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD'),
  side: z.enum(['buy', 'sell']),
  quantity: decimalString,
  price: decimalString,
  tradeCurrency: z.string().length(3),
  fxRate: decimalString,
  commission: decimalWithDefault('0'),
  // Left blank deliberately: 0.5% is applied automatically on a UK share
  // purchase, and any explicit value the owner types overrides it.
  stampDuty: optionalDecimal,
  fxFee: decimalWithDefault('0'),
  otherFees: decimalWithDefault('0'),
  note: optionalText,
});

export async function addTrade(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  await requireOwner();

  const parsed = tradeSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, message: `${first?.path.join('.')}: ${first?.message}` };
  }
  const input = parsed.data;

  if (dec(input.quantity).lessThanOrEqualTo(0)) {
    return { ok: false, message: 'quantity must be positive — use the sell side to reduce' };
  }
  if (dec(input.fxRate).lessThanOrEqualTo(0)) {
    return { ok: false, message: 'fx rate must be positive' };
  }

  const [instrument] = await db
    .select()
    .from(instruments)
    .where(eq(instruments.id, input.instrumentId));
  if (!instrument) return { ok: false, message: 'unknown instrument' };

  // Stamp duty is 0.5% on UK share purchases and zero on ETFs and investment
  // trusts. Defaulted rather than demanded, but always overridable.
  const consideration = dec(input.quantity).times(dec(input.price));
  const stampDuty =
    input.stampDuty ??
    (input.side === 'buy'
      ? stampDutyFor(instrument.assetClass, instrument.exchangeMic, consideration).toFixed(2)
      : '0');

  await db.insert(trades).values({
    accountId: input.accountId,
    instrumentId: input.instrumentId,
    tradeDate: input.tradeDate,
    side: input.side,
    quantity: input.quantity,
    price: input.price,
    tradeCurrency: input.tradeCurrency.toUpperCase(),
    fxRate: input.fxRate,
    commission: input.commission,
    stampDuty,
    fxFee: input.fxFee,
    otherFees: input.otherFees,
    source: 'manual',
    note: input.note ?? null,
  });

  revalidatePath('/');
  revalidatePath('/trades');
  revalidatePath('/positions');
  return {
    ok: true,
    message:
      `Recorded ${input.side} ${input.quantity} ${instrument.symbol}. ` +
      'Run `npm run recompute` to refresh the cached time series.',
  };
}

/**
 * Void a trade. Never delete: the row stays, flagged, and a correction is
 * inserted separately. Every historical figure that referenced it remains
 * explicable.
 */
export async function voidTrade(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  await requireOwner();
  const id = Number(form.get('id'));
  if (!Number.isInteger(id)) return { ok: false, message: 'bad trade id' };

  await db.update(trades).set({ isVoid: true }).where(eq(trades.id, id));
  revalidatePath('/trades');
  revalidatePath('/positions');
  revalidatePath('/');
  return { ok: true, message: `Trade ${id} voided. Insert the corrected row separately.` };
}

const cashFlowSchema = z.object({
  accountId: z.coerce.number().int().positive(),
  flowDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  kind: z.enum(['deposit', 'withdrawal', 'dividend', 'interest', 'fee', 'tax']),
  amount: decimalString,
  flowCurrency: z.string().length(3),
  fxRate: decimalString,
  instrumentId: optionalText,
  withholding: decimalWithDefault('0'),
  note: optionalText,
});

export async function addCashFlow(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  await requireOwner();
  const parsed = cashFlowSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, message: `${first?.path.join('.')}: ${first?.message}` };
  }
  const input = parsed.data;

  // The sign convention is enforced here so a withdrawal can never be recorded
  // as a positive number and quietly inflate the money-weighted return.
  const magnitude = dec(input.amount).abs();
  const signed =
    input.kind === 'withdrawal' || input.kind === 'fee' || input.kind === 'tax'
      ? magnitude.negated()
      : magnitude;

  await db.insert(cashFlows).values({
    accountId: input.accountId,
    flowDate: input.flowDate,
    kind: input.kind,
    amount: signed.toFixed(),
    flowCurrency: input.flowCurrency.toUpperCase(),
    fxRate: input.fxRate,
    instrumentId: input.instrumentId ? Number(input.instrumentId) : null,
    withholding: input.withholding,
    note: input.note ?? null,
  });

  revalidatePath('/trades');
  revalidatePath('/');
  return { ok: true, message: `Recorded ${input.kind} of ${signed.toFixed(2)}.` };
}

/**
 * Confirm a corporate action detected by the nightly job (§6).
 *
 * Nothing that would move a position by more than 15%, and no split whose
 * reported ratio disagrees with the price gap, applies without passing through
 * here.
 */
export async function confirmAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  await requireOwner();
  const id = Number(form.get('id'));
  const decision = String(form.get('decision'));
  if (!Number.isInteger(id)) return { ok: false, message: 'bad action id' };

  if (decision === 'reject') {
    // Rejecting means "this did not happen": the row is removed so a later
    // detection can re-raise it rather than finding a stale unapplied record.
    await db.delete(corporateActions).where(eq(corporateActions.id, id));
    revalidatePath('/corporate-actions');
    return { ok: true, message: `Action ${id} rejected and removed.` };
  }

  const ratioOverride = form.get('ratio');
  const update: Record<string, unknown> = { applied: true };
  if (typeof ratioOverride === 'string' && ratioOverride.trim() !== '') {
    update.ratio = ratioOverride.trim();
  }

  await db.update(corporateActions).set(update).where(eq(corporateActions.id, id));
  revalidatePath('/corporate-actions');
  revalidatePath('/positions');
  revalidatePath('/');
  return {
    ok: true,
    message:
      `Action ${id} applied. Every historical figure that depends on it corrects itself on the ` +
      'next `npm run recompute`.',
  };
}

const watchlistSchema = z.object({
  instrumentId: z.coerce.number().int().positive(),
  thesis: optionalText,
  targetEntry: optionalDecimal,
  conviction: blankToUndefined(z.coerce.number().int().min(1).max(5).optional()),
  alertAbove: optionalDecimal,
  alertBelow: optionalDecimal,
});

export async function addToWatchlist(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  await requireOwner();
  const parsed = watchlistSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'invalid' };
  const input = parsed.data;

  await db
    .insert(watchlist)
    .values({
      instrumentId: input.instrumentId,
      thesis: input.thesis ?? null,
      targetEntry: input.targetEntry ?? null,
      conviction: input.conviction ?? null,
      alertAbove: input.alertAbove ?? null,
      alertBelow: input.alertBelow ?? null,
    })
    .onConflictDoNothing();

  revalidatePath('/watchlist');
  return { ok: true, message: 'Added to the watchlist.' };
}

export async function removeFromWatchlist(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  await requireOwner();
  const id = Number(form.get('id'));
  await db.delete(watchlist).where(eq(watchlist.id, id));
  revalidatePath('/watchlist');
  return { ok: true, message: 'Removed.' };
}
