"""
Value at Risk and Expected Shortfall (CLAUDE.md §7.5).

Three methods at 95% and 99%, over 1-day and 10-day horizons:

  historical    — the empirical percentile of the actual return distribution.
                  This is the primary figure.
  parametric    — variance-covariance. Included for comparison, and it
                  understates tail risk; that is the point of showing it.
  cornish-fisher — parametric adjusted for skew and kurtosis. The best
                  compromise between the two.

CVaR / Expected Shortfall is given equal prominence, because "how bad is it
when it is bad" is more useful than "how often is it bad".

The constraint that matters most: **a portfolio with under a year of history has
no meaningful VaR.** Below 252 observations this module returns
``insufficient_history`` and the UI renders that phrase rather than a number
computed from sixty days.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
from scipy import stats

MIN_OBSERVATIONS = 252
CONFIDENCES = (0.95, 0.99)
HORIZONS = (1, 10)


def _clean(x: pd.Series) -> pd.Series:
    return pd.to_numeric(x, errors="coerce").replace([np.inf, -np.inf], np.nan).dropna()


def historical_var(returns: pd.Series, confidence: float) -> float:
    """Empirical quantile. Returned as a positive loss fraction."""
    return float(-np.percentile(returns.values, (1 - confidence) * 100))


def historical_cvar(returns: pd.Series, confidence: float) -> float:
    threshold = np.percentile(returns.values, (1 - confidence) * 100)
    tail = returns[returns <= threshold]
    if tail.empty:
        return float(-threshold)
    return float(-tail.mean())


def parametric_var(returns: pd.Series, confidence: float) -> float:
    mu = float(returns.mean())
    sigma = float(returns.std(ddof=1))
    z = stats.norm.ppf(1 - confidence)
    return float(-(mu + z * sigma))


def parametric_cvar(returns: pd.Series, confidence: float) -> float:
    mu = float(returns.mean())
    sigma = float(returns.std(ddof=1))
    alpha = 1 - confidence
    # E[X | X <= q] for a normal.
    return float(-(mu - sigma * stats.norm.pdf(stats.norm.ppf(alpha)) / alpha))


def cornish_fisher_var(returns: pd.Series, confidence: float) -> float:
    """
    Normal quantile expanded for skew (S) and excess kurtosis (K):

        z_cf = z + (z²-1)S/6 + (z³-3z)K/24 - (2z³-5z)S²/36
    """
    mu = float(returns.mean())
    sigma = float(returns.std(ddof=1))
    s = float(returns.skew())
    k = float(returns.kurtosis())  # pandas already returns EXCESS kurtosis
    z = stats.norm.ppf(1 - confidence)

    z_cf = (
        z
        + (z**2 - 1) * s / 6
        + (z**3 - 3 * z) * k / 24
        - (2 * z**3 - 5 * z) * s**2 / 36
    )
    return float(-(mu + z_cf * sigma))


def scale_horizon(one_day: float, days: int) -> float:
    """
    Square-root-of-time scaling. It assumes independent daily returns, which is
    not true in a stressed market — the 10-day figure is therefore optimistic,
    and is labelled as an estimate in the UI.
    """
    return float(one_day * np.sqrt(days))


def var_pack(returns: pd.Series, portfolio_value_gbp: float) -> dict[str, Any]:
    r = _clean(returns)

    if len(r) < MIN_OBSERVATIONS:
        return {
            "status": "insufficient_history",
            "observations": int(len(r)),
            "required_observations": MIN_OBSERVATIONS,
            "message": (
                f"{len(r)} daily observations. VaR needs at least {MIN_OBSERVATIONS} "
                "(one year) before it means anything."
            ),
        }

    out: dict[str, Any] = {
        "status": "ok",
        "observations": int(len(r)),
        "portfolio_value_gbp": portfolio_value_gbp,
        "distribution": {
            "mean_daily": float(r.mean()),
            "stdev_daily": float(r.std(ddof=1)),
            "skew": float(r.skew()),
            "excess_kurtosis": float(r.kurtosis()),
        },
        "methods": {},
    }

    for confidence in CONFIDENCES:
        label = f"{int(confidence * 100)}"
        one_day = {
            "historical": historical_var(r, confidence),
            "parametric": parametric_var(r, confidence),
            "cornish_fisher": cornish_fisher_var(r, confidence),
        }
        one_day_cvar = {
            "historical": historical_cvar(r, confidence),
            "parametric": parametric_cvar(r, confidence),
        }

        out["methods"][label] = {
            horizon_key(h): {
                "var": {
                    method: {
                        "fraction": scale_horizon(v, h),
                        "gbp": scale_horizon(v, h) * portfolio_value_gbp,
                    }
                    for method, v in one_day.items()
                },
                "cvar": {
                    method: {
                        "fraction": scale_horizon(v, h),
                        "gbp": scale_horizon(v, h) * portfolio_value_gbp,
                    }
                    for method, v in one_day_cvar.items()
                },
            }
            for h in HORIZONS
        }

    out["primary"] = {
        "var_95_1d_gbp": out["methods"]["95"]["1d"]["var"]["historical"]["gbp"],
        "cvar_95_1d_gbp": out["methods"]["95"]["1d"]["cvar"]["historical"]["gbp"],
        "var_99_1d_gbp": out["methods"]["99"]["1d"]["var"]["historical"]["gbp"],
        "cvar_99_1d_gbp": out["methods"]["99"]["1d"]["cvar"]["historical"]["gbp"],
    }
    return out


def horizon_key(days: int) -> str:
    return f"{days}d"


def component_var(
    holding_returns: pd.DataFrame,
    weights: pd.Series,
    portfolio_value_gbp: float,
    confidence: float = 0.95,
) -> dict[str, Any]:
    """
    Marginal and component VaR — which position contributes most to portfolio
    tail risk (§7.5). This is the genuinely actionable output of the whole VaR
    section, so it is computed even when the aggregate figures are the headline.

        marginal_i  = ∂VaR/∂w_i = z · (Σw)_i / σ_p
        component_i = w_i · marginal_i,   and Σ component_i = VaR

    The components sum exactly to the parametric portfolio VaR, which is what
    makes the decomposition readable as "this position is 40% of my tail risk".
    """
    aligned = holding_returns.dropna(how="all", axis=1)
    weights = weights.reindex(aligned.columns).fillna(0.0)
    aligned = aligned.dropna()

    if aligned.empty or len(aligned) < 60 or weights.abs().sum() == 0:
        return {"status": "insufficient_history", "observations": int(len(aligned))}

    cov = aligned.cov().values * 1.0
    w = weights.values.astype(float)

    portfolio_var_daily = float(w @ cov @ w)
    sigma_p = float(np.sqrt(portfolio_var_daily))
    if sigma_p == 0:
        return {"status": "degenerate", "observations": int(len(aligned))}

    z = float(stats.norm.ppf(1 - confidence))
    # VaR as a positive loss; the mean term is dropped, as is conventional for
    # component decomposition.
    var_total = -z * sigma_p

    marginal = (-z) * (cov @ w) / sigma_p
    component = w * marginal

    rows = []
    for i, instrument_id in enumerate(aligned.columns):
        rows.append(
            {
                "instrument_id": int(instrument_id),
                "weight": float(w[i]),
                "marginal_var": float(marginal[i]),
                "component_var": float(component[i]),
                "component_var_gbp": float(component[i] * portfolio_value_gbp),
                "share_of_var": float(component[i] / var_total) if var_total else None,
                "standalone_vol_annualised": float(aligned.iloc[:, i].std(ddof=1) * np.sqrt(252)),
            }
        )

    rows.sort(key=lambda r: r["component_var"], reverse=True)

    return {
        "status": "ok",
        "confidence": confidence,
        "observations": int(len(aligned)),
        "portfolio_var": var_total,
        "portfolio_var_gbp": var_total * portfolio_value_gbp,
        "sum_of_components": float(component.sum()),
        "positions": rows,
        # A diversification benefit near zero means the holdings are one bet.
        "diversification_benefit": float(
            1 - sigma_p / float(np.sqrt(np.diag(cov)) @ np.abs(w))
        )
        if float(np.sqrt(np.diag(cov)) @ np.abs(w)) > 0
        else None,
    }
