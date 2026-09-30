"""Target-return portfolios: analytic cases and an independent feasible grid."""
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
    assert node, "Node.js is required for the browser target-return solver"
    dashboard = Path(__file__).resolve().parents[1] / "dashboard"
    app = (dashboard / "app.js").read_text(encoding="utf-8")
    script = (dashboard / "port-constraints.js").read_text(encoding="utf-8")
    script += app[app.index("function matSolve("):app.index("function erf(")]
    script += app[app.index("function portRobustK("):app.index("function portMaxSharpe(")]
    script += """
const cases = JSON.parse(require('fs').readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(cases.map(c => {
  const spec = portConstraintSpec({assets:c.assets}, c.constraints || {});
  const model = c.constrained ? portConstrainedModel(c.C, c.mu, 60, spec)
    : portRobustModel(c.C, c.mu, 60);
  const results = c.targets.map(target => portTargetReturn(model, target));
  const last = results[results.length-1];
  return {spec, results, cached: model && Number.isFinite(last.target)
    ? last === portTargetReturn(model, last.target) : true};
})))
"""

    def run(cases):
        result = subprocess.run([node, "-e", script], input=json.dumps(cases),
                                capture_output=True, text=True, check=True, timeout=45)
        return json.loads(result.stdout)
    return run


def case(C, mu, targets, *, constrained=False, constraints=None):
    assets = ["국내시가", "해외주식", "대체투자"][:len(mu)]
    return {"C": np.asarray(C).tolist(), "mu": list(mu), "targets": targets,
            "assets": assets, "constrained": constrained, "constraints": constraints or {}}


def check_point(result, c, spec):
    assert not result["error"], result
    p = result["point"]
    w, mu, C = np.asarray(p["w"]), np.asarray(c["mu"]), np.asarray(c["C"])
    assert w.sum() == pytest.approx(1, abs=2e-8)
    assert np.all(w >= np.asarray(spec["lower"]) - 2e-8)
    for group in spec["groups"]:
        assert group["min"] - 2e-8 <= w[group["ids"]].sum() <= group["max"] + 2e-8
    assert w @ mu >= result["target"] - 1e-7
    assert p["mu"] == pytest.approx(w @ mu, abs=1e-9)
    assert p["sig"] == pytest.approx(np.sqrt(max(0, w @ C @ w)), abs=1e-9)
    return w


@pytest.mark.parametrize("constrained", [False, True])
def test_target_floor_analytic_two_assets_and_infeasible(target_js, constrained):
    # x is the high-return asset weight: variance=4(1-x)^2+9x^2,
    # GMV x=4/13, expected return=2+6x. A binding target fixes x.
    c = case([[4, 0], [0, 9]], [2, 8], [-100, 2, 4, 5, 7, 8, 8.001], constrained=constrained)
    result = target_js([c])[0]
    for target, solved in zip(c["targets"][:-1], result["results"][:-1]):
        w = check_point(solved, c, result["spec"])
        x = max(4/13, (target-2)/6)
        assert w == pytest.approx([1-x, x], abs=1e-8)
    assert result["results"][-1]["point"] is None
    assert "최대 기대수익률" in result["results"][-1]["error"]
    assert result["cached"]


@pytest.mark.parametrize("constrained", [False, True])
def test_tied_maximum_return_selects_minimum_variance_face(target_js, constrained):
    c = case(np.diag([4, 9, 1]), [8, 8, 2], [8], constrained=constrained)
    result = target_js([c])[0]
    w = check_point(result["results"][0], c, result["spec"])
    assert w == pytest.approx([9/13, 4/13, 0], abs=1e-8)


def test_target_constraints_against_independent_grid(target_js):
    C = np.array([[36., 5., -3.], [5., 16., 1.], [-3., 1., 64.]])
    mu = np.array([7., 4., 8.])
    c = case(C, mu, [5.2, 6, 7, 7.25, 7.5], constrained=True, constraints={
        "groupMin": {"채권": 15, "주식": 10, "대체": 10},
        "groupMax": {"채권": 65, "주식": 50, "대체": 55},
        "assetMin": {"국내시가": 20}})
    result = target_js([c])[0]
    x, y = np.meshgrid(np.arange(.2, .650001, .001), np.arange(.1, .500001, .001))
    grid = np.column_stack((x.ravel(), y.ravel(), 1-x.ravel()-y.ravel()))
    grid = grid[(grid[:, 2] >= .1-1e-10) & (grid[:, 2] <= .55+1e-10)]
    returns = grid @ mu
    variances = np.einsum("...i,ij,...j->...", grid, C, grid)
    for solved in result["results"]:
        feasible = returns >= solved["target"]-1e-10
        if not np.any(feasible):
            assert solved["point"] is None and solved["error"]
            continue
        w = check_point(solved, c, result["spec"])
        assert w @ C @ w <= variances[feasible].min() + 1e-7
        assert variances[feasible].min() - w @ C @ w < .05


@pytest.mark.parametrize("constrained", [False, True])
def test_equal_means_zero_risk_singular_and_invalid_inputs(target_js, constrained):
    cases = [
        case([[4, 0], [0, 9]], [5, 5], [-2, 5, 5.01], constrained=constrained),
        case([[0, 0], [0, 9]], [2, 5], [2, 3.5, 5], constrained=constrained),
        case([[4, 4], [4, 4]], [2, 8], [5, 6.5, 8], constrained=constrained),
        case([[4, 0], [0, 9]], [2, 8], [None, "bad"], constrained=constrained),
        case([[1, 2], [2, 1]], [2, 8], [5], constrained=constrained),
    ]
    results = target_js(cases)
    for c, output in zip(cases[:3], results[:3]):
        for solved in output["results"]:
            if solved["target"] > max(c["mu"]):
                assert solved["point"] is None and solved["error"]
            else:
                check_point(solved, c, output["spec"])
    assert results[0]["results"][1]["point"]["w"] == pytest.approx([9/13, 4/13], abs=1e-8)
    assert results[1]["results"][1]["point"]["w"] == pytest.approx([.5, .5], abs=1e-8)
    assert all(solved["point"] is None and solved["error"] for output in results[3:] for solved in output["results"])
