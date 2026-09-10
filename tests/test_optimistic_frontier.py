"""Optimistic frontier: browser code checked against independent simplex grids."""
from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess

import numpy as np
import pytest


@pytest.fixture(scope="module")
def optimistic_js():
    node = shutil.which("node")
    if not node:
        pytest.fail("Node.js is required to exercise the browser solver")
    source = (Path(__file__).resolve().parents[1] / "dashboard" / "app.js").read_text(encoding="utf-8")
    script = source[source.index("function matSolve("):source.index("function erf(")]
    script += source[source.index("function portRobustK("):source.index("function portEngine(")]
    script += """
const cases = JSON.parse(require('fs').readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(cases.map(c => {
  const model = portRobustModel(c.C, c.mu, c.months);
  return {valid: !!model,
    atRisk: (c.risks || []).map(s => model?.atRisk(s) || null),
    frontier: portFrontiers({}, {key: 'optimistic-test', n_months: c.months},
      c.C, c.mu, c.kappa, 0)};
})));
"""

    def run(cases):
        result = subprocess.run([node, "-e", script], input=json.dumps(cases), text=True,
                                capture_output=True, check=True, timeout=45)
        return json.loads(result.stdout)

    return run


def _case(C, mu, *, months=60, kappa=1, risks=()):
    return {"C": np.asarray(C).tolist(), "mu": np.asarray(mu).tolist(),
            "months": months, "kappa": kappa, "risks": list(risks)}


def _moments(C, mu, weights):
    weights = np.asarray(weights)
    variance = np.einsum("...i,ij,...j->...", weights, C, weights)
    return weights @ mu, np.sqrt(np.maximum(variance, 0))


def _check_point(point, C, mu):
    w = np.asarray(point["w"])
    assert np.isfinite(w).all() and w.min() >= -1e-9
    assert w.sum() == pytest.approx(1, abs=1e-9)
    mean, risk = _moments(C, mu, w)
    assert point["mu"] == pytest.approx(float(mean), abs=1e-7)
    assert point["sig"] == pytest.approx(float(risk), abs=1e-7)


def _compare_envelope(result, case, grid):
    C, mu = np.asarray(case["C"]), np.asarray(case["mu"])
    a = case["kappa"] * np.sqrt(12 / case["months"])
    mean, risk = _moments(C, mu, grid)
    best_grid = mean + a * risk
    points = result["frontier"]["optimistic"]
    assert result["valid"] and points
    for i, point in enumerate(points):
        _check_point(point, C, mu)
        assert point["best"] == pytest.approx(point["mu"] + a * point["sig"], abs=1e-9)
        # All portfolios with no greater risk are competitors.  This includes the
        # high-risk side of the simplex that the nominal frontier discards.
        # Do not relax the risk budget near the GMV point: its frontier slope
        # may diverge, so a tiny risk allowance can admit a materially higher mean.
        competitors = best_grid[risk <= point["sig"]]
        if len(competitors):
            assert competitors.max() <= point["best"] + 2e-6, (point, competitors.max())
        if i:
            assert point["sig"] > points[i - 1]["sig"]
            assert point["best"] > points[i - 1]["best"]
    # A linear mean plus a nonnegative norm is convex; its maximum on a
    # simplex is attained at a vertex, independently of the JS optimizer.
    vertex_best = mu + a * np.sqrt(np.diag(C))
    assert points[-1]["best"] == pytest.approx(vertex_best.max(), abs=1e-7)
    return points


def test_two_asset_optimistic_envelope_against_dense_grid(optimistic_js):
    x = np.linspace(0, 1, 200001)
    grid = np.column_stack((x, 1 - x))
    cases = [
        _case([[36., 5.], [5., 4.]], [7., 3.]),
        _case([[100., 0.], [0., 900.]], [10., 9.]),
        _case([[36., -8.], [-8., 16.]], [-5., -3.], kappa=3),
    ]
    for case, result in zip(cases, optimistic_js(cases)):
        _compare_envelope(result, case, grid)


