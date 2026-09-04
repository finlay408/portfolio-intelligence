/**
 * The in-app export upload: store → preview → commit.
 *
 * Nothing is written to the ledger until the owner has seen what would be
 * written. The upload itself is kept verbatim in `import_files`, which is what
 * makes the two steps possible on a serverless host (the second request has
 * only the database to find the file in) and gives every imported row a
 * statement it can be traced back to.
 *
 * Idempotency is the whole point. Trading 212 exports are date ranges the
 * owner picks by hand, so overlaps are the normal case, not an edge case. A
 * row is "already recorded" if its broker ID is stored, or — for rows recorded
 * before broker IDs were kept — if a row with the same instrument, date, side,
 * quantity and price exists and has not already been claimed by another row in
 * this upload.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  cashFlows,
  dataHealth,
  importFiles,
  instruments,
  jobRuns,
  pricesDaily,
  trades,
  type ImportFile,
} from '@/db/schema';
import { dec } from '../decimal';
import { addDays, todayIso } from '../dates';
import { toEngineInstrument } from '../engine/load';
import { recomputeSnapshots } from '../engine/recompute';
import { getDailyBars, setHealthSink } from '../providers/registry';
import { classifyNew, resolveSecurity, type ResolvedSecurity } from './resolve';
import {
  flowNaturalKey,
  mergeRows,
  parseT212Export,
  quoteCurrencyOf,
  securitiesIn,
  toLedgerEntries,
  tradeNaturalKey,
  planInserts,
  type LedgerFlow,
  type LedgerTrade,
  type Security,
} from './t212';

/* ---------------- types the UI renders ---------------- */

export interface NewInstrument {
  ticker: string;
  isin: string;
  name: string;
  currency: string;
  yahooSymbol: string | null;
  status: ResolvedSecurity['status'];
  /** Set once created. */
  instrumentId?: number;
}

export interface ImportPreview {
  fileId: number;
  filename: string;
  rows: number;
  /** Earliest and latest row dates in the file. */
  from: string | null;
  to: string | null;
  trades: { new: number; duplicate: number };
  flows: { new: number; duplicate: number };
  /** Rows that are not portfolio events (card spending, conversions). */
  skipped: number;
  /** Trades cross-checked against the broker's GBP total, and the drifts. */
  checked: number;
  mismatches: string[];
  problems: string[];
  newInstruments: NewInstrument[];
  /** The earliest date a new row would land on — where the recompute starts. */
  earliestNew: string | null;
  alreadyApplied: string | null;
}

export interface ImportResult extends ImportPreview {
  written: { trades: number; flows: number; instruments: number };
  /** Bars fetched for new instruments; failures are named. */
  backfill: { instruments: number; bars: number; failures: string[] };
  recompute: { ok: boolean; rowsWritten: number; error?: string };
}

/* ---------------- store ---------------- */

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Keep the file. The same content uploaded twice is the same row, so an
 * accidental double-upload cannot produce two previews of one file.
 */
export async function storeUpload(input: {
  accountId: number;
  filename: string;
  text: string;
}): Promise<{ fileId: number; existing: boolean }> {
  // Parse before storing: a file that is not an export is rejected here with
  // its header, not later with a database error.
  const rows = parseT212Export(input.text);
  const hash = sha256(input.text);

  const [existing] = await db
    .select({ id: importFiles.id })
    .from(importFiles)
    .where(and(eq(importFiles.accountId, input.accountId), eq(importFiles.sha256, hash)));
  if (existing) return { fileId: existing.id, existing: true };

  const [created] = await db
    .insert(importFiles)
    .values({
      accountId: input.accountId,
      filename: input.filename,
      sha256: hash,
      content: input.text,
      rowCount: rows.length,
    })
    .returning({ id: importFiles.id });
  return { fileId: created!.id, existing: false };
}

export async function listUploads(limit = 20): Promise<ImportFile[]> {
  return db
    .select()
    .from(importFiles)
    .orderBy(desc(importFiles.uploadedAt))
    .limit(limit);
}

/* ---------------- analysis shared by preview and commit ---------------- */

type InstrumentRow = typeof instruments.$inferSelect;

interface Analysis {
  file: ImportFile;
  preview: ImportPreview;
  tradesToInsert: LedgerTrade[];
  flowsToInsert: LedgerFlow[];
  /** Security key → existing instrument. */
  known: Map<string, InstrumentRow>;
  /** Security key → resolution for a security with no instrument row yet. */
  unknown: Map<string, { security: Security; resolved: ResolvedSecurity }>;
}

/**
 * Match a security to an instrument row by ISIN and quote currency. An ISIN
 * is shared by every share class of a fund, so the currency is part of the
 * key; the ticker breaks a remaining tie.
 */
