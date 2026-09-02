'use client';

import { useActionState } from 'react';
import { addToWatchlist, removeFromWatchlist, type ActionResult } from '@/app/actions';

const field =
  'w-full rounded border border-line bg-surface-2 px-2 py-1.5 text-[13px] text-ink outline-none focus:border-accent';
const label = 'block text-[11px] uppercase tracking-wide text-muted mb-1';

export function WatchlistForm(
  props:
    | { mode: 'add'; instruments: Array<{ id: number; symbol: string; name: string }> }
    | { mode: 'remove'; id: number },
) {
  if (props.mode === 'remove') return <RemoveButton id={props.id} />;
  return <AddForm instruments={props.instruments} />;
}

function RemoveButton({ id }: { id: number }) {
  const [, formAction, pending] = useActionState<ActionResult | null, FormData>(
    removeFromWatchlist,
    null,
  );
  return (
    <form action={formAction} className="inline">
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        disabled={pending}
        className="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted hover:border-down/40 hover:text-down disabled:opacity-50"
      >
        remove
      </button>
    </form>
  );
}

function AddForm({ instruments }: { instruments: Array<{ id: number; symbol: string; name: string }> }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    addToWatchlist,
    null,
  );

  return (
    <form action={formAction} className="space-y-3 px-4 py-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <label className={label} htmlFor="wl-instrument">
            Instrument
          </label>
          <select id="wl-instrument" name="instrumentId" className={field} required>
            {instruments.map((i) => (
              <option key={i.id} value={i.id}>
                {i.symbol} — {i.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="wl-target">
            Target entry
          </label>
          <input id="wl-target" name="targetEntry" inputMode="decimal" className={field} />
        </div>
        <div>
          <label className={label} htmlFor="wl-conviction">
            Conviction (1-5)
          </label>
          <input
            id="wl-conviction"
            name="conviction"
            type="number"
            min={1}
            max={5}
            className={field}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={label} htmlFor="wl-below">
              Alert below
            </label>
            <input id="wl-below" name="alertBelow" inputMode="decimal" className={field} />
          </div>
          <div>
            <label className={label} htmlFor="wl-above">
              Alert above
            </label>
            <input id="wl-above" name="alertAbove" inputMode="decimal" className={field} />
          </div>
        </div>
      </div>
      <div>
        <label className={label} htmlFor="wl-thesis">
          Thesis
        </label>
        <input
          id="wl-thesis"
          name="thesis"
          className={field}
          placeholder="Why this is interesting, and what would change your mind"
        />
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-accent px-3 py-1.5 text-[13px] font-medium text-canvas disabled:opacity-50"
        >
          {pending ? 'Adding…' : 'Add'}
        </button>
        {state && (
          <span className={`text-[12px] ${state.ok ? 'text-up' : 'text-down'}`}>
            {state.message}
          </span>
        )}
      </div>
    </form>
  );
}
