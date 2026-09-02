# Portfolio Intelligence

A single-user, private portfolio **risk and attribution** system. Not a performance tracker.

You enter trades once. Every position, weight, exposure, return decomposition and risk metric is
derived from that ledger and recomputed automatically. Base currency is GBP; it holds US- and
LSE-listed equities and ETFs; it runs on free data.

The full specification is in [CLAUDE.md](CLAUDE.md). This file is how to run it.

---

## The one rule everything else follows

**Positions are never stored. They are always derived.**

`trades` is append-only and is the sole source of truth. Holdings, cost basis, realised P&L,
weights and every exposure figure are computed on read from the full trade history plus corporate
actions. Cached snapshots exist only for speed and are rebuildable with one command.

That is what makes sells, partial closes, splits and rebalances work without intervention. It is
also what most home-built trackers get wrong: they mutate a `positions` table, drift from reality
within six months, and the owner stops believing the numbers.

Two consequences you will notice:

- Record a trade and every position updates immediately, before any job runs.
- A bug in the position engine is fixed once, and every historical figure corrects itself on the
  next `npm run recompute`.

---

## Quick start

```bash
npm install
cp .env.example .env
```

### Option A — try it with no database and no API keys

PGlite gives you a real Postgres running inside Node, so nothing needs installing.

```bash
echo 'DATABASE_URL=pglite://.data/local' > .env.local
echo 'AUTH_MODE=development' >> .env.local
npm run migrate
npm run seed
npm run dev
```

