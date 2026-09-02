"""
Liquidity stress (CLAUDE.md §7.10).

    days_to_liquidate = position_shares / (ADV_20d × participation_rate)

at 10%, 20% and 30% participation, plus the aggregate days to liquidate 50%,
90% and 100% of the portfolio. Positions taking more than five days are flagged.

Expect the UK sleeve to dominate the illiquid tail: LSE small caps and
investment trusts trade a fraction of the volume of US large caps, and that
asymmetry is the whole reason this view exists.

One limitation, surfaced in the payload rather than buried: free data sources
publish daily volume only. There is no intraday participation profile here, and
a position that looks like two days at 20% participation may behave differently
in a market that gaps.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

PARTICIPATION_RATES = (0.10, 0.20, 0.30)
FLAG_THRESHOLD_DAYS = 5.0
ADV_WINDOW = 20


def average_daily_volume(volumes: pd.Series, window: int = ADV_WINDOW) -> float | None:
    v = pd.to_numeric(volumes, errors="coerce").dropna()
    if v.empty:
        return None
    tail = v.tail(window)
    adv = float(tail.mean())
    return adv if adv > 0 else None


def days_to_liquidate(shares: float, adv: float | None, participation: float) -> float | None:
    if not adv or adv <= 0 or participation <= 0:
        return None
    return float(abs(shares) / (adv * participation))


def liquidity_pack(
    holdings: list[dict[str, Any]],
    volumes: dict[int, pd.Series],
    instrument_meta: dict[int, dict[str, Any]],
    portfolio_value_gbp: float,
    spreads: dict[int, float] | None = None,
) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []

    for holding in holdings:
        instrument_id = int(holding["instrument_id"])
        shares = float(holding.get("quantity") or 0)
        value_gbp = float(holding.get("value_gbp") or 0)
        if shares <= 0:
            continue

        meta = instrument_meta.get(instrument_id, {})
        adv = average_daily_volume(volumes.get(instrument_id, pd.Series(dtype=float)))

        per_rate = {
            f"{int(rate * 100)}pct": days_to_liquidate(shares, adv, rate)
            for rate in PARTICIPATION_RATES
        }
        worst = per_rate["10pct"]

        rows.append(
            {
                "instrument_id": instrument_id,
                "symbol": meta.get("symbol"),
                "exchange_mic": meta.get("exchange_mic"),
                "asset_class": meta.get("asset_class"),
                "shares": shares,
                "value_gbp": value_gbp,
                "weight": value_gbp / portfolio_value_gbp if portfolio_value_gbp else None,
                "adv_20d": adv,
                "adv_source": "daily bars" if adv else None,
                "days_to_liquidate": per_rate,
                "spread_pct": (spreads or {}).get(instrument_id),
                "flagged": bool(worst is not None and worst > FLAG_THRESHOLD_DAYS),
                "unknown_liquidity": adv is None,
            }
        )

    rows.sort(key=lambda r: (r["days_to_liquidate"]["10pct"] is None, -(r["days_to_liquidate"]["10pct"] or 0)))

    return {
        "participation_rates": list(PARTICIPATION_RATES),
        "flag_threshold_days": FLAG_THRESHOLD_DAYS,
        "positions": rows,
        "aggregate": _aggregate(rows, portfolio_value_gbp),
        "flagged_count": sum(1 for r in rows if r["flagged"]),
        "unknown_count": sum(1 for r in rows if r["unknown_liquidity"]),
        "caveat": (
            "ADV is daily-granularity only on free data sources. These figures assume steady "
            "participation through the day and no market impact."
        ),
    }


def _aggregate(rows: list[dict[str, Any]], portfolio_value_gbp: float) -> dict[str, Any]:
    """
    Days to raise 50/90/100% of the portfolio.

    Positions are liquidated most-liquid-first — the realistic order, since that
    is what anyone raising cash actually does, and it makes the 50% figure much
    smaller than the 100% one for a barbell portfolio.
    """
    if portfolio_value_gbp <= 0:
        return {"50pct": None, "90pct": None, "100pct": None}

    sellable = [
        r
        for r in rows
        if r["days_to_liquidate"]["20pct"] is not None and r["value_gbp"] > 0
    ]
    sellable.sort(key=lambda r: r["days_to_liquidate"]["20pct"])

    out: dict[str, Any] = {}
    for target in (0.5, 0.9, 1.0):
        needed = portfolio_value_gbp * target
        raised = 0.0
        days = 0.0
        for row in sellable:
            if raised >= needed:
                break
            raised += row["value_gbp"]
            days = max(days, float(row["days_to_liquidate"]["20pct"]))
        key = f"{int(target * 100)}pct"
        out[key] = round(days, 2) if raised >= needed else None
        if out[key] is None:
            out[f"{key}_note"] = "cannot be reached: some positions have no volume data"

    return out
