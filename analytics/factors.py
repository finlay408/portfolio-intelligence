"""
Fama-French factor exposures (CLAUDE.md §7.6).

Loadings from the Ken French Data Library — free, no key, CSV inside a zip.

The caveat the UI must display, and which this module enforces rather than
merely mentions: **French's US factors are USD-denominated and US-market.** For
a GBP-based portfolio holding UK stocks, the regression runs on the
local-currency return series and uses the Developed or Europe factor sets for
LSE holdings. Mixing a GBP-translated return series with USD factors produces
loadings that are partly a currency bet, and it does so silently.
"""

from __future__ import annotations

import io
import zipfile
from dataclasses import asdict, dataclass
from datetime import date
from typing import Any

import numpy as np
import pandas as pd
import requests
# Import only the OLS path rather than `statsmodels.api`. The umbrella module
# pulls in the whole tsa/statespace tree, which is a large amount of compiled
# code this project never touches — and on a locked-down machine those DLLs can
# be blocked outright, which would take the entire analytics job down with them.
from statsmodels.regression.linear_model import OLS
from statsmodels.tools.tools import add_constant

BASE = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp"

# region -> (five-factor file, momentum file)
FACTOR_FILES: dict[str, tuple[str, str]] = {
    "US": ("F-F_Research_Data_5_Factors_2x3_daily_CSV.zip", "F-F_Momentum_Factor_daily_CSV.zip"),
    "Developed": ("Developed_5_Factors_Daily_CSV.zip", "Developed_MOM_Factor_Daily_CSV.zip"),
    "Europe": ("Europe_5_Factors_Daily_CSV.zip", "Europe_MOM_Factor_Daily_CSV.zip"),
}

FIVE_FACTORS = ["Mkt-RF", "SMB", "HML", "RMW", "CMA"]
ALL_FACTORS = FIVE_FACTORS + ["MOM"]

MIN_OBSERVATIONS = 60


def _download_csv(filename: str) -> pd.DataFrame:
    response = requests.get(f"{BASE}/{filename}", timeout=60)
    response.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        name = archive.namelist()[0]
        raw = archive.read(name).decode("latin-1")
    return _parse_french_csv(raw)


def _parse_french_csv(raw: str) -> pd.DataFrame:
    """
    French's CSVs carry a prose header, then the data, then an annual section
    after a blank line. Only the daily block is wanted, so rows are taken while
    the first field parses as an 8-digit date.
    """
    rows: list[list[str]] = []
    header: list[str] | None = None

    for line in raw.splitlines():
        parts = [p.strip() for p in line.split(",")]
        first = parts[0]
        if header is None:
            # The header row is the one whose first cell is blank — the date
            # column is unlabelled. Two cells is enough: the momentum file's
            # header is just ',Mom', and requiring three silently skipped it,
            # which took the whole factor pull down with it.
            if first == "" and len(parts) >= 2 and any(p for p in parts[1:]):
                header = ["date"] + parts[1:]
            continue
        if len(first) == 8 and first.isdigit():
            rows.append(parts)
        elif rows:
            break  # reached the annual section

    if header is None or not rows:
        raise ValueError("could not parse the Ken French CSV layout")

    df = pd.DataFrame(rows, columns=header[: len(rows[0])])
    df["date"] = pd.to_datetime(df["date"], format="%Y%m%d")
    for col in df.columns[1:]:
        # Published as percent; the schema stores decimals.
        df[col] = pd.to_numeric(df[col], errors="coerce") / 100.0
    return df.set_index("date").dropna(how="all")


def fetch_region(region: str) -> pd.DataFrame:
    """Five factors plus momentum and RF for one region, as decimals."""
    five_file, mom_file = FACTOR_FILES[region]
    five = _download_csv(five_file)
    mom = _download_csv(mom_file)
    mom.columns = ["MOM" if c.strip() in ("Mom", "MOM", "WML") else c for c in mom.columns]
    joined = five.join(mom[["MOM"]], how="left")
    joined.columns = [c.strip() for c in joined.columns]
    return joined


def to_rows(region: str, frame: pd.DataFrame) -> list[tuple[date, str, str, float]]:
    rows: list[tuple[date, str, str, float]] = []
    for factor in [*ALL_FACTORS, "RF"]:
        if factor not in frame.columns:
            continue
        series = frame[factor].dropna()
        rows.extend(
            (idx.date(), factor, region, float(value)) for idx, value in series.items()
        )
    return rows


@dataclass
class Loading:
    factor: str
    coefficient: float
    stderr: float
    tstat: float
    pvalue: float
    ci95_low: float
    ci95_high: float


