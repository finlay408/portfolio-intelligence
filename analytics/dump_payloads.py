"""
Emit one of every analytics payload from synthetic data.

    python analytics/dump_payloads.py --out .scratch/payloads.json

This is the contract between the two runtimes. The Python job writes these
shapes into `analytics_snapshots`; the risk and rotation pages read them. Both
sides are hand-written, so nothing but an actual round trip proves they agree —
`npm run load-payloads` takes this file and writes it to the database, and the
pages then render real Python output.

It is also the fastest way to see what the risk screens will look like before
the portfolio has enough history for the real job to produce anything.
"""

from __future__ import annotations

import argparse
import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))

import factors as factor_lib  # noqa: E402
import jsonio  # noqa: E402
import liquidity as liquidity_lib  # noqa: E402
import risk as risk_lib  # noqa: E402
import rrg as rrg_lib  # noqa: E402
import scenarios as scenario_lib  # noqa: E402
import structure as structure_lib  # noqa: E402
import var as var_lib  # noqa: E402


def build(instrument_ids: list[int], portfolio_value: float, seed: int = 7) -> dict[str, dict]:
    rng = np.random.default_rng(seed)
    n = 700
    idx = pd.bdate_range(end=pd.Timestamp.today().normalize(), periods=n)

    market = pd.Series(rng.normal(0.0004, 0.010, n), index=idx)
    betas = np.linspace(0.6, 1.8, len(instrument_ids))
    holdings = pd.DataFrame(
        {
            inst: betas[i] * market.values + rng.normal(0, 0.006, n)
            for i, inst in enumerate(instrument_ids)
        },
        index=idx,
    )

    raw = rng.random(len(instrument_ids)) + 0.4
    weights = pd.Series(raw / raw.sum(), index=instrument_ids)
    portfolio = (holdings * weights).sum(axis=1)

    fx = pd.Series(rng.normal(0, 0.0035, n), index=idx)
    benchmarks = {
        "SPX_gbp": market + fx,
        "SPX_local": market,
        "FTSE100_gbp": pd.Series(rng.normal(0.0002, 0.008, n), index=idx),
    }

    prices = pd.DataFrame(
        {inst: 100 * (1 + holdings[inst]).cumprod() for inst in instrument_ids}, index=idx
    )
    bench_prices = pd.Series(100 * (1 + market).cumprod(), index=idx)

    factor_frame = pd.DataFrame(
        {
            "Mkt-RF": market.values,
            "SMB": rng.normal(0, 0.004, n),
            "HML": rng.normal(0, 0.004, n),
            "RMW": rng.normal(0, 0.003, n),
            "CMA": rng.normal(0, 0.003, n),
            "MOM": rng.normal(0, 0.005, n),
            "RF": np.full(n, 0.00008),
        },
        index=idx,
    )

    volumes = {
        inst: pd.Series(rng.integers(20_000, 4_000_000, 60).astype(float))
        for inst in instrument_ids
    }
    holding_rows = [
        {
            "instrument_id": inst,
            "quantity": float(1000 * (i + 1)),
            "value_gbp": float(weights[inst] * portfolio_value),
        }
        for i, inst in enumerate(instrument_ids)
    ]
    meta = {
        inst: {"symbol": f"INS{inst}", "exchange_mic": "XLON" if i % 2 else "XNAS", "asset_class": "equity"}
        for i, inst in enumerate(instrument_ids)
    }

    var_payload = var_lib.var_pack(portfolio, portfolio_value)
    var_payload["component"] = var_lib.component_var(holdings, weights, portfolio_value)

    fx_exposure = pd.Series({inst: 1.0 if i % 2 == 0 else 0.0 for i, inst in enumerate(instrument_ids)})

    return {
        "risk": risk_lib.risk_pack(portfolio, benchmarks),
        "var": var_payload,
        "structure": structure_lib.structure_pack(holdings, weights),
        "factor": factor_lib.factor_pack(portfolio, portfolio, {"US": factor_frame}),
        "rrg": rrg_lib.build(prices, bench_prices, {i: f"INS{i}" for i in instrument_ids}),
        "scenario": scenario_lib.scenario_pack(
            weights, holdings, market, portfolio_value, fx_exposure
        ),
        "liquidity": liquidity_lib.liquidity_pack(holding_rows, volumes, meta, portfolio_value),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=".scratch/payloads.json")
    parser.add_argument("--instruments", default="1,2,3,4,5,6")
    parser.add_argument("--account", type=int, default=1)
    parser.add_argument("--value", type=float, default=57_455.0)
    parsed = parser.parse_args()

    instrument_ids = [int(x) for x in parsed.instruments.split(",") if x.strip()]
    payloads = build(instrument_ids, parsed.value)

    out = Path(parsed.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        jsonio.dumps(
            {
                "account_id": parsed.account,
                "snap_date": date.today().isoformat(),
                "synthetic": True,
                "payloads": payloads,
            },
            indent=1,
        ),
        encoding="utf-8",
    )
    print(f"wrote {out} ({out.stat().st_size // 1024} KB): {', '.join(payloads)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
