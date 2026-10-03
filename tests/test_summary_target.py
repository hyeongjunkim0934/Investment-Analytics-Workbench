"""Exact target return checked with two-asset identities and a 3-asset line QP."""
from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess

import numpy as np
import pytest


@pytest.fixture(scope="module")
def target_js():
    node = shutil.which("node")
    if not node:
        pytest.fail("Node.js is required for the exact target-return solver")
    probe = Path(__file__).with_name("summary_target_probe.js")

    def run(cases):
        result = subprocess.run([node, str(probe)], input=json.dumps(cases), text=True,
                                capture_output=True, check=True, timeout=30)
        return json.loads(result.stdout)
    return run


def case(C, mu, targets, *, assets=("국내시가", "해외주식"), constraints=None):
    return {"C": np.asarray(C).tolist(), "mu": list(mu), "targets": list(targets),
            "assets": list(assets), "constraints": constraints or {}, "months": 60}


def check_point(point, C, mu, target, spec):
    assert point is not None
    w = np.array(point["w"])
    assert np.isfinite(w).all()
    assert w.sum() == pytest.approx(1, abs=2e-8)
    assert np.all(w >= np.array(spec["lower"]) - 2e-8)
    for group in spec["groups"]:
        assert group["min"] - 2e-8 <= w[group["ids"]].sum() <= group["max"] + 2e-8
    assert w @ mu == pytest.approx(target, abs=1e-7)
    assert point["mu"] == pytest.approx(w @ mu, abs=1e-8)
    assert point["sig"] == pytest.approx(np.sqrt(max(0, w @ C @ w)), abs=1e-8)
    return w


def test_exact_two_asset_target_includes_both_sides_of_gmv(target_js):
    C, mu = np.diag([1., 4.]), np.array([5., 3.])
    targets = [3., 3.5, 4., 4.6, 5., 2.999, 5.001]
    result = target_js([case(C, mu, targets)])[0]
    assert result["valid"] and result["unchanged"]
    assert result["gmv"]["mu"] == pytest.approx(4.6)
    for target, point in zip(targets, result["points"]):
        if 3 <= target <= 5:
            w = check_point(point, C, mu, target, result["spec"])
            # Two linear equalities uniquely determine the allocation.
            x = (target - mu[1]) / (mu[0] - mu[1])
            assert w == pytest.approx([x, 1 - x], abs=1e-9)
        else:
            assert point is None
    assert result["points"][2]["sig"] == pytest.approx(np.sqrt(1.25))


def independent_three_asset_target(C, mu, target, lower, groups):
    """Reduce the two equality constraints to one line, then clip its quadratic minimum.

    This does not enumerate portfolio faces or reuse the production solver.
    """
    system = np.vstack((np.ones(3), mu))
    start = np.linalg.lstsq(system, np.array([1., target]), rcond=None)[0]
    direction = np.cross(np.ones(3), mu)
    inequalities = [(-np.eye(3)[i], -lower[i]) for i in range(3)]
    for indexes, lo, hi in groups:
        row = np.zeros(3)
        row[indexes] = 1
        inequalities.extend([(row, hi), (-row, -lo)])
    lo_t, hi_t = -np.inf, np.inf
    for row, bound in inequalities:
        slope, residual = row @ direction, bound - row @ start
        if abs(slope) < 1e-12:
            if residual < -1e-10:
                return None
        elif slope > 0:
            hi_t = min(hi_t, residual / slope)
        else:
            lo_t = max(lo_t, residual / slope)
    if lo_t > hi_t + 1e-10:
        return None
    t = np.clip(-(direction @ C @ start) / (direction @ C @ direction), lo_t, hi_t)
    return start + t * direction