@dataclass
class FactorFit:
    region: str
    observations: int
    r_squared: float
    adj_r_squared: float
    alpha_annualised: float
    alpha_stderr_annualised: float
    alpha_tstat: float
    loadings: list[Loading]

    def to_dict(self) -> dict[str, Any]:
        return {
            "region": self.region,
            "observations": self.observations,
            "r_squared": self.r_squared,
            "adj_r_squared": self.adj_r_squared,
            "alpha_annualised": self.alpha_annualised,
            "alpha_stderr_annualised": self.alpha_stderr_annualised,
            "alpha_tstat": self.alpha_tstat,
            "loadings": [asdict(l) for l in self.loadings],
        }


def fit(
    returns: pd.Series,
    factors: pd.DataFrame,
    region: str,
    use_factors: list[str] | None = None,
) -> FactorFit | None:
    """
    Regress excess returns on the factor set. HAC standard errors again, for the
    same reason as in `risk.py`: daily returns are autocorrelated and the naive
    errors would flatter the loadings.
    """
    names = use_factors or [f for f in ALL_FACTORS if f in factors.columns]
    joined = pd.concat([returns.rename("r"), factors[names + ["RF"]]], axis=1).dropna()
    if len(joined) < MIN_OBSERVATIONS:
        return None

    y = (joined["r"] - joined["RF"]).values
    x = add_constant(joined[names].values)
    model = OLS(y, x).fit(cov_type="HAC", cov_kwds={"maxlags": 5})
    ci = model.conf_int(alpha=0.05)

    loadings = [
        Loading(
            factor=name,
            coefficient=float(model.params[i + 1]),
            stderr=float(model.bse[i + 1]),
            tstat=float(model.tvalues[i + 1]),
            pvalue=float(model.pvalues[i + 1]),
            ci95_low=float(ci[i + 1][0]),
            ci95_high=float(ci[i + 1][1]),
        )
        for i, name in enumerate(names)
    ]

    return FactorFit(
        region=region,
        observations=int(len(joined)),
        r_squared=float(model.rsquared),
        adj_r_squared=float(model.rsquared_adj),
        alpha_annualised=float(model.params[0] * 252),
        alpha_stderr_annualised=float(model.bse[0] * 252),
        alpha_tstat=float(model.tvalues[0]),
        loadings=loadings,
    )


def rolling_loadings(
    returns: pd.Series,
    factors: pd.DataFrame,
    window: int = 126,
    use_factors: list[str] | None = None,
) -> dict[str, Any]:
    """
    Rolling 126-day loadings so factor drift is visible. A portfolio whose value
    loading has quietly become a momentum loading is a different portfolio, and
    the point estimate alone would never show it.
    """
    names = use_factors or [f for f in ALL_FACTORS if f in factors.columns]
    joined = pd.concat([returns.rename("r"), factors[names + ["RF"]]], axis=1).dropna()
    if len(joined) < window + 10:
        return {"status": "insufficient_history", "observations": int(len(joined))}

    dates: list[str] = []
    series: dict[str, list[float | None]] = {name: [] for name in names}
    r2: list[float] = []

    for end in range(window, len(joined) + 1):
        chunk = joined.iloc[end - window : end]
        y = (chunk["r"] - chunk["RF"]).values
        x = add_constant(chunk[names].values)
        model = OLS(y, x).fit()
        dates.append(str(chunk.index[-1])[:10])
        r2.append(float(model.rsquared))
        for i, name in enumerate(names):
            series[name].append(float(model.params[i + 1]))

    return {
        "status": "ok",
        "window": window,
        "dates": dates,
        "loadings": series,
        "r_squared": r2,
    }


def factor_pack(
    returns_local: pd.Series,
    returns_gbp: pd.Series,
    factors_by_region: dict[str, pd.DataFrame],
    primary_region: str = "US",
) -> dict[str, Any]:
    """
    The §7.6 payload, with the mixing caveat attached to the data rather than
    left to the reader.
    """
    out: dict[str, Any] = {
        "caveat": (
            "Ken French factors are denominated in the region's local currency and built from "
            "that region's market. The regressions below use the LOCAL-currency portfolio "
            "return series so the loadings are not contaminated by GBP/USD moves. The "
            "GBP-translated series is shown separately and is not comparable to the factors."
        ),
        "primary_region": primary_region,
        "fits": {},
        "rolling": None,
    }

    for region, frame in factors_by_region.items():
        fitted = fit(returns_local, frame, region)
        out["fits"][region] = fitted.to_dict() if fitted else None

    primary = factors_by_region.get(primary_region)
    if primary is not None:
        out["rolling"] = rolling_loadings(returns_local, primary)

    # Shown for contrast only: the same regression on GBP returns, which mixes
    # the currency into every loading.
    if primary is not None:
        contaminated = fit(returns_gbp, primary, primary_region)
        out["gbp_translated_for_contrast"] = contaminated.to_dict() if contaminated else None

    return out