function matchInstrument(rows: InstrumentRow[], s: Security): InstrumentRow | undefined {
  const currency = quoteCurrencyOf(s.currency);
  const byIsin = rows.filter(
    (r) => r.isin && r.isin.toUpperCase() === s.isin.toUpperCase() && r.quoteCurrency === currency,
  );
  if (byIsin.length === 0) return undefined;
  if (byIsin.length === 1) return byIsin[0];
  const tickerFirst = byIsin.find((r) => r.symbol.toUpperCase().startsWith(s.ticker.toUpperCase()));
  return tickerFirst ?? byIsin[0];
}

async function loadFile(fileId: number): Promise<ImportFile> {
  const [file] = await db.select().from(importFiles).where(eq(importFiles.id, fileId));
  if (!file) throw new Error(`upload ${fileId} not found`);
  return file;
}

async function existingLedger(accountId: number) {
  const [tradeRows, flowRows] = await Promise.all([
    db
      .select({
        instrumentId: trades.instrumentId,
        date: trades.tradeDate,
        side: trades.side,
        quantity: trades.quantity,
        price: trades.price,
        externalId: trades.externalId,
      })
      .from(trades)
      .where(and(eq(trades.accountId, accountId), eq(trades.isVoid, false))),
    db
      .select({
        instrumentId: cashFlows.instrumentId,
        date: cashFlows.flowDate,
        kind: cashFlows.kind,
        amount: cashFlows.amount,
        currency: cashFlows.flowCurrency,
        externalId: cashFlows.externalId,
      })
      .from(cashFlows)
      .where(eq(cashFlows.accountId, accountId)),
  ]);

  const tradeIds = new Set<string>();
  const tradeKeys = new Map<string, number>();
  for (const t of tradeRows) {
    if (t.externalId) tradeIds.add(t.externalId);
    else {
      const k = tradeNaturalKey({ ...t, quantity: dec(t.quantity), price: dec(t.price) });
      tradeKeys.set(k, (tradeKeys.get(k) ?? 0) + 1);
    }
  }
  const flowIds = new Set<string>();
  const flowKeys = new Map<string, number>();
  for (const f of flowRows) {
    if (f.externalId) flowIds.add(f.externalId);
    else {
      const k = flowNaturalKey({ ...f, amount: dec(f.amount) });
      flowKeys.set(k, (flowKeys.get(k) ?? 0) + 1);
    }
  }
  return { tradeIds, tradeKeys, flowIds, flowKeys };
}

/**
 * Cached resolutions from a previous preview of the same file, so commit does
 * not go back to Yahoo for securities it already looked up.
 */
function cachedResolutions(file: ImportFile): Map<string, ResolvedSecurity> {
  const out = new Map<string, ResolvedSecurity>();
  const cached = (file.summary?.resolved ?? []) as ResolvedSecurity[];
  for (const r of cached) if (r && r.ticker && r.isin) out.set(`${r.ticker}|${r.isin}`, r);
  return out;
}

