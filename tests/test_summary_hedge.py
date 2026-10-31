"""Quarterly hedged returns versus independent exposure algebra and a dense grid."""
from __future__ import annotations

import json
from pathlib import Path
from statistics import NormalDist
import subprocess

import numpy as np
import pytest


ROOT = Path(__file__).resolve().parents[1]


def run(cases):
    source = """
const {summaryHedgeModels} = require('./dashboard/summary-hedge.js');
const cases = JSON.parse(require('fs').readFileSync(0, 'utf8'));
console.log(JSON.stringify(cases.map(c => summaryHedgeModels(c.payload, c.options, c.market,
  new Date(c.nowDate || '2026-11-01T00:00:00Z')))));
"""
    result = subprocess.run(["node", "-e", source], cwd=ROOT, input=json.dumps(cases),
                            capture_output=True, text=True, check=True, timeout=30)
    return json.loads(result.stdout)


def test_summary_hedge_adapter_boundaries():
    result = subprocess.run(["node", "tests/summary_hedge_probe.js"], cwd=ROOT,
                            capture_output=True, text=True, check=True, timeout=30)
    assert all(json.loads(result.stdout).values())


def test_quarterly_values_independent_distribution_and_optimization():
    rng = np.random.default_rng(761920)
    cases = []
    for _ in range(20):
        vol = rng.uniform(.01, .30, 2)
        correlation = rng.uniform(-.99, .99)
        covariance = np.diag(vol ** 2)
        covariance[0, 1] = covariance[1, 0] = np.prod(vol) * correlation
        lower, upper = sorted(rng.uniform(0, 100, 2))
        outlook = {"active": True, "asof": "2026-10-31", "yield_pct": float(rng.uniform(-2, 8)),
                   "cost": {"mean_pct": float(rng.uniform(-4, 4)), "source": "HP",
                            "sign": "positive_received", "unit": "pct_pa"},
                   "sample": {"n_months": 120},
                   "risk": {"cov_unit": "decimal_return_squared", "labels": ["bond", "fx"],
                            "cov_annual": covariance.tolist()}}
        options = {"riskAversion": float(rng.uniform(.1, 50)), "fxPct": float(rng.uniform(-6, 6)),
                   "minHedgePct": float(lower), "maxHedgePct": float(upper)}
        cases.append({"payload": {"bond_analytics": {"UST": {"outlook": outlook}}},
                      "options": {"UST": options}, "market": "UST"})
    quantile = NormalDist().inv_cdf(.975)
    for case, actual in zip(cases, run(cases), strict=True):
        outlook = case["payload"]["bond_analytics"]["UST"]["outlook"]
        settings = case["options"]["UST"]
        covariance = np.array(outlook["risk"]["cov_annual"])
        grid = np.linspace(settings["minHedgePct"] / 100, settings["maxHedgePct"] / 100, 100001)
        exposures = np.column_stack([np.ones(grid.size), 1 - grid])
        grid_variance = np.einsum("ni,ij,nj->n", exposures, covariance, exposures)
        grid_mean = (outlook["yield_pct"] + (1-grid)*settings["fxPct"]
                     + grid*outlook["cost"]["mean_pct"]) / 100
        grid_ce = grid_mean - settings["riskAversion"] * grid_variance / 2
        for model in actual:
            assert model["active"]
            ratio = model["hedgePct"] / 100
            exposure = np.array([1, 1-ratio])
            variance = exposure @ covariance @ exposure
            annual_mean = (outlook["yield_pct"] + (1-ratio)*settings["fxPct"]
                           + ratio*outlook["cost"]["mean_pct"])
            if model["key"] == "modelA":
                assert ratio == 1
            elif model["key"] == "modelB":
                assert annual_mean/100 - settings["riskAversion"]*variance/2 >= grid_ce.max()-1e-12
            else:
                assert variance <= grid_variance.min()+1e-12
            for row in model["rows"]:
                years = row["horizonMonths"] / 12
                mean = annual_mean * years
                sd = np.sqrt(variance * years) * 100
                assert row["meanPct"] == pytest.approx(mean)
                assert row["volPct"] == pytest.approx(sd)
                assert row["lower95"] == pytest.approx(mean - quantile*sd)
                assert row["upper95"] == pytest.approx(mean + quantile*sd)
                assert row["var975Pct"] == pytest.approx(max(0, quantile*sd - mean))
                assert row["carryPct"] == pytest.approx(ratio*outlook["cost"]["mean_pct"]*years)
                assert NormalDist(mean, sd).cdf(row["lower95"]) == pytest.approx(.025)


def test_cost_sign_natural_hedge_and_cumulative_not_annualized():
    def case(carry):
        return {"payload": {"bond_analytics": {"UST": {"outlook": {
            "active": True, "asof": "2026-10-31", "yield_pct": 4,
            "cost": {"mean_pct": carry, "source": "HP", "sign": "positive_received", "unit": "pct_pa"},
            "sample": {"n_months": 120},
            "risk": {"cov_unit": "decimal_return_squared", "labels": ["bond", "fx"],
                     "cov_annual": [[.01, -.008], [-.008, .01]]},
        }}}}, "options": {}, "market": "UST"}
    paid, received = run([case(-1), case(1)])
    assert paid[0]["rows"][0]["meanPct"] == .75
    assert paid[0]["rows"][-1]["meanPct"] == 3
    assert received[0]["rows"][0]["meanPct"] == 1.25
    assert received[0]["rows"][-1]["meanPct"] == 5
    assert paid[2]["hedgePct"] == pytest.approx(20)
    assert paid[2]["annualVolPct"] < paid[0]["annualVolPct"]
    assert paid[0]["rows"][-1]["volPct"] == pytest.approx(2*paid[0]["rows"][0]["volPct"])
