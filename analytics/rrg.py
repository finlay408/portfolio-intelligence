"""
Relative Rotation Graph — JdK RS-Ratio and RS-Momentum (CLAUDE.md §7.7).

This is easy to get subtly wrong, so the construction is spelled out:

    RS          = 100 × (price_asset / price_benchmark)
    RS-Ratio    = 100 + normalised(RS, smoothed over ~10 periods)
    RS-Momentum = 100 + normalised(rate of change of RS-Ratio)

`normalised` is a rolling z-score scaled so values centre on 100 with a typical
range of roughly 94-106. The scaling constant is what makes the four quadrants
readable at a glance; without it the axes are in arbitrary units and the chart
means nothing.

Weekly bars are the default. Daily RRG is noise: the tails whip across quadrants
on single-session moves and nothing can be read from them.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

# Scales a z-score into the conventional 94-106 band. A z of +2 lands near 106.
Z_SCALE = 3.0

DEFAULT_SMOOTHING = 10
DEFAULT_MOMENTUM_LOOKBACK = 5
DEFAULT_TAIL_LENGTH = 10  # weeks, i.e. the 8-12 week trail the brief asks for
MIN_PERIODS = 30


def to_weekly(prices: pd.DataFrame) -> pd.DataFrame:
    """Friday closes. Weeks with no observation are dropped, not forward-filled."""
    return prices.resample("W-FRI").last().dropna(how="all")


def _rolling_z(series: pd.Series, window: int) -> pd.Series:
    mean = series.rolling(window).mean()
    std = series.rolling(window).std(ddof=1)
    return (series - mean) / std.replace(0, np.nan)


def rs_ratio_momentum(
    asset: pd.Series,
    benchmark: pd.Series,
    smoothing: int = DEFAULT_SMOOTHING,
    momentum_lookback: int = DEFAULT_MOMENTUM_LOOKBACK,
) -> pd.DataFrame:
    joined = pd.concat([asset.rename("a"), benchmark.rename("b")], axis=1).dropna()
    if len(joined) < MIN_PERIODS:
        return pd.DataFrame(columns=["rs", "rs_ratio", "rs_momentum"])

    rs = 100 * (joined["a"] / joined["b"])

    # Smooth the raw relative strength, then z-score it against its own history.
    rs_smoothed = rs.rolling(smoothing).mean()
    rs_ratio = 100 + Z_SCALE * _rolling_z(rs_smoothed, smoothing * 2)

    # Momentum is the rate of change OF THE RATIO, not of the raw RS. Using raw
    # RS here is the most common way this gets built wrong: it produces a
    # momentum axis that is really just a noisier copy of the ratio axis.
    roc = rs_ratio / rs_ratio.shift(momentum_lookback) - 1
    rs_momentum = 100 + Z_SCALE * _rolling_z(roc, smoothing * 2)

    return pd.DataFrame(
        {"rs": rs, "rs_ratio": rs_ratio, "rs_momentum": rs_momentum}
    ).dropna()


def quadrant(ratio: float, momentum: float) -> str:
    if ratio >= 100 and momentum >= 100:
        return "leading"
    if ratio >= 100 and momentum < 100:
        return "weakening"
    if ratio < 100 and momentum < 100:
        return "lagging"
    return "improving"


def build(
    prices: pd.DataFrame,
    benchmark: pd.Series,
    labels: dict[Any, str],
    tail_length: int = DEFAULT_TAIL_LENGTH,
    weekly: bool = True,
) -> dict[str, Any]:
    """
    One RRG payload: a trailing tail per series, ready for the D3 chart.

    `prices` may hold individual instruments, theme aggregates, or both — the
    maths is identical, which is why theme rotation comes free.
    """
    px = to_weekly(prices) if weekly else prices
    bm = to_weekly(benchmark.to_frame("b"))["b"] if weekly else benchmark

    series_out: list[dict[str, Any]] = []
    for column in px.columns:
        frame = rs_ratio_momentum(px[column], bm)
        if frame.empty:
            continue
        tail = frame.tail(tail_length)
        latest = tail.iloc[-1]
        series_out.append(
            {
                "key": str(column),
                "label": labels.get(column, str(column)),
                "quadrant": quadrant(float(latest["rs_ratio"]), float(latest["rs_momentum"])),
                "tail": [
                    {
                        "date": str(idx)[:10],
                        "rs_ratio": float(row["rs_ratio"]),
                        "rs_momentum": float(row["rs_momentum"]),
                    }
                    for idx, row in tail.iterrows()
                ],
            }
        )

    return {
        "status": "ok" if series_out else "insufficient_history",
        "frequency": "weekly" if weekly else "daily",
        "tail_length": tail_length,
        "smoothing": DEFAULT_SMOOTHING,
        "series": series_out,
        "note": (
            "RS-Ratio and RS-Momentum are rolling z-scores centred on 100. They are relative "
            "measures: a holding in the leading quadrant is outperforming this benchmark, not "
            "necessarily rising."
        ),
    }


def theme_aggregate(
    prices: pd.DataFrame,
    membership: dict[int, list[tuple[str, float]]],
) -> pd.DataFrame:
    """
    Weight-average instrument price series into theme indices.

    Each theme series is rebased to 100 at its first observation so themes with
    different constituent price levels are comparable on the same chart.
    """
    theme_columns: dict[str, pd.Series] = {}
    for instrument_id, themes in membership.items():
        if instrument_id not in prices.columns:
            continue
        normalised = prices[instrument_id] / prices[instrument_id].dropna().iloc[0] * 100
        for theme, weight in themes:
            if weight <= 0:
                continue
            contribution = normalised * weight
            theme_columns[theme] = (
                contribution if theme not in theme_columns else theme_columns[theme] + contribution
            )

    if not theme_columns:
        return pd.DataFrame()
    return pd.DataFrame(theme_columns)
