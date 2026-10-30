"""Actual JS hedge engine versus independent quadratic/grid calculations."""
from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import subprocess

import numpy as np
import pytest


ROOT = Path(__file__).resolve().parents[1]


def run(cases):
    source = """
const {hedgeModelBCompute} = require('./dashboard/hedge-optimizer.js');
const cases = JSON.parse(require('fs').readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(cases.map(c => hedgeModelBCompute(c.outlook,c.options))));
"""
    result = subprocess.run(["node", "-e", source], cwd=ROOT, input=json.dumps(cases),
                            text=True, capture_output=True, check=True, timeout=30)
    return json.loads(result.stdout)


def case(cov=None, carry=-1.0, **options):
    return {"outlook": {
        "active": True, "yield_pct": 4.0, "asof": "2026-09-30",
        "yield_asof": "2026-09-30", "duration_years": 8.0,
        "cost": {"mean_pct": carry, "source": "HP", "sign": "positive_received",
                 "unit": "pct_pa", "asof": "2026-09-30"},
        "risk": {"cov_unit": "decimal_return_squared", "labels": ["bond", "fx"],
                 "cov_annual": [[.0064, -.003], [-.003, .01]] if cov is None else cov},
        "sample": {"n_months": 120, "start": "2016-09-30", "end": "2026-08-31"},
        "sources": {"bond": "synthetic", "fx": "synthetic", "cost": "synthetic"},
    }, "options": options}


def quadratic(c, h, fx=None):
    h = np.asarray(h)
    C = np.array(c["outlook"]["risk"]["cov_annual"])
    exposure = np.column_stack([np.ones(h.size), 1-h.reshape(-1)])
    variance = np.einsum("ni,ij,nj->n", exposure, C, exposure)
    forecast = c["options"].get("fxPct", 0) if fx is None else fx
    mu = (4 + (1-h.reshape(-1))*forecast + h.reshape(-1)*c["outlook"]["cost"]["mean_pct"])/100
    ce = mu-c["options"].get("riskAversion", 5)*variance/2
    return variance, mu, ce


def test_dense_grid_global_optimum_and_units():
    rng = np.random.default_rng(431781)
    cases = []
    for _ in range(35):
        vol = rng.uniform(.01, .30, 2)
        rho = rng.uniform(-1, 1)
        C = np.diag(vol**2)
        C[0, 1] = C[1, 0] = np.prod(vol)*rho
        low, high = sorted(rng.uniform(0, 100, 2))
        cases.append(case(C.tolist(), carry=float(rng.uniform(-4, 4)),
                          fxPct=float(rng.uniform(-6, 6)), riskAversion=float(rng.uniform(.1, 80)),
                          minHedgePct=float(low), maxHedgePct=float(high)))
    for c, r in zip(cases, run(cases)):
        assert r["active"]
        lo, hi = c["options"]["minHedgePct"]/100, c["options"]["maxHedgePct"]/100
        grid = np.linspace(lo, hi, 100001)
        var, mu, ce = quadratic(c, grid)
        assert r["optimal"]["cePct"] / 100 >= ce.max()-1e-12
        assert (r["minVariance"]["volPct"]/100)**2 <= var.min()+1e-12
        for key in ("current", "minVariance", "optimal", "unhedged", "fullHedge"):
            point = r[key]
            v, mean, utility = quadratic(c, [point["hedgePct"]/100])
            assert point["meanPct"] == pytest.approx(mean[0]*100)
            assert point["volPct"] == pytest.approx(np.sqrt(max(0, v[0]))*100)
            assert point["cePct"] == pytest.approx(utility[0]*100)
        assert len(r["grid"]) == 101
        assert sum(p["feasible"] for p in r["grid"]) == sum(lo-1e-12 <= x/100 <= hi+1e-12 for x in range(101))


def test_hand_computed_cost_sign_and_natural_hedge():
    c = case()
    r = run([c])[0]
    assert r["minVariance"]["hedgePct"] == pytest.approx(70)
    assert r["optimal"]["hedgePct"] == pytest.approx(50)
    assert r["optimal"]["meanPct"] == pytest.approx(3.5)
    assert r["optimal"]["carryPct"] == pytest.approx(-.5)
    assert r["unhedged"]["meanPct"] == pytest.approx(4)
    assert r["fullHedge"]["meanPct"] == pytest.approx(3)
    # Negative bond/FX covariance creates a natural hedge, so full hedge can
    # increase total risk. This is the opposite of subtracting FX volatility.
    cushion = case([[.01, -.008], [-.008, .01]])
    out = run([cushion])[0]
    assert out["minVariance"]["hedgePct"] == pytest.approx(20)
    assert out["fullHedge"]["riskReductionPp"] < 0
    assert out["optimal"]["hedgePct"] == pytest.approx(0)


