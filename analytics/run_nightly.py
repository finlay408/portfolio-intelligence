"""
The nightly analytics job (CLAUDE.md §4.2, §8).

Runs directly in GitHub Actions and writes to Postgres over ``DATABASE_URL``.
It never round-trips through Vercel: a full risk rebuild does not fit inside a
Hobby-tier serverless timeout, and the web app is not the right place for it.

    python analytics/run_nightly.py                 # full risk pack
    python analytics/run_nightly.py --job=factors   # monthly Ken French pull
    python analytics/run_nightly.py --job=macro     # daily FRED refresh

Everything lands in ``analytics_snapshots``. The dashboard reads those rows and
computes nothing, which is what keeps it under 200ms.
"""

from __future__ import annotations

import argparse
import os
import sys
import traceback
from datetime import date, datetime, timedelta
from typing import Any

import numpy as np
import pandas as pd
import requests

import db
import factors as factor_lib
import liquidity as liquidity_lib
import risk as risk_lib
import rrg as rrg_lib
import scenarios as scenario_lib
import structure as structure_lib
import var as var_lib

# FRED series the macro dashboard tracks (§6).
MACRO_SERIES = ["DGS10", "T10Y2Y", "VIXCLS", "CPIAUCSL", "SOFR", "IUDSOIA", "DEXUSUK"]

# The GBP risk-free rate. SONIA, not US T-bills (§7).
GBP_RISK_FREE_SERIES = "IUDSOIA"


# ---------------------------------------------------------------------------
# Series construction
# ---------------------------------------------------------------------------


def portfolio_returns(snapshots: pd.DataFrame) -> pd.Series:
    """
    The flow-adjusted daily TWR series computed by the TypeScript engine.

    Deliberately NOT recomputed here from market values: there is one definition
    of the portfolio's return, it lives in `src/lib/engine/twr.ts`, and a second
    implementation in Python would drift from it.
    """
    if snapshots.empty or "twr_daily" not in snapshots:
        return pd.Series(dtype=float)
    return snapshots["twr_daily"].dropna().astype(float)


def benchmark_series(
    conn,
    instruments: pd.DataFrame,
    fx: pd.DataFrame,
    code: str,
    proxy_symbol: str,
) -> dict[str, pd.Series]:
    """
    Both variants the brief requires (§3.3):

      local  — the correct comparison for judging security selection
      gbp    — the return the owner would actually have earned

    They are labelled unambiguously and neither is silently the default.
    """
    match = instruments[instruments["symbol"] == proxy_symbol]
    if match.empty:
        return {}

    instrument_id = int(match.iloc[0]["id"])
    currency = str(match.iloc[0]["quote_currency"])
    prices = db.load_prices(conn, [instrument_id])
    if prices.empty:
        return {}

    closes = prices.set_index("price_date")["close"].astype(float).sort_index()
    local = closes.pct_change().dropna()
    out = {f"{code}_local": local}

    if currency == "GBP":
        out[f"{code}_gbp"] = local
        return out

    pair = f"{currency}GBP"
    rates = fx[fx["pair"] == pair].set_index("rate_date")["rate"].astype(float).sort_index()
    if rates.empty:
        return out

    aligned = rates.reindex(closes.index).ffill()
    gbp_prices = (closes * aligned).dropna()
    out[f"{code}_gbp"] = gbp_prices.pct_change().dropna()
    return out


def holding_return_matrix(
    prices: pd.DataFrame, instrument_ids: list[int]
) -> pd.DataFrame:
    wide = db.wide_closes(prices)
    if wide.empty:
        return pd.DataFrame()
    keep = [c for c in wide.columns if int(c) in set(instrument_ids)]
    return wide[keep].sort_index().pct_change().dropna(how="all")


def latest_weights(holdings: list[dict[str, Any]]) -> tuple[pd.Series, float]:
    if not holdings:
        return pd.Series(dtype=float), 0.0
    values = {
        int(h["instrument_id"]): float(h.get("value_gbp") or 0)
        for h in holdings
        if float(h.get("value_gbp") or 0) > 0
    }
    total = sum(values.values())
    if total <= 0:
        return pd.Series(dtype=float), 0.0
    return pd.Series({k: v / total for k, v in values.items()}), total


