'use client';

import { useActionState } from 'react';
import { confirmAction, type ActionResult } from '@/app/actions';

/**
 * Confirm or reject a queued corporate action.
 *
 * The ratio is editable, because the reason an action reaches this queue is
 * usually that the provider's ratio and the price gap disagree — and when they
 * do, the price gap is more often right.
 */
export function ActionDecision({
  id,
  suggestedRatio,
  needsRatio,
}: {
  id: number;
  suggestedRatio: string;
  needsRatio: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    confirmAction,
    null,
  );

  return (
    <form action={formAction} className="flex items-center gap-1.5">
      <input type="hidden" name="id" value={id} />
      {needsRatio && (
        <input
          name="ratio"
          defaultValue={suggestedRatio}
          size={6}
          title="Override the ratio before applying"
          className="w-16 rounded border border-line bg-surface-2 px-1.5 py-1 text-[12px] outline-none focus:border-accent"
        />
      )}
      <button
        type="submit"
        name="decision"
        value="apply"
        disabled={pending}
        className="rounded border border-up/40 px-2 py-1 text-[11px] text-up transition-colors hover:bg-up/10 disabled:opacity-50"
      >
        Apply
      </button>
      <button
        type="submit"
        name="decision"
        value="reject"
        disabled={pending}
        title="This did not happen. The row is removed so a later detection can re-raise it."
        className="rounded border border-line px-2 py-1 text-[11px] text-muted transition-colors hover:border-down/40 hover:text-down disabled:opacity-50"
      >
        Reject
      </button>
      {state && (
        <span className={`text-[11px] ${state.ok ? 'text-up' : 'text-down'}`}>{state.message}</span>
      )}
    </form>
  );
}