async function analyse(fileId: number): Promise<Analysis> {
  const file = await loadFile(fileId);
  const rows = mergeRows([parseT212Export(file.content)]);
  const securities = securitiesIn(rows);

  const instrumentRows = await db.select().from(instruments);
  const known = new Map<string, InstrumentRow>();
  const unknown = new Map<string, { security: Security; resolved: ResolvedSecurity }>();
  const cache = cachedResolutions(file);

  for (const [key, s] of securities) {
    const match = matchInstrument(instrumentRows, s);
    if (match) {
      known.set(key, match);
      continue;
    }
    const resolved = cache.get(key) ?? (await resolveSecurity(s));
    unknown.set(key, { security: s, resolved });
  }

  const entries = toLedgerEntries(rows, (key) => {
    const k = known.get(key);
    if (k) return k.quoteCurrency;
    return unknown.get(key)?.resolved.quoteCurrency;
  });

  // Instruments not yet created have no id; natural keys for their rows use a
  // placeholder that cannot collide with a real id, so they always count as
  // new — which they are.
  const idFor = (key: string) => known.get(key)?.id ?? -1;
  const ledger = await existingLedger(file.accountId);

  const tradePlan = planInserts(
    entries.trades,
    (t) => t.externalId,
    (t) => tradeNaturalKey({ ...t, instrumentId: idFor(t.securityKey) }),
    ledger.tradeIds,
    ledger.tradeKeys,
  );
  const flowPlan = planInserts(
    entries.flows,
    (f) => f.externalId,
    (f) =>
      flowNaturalKey({
        ...f,
        instrumentId: f.securityKey ? idFor(f.securityKey) : null,
      }),
    ledger.flowIds,
    ledger.flowKeys,
  );

  const dates = rows.map((r) => r.time.slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  const newDates = [...tradePlan.insert.map((t) => t.date), ...flowPlan.insert.map((f) => f.date)];

  // Only securities that will actually be written need an instrument row.
  const needed = new Set([
    ...tradePlan.insert.map((t) => t.securityKey),
    ...flowPlan.insert.map((f) => f.securityKey).filter((k): k is string => k !== null),
  ]);
  for (const key of [...unknown.keys()]) if (!needed.has(key)) unknown.delete(key);

  const preview: ImportPreview = {
    fileId: file.id,
    filename: file.filename,
    rows: rows.length,
    from: dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null,
    to: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null,
    trades: {
      new: tradePlan.insert.length,
      duplicate: tradePlan.duplicateById + tradePlan.duplicateByKey,
    },
    flows: {
      new: flowPlan.insert.length,
      duplicate: flowPlan.duplicateById + flowPlan.duplicateByKey,
    },
    skipped: entries.skipped,
    checked: entries.checked,
    mismatches: entries.mismatches,
    problems: entries.problems,
    newInstruments: [...unknown.values()].map(({ security, resolved }) => ({
      ticker: security.ticker,
      isin: security.isin,
      name: security.name,
      currency: security.currency,
      yahooSymbol: resolved.yahooSymbol || null,
      status: resolved.status,
    })),
    earliestNew: newDates.length ? newDates.reduce((a, b) => (a < b ? a : b)) : null,
    alreadyApplied: file.appliedAt?.toISOString() ?? null,
  };

  return {
    file,
    preview,
    tradesToInsert: tradePlan.insert,
    flowsToInsert: flowPlan.insert,
    known,
    unknown,
  };
}

/* ---------------- preview ---------------- */

export async function previewUpload(fileId: number): Promise<ImportPreview> {
  const a = await analyse(fileId);
  // Remember the resolutions so commit does not repeat the Yahoo round-trips.
  await db
    .update(importFiles)
    .set({
      summary: {
        ...(a.file.summary ?? {}),
        preview: a.preview,
        resolved: [...a.unknown.values()].map((u) => u.resolved),
      },
    })
    .where(eq(importFiles.id, fileId));
  return a.preview;
}

/* ---------------- commit ---------------- */

function persistHealth() {
  setHealthSink(async (event) => {
    if (event.status === 'ok') return;
    await db.insert(dataHealth).values({
      provider: event.provider,
      capability: event.capability,
      instrumentId: event.instrumentId,
      status: event.status,
      detail: event.detail,
      servedBy: event.servedBy,
    });
  });
}

/**
 * Price history for instruments that did not exist a moment ago, so the
 * recompute that follows can value them. Best effort: a failure is recorded
 * in `data_health` and named in the result, and the nightly bars job will try
 * again anyway.
 */
async function backfillNew(
  created: Array<{ id: number; row: InstrumentRow }>,
  from: string,
): Promise<ImportResult['backfill']> {
  const out = { instruments: created.length, bars: 0, failures: [] as string[] };
  const to = todayIso();
  for (const { row } of created) {
    const inst = toEngineInstrument(row);
    if (!row.yahooSymbol) {
      out.failures.push(`${row.symbol}: no provider symbol — set yahoo_symbol and run npm run backfill`);
      continue;
    }
    try {
      // A little before the first trade, so the position is valued on day one
      // even if that day was a holiday somewhere.
      const { value: bars } = await getDailyBars(inst, addDays(from, -7), to);
      if (bars.length === 0) continue;
      await db
        .insert(pricesDaily)
        .values(
          bars.map((b) => ({
            instrumentId: inst.id,
            priceDate: b.date,
            open: b.open?.toFixed() ?? null,
            high: b.high?.toFixed() ?? null,
            low: b.low?.toFixed() ?? null,
            close: b.close.toFixed(),
            adjClose: b.adjClose?.toFixed() ?? null,
            volume: b.volume,
            provider: b.provider,
          })),
        )
        .onConflictDoNothing();
      out.bars += bars.length;
    } catch (err) {
      out.failures.push(`${row.symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

export async function commitUpload(fileId: number): Promise<ImportResult> {
  persistHealth();
  const started = Date.now();
  const [run] = await db
    .insert(jobRuns)
    .values({ job: 'import-upload', detail: { fileId } })
    .returning({ id: jobRuns.id });

  try {
    const a = await analyse(fileId);
    const accountId = a.file.accountId;

    // ---- instruments first, outside the ledger transaction: a created row is
    // harmless on its own, and classification talks to Yahoo. ----
    const created: Array<{ id: number; row: InstrumentRow }> = [];
    const idByKey = new Map<string, number>();
    for (const [key, row] of a.known) idByKey.set(key, row.id);

    for (const [key, { security, resolved }] of a.unknown) {
      const symbol = (resolved.yahooSymbol || security.ticker).toUpperCase();
      const classification = await classifyNew(resolved);
      const [row] = await db
        .insert(instruments)
        .values({
          symbol,
          isin: security.isin || null,
          name: security.name || symbol,
          assetClass: classification.assetClass,
          exchangeMic: resolved.exchangeMic,
          quoteCurrency: resolved.quoteCurrency,
          quoteMultiplier: resolved.quoteMultiplier,
          country: classification.country,
          sector: classification.sector,
          industry: classification.industry,
          sectorWeights: classification.sectorWeights,
          yahooSymbol: resolved.yahooSymbol || null,
          alpacaSymbol:
            resolved.exchangeMic === 'XNAS' || resolved.exchangeMic === 'XNYS'
              ? security.ticker
              : null,
          finnhubSymbol: resolved.yahooSymbol || null,
        })
        .onConflictDoNothing()
        .returning();
      // A symbol clash means the row exists under a different ISIN or
      // currency; reuse it rather than fail the whole upload.
      const final =
        row ?? (await db.select().from(instruments).where(eq(instruments.symbol, symbol)))[0];
      if (!final) throw new Error(`could not create instrument ${symbol}`);
      idByKey.set(key, final.id);
      if (row) created.push({ id: final.id, row: final });
      const shown = a.preview.newInstruments.find(
        (n) => n.ticker === security.ticker && n.isin === security.isin,
      );
      if (shown) shown.instrumentId = final.id;
    }

    // ---- the ledger, atomically ----
    await db.transaction(async (tx) => {
      for (const t of a.tradesToInsert) {
        await tx.insert(trades).values({
          accountId,
          instrumentId: idByKey.get(t.securityKey)!,
          tradeDate: t.date,
          side: t.side,
          quantity: t.quantity.toFixed(),
          price: t.price.toFixed(),
          tradeCurrency: t.currency,
          fxRate: t.fxRate.toFixed(),
          fxFee: t.fxFee.toFixed(),
          stampDuty: t.stampDuty.toFixed(),
          source: 'import',
          note: t.note,
          externalId: t.externalId,
        });
      }
      for (const f of a.flowsToInsert) {
        await tx.insert(cashFlows).values({
          accountId,
          flowDate: f.date,
          kind: f.kind,
          amount: f.amount.toFixed(),
          flowCurrency: f.currency,
          fxRate: f.fxRate.toFixed(),
          instrumentId: f.securityKey ? (idByKey.get(f.securityKey) ?? null) : null,
          withholding: f.withholding.toFixed(),
          note: f.note,
          externalId: f.externalId,
        });
      }
    });

    const written = {
      trades: a.tradesToInsert.length,
      flows: a.flowsToInsert.length,
      instruments: created.length,
    };

    // ---- prices for anything new, then the cache ----
    const from = a.preview.earliestNew;
    const backfill = from
      ? await backfillNew(created, from)
      : { instruments: 0, bars: 0, failures: [] as string[] };

    let recompute: ImportResult['recompute'] = { ok: true, rowsWritten: 0 };
    if (from) {
      try {
        const r = await recomputeSnapshots({ from, accountId });
        recompute = { ok: true, rowsWritten: r.rowsWritten };
      } catch (err) {
        recompute = {
          ok: false,
          rowsWritten: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const result: ImportResult = {
      ...a.preview,
      alreadyApplied: new Date().toISOString(),
      written,
      backfill,
      recompute,
    };

    await db
      .update(importFiles)
      .set({
        appliedAt: new Date(),
        summary: { ...(a.file.summary ?? {}), result: { ...result, newInstruments: result.newInstruments } },
      })
      .where(eq(importFiles.id, fileId));

    await db
      .update(jobRuns)
      .set({
        status: 'ok',
        finishedAt: new Date(),
        detail: {
          fileId,
          filename: a.file.filename,
          ...written,
          bars: backfill.bars,
          recomputed: recompute.rowsWritten,
          durationMs: Date.now() - started,
        },
      })
      .where(eq(jobRuns.id, run!.id));

    return result;
  } catch (err) {
    await db
      .update(jobRuns)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        detail: {
          fileId,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - started,
        },
      })
      .where(eq(jobRuns.id, run!.id));
    throw err;
  }
}

/** Convenience for the CLI: the whole path in one call. */
export async function importText(input: {
  accountId: number;
  filename: string;
  text: string;
  dryRun?: boolean;
}): Promise<ImportPreview | ImportResult> {
  const { fileId } = await storeUpload(input);
  const preview = await previewUpload(fileId);
  if (input.dryRun) return preview;
  return commitUpload(fileId);
}

/** Never-applied uploads, oldest first: what a "commit all" acts on. */
export async function pendingUploads(accountId: number): Promise<ImportFile[]> {
  return db
    .select()
    .from(importFiles)
    .where(and(eq(importFiles.accountId, accountId), sql`${importFiles.appliedAt} is null`))
    .orderBy(importFiles.id);
}
