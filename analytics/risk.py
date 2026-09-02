"""
Risk metrics (CLAUDE.md §7.4).

The rule that shapes this module: **report standard errors and R² alongside
alpha and beta**. With 200 daily observations and a concentrated portfolio, an
alpha estimate has an enormous confidence interval. Displaying a bare
"alpha: 4.2%" implies a precision that does not exist, so every regression
result here carries its own uncertainty and the UI is expected to render it.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

import numpy as np
import pandas as pd
# Import only the OLS path rather than `statsmodels.api`. The umbrella module
# pulls in the whole tsa/statespace tree, which is a large amount of compiled
# code this project never touches — and on a locked-down machine those DLLs can
# be blocked outright, which would take the entire analytics job down with them.
from statsmodels.regression.linear_model import OLS
from statsmodels.tools.tools import add_constant

TRADING_DAYS = 252

# Below this, a rolling window is noise rather than an estimate.
MIN_OBSERVATIONS = 30


def _clean(x: pd.Series) -> pd.Series:
    return pd.to_numeric(x, errors="coerce").replace([np.inf, -np.inf], np.nan).dropna()


def annualised_volatility(returns: pd.Series) -> float | None:
    r = _clean(returns)
    if len(r) < 2:
        return None
    return float(r.std(ddof=1) * np.sqrt(TRADING_DAYS))


def annualised_return(returns: pd.Series) -> float | None:
    r = _clean(returns)
    if r.empty:
        return None
    growth = float((1 + r).prod())
    if growth <= 0:
        return None
    return float(growth ** (TRADING_DAYS / len(r)) - 1)


def sharpe(returns: pd.Series, risk_free: pd.Series | float = 0.0) -> float | None:
    """
    GBP Sharpe. The risk-free series must be SONIA or the UK 3-month gilt —
    never US T-bills, which would shift the ratio by the whole rate differential.
    """
    excess = _excess(returns, risk_free)
    if len(excess) < 2:
        return None
    sd = excess.std(ddof=1)
    if sd == 0 or np.isnan(sd):
        return None
    return float(excess.mean() / sd * np.sqrt(TRADING_DAYS))


def sortino(returns: pd.Series, risk_free: pd.Series | float = 0.0, mar: float = 0.0) -> float | None:
    excess = _excess(returns, risk_free)
    if len(excess) < 2:
        return None
    downside = excess[excess < mar] - mar
    if downside.empty:
        return None  # no downside in the window: a ratio here would be a lie
    dd = float(np.sqrt((downside**2).sum() / len(excess)))
    if dd == 0:
        return None
    return float(excess.mean() / dd * np.sqrt(TRADING_DAYS))


def _excess(returns: pd.Series, risk_free: pd.Series | float) -> pd.Series:
    r = _clean(returns)
    if isinstance(risk_free, (int, float)):
        return r - float(risk_free)
    rf = _clean(risk_free).reindex(r.index).ffill().fillna(0.0)
    return r - rf


@dataclass
class Drawdown:
    depth: float | None
    peak_date: str | None
    trough_date: str | None
    recovered_date: str | None
    recovery_days: int | None
    underwater_days: int | None


def max_drawdown(returns: pd.Series) -> Drawdown:
    r = _clean(returns)
    if r.empty:
        return Drawdown(None, None, None, None, None, None)

    cumulative = (1 + r).cumprod()
    running_peak = cumulative.cummax()
    drawdown = cumulative / running_peak - 1

    trough = drawdown.idxmin()
    depth = float(drawdown.min())
    peak = cumulative.loc[:trough].idxmax()
    peak_value = float(cumulative.loc[peak])

    after = cumulative.loc[trough:]
    recovered = after[after >= peak_value]
    recovered_date = recovered.index[0] if len(recovered) else None

    return Drawdown(
        depth=depth,
        peak_date=str(peak)[:10],
        trough_date=str(trough)[:10],
        recovered_date=str(recovered_date)[:10] if recovered_date is not None else None,
        recovery_days=int((recovered_date - trough).days) if recovered_date is not None else None,
        underwater_days=int(((recovered_date or cumulative.index[-1]) - peak).days),
    )


def calmar(returns: pd.Series, drawdown_depth: float | None) -> float | None:
    ann = annualised_return(returns)
    if ann is None or not drawdown_depth:
        return None
    return float(ann / abs(drawdown_depth))


@dataclass
class Regression:
    """A single-factor regression with everything needed to judge it."""

    alpha_daily: float
    alpha_annualised: float
    alpha_stderr_annualised: float
    alpha_tstat: float
    alpha_pvalue: float
    alpha_ci95_low: float
    alpha_ci95_high: float
    beta: float
    beta_stderr: float
    beta_tstat: float
    beta_ci95_low: float
    beta_ci95_high: float
    r_squared: float
    observations: int

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def regress(
    portfolio: pd.Series,
    benchmark: pd.Series,
    risk_free: pd.Series | float = 0.0,
) -> Regression | None:
    """
    Jensen's alpha and beta by OLS on excess returns, with HAC (Newey-West)
    standard errors. Daily portfolio returns are autocorrelated and
    heteroskedastic; plain OLS errors would understate the uncertainty, which is
    exactly the failure this whole section exists to avoid.
    """
    p = _excess(portfolio, risk_free)
    b = _excess(benchmark, risk_free)
    joined = pd.concat([p, b], axis=1, keys=["p", "b"]).dropna()
    if len(joined) < MIN_OBSERVATIONS:
        return None

    x = add_constant(joined["b"].values)
    model = OLS(joined["p"].values, x).fit(cov_type="HAC", cov_kwds={"maxlags": 5})

    alpha_daily = float(model.params[0])
    beta = float(model.params[1])
    alpha_se_daily = float(model.bse[0])
    ci = model.conf_int(alpha=0.05)

    return Regression(
        alpha_daily=alpha_daily,
        alpha_annualised=float(alpha_daily * TRADING_DAYS),
        alpha_stderr_annualised=float(alpha_se_daily * TRADING_DAYS),
        alpha_tstat=float(model.tvalues[0]),
        alpha_pvalue=float(model.pvalues[0]),
        alpha_ci95_low=float(ci[0][0] * TRADING_DAYS),
        alpha_ci95_high=float(ci[0][1] * TRADING_DAYS),
        beta=beta,
        beta_stderr=float(model.bse[1]),
        beta_tstat=float(model.tvalues[1]),
        beta_ci95_low=float(ci[1][0]),
        beta_ci95_high=float(ci[1][1]),
        r_squared=float(model.rsquared),
        observations=int(len(joined)),
    )


def tracking_error(portfolio: pd.Series, benchmark: pd.Series) -> float | None:
    active = (_clean(portfolio) - _clean(benchmark)).dropna()
    if len(active) < 2:
        return None
    return float(active.std(ddof=1) * np.sqrt(TRADING_DAYS))


def information_ratio(portfolio: pd.Series, benchmark: pd.Series) -> float | None:
    active = (_clean(portfolio) - _clean(benchmark)).dropna()
    if len(active) < 2:
        return None
    sd = active.std(ddof=1)
    if sd == 0:
        return None
    return float(active.mean() / sd * np.sqrt(TRADING_DAYS))


def up_down_capture(portfolio: pd.Series, benchmark: pd.Series) -> dict[str, Any]:
    """Computed on monthly returns, which is the conventional reading (§7.4)."""
    joined = pd.concat([_clean(portfolio), _clean(benchmark)], axis=1, keys=["p", "b"]).dropna()
    if joined.empty:
        return {"up_capture": None, "down_capture": None, "up_months": 0, "down_months": 0}

    monthly = (1 + joined).resample("ME").prod() - 1
    up = monthly[monthly["b"] > 0]
    down = monthly[monthly["b"] < 0]

    def ratio(frame: pd.DataFrame) -> float | None:
        if frame.empty or frame["b"].mean() == 0:
            return None
        return float(frame["p"].mean() / frame["b"].mean())

    return {
        "up_capture": ratio(up),
        "down_capture": ratio(down),
        "up_months": int(len(up)),
        "down_months": int(len(down)),
    }


def rolling_metrics(returns: pd.Series, windows: tuple[int, ...] = (30, 90, 252)) -> dict[str, Any]:
    r = _clean(returns)
    out: dict[str, Any] = {}
    for window in windows:
        if len(r) < window:
            out[f"vol_{window}d"] = None
            out[f"sharpe_{window}d"] = None
            continue
        rolled = r.rolling(window)
        vol = rolled.std(ddof=1) * np.sqrt(TRADING_DAYS)
        sharpe_series = rolled.mean() / rolled.std(ddof=1) * np.sqrt(TRADING_DAYS)
        out[f"vol_{window}d"] = _series_payload(vol)
        out[f"sharpe_{window}d"] = _series_payload(sharpe_series)
    return out


def _series_payload(s: pd.Series) -> dict[str, Any]:
    s = s.dropna()
    return {
        "dates": [str(d)[:10] for d in s.index],
        "values": [None if np.isnan(v) else float(v) for v in s.values],
        "latest": float(s.iloc[-1]) if len(s) else None,
    }


def risk_pack(
    portfolio_returns: pd.Series,
    benchmarks: dict[str, pd.Series],
    risk_free: pd.Series | float = 0.0,
) -> dict[str, Any]:
    """
    The full §7.4 table. `benchmarks` carries both SPX variants — GBP-translated
    and local-currency — so alpha and beta are reported side by side against
    each, and neither is silently the default (§3.3).
    """
    r = _clean(portfolio_returns)
    dd = max_drawdown(r)

    pack: dict[str, Any] = {
        "observations": int(len(r)),
        "since_inception": {
            "annualised_return": annualised_return(r),
            "annualised_volatility": annualised_volatility(r),
            "sharpe": sharpe(r, risk_free),
            "sortino": sortino(r, risk_free),
            "max_drawdown": asdict(dd),
            "calmar": calmar(r, dd.depth),
            "skew": float(r.skew()) if len(r) > 2 else None,
            "excess_kurtosis": float(r.kurtosis()) if len(r) > 3 else None,
            "best_day": float(r.max()) if len(r) else None,
            "worst_day": float(r.min()) if len(r) else None,
            "positive_days_pct": float((r > 0).mean()) if len(r) else None,
        },
        "rolling": rolling_metrics(r),
        "benchmarks": {},
    }

    for name, series in benchmarks.items():
        reg = regress(r, series, risk_free)
        pack["benchmarks"][name] = {
            "regression": reg.to_dict() if reg else None,
            "tracking_error": tracking_error(r, series),
            "information_ratio": information_ratio(r, series),
            "capture": up_down_capture(r, series),
            "benchmark_annualised_return": annualised_return(series),
            "benchmark_annualised_volatility": annualised_volatility(series),
        }

    return pack
