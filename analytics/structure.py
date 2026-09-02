"""
Correlation structure and concentration (CLAUDE.md §7.8).

Weight tables show what you own. This shows what you are actually betting on.
Ten positions across five sectors that all load on the same factor are one bet,
and only the correlation matrix — read in cluster order — makes that visible.

PCA is included for the same reason: if the first principal component explains
70% of the variance, the portfolio has one dominant driver whatever the sector
table says.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
from scipy.cluster.hierarchy import leaves_list, linkage
from scipy.spatial.distance import squareform


def correlation_matrix(returns: pd.DataFrame, min_observations: int = 60) -> pd.DataFrame:
    usable = returns.dropna(axis=1, thresh=min_observations)
    return usable.corr(min_periods=min_observations)


def cluster_order(corr: pd.DataFrame) -> list[Any]:
    """
    Average-linkage clustering on distance = 1 - correlation.

    Rendering the heatmap in this order turns mutually correlated groups into
    visible blocks on the diagonal, which is the only way a 30x30 matrix is
    readable by a human.
    """
    if corr.empty or len(corr) < 3:
        return list(corr.columns)
    clean = corr.fillna(0.0).clip(-1, 1)
    distance = 1 - clean.values
    np.fill_diagonal(distance, 0.0)
    distance = (distance + distance.T) / 2  # enforce exact symmetry
    linked = linkage(squareform(distance, checks=False), method="average")
    return [corr.columns[i] for i in leaves_list(linked)]


def rolling_average_pairwise_correlation(
    returns: pd.DataFrame, window: int = 63
) -> dict[str, Any]:
    """
    Average pairwise correlation through time. It rises in stress — the moment
    diversification stops working is exactly the moment it matters.
    """
    usable = returns.dropna(axis=1, how="all")
    if usable.shape[1] < 2 or len(usable) < window:
        return {"status": "insufficient_history", "observations": int(len(usable))}

    dates: list[str] = []
    values: list[float] = []
    n = usable.shape[1]

    for end in range(window, len(usable) + 1):
        chunk = usable.iloc[end - window : end]
        corr = chunk.corr()
        upper = corr.values[np.triu_indices(n, k=1)]
        upper = upper[~np.isnan(upper)]
        if upper.size == 0:
            continue
        dates.append(str(chunk.index[-1])[:10])
        values.append(float(upper.mean()))

    return {
        "status": "ok",
        "window": window,
        "dates": dates,
        "values": values,
        "latest": values[-1] if values else None,
    }


def principal_components(returns: pd.DataFrame, components: int = 5) -> dict[str, Any]:
    usable = returns.dropna(axis=1, how="any")
    if usable.shape[1] < 3 or len(usable) < 60:
        return {"status": "insufficient_history"}

    standardised = (usable - usable.mean()) / usable.std(ddof=1).replace(0, np.nan)
    standardised = standardised.dropna(axis=1, how="any")
    if standardised.shape[1] < 3:
        return {"status": "insufficient_history"}

    covariance = np.cov(standardised.values, rowvar=False)
    eigenvalues, eigenvectors = np.linalg.eigh(covariance)
    order = np.argsort(eigenvalues)[::-1]
    eigenvalues = eigenvalues[order]
    eigenvectors = eigenvectors[:, order]

    total = float(eigenvalues.sum())
    keep = min(components, len(eigenvalues))

    return {
        "status": "ok",
        "instruments": [str(c) for c in standardised.columns],
        "explained_variance_ratio": [float(v / total) for v in eigenvalues[:keep]],
        "cumulative_explained": [
            float(eigenvalues[: i + 1].sum() / total) for i in range(keep)
        ],
        "loadings": [
            {
                "component": i + 1,
                "explained": float(eigenvalues[i] / total),
                "weights": {
                    str(col): float(eigenvectors[j, i])
                    for j, col in enumerate(standardised.columns)
                },
            }
            for i in range(keep)
        ],
        "interpretation": (
            "A first component explaining more than about half the variance means the portfolio "
            "has one dominant driver, whatever the sector table shows."
        ),
    }


def concentration(weights: pd.Series) -> dict[str, Any]:
    w = weights[weights > 0].sort_values(ascending=False)
    if w.empty:
        return {"hhi": None, "effective_n": None, "top1": None, "top5": None, "top10": None}
    hhi = float((w**2).sum())
    return {
        "hhi": hhi,
        "effective_n": float(1 / hhi) if hhi > 0 else None,
        "top1": float(w.iloc[:1].sum()),
        "top5": float(w.iloc[:5].sum()),
        "top10": float(w.iloc[:10].sum()),
        "count": int(len(w)),
    }


def structure_pack(returns: pd.DataFrame, weights: pd.Series) -> dict[str, Any]:
    corr = correlation_matrix(returns)
    order = cluster_order(corr)

    return {
        "concentration": concentration(weights),
        "correlation": {
            "instruments": [str(c) for c in corr.columns],
            "cluster_order": [str(c) for c in order],
            "matrix": [
                [None if pd.isna(v) else float(v) for v in corr.loc[row].values]
                for row in corr.index
            ],
            "average_pairwise": float(
                np.nanmean(corr.values[np.triu_indices(len(corr), k=1)])
            )
            if len(corr) > 1
            else None,
        },
        "rolling_correlation": rolling_average_pairwise_correlation(returns),
        "pca": principal_components(returns),
    }
