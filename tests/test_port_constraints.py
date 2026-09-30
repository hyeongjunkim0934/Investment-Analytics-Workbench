"""Constrained browser frontier, checked against independent grids and vertices."""
from __future__ import annotations

from itertools import combinations
import json
from pathlib import Path
import shutil
import subprocess

import numpy as np
import pytest


@pytest.fixture(scope="module")
def constrained_js():
    node = shutil.which("node")
    if not node:
        pytest.fail("Node.js is required for the browser constraint solver")
    source = (Path(__file__).resolve().parents[1] / "dashboard" / "port-constraints.js").read_text(encoding="utf-8")
    source += """
const cases = JSON.parse(require('fs').readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(cases.map(c => {
  const spec = portConstraintSpec(c.P, c.constraints);
  const model = c.C ? portConstrainedModel(c.C, c.mu, c.months, spec) : null;
  return {spec, valid: !!model, vertices: model?.vertices,
    points: (c.params || []).map(([lam, k]) => model?.solve(lam == null ? Infinity : lam, k) || null),
    sections: (c.risks || []).map(s => model?.atRisk(s) || null)};
})))
"""

    def run(cases):
        result = subprocess.run([node, "-e", source], input=json.dumps(cases), text=True,
                                capture_output=True, check=True, timeout=45)
        return json.loads(result.stdout)
    return run


def case(C, mu, *, assets=("국내시가", "해외주식"), constraints=None, risks=()):
    return {"P": {"assets": list(assets)}, "constraints": constraints or {},
            "C": np.asarray(C).tolist(), "mu": list(mu), "months": 60,
            "params": [[lam, k] for k in (0, 1, 3) for lam in (None, 0, .001, .03, .2, 1, 50)],
            "risks": list(risks)}


def objective(C, mu, months, lam, k, weights):
    variance = np.einsum("...i,ij,...j->...", weights, C, weights)
    return variance / 2 if lam is None else lam * variance / 2 + k * np.sqrt(12 / months * variance) - weights @ mu


def check_point(p, C, mu, spec):
    assert p is not None
    w = np.asarray(p["w"])
    assert w.sum() == pytest.approx(1, abs=2e-8)
    assert np.all(w >= np.asarray(spec["lower"]) - 2e-8)
    for group in spec["groups"]:
        assert group["min"] - 2e-8 <= w[group["ids"]].sum() <= group["max"] + 2e-8
    assert p["mu"] == pytest.approx(w @ mu, abs=1e-8)
    assert p["sig"] == pytest.approx(np.sqrt(max(0, w @ C @ w)), abs=1e-8)
    return w


def test_spec_rejects_infeasible_and_nonfinite_inputs(constrained_js):
    P = {"assets": ["국내시가", "국내장부", "해외주식", "대체투자"]}
    constraints = [
        {"groupMin": {"채권": 70, "주식": 40}},
        {"groupMax": {"채권": 20, "주식": 30, "대체": 40}},
        {"groupMin": {"채권": 60}, "groupMax": {"채권": 50}},
        {"groupMax": {"채권": 30}, "assetMin": {"국내시가": 20, "국내장부": 20}},
        {"assetMin": {"국내장부": -1}},
        {"groupMin": {"주식": "bad"}},
        {"assetMin": {"국내시가": ""}},
        {"groupMax": {"채권": 101}},
    ]
    results = constrained_js([{"P": P, "constraints": c} for c in constraints])
    assert all(not r["spec"]["ok"] and r["spec"]["error"] for r in results)


def test_group_mapping_and_caps_preserve_domestic_book_floor(constrained_js):
    P = {"assets": ["국내시가", "국내장부", "해외시가", "해외장부", "국내주식", "해외주식", "대체투자"],
         "defaults": {"groups": {"유동성": ["국내장부"]}}}
    c = {"groupMin": {"채권": 40}, "groupMax": {"주식": 35, "대체": 25}, "assetMin": {"국내장부": 15, "해외장부": 10}}
    spec = constrained_js([{"P": P, "constraints": c}])[0]["spec"]
    assert spec["ok"] and spec["active"]
    assert spec["groups"][1]["ids"] == [0, 1, 2, 3]
    seed = np.array(spec["seed"])
    assert seed.sum() == pytest.approx(1)
    assert seed[1] >= .15 and seed[3] >= .1 and seed[:4].sum() >= .4
    assert any(g["idx"] == [4, 5, 6] and g["cap"] == pytest.approx(.6) for g in spec["caps"])


