'use client';

/**
 * Broker export upload — preview, then commit.
 *
 * Two steps on purpose. The ledger is append-only and the figures on every
 * page derive from it, so a wrong upload is not "undo"; it is a set of voids.
 * The preview shows what would be written, what is already recorded, and any
 * row the importer could not reconcile with the broker's own GBP total, and
 * only then is there a button that writes.
 */
import { useActionState, useState } from 'react';
import { commitExport, uploadExport, type ImportActionState } from '@/app/actions';
import type { ImportPreview, ImportResult } from '@/lib/import/apply';
import type { AccountOption } from './trade-form';

const field =
  'w-full rounded border border-line bg-surface-2 px-2 py-1.5 text-[13px] text-ink outline-none focus:border-accent';
const label = 'block text-[11px] uppercase tracking-wide text-muted mb-1';
const button =
  'rounded bg-accent px-3 py-1.5 text-[13px] font-medium text-canvas disabled:opacity-50';

function Count({ label, value, tone }: { label: string; value: number; tone?: 'accent' | 'muted' }) {
  return (
    <div className="min-w-0">
      <div className={`text-[18px] font-semibold tabular-nums ${tone === 'muted' ? 'text-muted' : 'text-ink'}`}>
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
    </div>
  );
}

function Problems({ title, items, tone }: { title: string; items: string[]; tone: 'warn' | 'down' }) {
  if (items.length === 0) return null;
  const colour = tone === 'warn' ? 'text-warn' : 'text-down';
  return (
    <details className="rounded border border-line px-3 py-2" open={items.length <= 3}>
      <summary className={`cursor-pointer text-[12px] ${colour}`}>
        {items.length} {title}
      </summary>
      <ul className="mt-2 space-y-0.5 text-[11px] text-ink-2">
        {items.slice(0, 40).map((p, i) => (
          <li key={i} className="font-mono">
            {p}
          </li>
        ))}
        {items.length > 40 && <li className="text-muted">…and {items.length - 40} more</li>}
      </ul>
    </details>
  );
}