def test_fx_and_risk_aversion_sensitivity():
    base, higher_fx, larger_lambda, received = run([
        case(), case(fxPct=1), case(riskAversion=10), case(carry=1)])
    assert higher_fx["optimal"]["hedgePct"] < base["optimal"]["hedgePct"]
    assert larger_lambda["optimal"]["hedgePct"] > base["optimal"]["hedgePct"]
    assert received["optimal"]["hedgePct"] > base["optimal"]["hedgePct"]
    assert [r["fxPct"] for r in base["sensitivity"]] == [-2, -1, 0, 1, 2]
    assert all(a["hedgePct"] >= b["hedgePct"] for a, b in zip(base["sensitivity"], base["sensitivity"][1:]))
    for point in base["sensitivity"]:
        _, mean, ce = quadratic(case(), [point["hedgePct"]/100], point["fxPct"])
        assert point["meanPct"] == pytest.approx(mean[0]*100)
        assert point["cePct"] == pytest.approx(ce[0]*100)


@pytest.mark.parametrize("carry,fx,expected", [(-1, 0, 20), (1, 0, 80), (1, 1, 20)])
def test_zero_fx_variance_and_flat_ties(carry, fx, expected):
    r = run([case([[.0064, 0], [0, 0]], carry=carry, fxPct=fx, minHedgePct=20, maxHedgePct=80)])[0]
    assert r["active"] and r["meta"]["flatFxRisk"]
    assert not r["meta"]["minVarianceIdentified"]
    assert r["meta"]["optimalIdentified"] == (carry != fx)
    assert r["input"]["correlation"] is None
    assert r["optimal"]["hedgePct"] == pytest.approx(expected)
    assert r["minVariance"]["hedgePct"] == pytest.approx(20)
    assert all(p["volPct"] == pytest.approx(8) for p in r["grid"])


def test_bounds_fixed_and_outside_current_benchmark():
    r = run([case(minHedgePct=65, maxHedgePct=65, currentHedgePct=5)])[0]
    assert r["optimal"]["hedgePct"] == pytest.approx(65)
    assert r["minVariance"]["hedgePct"] == pytest.approx(65)
    assert r["optimal"]["boundary"] == "fixed"
    assert r["meta"]["minVarianceIdentified"]
    assert r["current"]["hedgePct"] == 5 and not r["current"]["feasible"]


@pytest.mark.parametrize("options", [None, [], {"riskAversion": 0}, {"riskAversion": -1},
    {"riskAversion": 101}, {"riskAversion": "5"}, {"fxPct": None}, {"fxPct": 51},
    {"minHedgePct": 80, "maxHedgePct": 70}, {"maxHedgePct": 101}, {"minHedgePct": -1},
    {"currentHedgePct": 101}, {"currentHedgePct": -1}])
def test_invalid_options(options):
    c = case()
    c["options"] = options
    r = run([c])[0]
    assert r["active"] is False and r["reason"]


@pytest.mark.parametrize("C", [[], [[1, 2], [2, 1]], [[1, .1], [.2, 1]],
    [[-1, 0], [0, 1]], [[1, 0], [0, -1]], [[1, None], [None, 1]],
    [[1, "0"], ["0", 1]], [[1, 0, 0], [0, 1, 0]], [[1e-20, 2e-20], [2e-20, 1e-20]]])
def test_invalid_covariance(C):
    r = run([case(C)])[0]
    assert r["active"] is False and r["reason"]


def test_roundoff_at_psd_boundary_and_zero_covariance():
    cases = [case([[.01, -.01*(1+1e-14)], [-.01*(1+1e-14), .01]]),
             case([[0, 0], [0, 0]], carry=0)]
    boundary, zero = run(cases)
    assert boundary["active"] and boundary["unhedged"]["volPct"] == 0
    assert boundary["input"]["correlation"] == -1
    assert zero["active"] and zero["optimal"]["hedgePct"] == 0
    assert all(p["volPct"] == 0 for p in zero["grid"])


def test_missing_data_metadata_and_no_mutation():
    base = case()
    variants = []
    for path, value in [(('active',), False), (('yield_pct',), None),
                        (('cost', 'source'), 'proxy'), (('cost', 'sign'), 'positive_paid'),
                        (('cost', 'unit'), 'bp'), (('sample', 'n_months'), 35),
                        (('risk', 'labels'), ['fx', 'bond']), (('risk', 'cov_unit'), 'pct_squared')]:
        c = deepcopy(base)
        target = c['outlook']
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = value
        variants.append(c)
    variants += [{"outlook": None}, {"outlook": {}}]
    assert all(not r['active'] and r['reason'] for r in run(variants))
    script = """
const {hedgeModelBCompute} = require('./dashboard/hedge-optimizer.js');
const c = JSON.parse(require('fs').readFileSync(0,'utf8'));
const before=JSON.stringify(c); const r=hedgeModelBCompute(c.outlook,c.options);
if (before!==JSON.stringify(c) || !r.active) process.exit(1);
for(const value of [NaN,Infinity,-Infinity,undefined]) {
 if(hedgeModelBCompute(c.outlook,{fxPct:value}).active) process.exit(2);
}
"""
    subprocess.run(["node", "-e", script], cwd=ROOT, input=json.dumps(base), text=True, check=True)