def test_two_asset_constrained_utility_against_dense_grid(constrained_js):
    C, mu = np.array([[36., 5.], [5., 4.]]), np.array([7., 3.])
    c = case(C, mu, constraints={"groupMin": {"채권": 25}, "groupMax": {"채권": 65}, "assetMin": {"해외주식": 20}})
    result = constrained_js([c])[0]
    assert result["valid"]
    x = np.linspace(.25, .65, 100001)
    grid = np.column_stack((x, 1 - x))
    for (lam, k), point in zip(c["params"], result["points"]):
        w = check_point(point, C, mu, result["spec"])
        assert objective(C, mu, 60, lam, k, w) <= objective(C, mu, 60, lam, k, grid).min() + 1e-7
    assert sorted(p["w"][0] for p in result["vertices"]) == pytest.approx([.25, .65])


def test_two_asset_fixed_risk_sections_against_quadratic_roots(constrained_js):
    C, mu = np.array([[100., 0.], [0., 900.]]), np.array([10., 9.])
    risks = np.linspace(11, 24, 20)
    c = case(C, mu, constraints={"groupMin": {"채권": 20}, "groupMax": {"채권": 80}}, risks=risks)
    result = constrained_js([c])[0]
    for risk, point in zip(risks, result["sections"]):
        roots = np.roots([1000., -1800., 900. - risk ** 2])
        candidates = [np.array([float(x.real), 1-float(x.real)]) for x in roots if abs(x.imag) < 1e-10 and .2-1e-8 <= x.real <= .8+1e-8]
        if not candidates:
            assert point is None
        else:
            w = check_point(point, C, mu, result["spec"])
            assert point["sig"] == pytest.approx(risk, abs=1e-7)
            assert w @ mu == pytest.approx(max(v @ mu for v in candidates), abs=1e-7)


def test_three_asset_faces_against_independent_grid(constrained_js):
    C = np.array([[36., 5., -3.], [5., 16., 1.], [-3., 1., 64.]])
    mu = np.array([7., 4., 8.])
    c = case(C, mu, assets=("국내시가", "해외시가", "해외주식"), constraints={
        "groupMin": {"채권": 45}, "groupMax": {"채권": 80}, "assetMin": {"국내시가": 15, "해외시가": 5, "해외주식": 10}})
    result = constrained_js([c])[0]
    points = []
    for x in np.arange(.15, .750001, .002):
        for y in np.arange(.05, 1 - x - .09999, .002):
            if .45 - 1e-8 <= x + y <= .8 + 1e-8:
                points.append([x, y, 1 - x - y])
    grid = np.array(points)
    for (lam, k), point in zip(c["params"], result["points"]):
        w = check_point(point, C, mu, result["spec"])
        assert objective(C, mu, 60, lam, k, w) <= objective(C, mu, 60, lam, k, grid).min() + 1e-7


def test_fixed_mix_equal_means_zero_volatility_and_bad_covariance(constrained_js):
    cases = [
        case([[4., 0.], [0., 9.]], [5., 5.], constraints={"assetMin": {"국내시가": 40, "해외주식": 60}}, risks=[2., np.sqrt(3.88)]),
        case([[4., 0.], [0., 9.]], [5., 5.], constraints={"groupMin": {"채권": 20}, "groupMax": {"채권": 80}}, risks=[1.7, 2., 2.4]),
        case([[0., 0.], [0., 9.]], [2., 5.], constraints={"assetMin": {"국내시가": 10}}),
        case([[1., 2.], [2., 1.]], [2., 5.], constraints={"assetMin": {"국내시가": 10}}),
    ]
    results = constrained_js(cases)
    for c, result in zip(cases[:3], results[:3]):
        assert result["valid"]
        C, mu = np.array(c["C"]), np.array(c["mu"])
        for point in result["points"]:
            check_point(point, C, mu, result["spec"])
    assert all(p["w"] == pytest.approx([.4, .6]) for p in results[0]["points"])
    assert results[0]["sections"][0] is None
    assert results[0]["sections"][1]["w"] == pytest.approx([.4, .6])
    assert all(p is not None and p["mu"] == pytest.approx(5) for p in results[1]["sections"])
    assert not results[3]["valid"]


