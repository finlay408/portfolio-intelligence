'use client';

import { useActionState } from 'react';
import { voidTrade, type ActionResult } from '@/app/actions';

/**
 * Voiding is the only correction mechanism, so the button says what it does:
 * the row survives, flagged, and the fix is a new row.
 */
export function VoidButton({ id }: { id: number }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    voidTrade,
    null,
  );

  return (
    <form action={formAction} className="inline">
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        disabled={pending}
        title="Mark this trade void. It stays in the ledger; record the correction as a new trade."
        className="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:border-warn/50 hover:text-warn disabled:opacity-50"
      >
        {pending ? '…' : 'void'}
      </button>
      {state && !state.ok && <span className="ml-2 text-[10px] text-down">{state.message}</span>}
    </form>
  );
}
