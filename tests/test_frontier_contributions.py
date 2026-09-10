"""Portfolio hover contributions against moments and finite-difference risk changes."""
from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess

import numpy as np
import pytest


@pytest.fixture(scope="module")
def contributions_js():
    node = shutil.which("node")
    assert node, "Node.js is required to execute portfolio contributions"
    source = (Path(__file__).resolve().parents[1] / "dashboard" / "app.js").read_text(encoding="utf-8")
    start = source.index("function portContributionBreakdown(")
    end = source.index("\nfunction ", start + 1)
    helpers = "\n".join(line for line in source.splitlines()
                        if line.startswith(("function amDot(", "function amMv(")))
    script = helpers + "\n" + source[start:end] + """
const cases = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(cases.map(c => portContributionBreakdown(c.w, c.mu, c.C))));
"""

    def run(cases):
        result = subprocess.run([node, "-e", script], input=json.dumps(cases), text=True,
                                capture_output=True, check=True, timeout=10)
        return json.loads(result.stdout)

    return run


def _case(w, mu, C):
    return {"w": np.asarray(w).tolist(), "mu": np.asarray(mu).tolist(), "C": np.asarray(C).tolist()}


def test_component_sums_match_portfolio_mean_and_volatility(contributions_js):
    rng = np.random.default_rng(190926)
    cases = [_case([.6, .4], [4., 8.], [[100., 50.], [50., 400.]])]
    for _ in range(8):
        loadings = rng.normal(size=(6, 6))
        C = loadings @ loadings.T + np.eye(6)
        cases.append(_case(rng.dirichlet(np.ones(6)), rng.uniform(-5, 12, 6), C))
    for case, got in zip(cases, contributions_js(cases)):
        w, mu, C = (np.asarray(case[key]) for key in ("w", "mu", "C"))
        mean, risk = float(w @ mu), float(np.linalg.norm(np.linalg.cholesky(C).T @ w))
        assert got["mu"] == pytest.approx(mean, abs=1e-11)
        assert got["sig"] == pytest.approx(risk, abs=1e-11)
        assert got["returnPp"] == pytest.approx(w * mu, abs=1e-11)
        assert sum(got["returnPp"]) == pytest.approx(mean, abs=1e-11)
        assert sum(got["riskPp"]) == pytest.approx(risk, abs=1e-11)
        assert sum(got["returnPct"]) == pytest.approx(100, abs=1e-9)
        assert sum(got["riskPct"]) == pytest.approx(100, abs=1e-9)
        assert got["returnPct"] == pytest.approx(100 * w * mu / mean, abs=1e-9)
        assert got["riskPct"] == pytest.approx(100 * np.asarray(got["riskPp"]) / risk, abs=1e-9)
        # Independent perturbation path: do not renormalize w, since Euler
        # contributions use the unconstrained derivative of the risk function.
        step = 1e-6
        marginal = []
        for direction in np.eye(len(w)):
            upper, lower = w + step * direction, w - step * direction
            marginal.append((np.sqrt(upper @ C @ upper) - np.sqrt(lower @ C @ lower)) / (2 * step))
        assert got["riskPp"] == pytest.approx(w * marginal, abs=1e-8)


def test_contributions_preserve_negative_returns_and_hedging_risk(contributions_js):
    cases = [
        _case([.25, .75], [-8., 4.], [[100., 0.], [0., 400.]]),
        _case([.75, .25], [-8., 2.], [[100., 0.], [0., 400.]]),
        _case([.2, .8], [4., 8.], [[100., -180.], [-180., 400.]]),
    ]
    mixed, negative, hedge = contributions_js(cases)
    assert mixed["returnPp"] == [-2., 3.]
    assert mixed["returnPct"] == [-200., 300.]
    assert negative["mu"] == -5.5
    assert negative["returnPp"] == [-6., .5]
    assert negative["returnPct"] == pytest.approx([1200 / 11, -100 / 11])
    assert hedge["riskPct"] == pytest.approx([-24.8 / 202.4 * 100, 227.2 / 202.4 * 100])
    assert hedge["riskPp"][0] < 0 < hedge["riskPp"][1]


def test_zero_denominators_are_unavailable_not_infinite_percentages(contributions_js):
    no_return, no_risk, fully_hedged = contributions_js([
        _case([.5, .5], [4., -4.], [[100., 0.], [0., 400.]]),
        _case([.5, .5], [4., 8.], [[0., 0.], [0., 0.]]),
        _case([.5, .5], [4., 8.], [[4., -4.], [-4., 4.]]),
    ])
    assert no_return["mu"] == 0
    assert no_return["returnPp"] == [2., -2.]
    assert no_return["returnPct"] == [None, None]
    assert sum(no_return["riskPct"]) == pytest.approx(100)
    for got in (no_risk, fully_hedged):
        assert got["sig"] == 0
        assert got["riskPct"] == [None, None]
        assert got["riskPp"] == [None, None]
        assert sum(got["returnPct"]) == pytest.approx(100)


def test_input_mean_volatility_and_correlation_have_distinct_effects(contributions_js):
    w, mu = [.8, .2], [4., 8.]
    cases = [_case(w, mu, [[100., rho * 200], [rho * 200, 400.]]) for rho in [-.6, 0., .6]]
    cases += [_case(w, [7., 8.], cases[1]["C"]),
              _case(w, mu, [[225., 0.], [0., 400.]])]
    low, zero, high, changed_mean, changed_vol = contributions_js(cases)
    assert low["sig"] < zero["sig"] < high["sig"]
    assert low["riskPct"] != zero["riskPct"] != high["riskPct"]
    assert low["returnPct"] == zero["returnPct"] == high["returnPct"]
    assert changed_mean["riskPct"] == zero["riskPct"]
    assert changed_mean["returnPct"] != zero["returnPct"]
    assert changed_vol["returnPct"] == zero["returnPct"]
    assert changed_vol["riskPct"] != zero["riskPct"]


def test_percentage_shares_are_unit_invariant_and_zero_weights_stay_zero(contributions_js):
    base = _case([.6, .4, 0.], [4., 8., -3.], [[100., 50., 0.], [50., 400., 0.], [0., 0., 25.]])
    decimal = _case(base["w"], np.asarray(base["mu"]) / 100, np.asarray(base["C"]) / 10000)
    pct, scaled = contributions_js([base, decimal])
    assert scaled["returnPct"] == pytest.approx(pct["returnPct"], abs=1e-10)
    assert scaled["riskPct"] == pytest.approx(pct["riskPct"], abs=1e-10)
    assert np.asarray(scaled["returnPp"]) * 100 == pytest.approx(pct["returnPp"])
    assert np.asarray(scaled["riskPp"]) * 100 == pytest.approx(pct["riskPp"])
    for key in ("returnPp", "returnPct", "riskPp", "riskPct"):
        assert pct[key][2] == 0