def independent_vertices(n, lower, groups):
    """Intersect arbitrary inequality hyperplanes; no partition-face solver reuse."""
    inequalities = [(-np.eye(n)[i], -lower[i]) for i in range(n)]
    for ids, low, high in groups:
        row = np.zeros(n)
        row[ids] = 1
        inequalities.extend([(row, high), (-row, -low)])
    A = np.array([p[0] for p in inequalities])
    b = np.array([p[1] for p in inequalities])
    vertices = []
    for ids in combinations(range(len(A)), n - 1):
        system = np.vstack((np.ones(n), A[list(ids)]))
        if np.linalg.matrix_rank(system) != n:
            continue
        w = np.linalg.solve(system, np.r_[1, b[list(ids)]])
        if np.all(A @ w <= b + 1e-9) and not any(np.max(np.abs(v-w)) < 1e-8 for v in vertices):
            vertices.append(w)
    return np.array(vertices)


def test_seven_assets_vertex_completeness_and_original_kkt(constrained_js):
    rng = np.random.default_rng(9231)
    X = rng.normal(size=(7, 7))
    C = X @ X.T + np.eye(7)
    mu = rng.normal(4, 3, 7)
    assets = ("국내시가", "국내장부", "해외시가", "해외장부", "국내주식", "해외주식", "대체투자")
    lower = np.array([.05, .1, 0, .1, .05, 0, .03])
    c = case(C, mu, assets=assets, constraints={"groupMin": {"채권": 35, "주식": 10, "대체": 5},
        "groupMax": {"채권": 70, "주식": 40, "대체": 25}, "assetMin": dict(zip(assets, (lower * 100).tolist()))})
    result = constrained_js([c])[0]
    vertices = independent_vertices(7, lower, [([0, 1, 2, 3], .35, .7), ([4, 5], .1, .4), ([6], .05, .25)])
    obtained = np.array([p["w"] for p in result["vertices"]])
    assert len(vertices) == len(obtained)
    assert all(np.min(np.max(np.abs(obtained - w), axis=1)) < 1e-8 for w in vertices)
    for (lam, k), point in zip(c["params"], result["points"]):
        w = check_point(point, C, mu, result["spec"])
        sd = np.sqrt(w @ C @ w)
        gradient = C @ w if lam is None else (lam + k * np.sqrt(12/60) / sd) * (C @ w) - mu
        assert gradient @ w - np.min(vertices @ gradient) <= 1.1e-5


def test_singular_covariance_affine_face_has_analytic_gmv(constrained_js):
    # Bond risk is exactly (3*w0-w1)^2. The equity floor implied by the
    # 70% bond cap is .3; setting w1=3*w0 then gives the unique GMV below.
    C = np.array([[9., -3., 0.], [-3., 1., 0.], [0., 0., 9.]])
    mu = np.array([1., 5., 7.])
    c = case(C, mu, assets=("국내시가", "해외시가", "해외주식"), constraints={
        "assetMin": {"국내시가": 10, "해외시가": 10, "해외주식": 10},
        "groupMin": {"채권": 40}, "groupMax": {"채권": 70}}, risks=[.9, 1., 1.5])
    c["params"] = [[None, 0], [1000, 0], [1, 3]]
    result = constrained_js([c])[0]
    for p in result["points"] + result["sections"]:
        check_point(p, C, mu, result["spec"])
    assert result["points"][0]["w"] == pytest.approx([.175, .525, .3], abs=1e-9)
    assert result["points"][0]["sig"] == pytest.approx(.9, abs=1e-9)
    # On the binding group-cap face: dμ/dw0=-4, dVar/dw0=32*w0-5.6.
    assert result["points"][1]["w"] == pytest.approx([.17475, .52525, .3], abs=1e-9)