You get the golden portfolio: 31 hand-verified trades across an ISA and a GIA, with correct
positions, cost basis, realised P&L and Section 104 tax pooling — and **no market data**, which
the UI says plainly. That is deliberate; see [Seed data](#seed-data).

To exercise the whole data pipeline against real prices:

```bash
npm run seed -- --demo-prices    # map the fixture onto real tickers
npm run backfill                 # daily bars + FX, keyless, via Yahoo
npm run recompute -- --from=inception
```

> **PGlite is single-writer.** Only one process may hold `.data/local` at a time, so a running
> `npm run dev` will not see writes made by a CLI job in another terminal. Restart the dev server
> after seeding or recomputing. Real Postgres has no such constraint.

### Option B — a real database (what you deploy)

Create a free Postgres on [Neon](https://neon.tech) or [Supabase](https://supabase.com), put the
connection string in `.env`, then:

```bash
npm run db:migrate
npm run seed
npm run backfill
npm run recompute -- --from=inception
npm run dev
```

### Verify it

```bash
npm test                          # 132 tests, no database required
npm run typecheck
python analytics/test_analytics.py   # 65 checks on the Python half
```

---

## Layout

```
src/lib/engine/     the analytics engine — pure functions, no I/O
  positions.ts        average cost + FIFO lots + HMRC Section 104 pooling
  snapshots.ts        ledger → daily series (the recompute definition)
  twr.ts  xirr.ts     time- and money-weighted return
  attribution.ts      chain-linked contribution, exact to floating point
  concentration.ts    HHI, effective N, correlation clustering
  valuation.ts        market value and the GBP return decomposition
  greeks.ts           Black-Scholes and portfolio Greek aggregation
  auto-invest.ts      rule expansion, calendar roll-forward
  corporate-actions.ts  detection validation and the 15% confirmation gate
  load.ts             the ONLY place DB rows become engine types

src/lib/providers/  every external source behind one interface
  registry.ts         the routing table and fallthrough recorder
  normalise.ts        the GBX→GBP ingestion boundary
  yahoo.ts alpaca.ts finnhub.ts alphavantage.ts fx.ts

src/app/            Next.js App Router — pages read, actions write
analytics/          the Python half: regressions, VaR, factors, RRG, scenarios
scripts/            the CLI jobs GitHub Actions runs
tests/              the golden portfolio and the property tests
.github/workflows/  the schedules
```

---

## The three traps this codebase is built around

### 1. LSE prices are quoted in pence

Yahoo returns a UK stock at `2450.0`, meaning **£24.50**. Every instrument carries a
`quote_multiplier` (0.01 for GBX lines), applied once at the ingestion boundary in
`providers/normalise.ts`. Nothing downstream ever sees pence.

The multiplier is **stored per instrument, never inferred from the `.L` suffix** — many LSE-listed
ETFs quote in GBP on the same exchange. The Yahoo provider cross-checks its own `GBp` currency
label on every ingest and *refuses* to store bars for a mis-configured line rather than making the
portfolio a hundred times too large.

### 2. FX is not optional and a missing rate is not 1.0

Every non-GBP position's return is split into `asset_return_local + fx_return + cross_term`, which
sum **exactly** to the GBP return. Without that split, "alpha vs the S&P 500" is contaminated by
GBP/USD and the factor regressions mean nothing.

A position with no FX rate is reported as unvalued, never valued at parity. A day the portfolio
cannot be fully valued becomes a **gap** in the TWR chain, not a 100% loss.

FX history comes from FRED where a key is available and from Yahoo otherwise, so a fresh install
with no API keys still has a complete GBP series.

### 3. TWR and MWR are different numbers and both are shown

TWR neutralises deposit timing and is the only correct basis for comparison against an index. MWR
(XIRR) is what your capital actually earned. With regular auto-invest they diverge materially.
Showing one without the other is the most common analytical error in retail portfolio tools, so
the overview shows both, side by side, always labelled.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | the app |
| `npm test` | the test suite — no database needed |
| `npm run migrate` | apply migrations (works with `pglite://` too) |
| `npm run db:generate` | generate a migration after a schema change |
| `npm run seed` | the golden portfolio; `-- --demo-prices` to map real tickers |
| `npm run import -- --file=x.csv --dry-run` | load a portfolio from CSV; creates instruments from tickers |
| `npm run icons` | rebuild the home-screen icons from `public/source-icon.jpg` |
| `npm run backfill` | daily bars and FX for everything held, watched or benchmarked |
| `npm run recompute -- --from=inception` | rebuild every cached daily snapshot |
| `npm run integrity-check` | recompute from inception and diff against the cache |
| `npm run auto-invest` | fire due rules; `-- --dry-run` to preview |
| `npm run refresh-quotes -- --market=uk` | live quotes |
| `npm run corp-actions` | detect, validate and queue corporate actions |
| `npm run earnings` | refresh the earnings calendar |
| `npm run options` | ingest option chains and fill missing Greeks |
| `python analytics/run_nightly.py` | the risk pack |
| `python analytics/run_nightly.py --job=factors` | monthly Ken French pull |
| `python analytics/run_nightly.py --job=macro` | daily FRED refresh |

CSV export lives at `/api/export?dataset=trades|positions|disposals|daily`. The `disposals`
dataset takes `&taxYear=2025/26` and emits the Section 104 matching — the ledger's own working,
for an accountant. It is not a tax return; that is an explicit non-goal.

---

## Data providers

All free tiers. Nothing here costs anything per month.

| Need | Primary | Fallback |
|---|---|---|
| US quote | Alpaca (real-time IEX) | Finnhub → Yahoo |
| US daily bars | Alpaca | Yahoo |
| LSE quote | Yahoo (~15-20 min delayed) | Finnhub |
| LSE daily bars | Yahoo | Alpha Vantage (25/day, batch only) |
| FX daily | FRED `DEXUSUK` | exchangerate.host → Yahoo |
| Corporate actions | Yahoo | Finnhub |
| Earnings | Finnhub | — |
| Macro | FRED | — |
| Factors | Ken French Data Library | — |
| Option chains + Greeks | Alpaca indicative feed | Black-Scholes |

**Only `DATABASE_URL` is required.** Without any API key at all, Yahoo still supplies bars, FX and
corporate actions — you lose real-time US quotes, the earnings calendar, macro series and options.

Three rules the resolver enforces:

- **Alpha Vantage's 25-a-day budget is unreachable from a user request.** The token bucket marks
  it batch-only, so a page refresh cannot exhaust tomorrow's data.
- **Every fallthrough is recorded** in `data_health` and shown at `/data-health`. A fallback nobody
  can see is the same failure as no fallback.
- **Freshness is never guessed.** Each quote stores the delay its provider actually guarantees, and
  a stored end-of-day close is never badged "Live" no matter how recent it is.

---

## Scheduling

GitHub Actions, not Vercel Cron. The Hobby tier limits both the number of cron jobs and their
frequency, and its function timeout is too short for a nightly analytics rebuild. Verify Vercel's
current limits before relying on them either way.

- **Light jobs** (quote refresh) call a protected Next.js route with `CRON_SECRET`.
- **Heavy jobs** (bars, recompute, the Python risk pack) run directly against Postgres and never
  round-trip through Vercel.

Repository secrets needed: `DATABASE_URL`, `APP_URL`, `CRON_SECRET`, and whichever provider keys
you have.

The weekly **integrity check** recomputes every snapshot from inception and diffs it against the
cache, failing the workflow on any mismatch over a penny. It is not optional — it is what catches
silent drift, and a cache that has quietly diverged is worse than no cache because every number
downstream still looks plausible.

---

## Auth

The default is **Vercel Deployment Protection** with SSO: platform-level, zero code, and no
authentication surface in this repo to get wrong. Requests that fail it never reach Next.js.

Set `AUTH_MODE=vercel-protection` in production as an explicit acknowledgement that you have
enabled it. `requireOwner()` **fails closed** — an unset `AUTH_MODE` in production returns an error
page rather than serving an unauthenticated portfolio.

Cron routes are separate and always enforced: a bearer token compared in constant time.

To use NextAuth instead, set `AUTH_MODE=nextauth`, add the email provider with a single
allowlisted address, and replace the body of `requireOwner()` in `src/lib/auth.ts`. There is
deliberately no password check anywhere.

---

## Testing

132 TypeScript tests and 65 Python checks. None of them need a database, because the engine is a
pure function of its inputs — which is the whole reason it is written that way.

| Suite | What it pins down |
|---|---|
| `positions.test.ts` | the golden portfolio: 31 trades, buys, partial sells, full closes, a 4:1 split, a 1:10 reverse split, a dividend, a ticker change — every figure hand-computed |
| | Section 104: same-day matching, the 30-day bed-and-breakfast rule, and three different realised figures from one ledger (£2,350 / £3,100 / £2,850) |
| `attribution.test.ts` | every grid reconciles to total return — to 1e-20, not to 1bp |
| `pipeline.test.ts` | ledger → snapshots → TWR → attribution, including that recompute-from-inception is deterministic and window-independent |
| `gbx.test.ts` | pence conversion in both directions, and the mis-configuration detector |
| `xirr.test.ts` | convergence on pathological flows: near-total loss, a huge late deposit, alternating signs |
| `greeks.test.ts` | Black-Scholes against Hull's worked example and the standard ATM reference |
| `auto-invest.test.ts` | the market calendar, bank-holiday roll-forward, and the 1-28 day cap |
| `analytics/test_analytics.py` | that component VaR sums to portfolio VaR, that VaR is refused below 252 observations, that factor loadings recover known values, and that alpha's reported interval actually contains the truth |

That last one is worth reading. On 800 observations the alpha estimate lands 34% away from the
true value while beta is accurate to 1%. The test asserts the *interval*, not the point — which is
exactly why §7.4 forbids displaying a bare alpha, and why the UI renders `+4.8% ± 8.7% · not
significant`.

---

## Seed data

`npm run seed` loads the same ledger the test suite asserts against by hand. Positions, cost
basis, realised P&L under all three methods, and the tax pooling are all correct and verified.

By default the fixture instruments carry **no provider symbols**, so there is no price history and
no market value. That is on purpose. The fixture's trades are fictional and priced for hand
arithmetic — 5,000 shares at $2, 40 shares at $400 — and pointing them at real tickers values an
£8,000 position at £100,000, producing an 800% day out of nothing. A portfolio tool that shows
nonsense on first run has already lost the argument.

`--demo-prices` maps them onto real listings so you can exercise ingestion, FX, corporate actions
and the analytics pipeline end to end. Use it to check the machinery, never to read the P&L.

Once you start entering your own trades, delete the fixture rows and add instruments with real
`yahoo_symbol` values.

---

## Putting your own portfolio in

There is no "add instrument" screen — the trade form only offers instruments
that already exist. That is fine once you are running (you add a holding
rarely) but useless for loading an existing portfolio, so use the importer.

Copy `portfolio-template.csv`, fill it in, and:

```bash
npm run import -- --file=my-portfolio.csv --dry-run   # always this first
npm run import -- --file=my-portfolio.csv
npm run backfill
npm run recompute -- --from=inception
```

One row per event. `type` is `buy`, `sell`, `deposit`, `withdrawal`,
`dividend`, `interest`, `fee` or `tax`. Only `account`, `type` and `date` are
required columns; the rest are read if present under any reasonable name
(`qty`/`shares`/`units` all work, dates may be `YYYY-MM-DD` or `DD/MM/YYYY`).

What it does for you:

- **Creates instruments from the ticker.** It asks Yahoo for the name,
  exchange, asset class and currency, so you never type them.
- **Gets GBX right.** Yahoo reports a pence-quoted line as `GBp`, and the
  importer stores it at a 0.01 multiplier. The dry run prints which of your
  holdings are in pence — worth reading, because it is not the `.L` suffix that
  decides: `RR.L` and `SHEL.L` quote in pence, `VUSA.L` quotes in pounds.
- **Applies stamp duty.** 0.5% on UK share purchases, nothing on ETFs and
  investment trusts.
- **Uses the FX rate for the trade date**, not today's, when you leave
  `fx_rate` blank. If the rate is not stored yet it skips the row and says so
  rather than guessing — run `npm run backfill` and import again.

**Prices go in pounds, not pence.** If you bought Rolls-Royce at 450p, write
`4.50`. The importer's dry run shows the last traded price both ways so you can
check you have the magnitude right before committing.

Nothing is written until you drop `--dry-run`.

## Home screen icon

Save any photo as `public/source-icon.jpg` — JPEG, PNG or straight-off-the-phone
HEIC all work — then:

```bash
npm run icons
npm run icons -- --focus=top          # if the crop clipped your subject
npm run icons -- --file=C:/pics/x.jpg # or point at it anywhere
```

By default it picks the most visually salient square rather than a blind centre
crop, which on a portrait photo of a person or an animal usually lands on the
face. `--focus top|centre|bottom` overrides that.

Commit the results, push, then on the phone open the site in **Safari** (only
Safari can do this) → Share → **Add to Home Screen**. It opens without Safari's
chrome. If it was already on your Home Screen, delete and re-add it — iOS caches
the old icon indefinitely.

Placeholder icons ship in the repo so nothing 404s before you replace them.

This runs on Node via sharp, not Python. A machine can easily have several
Pythons on its PATH with only one carrying Pillow, which makes the same command
work in one terminal and fail in another; `npm run icons` resolves the same way
everywhere.

## Deploying

1. Push to GitHub and import the repo into Vercel.
2. Set `DATABASE_URL` and `AUTH_MODE=vercel-protection` in the Vercel project.
3. Turn on Deployment Protection (Settings → Deployment Protection → Vercel Authentication).
4. Add the repository secrets listed under [Scheduling](#scheduling).
5. Run `npm run db:migrate` once against the production database.

`DATABASE_URL` and every provider key are server-side only. Nothing is ever prefixed
`NEXT_PUBLIC_`.

---

## Non-goals

No trade execution, no tax filing output, no multi-user support, no mobile app, no social
features, no LLM chat over the portfolio. Each of those expands the scope dramatically and none
serves the purpose.

The `earnings_events.key_points` column is nullable by design: an LLM may fill it, and nothing in
the system depends on it. The app runs standalone and indefinitely without one.
