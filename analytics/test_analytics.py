"""
Tests for the Python analytics half.

No database: every function here is pure over pandas objects, which is what
makes the statistical work checkable at all. Run with:

    python analytics/test_analytics.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))

import factors as factor_lib  # noqa: E402
import liquidity as liquidity_lib  # noqa: E402
import risk as risk_lib  # noqa: E402
import rrg as rrg_lib  # noqa: E402
import scenarios as scenario_lib  # noqa: E402
import structure as structure_lib  # noqa: E402
import var as var_lib  # noqa: E402

FAILURES: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  ok    {name}")
    else:
        FAILURES.append(f"{name}: {detail}")
        print(f"  FAIL  {name}  {detail}")


def close(a: float, b: float, tol: float = 1e-6) -> bool:
    return a is not None and b is not None and abs(a - b) <= tol


def series(values, start="2022-01-03") -> pd.Series:
    idx = pd.bdate_range(start=start, periods=len(values))
    return pd.Series(values, index=idx)


rng = np.random.default_rng(20240101)
N = 800
BENCH = series(rng.normal(0.0004, 0.010, N))
# A portfolio with a known beta of 1.3 and 8bp/day of true alpha.
PORT = series(0.0008 + 1.3 * BENCH.values + rng.normal(0, 0.004, N))


def test_risk() -> None:
    print("\nrisk.py")

    flat = series([0.0] * 100)
    check("zero-variance volatility is zero", close(risk_lib.annualised_volatility(flat), 0.0))

    doubling = series([0.01] * 252)
    expected = 1.01**252 - 1
    check(
        "annualised return compounds",
        close(risk_lib.annualised_return(doubling), expected, 1e-9),
        f"{risk_lib.annualised_return(doubling)} vs {expected}",
    )

    vol = risk_lib.annualised_volatility(BENCH)
    check("volatility scales by sqrt(252)", 0.13 < vol < 0.19, f"{vol}")

    # A ruinous path: -50% then flat. Depth, dates and recovery must all be right.
    path = series([0.0] * 10 + [-0.5] + [0.0] * 10)
    dd = risk_lib.max_drawdown(path)
    check("drawdown depth", close(dd.depth, -0.5, 1e-12), f"{dd.depth}")
    check("drawdown never recovers here", dd.recovered_date is None)

    recovering = series([0.0] * 5 + [-0.2] + [0.0] * 3 + [0.25] + [0.0] * 5)
    dd2 = risk_lib.max_drawdown(recovering)
    check("recovery is detected", dd2.recovered_date is not None, str(dd2))
    check("recovery takes a positive number of days", (dd2.recovery_days or 0) > 0)

    reg = risk_lib.regress(PORT, BENCH)
    check("regression runs", reg is not None)
    assert reg is not None
    check("beta recovers 1.3", close(reg.beta, 1.3, 0.06), f"{reg.beta}")

    # Alpha is asserted through its confidence interval rather than as a point
    # estimate, because that is the honest test. On this sample the point
    # estimate is 0.271 against a true 0.202 — 34% out, and 1.9 standard errors
    # from truth, with 800 observations. Beta over the same sample is accurate
    # to 1%. That asymmetry is exactly why §7.4 insists alpha is never displayed
    # as a bare number, and asserting a tight tolerance here would be asserting
    # a precision the estimator does not have.
    true_alpha = 0.0008 * 252
    check(
        "the reported 95% interval contains the true alpha",
        reg.alpha_ci95_low <= true_alpha <= reg.alpha_ci95_high,
        f"{reg.alpha_ci95_low:.4f}..{reg.alpha_ci95_high:.4f} excludes {true_alpha:.4f}",
    )
    check(
        "alpha is within 3 standard errors of truth",
        abs(reg.alpha_annualised - true_alpha) < 3 * reg.alpha_stderr_annualised,
        f"{abs(reg.alpha_annualised - true_alpha) / reg.alpha_stderr_annualised:.2f} se",
    )
    check(
        "alpha is estimated far less precisely than beta",
        (reg.alpha_stderr_annualised / abs(reg.alpha_annualised))
        > 10 * (reg.beta_stderr / abs(reg.beta)),
        "alpha is not meaningfully noisier than beta, which would be surprising",
    )
    check("standard errors are reported", reg.alpha_stderr_annualised > 0 and reg.beta_stderr > 0)
    check("R-squared is in [0,1]", 0 <= reg.r_squared <= 1, f"{reg.r_squared}")
    check(
        "the 95% interval brackets the point estimate",
        reg.alpha_ci95_low < reg.alpha_annualised < reg.alpha_ci95_high,
    )

    check(
        "a regression with too little data returns None rather than a number",
        risk_lib.regress(PORT.head(10), BENCH.head(10)) is None,
    )

    check(
        "tracking error against itself is zero",
        close(risk_lib.tracking_error(BENCH, BENCH), 0.0, 1e-12),
    )

    capture = risk_lib.up_down_capture(BENCH, BENCH)
    check("self-capture is 1.0 both ways", close(capture["up_capture"], 1.0, 1e-9) and close(capture["down_capture"], 1.0, 1e-9))

    pack = risk_lib.risk_pack(PORT, {"bench": BENCH})
    check("risk pack carries both estimate and uncertainty", pack["benchmarks"]["bench"]["regression"]["alpha_stderr_annualised"] > 0)
    check("rolling windows are present", "vol_252d" in pack["rolling"])


def test_var() -> None:
    print("\nvar.py")

    short = series(rng.normal(0, 0.01, 100))
    result = var_lib.var_pack(short, 100_000)
    check(
        "under a year of history is refused, not estimated",
        result["status"] == "insufficient_history",
        str(result.get("status")),
    )
    check("the refusal says how much history is needed", "252" in result["message"])

    long = series(rng.normal(0, 0.01, 600))
    pack = var_lib.var_pack(long, 100_000)
    check("a full year is accepted", pack["status"] == "ok")

    v95 = pack["methods"]["95"]["1d"]["var"]
    v99 = pack["methods"]["99"]["1d"]["var"]
    check("99% VaR exceeds 95%", v99["historical"]["fraction"] > v95["historical"]["fraction"])

    cvar95 = pack["methods"]["95"]["1d"]["cvar"]["historical"]["fraction"]
    check("expected shortfall exceeds VaR", cvar95 > v95["historical"]["fraction"])

    ten_day = pack["methods"]["95"]["10d"]["var"]["historical"]["fraction"]
    check(
        "10-day scales by sqrt(10)",
        close(ten_day, v95["historical"]["fraction"] * np.sqrt(10), 1e-9),
    )

    check(
        "VaR is expressed in pounds as well as fractions",
        close(v95["historical"]["gbp"], v95["historical"]["fraction"] * 100_000, 1e-6),
    )

    # On a normal sample the three methods should broadly agree.
    spread = abs(v95["parametric"]["fraction"] - v95["cornish_fisher"]["fraction"])
    check("Cornish-Fisher is near parametric on a normal sample", spread < 0.004, f"{spread}")

    # On a skewed one they should not.
    skewed = series(np.concatenate([rng.normal(0.002, 0.005, 580), rng.normal(-0.08, 0.02, 20)]))
    skewed_pack = var_lib.var_pack(skewed, 100_000)
    cf = skewed_pack["methods"]["99"]["1d"]["var"]["cornish_fisher"]["fraction"]
    para = skewed_pack["methods"]["99"]["1d"]["var"]["parametric"]["fraction"]
    check("Cornish-Fisher exceeds parametric on a fat left tail", cf > para, f"cf={cf} para={para}")

    # Component VaR must sum to the portfolio VaR.
    holdings = pd.DataFrame(
        {
            1: rng.normal(0, 0.012, 400),
            2: rng.normal(0, 0.020, 400),
            3: rng.normal(0, 0.008, 400),
        },
        index=pd.bdate_range("2023-01-02", periods=400),
    )
    weights = pd.Series({1: 0.5, 2: 0.3, 3: 0.2})
    comp = var_lib.component_var(holdings, weights, 100_000)
    check("component VaR runs", comp["status"] == "ok")
    check(
        "components sum to the portfolio VaR",
        close(comp["sum_of_components"], comp["portfolio_var"], 1e-9),
        f"{comp['sum_of_components']} vs {comp['portfolio_var']}",
    )
    check(
        "shares of risk sum to 1",
        close(sum(p["share_of_var"] for p in comp["positions"]), 1.0, 1e-9),
    )
    check(
        "the most volatile holding is not automatically the largest risk share",
        comp["positions"][0]["instrument_id"] in (1, 2),
    )


def test_structure() -> None:
    print("\nstructure.py")

    base = rng.normal(0, 0.01, 400)
    frame = pd.DataFrame(
        {
            1: base + rng.normal(0, 0.001, 400),  # tightly coupled to 2
            2: base + rng.normal(0, 0.001, 400),
            3: rng.normal(0, 0.01, 400),  # independent
        },
        index=pd.bdate_range("2023-01-02", periods=400),
    )

    corr = structure_lib.correlation_matrix(frame)
    check("1 and 2 are highly correlated", corr.loc[1, 2] > 0.9, f"{corr.loc[1, 2]}")
    check("3 is not", abs(corr.loc[1, 3]) < 0.2, f"{corr.loc[1, 3]}")

    order = structure_lib.cluster_order(corr)
    check("clustering puts the coupled pair adjacent", abs(order.index(1) - order.index(2)) == 1, str(order))

    conc = structure_lib.concentration(pd.Series({1: 0.5, 2: 0.3, 3: 0.2}))
    check("HHI", close(conc["hhi"], 0.38, 1e-12), str(conc["hhi"]))
    check("effective N", close(conc["effective_n"], 1 / 0.38, 1e-9))

    equal = structure_lib.concentration(pd.Series({i: 0.1 for i in range(10)}))
    check("ten equal weights give an effective N of 10", close(equal["effective_n"], 10.0, 1e-9))

    pca = structure_lib.principal_components(frame)
    check("PCA runs", pca["status"] == "ok")
    check(
        "the first component dominates when two of three names are one bet",
        pca["explained_variance_ratio"][0] > 0.5,
        str(pca["explained_variance_ratio"][:1]),
    )

    rolling = structure_lib.rolling_average_pairwise_correlation(frame, window=63)
    check("rolling correlation produces a series", rolling["status"] == "ok" and len(rolling["values"]) > 0)


def test_rrg() -> None:
    print("\nrrg.py")

    idx = pd.bdate_range("2022-01-03", periods=500)
    bench = pd.Series(100 * np.cumprod(1 + rng.normal(0.0003, 0.008, 500)), index=idx)
    # A name that steadily outperforms must end up leading.
    leader = pd.Series(100 * np.cumprod(1 + rng.normal(0.0012, 0.008, 500)), index=idx)
    laggard = pd.Series(100 * np.cumprod(1 + rng.normal(-0.0006, 0.008, 500)), index=idx)

    frame = rrg_lib.build(
        pd.DataFrame({"LEAD": leader, "LAG": laggard}),
        bench,
        {"LEAD": "Leader", "LAG": "Laggard"},
    )
    check("RRG builds", frame["status"] == "ok")
    check("it uses weekly bars by default", frame["frequency"] == "weekly")

    by_key = {s["key"]: s for s in frame["series"]}
    check(
        "the outperformer sits on the right-hand side",
        by_key["LEAD"]["tail"][-1]["rs_ratio"] > 100,
        str(by_key["LEAD"]["tail"][-1]),
    )
    check(
        "the underperformer sits on the left",
        by_key["LAG"]["tail"][-1]["rs_ratio"] < 100,
        str(by_key["LAG"]["tail"][-1]),
    )
    check("tails are trimmed to the requested length", len(by_key["LEAD"]["tail"]) <= frame["tail_length"])
    check(
        "quadrant labels are consistent with the coordinates",
        all(
            s["quadrant"]
            == rrg_lib.quadrant(s["tail"][-1]["rs_ratio"], s["tail"][-1]["rs_momentum"])
            for s in frame["series"]
        ),
    )

    short = rrg_lib.build(
        pd.DataFrame({"X": leader.head(20)}), bench.head(20), {"X": "X"}
    )
    check("too little history is refused", short["status"] == "insufficient_history")


def test_scenarios() -> None:
    print("\nscenarios.py")

    idx = pd.bdate_range("2023-01-02", periods=400)
    market = pd.Series(rng.normal(0.0004, 0.010, 400), index=idx)
    holdings = pd.DataFrame(
        {1: 0.5 * market.values + rng.normal(0, 0.002, 400),
         2: 2.0 * market.values + rng.normal(0, 0.002, 400)},
        index=idx,
    )
    betas = scenario_lib.estimate_betas(holdings, market)
    check("beta of the defensive name", close(betas[1], 0.5, 0.06), f"{betas[1]}")
    check("beta of the aggressive name", close(betas[2], 2.0, 0.08), f"{betas[2]}")

    weights = pd.Series({1: 0.5, 2: 0.5})
    shock = scenario_lib.factor_shock(weights, betas, {"market": -0.20}, 100_000)
    expected = 0.5 * betas[1] * -0.20 + 0.5 * betas[2] * -0.20
    check("equity shock propagates through betas", close(shock["modelled_return"], expected, 1e-9))
    check("the result is labelled an estimate", "Estimate only" in shock["disclaimer"])

    # A weaker pound is a GAIN on a USD-denominated holding.
    fx_exposure = pd.Series({1: 1.0, 2: 0.0})
    weaker_gbp = scenario_lib.factor_shock(
        weights, betas, {"gbpusd": -0.10}, 100_000, fx_exposure=fx_exposure
    )
    check(
        "a falling pound helps the USD sleeve",
        weaker_gbp["modelled_return"] > 0,
        str(weaker_gbp["modelled_return"]),
    )

    stronger_gbp = scenario_lib.factor_shock(
        weights, betas, {"gbpusd": 0.10}, 100_000, fx_exposure=fx_exposure
    )
    check("and a rising pound hurts it", stronger_gbp["modelled_return"] < 0)

    pack = scenario_lib.scenario_pack(weights, holdings, market, 100_000)
    check("every preset shock is evaluated", len(pack["shocks"]) == len(scenario_lib.PRESET_SHOCKS))
    check("historical windows are attempted", len(pack["historical"]) == len(scenario_lib.HISTORICAL_WINDOWS))
    check(
        "windows with no benchmark history say so rather than returning zero",
        all(h["status"] in ("ok", "no_benchmark_history") for h in pack["historical"]),
    )


def test_liquidity() -> None:
    print("\nliquidity.py")

    volumes = {
        1: pd.Series([1_000_000] * 30),
        2: pd.Series([10_000] * 30),  # thin
    }
    holdings = [
        {"instrument_id": 1, "quantity": 10_000, "value_gbp": 500_000},
        {"instrument_id": 2, "quantity": 50_000, "value_gbp": 300_000},
    ]
    meta = {
        1: {"symbol": "BIG", "exchange_mic": "XNAS", "asset_class": "equity"},
        2: {"symbol": "SMALL", "exchange_mic": "XLON", "asset_class": "equity"},
    }

    pack = liquidity_lib.liquidity_pack(holdings, volumes, meta, 800_000)
    rows = {r["symbol"]: r for r in pack["positions"]}

    # 10,000 shares at 10% of 1,000,000 ADV = 0.1 days.
    check("liquid name exits in a fraction of a day", close(rows["BIG"]["days_to_liquidate"]["10pct"], 0.1, 1e-9))
    # 50,000 shares at 10% of 10,000 ADV = 50 days.
    check("thin name takes 50 days", close(rows["SMALL"]["days_to_liquidate"]["10pct"], 50.0, 1e-9))
    check("the thin name is flagged", rows["SMALL"]["flagged"] is True)
    check("the liquid one is not", rows["BIG"]["flagged"] is False)
    check("positions are ordered worst-first", pack["positions"][0]["symbol"] == "SMALL")
    check("higher participation is faster", rows["SMALL"]["days_to_liquidate"]["30pct"] < rows["SMALL"]["days_to_liquidate"]["10pct"])

    unknown = liquidity_lib.liquidity_pack(
        [{"instrument_id": 3, "quantity": 100, "value_gbp": 1000}], {}, {}, 1000
    )
    check("a position with no volume data is marked unknown, not zero", unknown["positions"][0]["unknown_liquidity"] is True)
    check("the caveat about daily-granularity ADV is carried", "daily-granularity" in pack["caveat"])


def test_factors() -> None:
    print("\nfactors.py")

    raw = "\n".join(
        [
            "This file was created by the Fama/French library.",
            "",
            ",Mkt-RF,SMB,HML,RMW,CMA,RF",
            "20240102,  0.50, -0.20,  0.10,  0.05, -0.03, 0.021",
            "20240103, -0.75,  0.30, -0.15,  0.02,  0.01, 0.021",
            "20240104,  1.20, -0.10,  0.25, -0.04,  0.06, 0.021",
            "",
            "  Annual Factors: January-December",
            ",Mkt-RF,SMB,HML,RMW,CMA,RF",
            "2024, 12.00, -3.00,  2.00,  1.00,  0.50, 5.300",
        ]
    )
    parsed = factor_lib._parse_french_csv(raw)
    check("only the daily block is parsed", len(parsed) == 3, str(len(parsed)))
    check(
        "percent is converted to decimal",
        close(float(parsed.iloc[0]["Mkt-RF"]), 0.005, 1e-12),
        str(parsed.iloc[0]["Mkt-RF"]),
    )
    check("the RF column survives", "RF" in parsed.columns)

    # A synthetic portfolio with known loadings.
    n = 500
    idx = pd.bdate_range("2022-01-03", periods=n)
    frame = pd.DataFrame(
        {
            "Mkt-RF": rng.normal(0.0004, 0.009, n),
            "SMB": rng.normal(0, 0.004, n),
            "HML": rng.normal(0, 0.004, n),
            "RMW": rng.normal(0, 0.003, n),
            "CMA": rng.normal(0, 0.003, n),
            "MOM": rng.normal(0, 0.005, n),
            "RF": np.full(n, 0.00008),
        },
        index=idx,
    )
    truth = {"Mkt-RF": 1.15, "SMB": 0.40, "HML": -0.25, "RMW": 0.0, "CMA": 0.0, "MOM": 0.30}
    ret = frame["RF"].copy()
    for factor, loading in truth.items():
        ret = ret + loading * frame[factor]
    ret = ret + rng.normal(0, 0.002, n)

    fitted = factor_lib.fit(pd.Series(ret, index=idx), frame, "US")
    check("the fit runs", fitted is not None)
    assert fitted is not None
    loadings = {l.factor: l.coefficient for l in fitted.loadings}
    for factor, expected in truth.items():
        check(f"{factor} loading recovers {expected}", close(loadings[factor], expected, 0.08), f"{loadings[factor]}")
    check("t-statistics are reported", all(l.tstat is not None for l in fitted.loadings))
    check("R-squared is high on a constructed portfolio", fitted.r_squared > 0.85, str(fitted.r_squared))

    rolled = factor_lib.rolling_loadings(pd.Series(ret, index=idx), frame, window=126)
    check("rolling loadings run", rolled["status"] == "ok")
    check("one loading series per factor", len(rolled["loadings"]) == 6)

    pack = factor_lib.factor_pack(pd.Series(ret, index=idx), pd.Series(ret, index=idx), {"US": frame})
    check("the currency caveat is carried in the payload", "local-currency" in pack["caveat"].lower())


def main() -> int:
    for test in (
        test_risk,
        test_var,
        test_structure,
        test_rrg,
        test_scenarios,
        test_liquidity,
        test_factors,
    ):
        test()

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILURES:")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("all analytics checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
