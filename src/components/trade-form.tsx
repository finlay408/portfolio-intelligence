'use client';

/**
 * Trade entry — the only manual input the system requires (§1).
 *
 * Deliberately plain: a form that submits a server action, with the two things
 * that actually prevent bad data. The instrument picker shows the quote
 * convention, so entering 450 for a GBX line quoted at £4.50 is visibly wrong
 * before submission; and stamp duty defaults from the instrument's asset class
 * rather than being remembered by the owner.
 */
import { useActionState, useState } from 'react';
import { addTrade, type ActionResult } from '@/app/actions';

export interface InstrumentOption {
  id: number;
  symbol: string;
  name: string;
  quoteCurrency: string;
  quoteMultiplier: string;
  exchangeMic: string | null;
  assetClass: string;
}

export interface AccountOption {
  id: number;
  name: string;
  wrapper: string;
}

const field =
  'w-full rounded border border-line bg-surface-2 px-2 py-1.5 text-[13px] text-ink outline-none focus:border-accent';
const label = 'block text-[11px] uppercase tracking-wide text-muted mb-1';

export function TradeForm({
  instruments,
  accounts,
  today,
}: {
  instruments: InstrumentOption[];
  accounts: AccountOption[];
  today: string;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    addTrade,
    null,
  );
  const [instrumentId, setInstrumentId] = useState(String(instruments[0]?.id ?? ''));
  const [side, setSide] = useState<'buy' | 'sell'>('buy');

  const selected = instruments.find((i) => String(i.id) === instrumentId);
  const isGbx = selected?.quoteMultiplier === '0.01';
  const stampApplies =
    side === 'buy' &&
    selected?.exchangeMic === 'XLON' &&
    selected.assetClass !== 'etf' &&
    selected.assetClass !== 'investment_trust';

  return (
    <form action={formAction} className="space-y-3 px-4 py-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className={label} htmlFor="accountId">
            Account
          </label>
          <select id="accountId" name="accountId" className={field} required>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.wrapper})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={label} htmlFor="instrumentId">
            Instrument
          </label>
          <select
            id="instrumentId"
            name="instrumentId"
            className={field}
            value={instrumentId}
            onChange={(e) => setInstrumentId(e.target.value)}
            required
          >
            {instruments.map((i) => (
              <option key={i.id} value={i.id}>
                {i.symbol} — {i.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={label} htmlFor="side">
            Side
          </label>
          <select
            id="side"
            name="side"
            className={field}
            value={side}
            onChange={(e) => setSide(e.target.value as 'buy' | 'sell')}
          >
            <option value="buy">buy</option>
            <option value="sell">sell</option>
          </select>
        </div>

        <div>
          <label className={label} htmlFor="tradeDate">
            Trade date
          </label>
          <input
            id="tradeDate"
            name="tradeDate"
            type="date"
            defaultValue={today}
            className={field}
            required
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className={label} htmlFor="quantity">
            Quantity
          </label>
          <input
            id="quantity"
            name="quantity"
            inputMode="decimal"
            placeholder="100"
            className={field}
            required
          />
        </div>

        <div>
          <label className={label} htmlFor="price">
            Price per share
          </label>
          <input
            id="price"
            name="price"
            inputMode="decimal"
            placeholder={isGbx ? '4.50' : '150.00'}
            className={field}
            required
          />
          {isGbx && (
            <p className="mt-1 text-[11px] leading-snug text-warn">
              This line is quoted in pence on the exchange. Enter the price in{' '}
              <strong>pounds</strong> — 450p is 4.50.
            </p>
          )}
        </div>

        <div>
          <label className={label} htmlFor="tradeCurrency">
            Trade currency
          </label>
          <input
            id="tradeCurrency"
            name="tradeCurrency"
            defaultValue={selected?.quoteCurrency ?? 'GBP'}
            key={selected?.quoteCurrency}
            maxLength={3}
            className={`${field} uppercase`}
            required
          />
        </div>

        <div>
          <label className={label} htmlFor="fxRate">
            FX to GBP
          </label>
          <input
            id="fxRate"
            name="fxRate"
            inputMode="decimal"
            defaultValue={selected?.quoteCurrency === 'GBP' ? '1' : ''}
            key={`fx-${selected?.quoteCurrency}`}
            placeholder="0.79"
            className={field}
            required
          />
          <p className="mt-1 text-[11px] text-muted">Rate at execution, not today&apos;s.</p>
        </div>
      </div>

      <details className="rounded border border-line px-3 py-2">
        <summary className="cursor-pointer text-[12px] text-ink-2">Fees</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className={label} htmlFor="commission">
              Commission
            </label>
            <input id="commission" name="commission" defaultValue="0" className={field} />
          </div>
          <div>
            <label className={label} htmlFor="stampDuty">
              Stamp duty
            </label>
            <input
              id="stampDuty"
              name="stampDuty"
              placeholder={stampApplies ? 'auto: 0.5%' : '0'}
              className={field}
            />
            <p className="mt-1 text-[11px] text-muted">
              {stampApplies
                ? 'Left blank, 0.5% of consideration is applied.'
                : 'Not chargeable on this line.'}
            </p>
          </div>
          <div>
            <label className={label} htmlFor="fxFee">
              FX fee
            </label>
            <input id="fxFee" name="fxFee" defaultValue="0" className={field} />
          </div>
          <div>
            <label className={label} htmlFor="otherFees">
              Other fees
            </label>
            <input id="otherFees" name="otherFees" defaultValue="0" className={field} />
          </div>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted">
          All fees are in the trade currency and are converted at the rate above. Buy-side fees
          increase cost basis; sell-side fees reduce proceeds.
        </p>
      </details>

      <div>
        <label className={label} htmlFor="note">
          Note
        </label>
        <input id="note" name="note" className={field} placeholder="optional" />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-accent px-3 py-1.5 text-[13px] font-medium text-canvas disabled:opacity-50"
        >
          {pending ? 'Recording…' : 'Record trade'}
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