def test_optimistic_frontier_includes_nominally_dominated_high_risk_tail(optimistic_js):
    case = _case([[100., 0.], [0., 900.]], [10., 9.])
    result = optimistic_js([case])[0]
    nominal, optimistic = result["frontier"]["front"], result["frontier"]["optimistic"]
    assert nominal[-1]["w"] == pytest.approx([1, 0], abs=1e-8)
    assert optimistic[-1]["w"] == pytest.approx([0, 1], abs=1e-8)
    assert optimistic[-1]["sig"] == pytest.approx(30, abs=1e-8)
    assert optimistic[-1]["best"] == pytest.approx(9 + np.sqrt(12 / 60) * 30, abs=1e-8)
    assert any(10.01 < point["sig"] < 29.99 for point in optimistic)


def test_optimistic_gap_survives_near_duplicate_endpoint_replacement(optimistic_js):
    coefficient = np.sqrt(12 / 60)
    C = np.diag([100., 900.])
    mu = np.array([10., 10 - coefficient * 20 + 0.001])
    risks = [15., 20., 25.]
    result = optimistic_js([_case(C, mu, risks=risks)])[0]
    optimistic = result["frontier"]["optimistic"]
    anchor, endpoint = optimistic[-2:]
    assert anchor["sig"] == pytest.approx(10, abs=1e-8)
    assert endpoint["sig"] == pytest.approx(30, abs=1e-8)
    assert endpoint["best"] - anchor["best"] == pytest.approx(0.001, abs=1e-8)

    # An independent quadratic finds every feasible allocation at each interior
    # risk.  Their best upper-scenario mean is dominated by the lower-risk A
    # vertex, so a straight segment connecting A and B would fabricate a frontier.
    for target, point in zip(risks, result["atRisk"]):
        roots = np.roots([1000., -1800., 900. - target ** 2])
        weights = [np.array([x.real, 1 - x.real]) for x in roots
                   if abs(x.imag) < 1e-10 and 0 <= x.real <= 1]
        expected_best = max(w @ mu + coefficient * target for w in weights)
        assert expected_best < anchor["best"]
        assert point["mu"] + coefficient * point["sig"] == pytest.approx(expected_best, abs=2e-7)
    # A later, numerically duplicate B endpoint must preserve this segment break.
    assert endpoint.get("breakBefore") is True


def test_three_asset_optimistic_envelope_against_simplex_grid(optimistic_js):
    denominator = 500
    grid = np.asarray([(i / denominator, j / denominator, (denominator - i - j) / denominator)
                       for i in range(denominator + 1) for j in range(denominator + 1 - i)])
    cases = [
        _case([[36., 5., -2.], [5., 4., 1.], [-2., 1., 16.]], [7., 3., 5.]),
        _case(np.diag([100., 400., 900.]), [10., 9.5, 9.]),
    ]
    for case, result in zip(cases, optimistic_js(cases)):
        _compare_envelope(result, case, grid)


def test_fixed_risk_equal_means_outside_unconstrained_minimum(optimistic_js):
    # The unrestricted minimum on w1+w2=1 has a negative second weight.
    # A constant mean still permits a valid portfolio at every risk in [10,20].
    case = _case([[100., 150.], [150., 400.]], [5., 5.], risks=[10., 12., 15., 18., 20.])
    result = optimistic_js([case])[0]
    for target, point in zip(case["risks"], result["atRisk"]):
        assert point is not None, target
        _check_point(point, np.asarray(case["C"]), np.asarray(case["mu"]))
        assert point["sig"] == pytest.approx(target, abs=2e-7)
        assert point["mu"] == pytest.approx(5, abs=1e-10)
    x = np.linspace(0, 1, 100001)
    _compare_envelope(result, case, np.column_stack((x, 1 - x)))