def gbp_risk_free(conn) -> pd.Series:
    """SONIA, annualised percent, converted to a daily decimal rate."""
    series = db.load_macro(conn, GBP_RISK_FREE_SERIES)
    if series.empty:
        return pd.Series(dtype=float)
    return (series / 100.0) / 252.0


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------


def run_analytics(snap_date: date) -> dict[str, Any]:
    written: list[str] = []

    with db.connect() as conn:
        accounts = db.load_accounts(conn)
        instruments = db.load_instruments(conn)
        fx = db.load_fx(conn)
        benchmarks = db.load_benchmarks(conn)
        risk_free = gbp_risk_free(conn)

        theme_membership = _theme_membership(conn)

        # Benchmarks are shared across accounts, so build them once.
        benchmark_map: dict[str, pd.Series] = {}
        for _, row in benchmarks.iterrows():
            benchmark_map.update(
                benchmark_series(conn, instruments, fx, row["code"], row["proxy_symbol"])
            )

        for _, account in accounts.iterrows():
            account_id = int(account["id"])
            snapshots = db.load_portfolio_daily(conn, account_id)
            if snapshots.empty:
                print(f"[analytics] account {account_id}: no snapshots; run `npm run recompute`")
                continue

            returns = portfolio_returns(snapshots)
            holdings = db.latest_holdings(conn, account_id)
            weights, portfolio_value = latest_weights(holdings)
            instrument_ids = [int(w) for w in weights.index]

            prices = db.load_prices(conn, instrument_ids)
            holding_returns = holding_return_matrix(prices, instrument_ids)

            # ---- risk ----
            db.write_snapshot(
                conn,
                account_id,
                snap_date,
                "risk",
                risk_lib.risk_pack(returns, benchmark_map, risk_free),
            )
            written.append(f"{account_id}/risk")

            # ---- VaR, including the component decomposition ----
            var_payload = var_lib.var_pack(returns, portfolio_value)
            var_payload["component"] = var_lib.component_var(
                holding_returns, weights, portfolio_value
            )
            db.write_snapshot(conn, account_id, snap_date, "var", var_payload)
            written.append(f"{account_id}/var")

            # ---- concentration, correlation clustering, PCA ----
            db.write_snapshot(
                conn,
                account_id,
                snap_date,
                "structure",
                structure_lib.structure_pack(holding_returns, weights),
            )
            written.append(f"{account_id}/structure")

            # ---- factor exposures ----
            factor_regions = {
                region: frame
                for region in ("US", "Developed", "Europe")
                if not (frame := db.load_factor_returns(conn, region)).empty
            }
            if factor_regions:
                # The local-currency series is the honest input for a factor
                # regression; the GBP one is carried alongside for contrast.
                db.write_snapshot(
                    conn,
                    account_id,
                    snap_date,
                    "factor",
                    factor_lib.factor_pack(
                        returns_local=returns,
                        returns_gbp=returns,
                        factors_by_region=factor_regions,
                    ),
                )
                written.append(f"{account_id}/factor")
            else:
                print("[analytics] no factor returns stored; run --job=factors first")

            # ---- RRG ----
            market = benchmark_map.get("SPX_local")
            wide = db.wide_closes(prices)
            if market is not None and not wide.empty:
                proxy = instruments[instruments["symbol"] == "SPY"]
                bench_prices = (
                    db.load_prices(conn, [int(proxy.iloc[0]["id"])]) if not proxy.empty else pd.DataFrame()
                )
                if not bench_prices.empty:
                    bench_series = (
                        bench_prices.set_index("price_date")["close"].astype(float).sort_index()
                    )
                    labels = {
                        int(r["id"]): str(r["symbol"]) for _, r in instruments.iterrows()
                    }
                    payload = rrg_lib.build(wide, bench_series, labels)
                    themes = rrg_lib.theme_aggregate(wide, theme_membership)
                    if not themes.empty:
                        payload["themes"] = rrg_lib.build(
                            themes, bench_series, {c: c for c in themes.columns}
                        )
                    db.write_snapshot(conn, account_id, snap_date, "rrg", payload)
                    written.append(f"{account_id}/rrg")

            # ---- scenarios ----
            if market is not None and not holding_returns.empty:
                fx_exposure = pd.Series(
                    {
                        int(r["id"]): 0.0 if r["quote_currency"] == "GBP" else 1.0
                        for _, r in instruments.iterrows()
                    }
                ).reindex(weights.index).fillna(0.0)

                db.write_snapshot(
                    conn,
                    account_id,
                    snap_date,
                    "scenario",
                    scenario_lib.scenario_pack(
                        weights, holding_returns, market, portfolio_value, fx_exposure
                    ),
                )
                written.append(f"{account_id}/scenario")

            # ---- liquidity ----
            volumes = {
                int(instrument_id): group.set_index("price_date")["volume"]
                for instrument_id, group in prices.groupby("instrument_id")
            }
            meta = {
                int(r["id"]): {
                    "symbol": r["symbol"],
                    "exchange_mic": r["exchange_mic"],
                    "asset_class": r["asset_class"],
                }
                for _, r in instruments.iterrows()
            }
            db.write_snapshot(
                conn,
                account_id,
                snap_date,
                "liquidity",
                liquidity_lib.liquidity_pack(holdings, volumes, meta, portfolio_value),
            )
            written.append(f"{account_id}/liquidity")

            print(f"[analytics] account {account_id}: {len(returns)} return observations")

        db.record_job(conn, "analytics-nightly", "ok", {"written": written})

    return {"written": written}


