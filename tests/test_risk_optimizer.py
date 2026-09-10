"""Risk-history QP: executable JS against independent face enumeration/closed form."""
from __future__ import annotations

import itertools
import json
from pathlib import Path
import shutil
import subprocess

import numpy as np
import pytest


@pytest.fixture(scope="module")
def solve_js():
    node = shutil.which("node")
    assert node, "Node.js is required to check the risk-history solver"
    source = (Path(__file__).resolve().parents[1] / "dashboard" / "app.js").read_text()
    start = source.index("function allocRiskOptimize(")
    end = source.index("\nfunction ", start + 1)
    script = source[start:end] + """
const cases = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const out = cases.map(c => {
  const E = c.engine;
  const tic = performance.now();
  const results = c.lambdas.map(l => allocRiskOptimize(E, l));
  let mutated = null;
  if (c.mutate) {
    E.V.mu = c.mutate;
    mutated = allocRiskOptimize(E, c.lambdas[0]);
  }
  return {results, mutated, ms: performance.now() - tic};
});
process.stdout.write(JSON.stringify(out));
"""

    def run(cases):
        result = subprocess.run([node, "-e", script], input=json.dumps(cases),
                                text=True, capture_output=True, timeout=20)
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)

    return run


def engine(mu, cov, lo=None, hi=None, groups=None):
    n = len(mu)
    return {"V": {"mu": mu, "C": cov}, "lo": lo or [0] * n,
            "hi": hi or [1] * n, "groups": groups or []}


def inequality_arrays(e):
    n = len(e["lo"])
    rows = [*np.eye(n), *-np.eye(n)]
    values = [*e["hi"], *-np.array(e["lo"])]
    for group in e["groups"]:
        row = np.zeros(n)
        row[group["idx"]] = 1
        rows.append(row)
        values.append(group["cap"])
    return np.array(rows), np.array(values)


def objective(e, lam, w):
    cov, mu = np.array(e["V"]["C"]) / 10000, np.array(e["V"]["mu"]) / 100
    scale = max(1e-12, lam * np.abs(cov).sum(axis=1).max(), np.abs(mu).max())
    return (lam * w @ cov @ w / 2 - mu @ w) / scale


def reference_faces(e, lam):
    """Exhaust all faces; solve their equality-constrained QPs via NumPy.

    This does not share the JS working-set selection, feasible-start projection,
    ridge, pivot solver, stopping criterion, cache, or initialization.
    """
    n = len(e["lo"])
    cov, mu = np.array(e["V"]["C"]) / 10000, np.array(e["V"]["mu"]) / 100
    scale = max(1e-12, lam * np.abs(cov).sum(axis=1).max(), np.abs(mu).max())
    H, q = lam * cov / scale, -mu / scale
    A, b = inequality_arrays(e)
    best = None
    for count in range(n):
        for active in itertools.combinations(range(len(b)), count):
            B = np.vstack([np.ones(n), A[list(active)]])
            target = np.r_[1, b[list(active)]]
            kkt = np.block([[H, B.T], [B, np.zeros((count + 1, count + 1))]])
            rhs = np.r_[-q, target]
            candidate, *_ = np.linalg.lstsq(kkt, rhs, rcond=1e-12)
            w = candidate[:n]
            if np.max(np.abs(kkt @ candidate - rhs)) > 1e-8:
                continue
            if abs(w.sum() - 1) > 1e-8 or np.max(A @ w - b) > 1e-8:
                continue
            value = objective(e, lam, w)
            if best is None or value < best:
                best = value
    assert best is not None, "independent reference found no feasible optimum"
    return best


def test_two_asset_closed_form_extremes_and_mutable_input_cache(solve_js):
    e = engine([3, 7], [[16, 8], [8, 100]], [.1, .15], [.8, .9])
    lams = [0, 1e-4, .1, 1, 5, 30, 1e4, 1e6]
    result = solve_js([{"engine": e, "lambdas": lams, "mutate": [9, 2]}])[0]
    for lam, got in zip(lams, result["results"]):
        # d utility / d w1 = 0, using w2 = 1 - w1; clamp to both assets' bounds.
        expect = .1 if lam == 0 else np.clip((100 - 8 - 400 / lam) / (16 + 100 - 16), .1, .8)
        assert got is not None
        np.testing.assert_allclose(got, [expect, 1 - expect], atol=1e-7, rtol=0)
    np.testing.assert_allclose(result["mutated"], [.8, .2], atol=1e-8)


