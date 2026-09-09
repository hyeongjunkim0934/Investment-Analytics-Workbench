"""Browser robust frontier: actual JavaScript against independent convex checks."""
from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess

import numpy as np
import pytest


@pytest.fixture(scope="module")
def solve_js():
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
  return {valid: !!model, meanScale: model?.meanScale,
    points: c.params.map(([lam, k]) => model?.solve(lam === null ? Infinity : lam, k) || null),
    frontier: portFrontiers({}, {key: 'test', n_months: c.months}, c.C, c.mu, c.kappa || 0)};
})));
"""

    def run(cases):
        result = subprocess.run([node, "-e", script], input=json.dumps(cases), text=True,
                                capture_output=True, check=True, timeout=30)
        return json.loads(result.stdout)

    return run


def _case(C, mu, *, months=120, kappa=1, params=None):
    return {"C": np.asarray(C).tolist(), "mu": np.asarray(mu).tolist(), "months": months,
            "kappa": kappa, "params": params if params is not None else
            [[lam, k] for k in (0, 1, 3) for lam in (0, 0.001, 0.01, 0.1, 1, 10, 100, 1000, None)]}


def _objective(C, mu, months, lam, kappa, w):
    variance = np.einsum("...i,ij,...j->...", w, C, w)
    if lam is None:
        return variance / 2
    return lam * variance / 2 + kappa * np.sqrt(12 / months) * np.sqrt(np.maximum(variance, 0)) - w @ mu


def test_seven_asset_solver_global_optimality_and_frontier(solve_js):
    rng = np.random.default_rng(774491)
    cases = []
    for _ in range(3):
        x = rng.normal(size=(7, 7))
        C = x @ x.T
        vol = rng.uniform(1, 30, 7)
        C = C / np.sqrt(np.outer(C.diagonal(), C.diagonal())) * np.outer(vol, vol)
        cases.append(_case(C, rng.normal(3, 6, 7), kappa=3))
    for c, result in zip(cases, solve_js(cases)):
        C, mu = np.array(c["C"]), np.array(c["mu"])
        # Reconstruct the explicitly documented numerical stabilizer, independently
        # evaluate the simplex variational inequality: g(w)'(v-w) >= 0 for every vertex.
        D = C + np.eye(len(mu)) * max(1, np.abs(C.diagonal()).max()) * 1e-12
        assert result["valid"] and result["frontier"]["robustOk"]
        for (lam, kappa), point in zip(c["params"], result["points"]):
            assert point is not None, (lam, kappa)
            w = np.array(point["w"])
            assert np.isfinite(w).all() and w.min() >= -1e-10
            assert abs(w.sum() - 1) < 1e-10
            assert point["sig"] == pytest.approx(np.sqrt(w @ C @ w), abs=1e-8)
            assert point["mu"] == pytest.approx(w @ mu, abs=1e-8)
            assert point["worst"] == pytest.approx(w @ mu - kappa * np.sqrt(12 / c["months"]) * point["sig"], abs=1e-8)
            g = D @ w if lam is None else (lam + kappa * np.sqrt(12 / c["months"]) / np.sqrt(w @ D @ w)) * (D @ w) - mu
            gap = float(g @ w - g.min())
            assert gap <= 1e-5, (lam, kappa, gap)
        for key, field in (("front", "mu"), ("robust", "worst")):
            points = result["frontier"][key]
            assert len(points) >= 2
            # Every retained point must escape domination by ALL earlier points.
            for i, p in enumerate(points):
                assert all(p["sig"] > q["sig"] and p[field] > q[field] for q in points[:i])


def test_two_asset_dense_grid_independent_objective(solve_js):
    C, mu = np.array([[36., 5.], [5., 4.]]), np.array([7., 3.])
    case = _case(C, mu, months=60)
    result = solve_js([case])[0]
    x = np.linspace(0, 1, 100001)
    grid = np.column_stack([x, 1 - x])
    for (lam, kappa), point in zip(case["params"], result["points"]):
        assert point is not None
        obtained = _objective(C, mu, 60, lam, kappa, np.array(point["w"]))
        best_grid = _objective(C, mu, 60, lam, kappa, grid).min()
        assert obtained <= best_grid + 1e-7, (lam, kappa, obtained, best_grid)


def test_zero_strength_and_sample_size_scaling(solve_js):
    C, mu = [[36., 5.], [5., 4.]], [7., 3.]
    cases = [_case(C, mu, kappa=0),
             _case(C, mu, months=30, params=[[0.1, 1]]),
             _case(C, mu, months=120, params=[[0.1, 2]])]
    zero, short, long = solve_js(cases)
    assert zero["frontier"]["robustOk"]
    nominal, robust = zero["frontier"]["front"], zero["frontier"]["robust"]
    assert len(nominal) == len(robust)
    for a, b in zip(nominal, robust):
        assert a["w"] == pytest.approx(b["w"], abs=1e-12)
        assert a["mu"] == pytest.approx(b["worst"], abs=1e-12)
    assert short["meanScale"] == pytest.approx(2 * long["meanScale"])
    assert short["points"][0]["w"] == pytest.approx(long["points"][0]["w"], abs=1e-10)
    assert short["points"][0]["worst"] == pytest.approx(long["points"][0]["worst"], abs=1e-10)


def test_zero_covariance_and_invalid_covariance(solve_js):
    mu = np.arange(7, dtype=float) - 10
    zero, indefinite = solve_js([_case(np.zeros((7, 7)), mu),
                                 _case(np.eye(7) - np.ones((7, 7)), mu)])
    assert zero["valid"] and zero["frontier"]["robustOk"]
    for (lam, _), point in zip(_case(np.zeros((7, 7)), mu)["params"], zero["points"]):
        assert point is not None and point["sig"] == 0
        if lam is not None:
            assert point["mu"] == pytest.approx(mu.max(), abs=1e-8)
    assert not indefinite["valid"] and not indefinite["frontier"]["robustOk"]
    assert not indefinite["frontier"]["robust"]


def test_frontier_controls_gradient_ranges_and_chart_lifecycle():
    root = Path(__file__).resolve().parents[1]
    node = shutil.which("node")
    assert node, "Node.js is required to exercise the frontier UI"
    result = subprocess.run([node, str(root / "tests" / "robust_frontier_ui_probe.js")],
                            cwd=root, capture_output=True, text=True, check=True, timeout=30)
    assert json.loads(result.stdout)["pass"]
