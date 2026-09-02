"""
Scenario analysis (CLAUDE.md §7.9).

Two modes: historical replay and factor shock.

**Everything here is an estimate, and the payload says so in a field the UI is
required to render.** Beta-propagated scenario analysis assumes stable linear
relationships between holdings and factors — and those relationships break
precisely in the scenarios being modelled. A 2008 replay run on 2026 betas tells
you something useful about relative exposure and almost nothing reliable about
the absolute number.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd
# Import only the OLS path rather than `statsmodels.api`. The umbrella module
# pulls in the whole tsa/statespace tree, which is a large amount of compiled
# code this project never touches — and on a locked-down machine those DLLs can
# be blocked outright, which would take the entire analytics job down with them.
from statsmodels.regression.linear_model import OLS
from statsmodels.tools.tools import add_constant

ESTIMATE_DISCLAIMER = (
    "Estimate only. This propagates historical betas and factor loadings, which are assumed "
    "stable — an assumption that fails hardest in exactly the conditions being modelled. "
    "Treat the ordering of the positions as more informative than the pound figures."
)


@dataclass(frozen=True)
class StressWindow:
    key: str
    label: str
    start: str
    end: str


HISTORICAL_WINDOWS: tuple[StressWindow, ...] = (
    StressWindow("gfc", "Global Financial Crisis", "2008-09-01", "2009-03-31"),
    StressWindow("covid", "Covid crash", "2020-02-19", "2020-03-23"),
    StressWindow("rates_2022", "2022 rates repricing", "2022-01-03", "2022-10-14"),
    StressWindow("yen_carry", "Aug 2024 yen carry unwind", "2024-07-31", "2024-08-07"),
)


def estimate_betas(
    holding_returns: pd.DataFrame,
    market_returns: pd.Series,
    min_observations: int = 60,
) -> pd.Series:
    """
    Per-holding beta against the market series. Positions with too little
    history fall back to 1.0 — a deliberate, visible assumption rather than an
    exclusion that would quietly shrink the modelled loss.
    """
    betas: dict[Any, float] = {}
    for column in holding_returns.columns:
        joined = pd.concat(
            [holding_returns[column].rename("y"), market_returns.rename("x")], axis=1
        ).dropna()
        if len(joined) < min_observations or joined["x"].std(ddof=1) == 0:
            betas[column] = 1.0
            continue
        model = OLS(joined["y"].values, add_constant(joined["x"].values)).fit()
        betas[column] = float(model.params[1])
    return pd.Series(betas)


def historical_replay(
    weights: pd.Series,
    betas: pd.Series,
    market_returns: pd.Series,
    window: StressWindow,
    portfolio_value_gbp: float,
) -> dict[str, Any]:
    """
    Apply the actual daily path of a stress window to today's holdings through
    their betas. The path matters, not just the total: a 30% fall that arrives
    over four days is a different experience from the same fall over four months.
    """
    path = market_returns.loc[window.start : window.end].dropna()
    if path.empty:
        return {
            "key": window.key,
            "label": window.label,
            "status": "no_benchmark_history",
            "start": window.start,
            "end": window.end,
        }

    portfolio_beta = float((weights * betas.reindex(weights.index).fillna(1.0)).sum())
    modelled = path * portfolio_beta
    cumulative = float((1 + modelled).prod() - 1)

    equity_curve = (1 + modelled).cumprod()
    trough = float(equity_curve.min() - 1)

    per_position = [
        {
            "instrument_id": int(instrument_id),
            "weight": float(weights[instrument_id]),
            "beta": float(betas.get(instrument_id, 1.0)),
            "modelled_return": float(
                (1 + path * betas.get(instrument_id, 1.0)).prod() - 1
            ),
            "modelled_pnl_gbp": float(
                ((1 + path * betas.get(instrument_id, 1.0)).prod() - 1)
                * weights[instrument_id]
                * portfolio_value_gbp
            ),
        }
        for instrument_id in weights.index
    ]
    per_position.sort(key=lambda r: r["modelled_pnl_gbp"])

    return {
        "key": window.key,
        "label": window.label,
        "status": "ok",
        "start": window.start,
        "end": window.end,
        "trading_days": int(len(path)),
        "portfolio_beta": portfolio_beta,
        "benchmark_return": float((1 + path).prod() - 1),
        "modelled_return": cumulative,
        "modelled_pnl_gbp": cumulative * portfolio_value_gbp,
        "modelled_trough": trough,
        "modelled_trough_gbp": trough * portfolio_value_gbp,
        "path": [
            {"date": str(d)[:10], "cumulative": float(v - 1)}
            for d, v in equity_curve.items()
        ],
        "positions": per_position,
        "disclaimer": ESTIMATE_DISCLAIMER,
    }


# Preset shocks (§7.9). Values are the shock applied to each risk driver.
PRESET_SHOCKS: dict[str, dict[str, float]] = {
    "equities_down_20": {"market": -0.20},
    "rates_up_100bp": {"rates_10y_bp": 100},
    "gbpusd_up_10": {"gbpusd": 0.10},
    "gbpusd_down_10": {"gbpusd": -0.10},
    "oil_up_30": {"oil": 0.30},
    "oil_down_30": {"oil": -0.30},
    "vix_to_40": {"market": -0.12},  # a VIX of 40 has historically coincided with this
    "credit_spreads_up_200bp": {"market": -0.15, "rates_10y_bp": -50},
    # Correlated shocks are the realistic case, so the presets include combinations.
    "risk_off_combo": {"market": -0.20, "rates_10y_bp": -75, "gbpusd": -0.05},
    "stagflation_combo": {"market": -0.15, "rates_10y_bp": 150, "oil": 0.30, "gbpusd": -0.08},
}


def factor_shock(
    weights: pd.Series,
    betas: pd.Series,
    shock: dict[str, float],
    portfolio_value_gbp: float,
    fx_exposure: pd.Series | None = None,
    rate_duration: float = 0.0,
    oil_beta: pd.Series | None = None,
) -> dict[str, Any]:
    """
    Δ portfolio = Σ_i w_i × [ β_i × Δ_market + Σ_k loading_{i,k} × Δ_k ] + fx_effect

    `fx_exposure` is the fraction of each position denominated in a non-GBP
    currency; for a GBP-based owner a falling pound is a *gain* on USD assets,
    so the sign is deliberate and is the easiest part of this to get backwards.
    """
    market_shock = shock.get("market", 0.0)
    fx_shock = shock.get("gbpusd", 0.0)
    rate_shock_bp = shock.get("rates_10y_bp", 0.0)
    oil_shock = shock.get("oil", 0.0)

    rows: list[dict[str, Any]] = []
    total = 0.0

    for instrument_id in weights.index:
        w = float(weights[instrument_id])
        beta = float(betas.get(instrument_id, 1.0))

        equity_effect = beta * market_shock
        rate_effect = -rate_duration * (rate_shock_bp / 10_000)
        oil_effect = float(oil_beta.get(instrument_id, 0.0)) * oil_shock if oil_beta is not None else 0.0
        # A stronger GBP (positive gbpusd shock) reduces the GBP value of a
        # USD-denominated holding.
        currency_share = float(fx_exposure.get(instrument_id, 0.0)) if fx_exposure is not None else 0.0
        fx_effect = -currency_share * fx_shock

        position_effect = equity_effect + rate_effect + oil_effect + fx_effect
        contribution = w * position_effect
        total += contribution

        rows.append(
            {
                "instrument_id": int(instrument_id),
                "weight": w,
                "beta": beta,
                "equity_effect": equity_effect,
                "rate_effect": rate_effect,
                "oil_effect": oil_effect,
                "fx_effect": fx_effect,
                "position_return": position_effect,
                "contribution": contribution,
                "pnl_gbp": contribution * portfolio_value_gbp,
            }
        )

    rows.sort(key=lambda r: r["pnl_gbp"])

    return {
        "shock": shock,
        "modelled_return": total,
        "modelled_pnl_gbp": total * portfolio_value_gbp,
        "positions": rows,
        "disclaimer": ESTIMATE_DISCLAIMER,
    }


def scenario_pack(
    weights: pd.Series,
    holding_returns: pd.DataFrame,
    market_returns: pd.Series,
    portfolio_value_gbp: float,
    fx_exposure: pd.Series | None = None,
) -> dict[str, Any]:
    betas = estimate_betas(holding_returns, market_returns)

    return {
        "disclaimer": ESTIMATE_DISCLAIMER,
        "portfolio_value_gbp": portfolio_value_gbp,
        "betas": {int(k): float(v) for k, v in betas.items()},
        "historical": [
            historical_replay(weights, betas, market_returns, window, portfolio_value_gbp)
            for window in HISTORICAL_WINDOWS
        ],
        "shocks": {
            name: factor_shock(
                weights, betas, shock, portfolio_value_gbp, fx_exposure=fx_exposure
            )
            for name, shock in PRESET_SHOCKS.items()
        },
    }