def test_fixed_risk_two_asset_sections_have_maximum_mean(optimistic_js):
    # Independent scalar quadratic roots determine the two intersections of
    # the risk ellipse with a two-asset simplex; no face enumeration is used.
    C, mu = np.array([[100., 0.], [0., 900.]]), np.array([10., 9.])
    risks = [9.6, 9.8, 10., 12., 15., 20., 25., 30.]
    result = optimistic_js([_case(C, mu, risks=risks)])[0]
    for target, point in zip(risks, result["atRisk"]):
        roots = np.roots([C[0, 0] - 2 * C[0, 1] + C[1, 1],
                          2 * (C[0, 1] - C[1, 1]), C[1, 1] - target ** 2])
        candidates = [np.array([x.real, 1 - x.real]) for x in roots
                      if abs(x.imag) < 1e-10 and -1e-10 <= x.real <= 1 + 1e-10]
        assert candidates and point is not None
        _check_point(point, C, mu)
        assert point["sig"] == pytest.approx(target, abs=2e-7)
        assert point["mu"] == pytest.approx(max(w @ mu for w in candidates), abs=2e-7)


def test_zero_strength_and_sample_size_scaling(optimistic_js):
    C, mu = [[36., 5.], [5., 4.]], [7., 3.]
    cases = [_case(C, mu, kappa=0), _case(C, mu, months=30),
             _case(C, mu, months=120, kappa=2)]
    zero, short, long = optimistic_js(cases)
    x = np.linspace(0, 1, 100001)
    _compare_envelope(zero, cases[0], np.column_stack((x, 1 - x)))
    for point in zero["frontier"]["optimistic"]:
        assert point["best"] == pytest.approx(point["mu"], abs=1e-12)
    optimistic_short, optimistic_long = short["frontier"]["optimistic"], long["frontier"]["optimistic"]
    assert len(optimistic_short) == len(optimistic_long)
    for a, b in zip(optimistic_short, optimistic_long):
        assert a["w"] == pytest.approx(b["w"], abs=1e-9)
        assert a["best"] == pytest.approx(b["best"], abs=1e-9)
    # Each scenario is symmetric around the nominal mean for the SAME weights;
    # the optimized weights of the two scenarios need not be identical.
    coefficient = np.sqrt(12 / 30)
    for point in short["frontier"]["robust"]:
        _check_point(point, np.asarray(C), np.asarray(mu))
        assert point["mu"] - point["worst"] == pytest.approx(coefficient * point["sig"], abs=1e-9)
    for point in optimistic_short:
        conservative_same_weights = point["mu"] - coefficient * point["sig"]
        assert (point["best"] + conservative_same_weights) / 2 == pytest.approx(point["mu"], abs=1e-9)


def test_zero_and_singular_covariance_remain_feasible(optimistic_js):
    cases = [
        _case(np.zeros((3, 3)), [1., 2., -1.], risks=[0.]),
        _case([[4., 6.], [6., 9.]], [2., 1.], risks=[2., 2.25, 2.5, 2.75, 3.]),
        _case([[4., -4.], [-4., 4.]], [2., 1.], risks=[0., 0.25, 1., 2.]),
    ]
    zero, same_direction, offsetting = optimistic_js(cases)
    assert zero["valid"] and zero["frontier"]["optimistic"]
    for point in zero["frontier"]["optimistic"]:
        _check_point(point, np.zeros((3, 3)), np.array([1., 2., -1.]))
        assert point["sig"] == 0
        assert point["best"] == pytest.approx(2, abs=1e-8)
    x = np.linspace(0, 1, 100001)
    grid = np.column_stack((x, 1 - x))
    for case, result in zip(cases[1:], (same_direction, offsetting)):
        _compare_envelope(result, case, grid)
        for target, point in zip(case["risks"], result["atRisk"]):
            assert point is not None, target
            _check_point(point, np.asarray(case["C"]), np.asarray(case["mu"]))
            assert point["sig"] == pytest.approx(target, abs=2e-6)