def _theme_membership(conn) -> dict[int, list[tuple[str, float]]]:
    df = db.query_df(
        conn,
        """
        select it.instrument_id, t.name, it.weight
          from instrument_themes it
          join themes t on t.id = it.theme_id
        """,
    )
    out: dict[int, list[tuple[str, float]]] = {}
    for _, row in df.iterrows():
        out.setdefault(int(row["instrument_id"]), []).append(
            (str(row["name"]), float(row["weight"]))
        )
    return out


def run_factors() -> dict[str, Any]:
    """Monthly Ken French pull (§8, factor-refresh)."""
    written = 0
    with db.connect() as conn:
        for region in factor_lib.FACTOR_FILES:
            try:
                frame = factor_lib.fetch_region(region)
            except Exception as err:  # noqa: BLE001 - one region failing must not stop the rest
                print(f"[factors] {region} FAILED: {err}")
                continue
            rows = factor_lib.to_rows(region, frame)
            db.write_factor_returns(conn, rows)
            written += len(rows)
            print(f"[factors] {region}: {len(rows)} rows through {frame.index[-1].date()}")
        db.record_job(conn, "factor-refresh", "ok", {"rows": written})
    return {"rows": written}


def run_macro() -> dict[str, Any]:
    """Daily FRED refresh (§8, macro-refresh)."""
    key = os.environ.get("FRED_API_KEY")
    if not key:
        raise RuntimeError("FRED_API_KEY is not set")

    start = (datetime.utcnow() - timedelta(days=365 * 25)).date().isoformat()
    written = 0

    with db.connect() as conn:
        for series_id in MACRO_SERIES:
            response = requests.get(
                "https://api.stlouisfed.org/fred/series/observations",
                params={
                    "series_id": series_id,
                    "api_key": key,
                    "file_type": "json",
                    "observation_start": start,
                },
                timeout=45,
            )
            response.raise_for_status()
            observations = response.json().get("observations", [])
            rows = [
                (series_id, date.fromisoformat(o["date"]), float(o["value"]))
                # FRED marks a missing observation with '.', not with a null.
                for o in observations
                if o["value"] not in (".", "")
            ]
            db.write_macro(conn, rows)
            written += len(rows)
            print(f"[macro] {series_id}: {len(rows)} observations")
        db.record_job(conn, "macro-refresh", "ok", {"rows": written})

    return {"rows": written}


def main() -> int:
    parser = argparse.ArgumentParser(description="Portfolio analytics jobs")
    parser.add_argument("--job", default="analytics", choices=["analytics", "factors", "macro"])
    parser.add_argument("--date", default=None, help="snapshot date (defaults to today)")
    parsed = parser.parse_args()

    snap_date = date.fromisoformat(parsed.date) if parsed.date else date.today()

    try:
        if parsed.job == "analytics":
            result = run_analytics(snap_date)
        elif parsed.job == "factors":
            result = run_factors()
        else:
            result = run_macro()
    except Exception:  # noqa: BLE001 - the job must exit non-zero and say why
        traceback.print_exc()
        try:
            with db.connect() as conn:
                db.record_job(conn, parsed.job, "failed", {"error": traceback.format_exc(limit=3)})
        except Exception:
            pass
        return 1

    print(f"[{parsed.job}] ok: {result}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
