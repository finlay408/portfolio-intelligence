# Handoff

Working state as of 2 September 2026. `CLAUDE.md` is the specification and
`README.md` is the manual — this file is only what a fresh session would not
otherwise know: what is deployed, what is done, what is not, and the traps
already paid for.

---

## Status: live and in use

| | |
|---|---|
| Repo | `github.com/finlay408/portfolio-intelligence` (public) |
| Database | Neon, London/Frankfurt, pooled connection |
| Hosting | Vercel, `AUTH_MODE=vercel-protection` |
| Owner | UK-based, GBP, Trading 212 ISA |

All six phases of the brief are built. 132 TypeScript tests and 65 Python
checks pass; `tsc --noEmit` and `next build` are clean.

**Real data is loaded.** This is not a demo — treat the database as production.

```
accounts                   1     instruments             141
trades                  1007     cash_flows              391
prices_daily          242436     fx_rates_daily         3995
portfolio_daily          272     analytics_snapshots        7
factor_returns        242612     themes                     0
```

Portfolio at last check: £17,271 total (£14,109 invested, £3,162 cash), 21 open
positions, 117 closed, TWR +8.4%, MWR +7.5%, Sharpe 0.77, max drawdown −7.1%.
Alpha vs SPX −0.3% ± 15.1% (not significant), beta 0.51 ± 0.12.
Integrity check: 272 snapshots, 0 mismatches.

---

## Environment traps on this machine

These each cost real time. They are in memory too, but repeating them here:

1. **No pnpm.** `corepack enable` fails with EPERM (no admin). Use `npm`. The
   brief's `pnpm <script>` maps to `npm run <script>`.

2. **Three Pythons on PATH**, and only `C:\Python314` carries the installed
   packages. A command can work in one terminal and fail in another. This is why
   `npm run icons` uses sharp rather than Pillow.

3. **`import statsmodels.api` is blocked** by an Application Control policy
   (`_kalman_filter` DLL). `analytics/` imports only
   `statsmodels.regression.linear_model.OLS` and `statsmodels.tools.tools.add_constant`,
   which avoids the whole tsa/statespace tree. Do not "tidy" that back to
   `import statsmodels.api as sm`.

4. **Never write source through a shell heredoc containing regex escapes.**
   `\b` inside `<<'PYEOF'` became a literal backspace byte (0x08) in
   `scripts/enrich.ts`, so `/\bgilt|...|tips\b/` silently never matched. Two
   debugging rounds. Use the Write/Edit tools for source, or a `.py` file.

5. **PGlite is single-writer.** `DATABASE_URL=pglite://.data/local` is the
   offline mode (`.env.pglite-offline.bak` holds the old config). A running
   `npm run dev` will not see CLI writes — restart it. Neon has no such issue.

---

## Local-only files (gitignored, not recoverable from the repo)

| File | What it is |
|---|---|
| `.env` | `DATABASE_URL`, `CRON_SECRET`, `AUTH_MODE=development` |
| `t212-instruments.csv` | ticker → Yahoo symbol map, 138 rows, all verified |
| `classification.csv` | sector/geography/themes, applied; themes still blank |
| `public/source-icon.jpeg` | the cow photo behind the app icon |
| `.env.pglite-offline.bak` | restore as `.env.local` for offline mode |

---

## What is NOT done

**Ordered by what actually matters.**

1. **GitHub Secrets are not set**, so no scheduled job has ever run in CI.
   Needs `DATABASE_URL`, `CRON_SECRET` (both in `.env`) and `APP_URL` (the
   Vercel URL, no trailing slash). Until then quotes, EOD bars, corporate
   actions, auto-invest and the nightly analytics only run when invoked by hand.

2. **Themes are empty.** No data source can supply them. `classification.csv`
   has a `themes` column (`"Defence:0.7;Photonics:0.3"`), then
   `npm run enrich -- --apply`. Obvious candidates from the holdings: Defence
   (BA.L, NATP.L, MTUAY), Critical Minerals (GLEN.L, USAR, UUUU, LEU, NEM),
   AI/Compute (NVDA, AMD, MU, AVGO, MRVL, CRDO, NBIS, APLD, IREN), Space (SPIR,
   BKSY), Quantum (IONQ, QUBT). The owner was offered a draft and had not
   replied.

3. **Revenue geography is 31% Unmapped** — the individual equities. ETFs are
   filled from index weights. Deliberately not guessed: defaulting a US listing
   to US revenue is right for Duke Energy and wrong for Amgen, and that is the
   precise error §5 warns about.

4. **No API keys.** Everything runs keyless off Yahoo. Adding them would give:
   FRED → macro dashboard and the SONIA risk-free rate (Sharpe currently uses
   0); Alpaca → real-time US quotes instead of delayed; Finnhub → the earnings
   calendar.

5. **Corporate actions have never been detected** (`corp_actions` table empty).
   `npm run corp-actions` has not been run against the real portfolio.

6. **Options are unused.** Schema, Black-Scholes engine, Alpaca chain ingestion
   and the Greeks page all exist and are tested; there are no option positions.

7. **`npm run seed` was never used on Neon.** The demo fixture is not in the
   production database and should not be put there.

---

## Non-obvious decisions already made

- **Attribution is chain-linked by growth factor**, not Cariño-smoothed:
  `Π(1+r) − 1 = Σ r_t · Π_{s<t}(1+r_s)`. Exact to 1e-20, not "within 1bp".
- **TWR flow day-weight is 0** (end-of-day settlement). A constant in `twr.ts`,
  not a parameter. Changing it changes every historical figure.
- **A day the portfolio cannot be fully valued is a null in the TWR chain**, not
  a zero. Fabricating one turned a data gap into a −78% return once already.
- **A missing FX rate is never 1.0.** The position is reported unvalued.
- **All accounts share one trading calendar.** Per-account calendars made a GIA
  vanish on UK bank holidays and produced phantom ±14% days.
- **Multiply before dividing** in the position engine (`basis × qty / held`),
  or exact cases stop being exact.
- **Alpha is asserted through its confidence interval** in the Python tests, not
  as a point estimate — on 800 observations it lands 34% from truth while beta
  is accurate to 1%.

## Trading 212 specifics (in `scripts/import-t212.ts`)

Four traps, all verified against the real export before writing:

1. `Exchange rate` **inverts** between trades (units per GBP, divide) and
   dividends (GBP per unit, multiply).
2. Tickers are not Yahoo tickers. `BA` is BAE Systems; `RR` is Richtech
   Robotics; `NOV` appears twice as two different companies. Resolve by ISIN.
3. An ETF's ISIN is shared by all share classes, so an ISIN search for a
   GBP-quoted line returns the USD one. Try `TICKER.L` first, accept only on a
   currency match.
4. A dividend's `Total` is gross **in GBP**; `Withholding tax` is in the local
   currency.

Every trade is cross-checked against the broker's own GBP total. 0 of 1,007
disagreed by more than 2%.

---

## Routine

```bash
npm run backfill                        # prices + FX
npm run recompute -- --from=inception   # daily snapshots
python analytics/run_nightly.py         # risk pack
npm run integrity-check                 # must report 0 mismatches
```

Adding a holding: record the trade in the UI if the instrument exists,
otherwise `npm run import -- --file=x.csv` (creates instruments from tickers),
then `npm run enrich`.

`npm test && npm run typecheck && python analytics/test_analytics.py` before any
commit.