def test_three_asset_target_matches_independent_line_quadratic(target_js):
    assets = ("국내시가", "해외시가", "해외주식")
    mu, lower = np.array([3., 5., 7.]), np.array([.1, .05, .2])
    constraints = {"assetMin": dict(zip(assets, (lower * 100).tolist())),
                   "groupMin": {"채권": 35}, "groupMax": {"채권": 75}}
    groups = [([0, 1], .35, .75), ([2], 0., 1.)]
    targets = [3.9, 4., 4.1, 4.7, 5.3, 6.1, 6.1001]
    rng = np.random.default_rng(41003)
    matrices = []
    for _ in range(8):
        X = rng.normal(size=(3, 3))
        matrices.append(X @ X.T + np.eye(3) * .25)
    cases = [case(C, mu, targets, assets=assets, constraints=constraints) for C in matrices]
    for C, result in zip(matrices, target_js(cases)):
        assert result["valid"] and result["unchanged"]
        for target, point in zip(targets, result["points"]):
            expected = independent_three_asset_target(C, mu, target, lower, groups)
            if expected is None:
                assert point is None
            else:
                w = check_point(point, C, mu, target, result["spec"])
                assert w == pytest.approx(expected, abs=2e-8)


def test_target_feasibility_uses_constraints_not_raw_asset_return_range(target_js):
    C, mu = np.diag([4., 9.]), np.array([3., 7.])
    targets = [3., 3.8, 4., 6., 6.2, 7.]
    constraints = {"groupMin": {"채권": 25}, "groupMax": {"채권": 80}}
    result = target_js([case(C, mu, targets, constraints=constraints)])[0]
    for target, point in zip(targets, result["points"]):
        if 3.8 <= target <= 6:
            w = check_point(point, C, mu, target, result["spec"])
            assert w == pytest.approx([(7 - target) / 4, (target - 3) / 4], abs=1e-9)
        else:
            assert point is None


def test_flat_return_faces_fixed_mix_and_zero_variance(target_js):
    cases = [
        case([[4., 0.], [0., 9.]], [4., 4.], [4., 3.999, 4.001]),
        case([[1., 1.5], [1.5, 4.]], [4., 4.], [4.]),
        case([[4., 0.], [0., 9.]], [3., 5.], [4.2, 4.],
             constraints={"assetMin": {"국내시가": 40, "해외주식": 60}}),
        case([[0., 0.], [0., 0.]], [3., 5.], [4.]),
        case([[0., 0.], [0., 9.]], [3., 5.], [3., 4., 5.]),
    ]
    results = target_js(cases)
    assert results[0]["points"][0]["w"] == pytest.approx([9 / 13, 4 / 13], abs=1e-9)
    assert results[0]["points"][1:] == [None, None]
    # The unconstrained face GMV has a negative second weight; a subface binds.
    assert results[1]["points"][0]["w"] == pytest.approx([1., 0.])
    assert results[2]["points"][0]["w"] == pytest.approx([.4, .6])
    assert results[2]["points"][1] is None
    assert results[3]["points"][0]["sig"] == pytest.approx(0)
    for c, result in zip(cases, results):
        for target, point in zip(c["targets"], result["points"]):
            if point is not None:
                check_point(point, np.array(c["C"]), np.array(c["mu"]), target, result["spec"])


def test_singular_covariance_exact_target_and_nonfinite_requests(target_js):
    C = np.array([[9., -3., 0.], [-3., 1., 0.], [0., 0., 9.]])
    mu = np.array([1., 5., 7.])
    assets = ("국내시가", "해외시가", "해외주식")
    lower = np.array([.1, .1, .1])
    constraints = {"assetMin": dict(zip(assets, (lower * 100).tolist())),
                   "groupMin": {"채권": 40}, "groupMax": {"채권": 70}}
    targets = [4., 5., 5.8, 6., None, "4"]
    result = target_js([case(C, mu, targets, assets=assets, constraints=constraints)])[0]
    for target, point in zip(targets[:4], result["points"][:4]):
        expected = independent_three_asset_target(C, mu, target, lower, [([0, 1], .4, .7)])
        if expected is None:
            assert point is None
        else:
            w = check_point(point, C, mu, target, result["spec"])
            assert w == pytest.approx(expected, abs=2e-8)
    assert result["points"][4:] == [None, None]