def test_overlapping_tight_and_singular_constraints_against_all_faces(solve_js):
    factor = np.array([[2, 0, 0, 0], [1, 5, 0, 0], [.5, -.2, 8, 0], [1, 1, 2, 4]])
    base = engine([3, 5, 7, 4], (factor @ factor.T).tolist(), [0, .05, 0, .05], [.6, .5, .7, .8],
                  [{"idx": [0, 1], "cap": .6}, {"idx": [1, 2], "cap": .45}])
    tight = engine([3, 5, 7, 4], (factor @ factor.T).tolist(), groups=[
        {"idx": [0, 1], "cap": 0}, {"idx": [1, 2], "cap": .15}])
    singular = engine([3, 5, 7, 4], (factor[:, :2] @ factor[:, :2].T).tolist(), groups=base["groups"])
    zero = engine([1, 1, 1, 1], np.zeros((4, 4)).tolist(), groups=base["groups"])
    floor = engine([3, 5, 7, 4], (factor @ factor.T).tolist(), [.1, .2, 0, 0],
                   groups=[{"idx": [0, 1], "cap": .3}])
    lams = [0, 1e-4, 1, 20, 1e4, 1e6]
    models = [base, tight, singular, zero, floor]
    outputs = solve_js([{"engine": e, "lambdas": lams} for e in models])
    for e, output in zip(models, outputs):
        A, b = inequality_arrays(e)
        for lam, got in zip(lams, output["results"]):
            assert got is not None, (lam, e)
            w = np.array(got)
            assert abs(w.sum() - 1) <= 2e-9
            assert np.max(A @ w - b) <= 2e-9
            assert abs(objective(e, lam, w) - reference_faces(e, lam)) <= 3e-8


def test_rejects_unusable_covariance_and_jointly_infeasible_constraints(solve_js):
    cases = [
        engine([3, 4], [[1, 2], [2, 1]]),  # indefinite
        engine([3, 4], [[1, 1], [0, 1]]),  # asymmetric
        engine([3, 4], [[1, 0], [0, 1]], [.6, .6]),
        engine([3, 4], [[1, 0], [0, 1]], hi=[.4, .4]),
        engine([3, 4, 5, 6], np.eye(4).tolist(), groups=[
            {"idx": [0, 1], "cap": .3}, {"idx": [2, 3], "cap": .3}]),
        engine([3, 4, 5, 6], np.eye(4).tolist(), [.1, .2, 0, 0], groups=[
            {"idx": [0, 1], "cap": .2}]),
        engine([3, 4, 5, 6], np.eye(4).tolist(), hi=[.8, .8, .1, .1], groups=[
            {"idx": [0, 1], "cap": .3}]),
    ]
    results = solve_js([{"engine": e, "lambdas": [0, 1e6]} for e in cases])
    assert all(output["results"] == [None, None] for output in results)


def test_weekly_history_cost_and_warm_start_order(solve_js):
    e = engine([3.25, 2.94, 6.29, 5.43, 4.39, 6.86, 2.09],
               np.diag([16, 25, 225, 256, 36, 144, 1]).tolist(),
               [.2, 0, 0, 0, .05, .05, 0], [.6, .3, .25, .25, .2, .3, .2])
    lams = (5.81 * 10 ** (2 * np.sin(np.arange(900) * .71))).tolist()
    forward, reverse = solve_js([{"engine": e, "lambdas": lams}, {"engine": e, "lambdas": lams[::-1]}])
    assert all(w is not None for w in forward["results"] + reverse["results"])
    np.testing.assert_allclose(forward["results"], reverse["results"][::-1], atol=2e-7, rtol=0)
    assert max(forward["ms"], reverse["ms"]) < 3000, "900-point solve stalls the chart"
