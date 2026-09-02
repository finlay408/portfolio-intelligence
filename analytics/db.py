"""
Database access for the nightly analytics job (CLAUDE.md §4.2).

The heavy job talks to Postgres directly over ``DATABASE_URL`` and never
round-trips through Vercel: a full risk rebuild does not fit inside a
serverless function timeout, and it does not need to.

Everything read here was produced by the TypeScript engine. This module does
not derive positions or cost basis — there is one position engine, and it lives
in ``src/lib/engine/positions.ts``.
"""

from __future__ import annotations

import json
import os
from contextlib import contextmanager
from datetime import date
from typing import Any, Iterator

import pandas as pd
import psycopg
from psycopg.rows import dict_row

from jsonio import dumps as json_dumps


def connection_string() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "DATABASE_URL is not set. In GitHub Actions it comes from repository secrets."
        )
    return url


@contextmanager
def connect() -> Iterator[psycopg.Connection]:
    conn = psycopg.connect(connection_string(), row_factory=dict_row)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def query_df(conn: psycopg.Connection, sql: str, params: tuple[Any, ...] = ()) -> pd.DataFrame:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------
# Reads
# --------------------------------------------------------------------------


def load_accounts(conn: psycopg.Connection) -> pd.DataFrame:
    return query_df(conn, "select id, name, wrapper, base_currency from accounts order by id")


def load_portfolio_daily(conn: psycopg.Connection, account_id: int) -> pd.DataFrame:
    """
    The cached daily snapshots produced by ``npm run recompute``.

    ``twr_daily`` is already flow-adjusted, so it is the correct series for every
    risk metric here. Using the raw market-value change instead would attribute
    a deposit to performance.
    """
    df = query_df(
        conn,
        """
        select snap_date, market_value_gbp, cost_basis_gbp, cash_gbp,
               net_flow_gbp, twr_daily, holdings
          from portfolio_daily
         where account_id = %s
         order by snap_date
        """,
        (account_id,),
    )
    if df.empty:
        return df
    df["snap_date"] = pd.to_datetime(df["snap_date"])
    for col in ("market_value_gbp", "cost_basis_gbp", "cash_gbp", "net_flow_gbp", "twr_daily"):
        df[col] = pd.to_numeric(df[col], errors="coerce")
    return df.set_index("snap_date")


def load_prices(conn: psycopg.Connection, instrument_ids: list[int]) -> pd.DataFrame:
    """Wide frame of closes: one column per instrument, indexed by date."""
    if not instrument_ids:
        return pd.DataFrame()
    df = query_df(
        conn,
        """
        select instrument_id, price_date, close, adj_close, volume
          from prices_daily
         where instrument_id = any(%s)
         order by price_date
        """,
        (instrument_ids,),
    )
    if df.empty:
        return df
    df["price_date"] = pd.to_datetime(df["price_date"])
    df["close"] = pd.to_numeric(df["close"])
    return df


def wide_closes(prices: pd.DataFrame, column: str = "close") -> pd.DataFrame:
    if prices.empty:
        return pd.DataFrame()
    return prices.pivot(index="price_date", columns="instrument_id", values=column).astype(float)


def load_instruments(conn: psycopg.Connection) -> pd.DataFrame:
    return query_df(
        conn,
        """
        select id, symbol, name, asset_class, exchange_mic, quote_currency,
               quote_multiplier, country, revenue_regions, sector, industry
          from instruments
        """,
    )


def load_fx(conn: psycopg.Connection) -> pd.DataFrame:
    df = query_df(conn, "select pair, rate_date, rate from fx_rates_daily order by rate_date")
    if df.empty:
        return df
    df["rate_date"] = pd.to_datetime(df["rate_date"])
    df["rate"] = pd.to_numeric(df["rate"])
    return df


def load_benchmarks(conn: psycopg.Connection) -> pd.DataFrame:
    return query_df(conn, "select id, code, name, proxy_symbol, currency from benchmarks")


def load_factor_returns(conn: psycopg.Connection, region: str) -> pd.DataFrame:
    df = query_df(
        conn,
        "select factor_date, factor, ret from factor_returns where region = %s order by factor_date",
        (region,),
    )
    if df.empty:
        return df
    df["factor_date"] = pd.to_datetime(df["factor_date"])
    df["ret"] = pd.to_numeric(df["ret"])
    return df.pivot(index="factor_date", columns="factor", values="ret")


def load_macro(conn: psycopg.Connection, series_id: str) -> pd.Series:
    df = query_df(
        conn,
        "select obs_date, value from macro_series where series_id = %s order by obs_date",
        (series_id,),
    )
    if df.empty:
        return pd.Series(dtype=float)
    return pd.Series(
        pd.to_numeric(df["value"]).values,
        index=pd.to_datetime(df["obs_date"]),
        name=series_id,
    )


def latest_holdings(conn: psycopg.Connection, account_id: int) -> list[dict[str, Any]]:
    df = query_df(
        conn,
        """
        select holdings from portfolio_daily
         where account_id = %s
         order by snap_date desc
         limit 1
        """,
        (account_id,),
    )
    if df.empty:
        return []
    holdings = df.iloc[0]["holdings"]
    return holdings if isinstance(holdings, list) else json.loads(holdings)


# --------------------------------------------------------------------------
# Writes
# --------------------------------------------------------------------------


def write_snapshot(
    conn: psycopg.Connection,
    account_id: int | None,
    snap_date: date,
    kind: str,
    payload: dict[str, Any],
) -> None:
    """
    Upsert one analytics payload. The web app reads these and never computes
    them, which is what keeps the dashboard under 200ms (§10, Phase 4).
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into analytics_snapshots (account_id, snap_date, kind, payload, computed_at)
            values (%s, %s, %s, %s, now())
            on conflict (account_id, snap_date, kind)
            do update set payload = excluded.payload, computed_at = now()
            """,
            (account_id, snap_date, kind, json_dumps(payload)),
        )


def write_factor_returns(conn: psycopg.Connection, rows: list[tuple[date, str, str, float]]) -> None:
    if not rows:
        return
    with conn.cursor() as cur:
        cur.executemany(
            """
            insert into factor_returns (factor_date, factor, region, ret)
            values (%s, %s, %s, %s)
            on conflict (factor_date, factor, region) do update set ret = excluded.ret
            """,
            rows,
        )


def write_macro(conn: psycopg.Connection, rows: list[tuple[str, date, float | None]]) -> None:
    if not rows:
        return
    with conn.cursor() as cur:
        cur.executemany(
            """
            insert into macro_series (series_id, obs_date, value)
            values (%s, %s, %s)
            on conflict (series_id, obs_date) do update set value = excluded.value
            """,
            rows,
        )


def record_job(conn: psycopg.Connection, job: str, status: str, detail: dict[str, Any]) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into job_runs (job, started_at, finished_at, status, detail)
            values (%s, now(), now(), %s, %s)
            """,
            (job, status, json_dumps(detail)),
        )