function PreviewCard({ p }: { p: ImportPreview }) {
  const nothingNew = p.trades.new + p.flows.new === 0;
  return (
    <div className="space-y-3 rounded border border-line p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[12px] font-medium text-ink">{p.filename}</div>
          <div className="text-[11px] text-muted">
            {p.rows} rows
            {p.from && p.to ? ` · ${p.from} to ${p.to}` : ''}
            {p.alreadyApplied ? ' · already committed' : ''}
          </div>
        </div>
        {p.checked > 0 && (
          <div className={`text-[11px] ${p.mismatches.length ? 'text-warn' : 'text-muted'}`}>
            {p.checked} trades checked against the broker&apos;s GBP totals · {p.mismatches.length} disagree
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
        <Count label="new trades" value={p.trades.new} />
        <Count label="new cash flows" value={p.flows.new} />
        <Count label="new instruments" value={p.newInstruments.length} />
        <Count label="trades recorded" value={p.trades.duplicate} tone="muted" />
        <Count label="flows recorded" value={p.flows.duplicate} tone="muted" />
        <Count label="not portfolio" value={p.skipped} tone="muted" />
      </div>

      {p.newInstruments.length > 0 && (
        <div className="rounded border border-line px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-muted">
            Instruments that will be created
          </div>
          <ul className="mt-1.5 space-y-0.5 text-[12px]">
            {p.newInstruments.map((n) => (
              <li key={`${n.ticker}|${n.isin}`} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{n.ticker}</span>
                <span className="truncate text-ink-2">{n.name}</span>
                <span className="text-[11px] text-muted">
                  {n.currency} · {n.isin}
                </span>
                {n.status === 'ok' && (
                  <span className="text-[11px] text-muted">→ {n.yahooSymbol}</span>
                )}
                {n.status === 'currency-mismatch' && (
                  <span className="text-[11px] text-warn">
                    → {n.yahooSymbol} (Yahoo quotes it in another currency — check it)
                  </span>
                )}
                {n.status === 'unresolved' && (
                  <span className="text-[11px] text-down">
                    no price feed found — created without one, set yahoo_symbol later
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Problems title="trades whose GBP total disagrees with the broker's by over 2%" items={p.mismatches} tone="warn" />
      <Problems title="rows that could not be read" items={p.problems} tone="down" />

      {nothingNew && (
        <p className="text-[12px] text-muted">Nothing new here — every row is already in the ledger.</p>
      )}
    </div>
  );
}

function ResultCard({ r }: { r: ImportResult }) {
  return (
    <div className="space-y-2 rounded border border-line p-3">
      <div className="truncate text-[12px] font-medium text-ink">{r.filename}</div>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
        <Count label="trades written" value={r.written.trades} />
        <Count label="flows written" value={r.written.flows} />
        <Count label="instruments" value={r.written.instruments} />
        <Count label="bars fetched" value={r.backfill.bars} tone="muted" />
        <Count label="days rebuilt" value={r.recompute.rowsWritten} tone="muted" />
      </div>
      {!r.recompute.ok && (
        <p className="text-[12px] text-warn">
          Cached series not rebuilt: {r.recompute.error}. The nightly job rebuilds it; positions are
          already correct because they derive from the ledger on read.
        </p>
      )}
      <Problems title="instruments without price history" items={r.backfill.failures} tone="warn" />
    </div>
  );
}

export function ImportForm({ accounts }: { accounts: AccountOption[] }) {
  const [upload, uploadAction, uploading] = useActionState<ImportActionState | null, FormData>(
    uploadExport,
    null,
  );
  const [commit, commitAction, committing] = useActionState<ImportActionState | null, FormData>(
    commitExport,
    null,
  );
  const [fileNames, setFileNames] = useState<string[]>([]);

  const previews = upload?.previews ?? [];
  const committable = previews.filter((p) => !p.alreadyApplied && p.trades.new + p.flows.new > 0);
  const totalNew = committable.reduce((n, p) => n + p.trades.new + p.flows.new, 0);
  // Once committed, the previews are stale; show the result instead.
  const committed = commit?.results && commit.results.length > 0;

  return (
    <div className="space-y-3 px-4 py-3">
      <form action={uploadAction} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-[1fr_2fr_auto]">
          <div>
            <label className={label} htmlFor="import-account">
              Account
            </label>
            <select id="import-account" name="accountId" className={field} required>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.wrapper})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="import-files">
              Trading 212 export (.csv)
            </label>
            <input
              id="import-files"
              name="files"
              type="file"
              accept=".csv,text/csv"
              multiple
              required
              className={`${field} file:mr-3 file:rounded file:border-0 file:bg-surface file:px-2 file:py-0.5 file:text-[12px] file:text-ink`}
              onChange={(e) => setFileNames([...(e.target.files ?? [])].map((f) => f.name))}
            />
            {fileNames.length > 1 && (
              <p className="mt-1 text-[11px] text-muted">{fileNames.length} files, oldest first.</p>
            )}
          </div>
          <div className="flex items-end">
            <button type="submit" disabled={uploading} className={button}>
              {uploading ? 'Reading…' : 'Preview'}
            </button>
          </div>
        </div>
        {upload && !committed && (
          <p className={`text-[12px] ${upload.ok ? 'text-ink-2' : 'text-down'}`}>{upload.message}</p>
        )}
      </form>

      {!committed && previews.length > 0 && (
        <div className="space-y-3">
          {previews.map((p) => (
            <PreviewCard key={p.fileId} p={p} />
          ))}
          {committable.length > 0 && (
            <form action={commitAction} className="flex flex-wrap items-center gap-3">
              <input
                type="hidden"
                name="fileIds"
                value={committable.map((p) => p.fileId).join(',')}
              />
              <button type="submit" disabled={committing} className={button}>
                {committing
                  ? 'Writing, pricing and rebuilding…'
                  : `Commit ${totalNew} rows to the ledger`}
              </button>
              <span className="text-[11px] text-muted">
                Writes the new rows, fetches price history for new instruments, and rebuilds the
                cached series from the earliest new date. Usually under a minute.
              </span>
              {commit && !commit.ok && <span className="text-[12px] text-down">{commit.message}</span>}
            </form>
          )}
        </div>
      )}

      {committed && (
        <div className="space-y-3">
          <p className={`text-[12px] ${commit.ok ? 'text-up' : 'text-warn'}`}>{commit.message}</p>
          {commit.results!.map((r) => (
            <ResultCard key={r.fileId} r={r} />
          ))}
          <p className="text-[11px] text-muted">
            New instruments carry sector and listing country but no revenue geography — nobody
            publishes that for free. The nightly analytics job picks the new rows up at 01:00 UTC.
          </p>
        </div>
      )}
    </div>
  );
}
