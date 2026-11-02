"""Independent empirical-CVaR variational oracle for the browser C policy.

The oracle minimizes Rockafellar-Uryasev's scalar threshold expression instead
of sorting tail observations as the production aggregator does. No private data.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
import subprocess

import numpy as np
import pandas as pd
import pytest

from hedge_tail import build_tail_risk


ROOT = Path(__file__).resolve().parents[1]


def _run(cases):
    code = """
const {hedgeModelCCompute} = require('./dashboard/hedge-tail-optimizer.js');
const cases=JSON.parse(require('fs').readFileSync(0,'utf8'));
const before=JSON.stringify(cases);
const out=cases.map(c=>hedgeModelCCompute(c.outlook,c.options));
if(JSON.stringify(cases)!==before) throw Error('mutated input');
console.log(JSON.stringify(out));
"""
    result = subprocess.run(["node", "-e", code], input=json.dumps(cases),
                            text=True, capture_output=True, cwd=ROOT,
                            check=True, timeout=30)
    return json.loads(result.stdout)


def _es(loss):
    # A minimum lies at an observed loss; repeated thresholds are harmless.
    return min(float(eta + np.maximum(loss - eta, 0).mean() / .05) for eta in loss)


def _case(shocks, *, y=4., carry=-1., options=None):
    frame = pd.DataFrame(shocks, columns=["bond", "fx"],
                         index=pd.date_range(end="2026-09-30", periods=len(shocks), freq="ME"))
    tail = build_tail_risk(frame, yield_pct=y, carry_pct=carry, asof="2026-10-31")
    return {"outlook": {"active": True, "asof": "2026-10-31", "yield_pct": y,
            "cost": {"source": "HP", "sign": "positive_received", "unit": "pct_pa", "mean_pct": carry},
            "tail_risk": tail}, "options": options or {}}


def _oracle(shocks, y, carry, options):
    settings = {"currentHedgePct": 50, "minHedgePct": 0, "maxHedgePct": 100,
                "maxTurnoverPp": 100, "tradeCostBps": 10, "carryStressPp": 0, **options}
    centered = [s - s.mean(axis=0) for s in [shocks, shocks[-120:]]]
    output = []
    for percentage in range(101):
        h = percentage / 100
        cost = abs(h - settings["currentHedgePct"] / 100) * settings["tradeCostBps"] / 100
        means = (y + h * (carry - settings["carryStressPp"])) / 12
        losses = [-(means + (s[:, 0] + (1 - h) * s[:, 1]) * 100) for s in centered]
        es = [_es(loss) for loss in losses]
        allowed = (settings["minHedgePct"] <= percentage <= settings["maxHedgePct"] and
                   abs(percentage - settings["currentHedgePct"]) <= settings["maxTurnoverPp"])
        output.append((max(es) + cost, percentage, cost, es, allowed))
    feasible = [row for row in output if row[-1]]
    minimum = min(row[0] for row in feasible)
    candidates = [row for row in feasible if row[0] <= minimum + 1e-10 * max(1, abs(minimum))]
    selected = min(candidates, key=lambda row: (abs(row[1] - settings["currentHedgePct"]), row[1]))
    return output, selected


def test_policy_matches_variational_cvar_and_costs_on_noninteger_tail_mass():
    rng = np.random.default_rng(12872)
    cases, histories, settings = [], [], []
    for i in range(5):
        x = rng.standard_t(4, size=(123 + i * 7, 2)) @ np.array([[.011, -.006], [.003, .015]])
        # Heavy joint tails and non-integer full-window tail mass.
        x[0] += [-.13, .10]
        options = {"currentHedgePct": 40, "minHedgePct": 10, "maxHedgePct": 90,
                   "maxTurnoverPp": 35, "tradeCostBps": 10 + i * 21,
                   "carryStressPp": i * .7}
        y, carry = 2 + i, -2 + i * .5
        cases.append(_case(x, y=y, carry=carry, options=options))
        histories.append(x); settings.append((y, carry, options))
    for x, params, result in zip(histories, settings, _run(cases), strict=True):
        expected, selected = _oracle(x, *params)
        assert result["active"] and result["optimal"]["hedgePct"] == selected[1]
        assert result["optimal"]["objectivePct"] == pytest.approx(selected[0])
        for actual, reference in zip(result["grid"], expected, strict=True):
            assert actual["objectivePct"] == pytest.approx(reference[0])
            assert actual["tradeCostPct"] == pytest.approx(reference[2])
            assert actual["fullEsPct"] == pytest.approx(reference[3][0])
            assert actual["recentEsPct"] == pytest.approx(reference[3][1])
            assert actual["feasible"] is reference[4]


def test_adjustment_cost_deadband_and_carry_stress_direction():
    # No shocks: a positive carry favors 100%; a sufficiently large one-off
    # rehedging fee makes keeping 50% optimal. The fee is not divided by 12.
    x = np.zeros((120, 2))
    no_fee = _case(x, carry=1.2, options={"tradeCostBps": 0})
    fee = _case(x, carry=1.2, options={"tradeCostBps": 100})
    bad_carry = _case(x, carry=1.2, options={"tradeCostBps": 0, "carryStressPp": 2.4})
    a, b, c = _run([no_fee, fee, bad_carry])
    assert a["optimal"]["hedgePct"] == 100
    assert b["optimal"]["hedgePct"] == 50
    assert b["fullHedge"]["tradeCostPct"] == .5
    assert c["optimal"]["hedgePct"] == 0
    assert c["fullHedge"]["fullEsPct"] - a["fullHedge"]["fullEsPct"] == pytest.approx(.2)
    assert a["fullHedge"]["fullEsPct"] < 0, "negative ES is not clipped to zero"


def test_same_covariance_different_tail_shape_changes_c_policy():
    rng = np.random.default_rng(5013)

    def whiten(x):
        x = x - x.mean(axis=0)
        return x @ np.linalg.inv(np.linalg.cholesky(np.cov(x, rowvar=False))).T

    gaussian = whiten(rng.normal(size=(120, 2)))
    skewed = gaussian.copy()
    skewed[:6] += [7, -6]
    skewed = whiten(skewed)
    transformation = np.array([[.02, 0], [-.015, .015]])
    gaussian, skewed = [x @ transformation.T for x in [gaussian, skewed]]
    assert np.cov(gaussian, rowvar=False) == pytest.approx(np.cov(skewed, rowvar=False))
    assert gaussian.mean(0) == pytest.approx(skewed.mean(0), abs=1e-15)
    a, b = _run([_case(x, carry=0, options={"tradeCostBps": 0}) for x in [gaussian, skewed]])
    assert abs(a["optimal"]["hedgePct"] - b["optimal"]["hedgePct"]) >= 20
    assert a["meta"]["statisticalOrthogonality"] == "unverified"


def test_ties_feasible_boundaries_and_turnover_constraint():
    x = np.zeros((120, 2))
    flat = _case(x, carry=0, options={"tradeCostBps": 0, "currentHedgePct": 37})
    fixed = _case(x, carry=-1, options={"minHedgePct": 60, "maxHedgePct": 60})
    limited = _case(x, carry=1, options={"maxTurnoverPp": 7, "tradeCostBps": 0})
    a, b, c = _run([flat, fixed, limited])
    assert a["optimal"]["hedgePct"] == 37 and a["tieCount"] == 101 and not a["identified"]
    assert b["optimal"]["hedgePct"] == 60 and b["identified"]
    assert not b["current"]["feasible"]
    assert c["optimal"]["hedgePct"] == 57


def test_invalid_contracts_options_and_inactive_inputs_fail_closed():
    base = _case(np.zeros((120, 2)))
    cases = []
    for options in [None, [], {"currentHedgePct": 20.1}, {"tradeCostBps": -1},
                    {"carryStressPp": 21}, {"minHedgePct": 90, "maxHedgePct": 20},
                    {"currentHedgePct": 20, "minHedgePct": 90, "maxTurnoverPp": 5}]:
        case = copy.deepcopy(base); case["options"] = options; cases.append(case)
    changes = [
        lambda o: o.update(active=False),
        lambda o: o["cost"].update(sign="positive_paid"),
        lambda o: o.pop("tail_risk"),
        lambda o: o["tail_risk"].update(asof="2026-11-01"),
        lambda o: o["tail_risk"].update(confidence=.975),
        lambda o: o["tail_risk"].update(unit="annual_loss_pct"),
        lambda o: o["tail_risk"]["recent"].update(n_months=119),
        lambda o: o["tail_risk"]["full"].update(tail_mass=5),
        lambda o: o["tail_risk"]["full"].update(start="2026-02-30"),
        lambda o: o["tail_risk"]["recent"].update(end="2026-10-31"),
        lambda o: o["tail_risk"]["grid"].pop(),
        lambda o: o["tail_risk"]["grid"][3].update(hedge_pct=4),
        lambda o: o["tail_risk"]["grid"][3].update(full_es_pct=None),
        lambda o: o["tail_risk"]["grid"][3].update(robust_es_pct=1e8),
    ]
    for change in changes:
        case = copy.deepcopy(base); change(case["outlook"]); cases.append(case)
    for result in _run(cases):
        assert not result["active"] and result["reason"]
