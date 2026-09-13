"""Frontier annotations: independent moment identities and boundary cases."""
from __future__ import annotations

import copy
import json
from pathlib import Path
import shutil
import subprocess

import numpy as np
import unittest
from numpy.testing import assert_allclose


def _opportunity_runner():
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js is required to exercise browser opportunity annotations")
    source = (Path(__file__).resolve().parents[1] / "dashboard" / "port-opportunities.js").read_text()
    source += """
const cases = JSON.parse(require('fs').readFileSync(0, 'utf8'));
function freeze(x) {
  if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); }
  return x;
}
process.stdout.write(JSON.stringify(cases.map(c => {
  freeze(c);
  const first = portOpportunityHints(c.front, c.C, c.mu, c.options);
  const repeat = portOpportunityHints(c.front, c.C, c.mu, c.options);
  if (JSON.stringify(first) !== JSON.stringify(repeat)) throw Error('nondeterministic');
  if (first.scenarioC === c.C || first.scenarioC?.some((r, i) => r === c.C[i]))
    throw Error('covariance aliases input');
  for (const p of [...first.gaps, ...first.diversification]) {
    if (c.front.some(q => q.w === p.w)) throw Error('weights alias input');
  }
  return first;
})));
"""

    def run(cases):
        completed = subprocess.run([node, "-e", source], input=json.dumps(cases),
                                   text=True, capture_output=True, check=True, timeout=5)
        return json.loads(completed.stdout)

    return run


def _case(C, mu, weights, options=None):
    C, mu, weights = np.asarray(C, dtype=float), np.asarray(mu, dtype=float), np.asarray(weights)
    means = weights @ mu
    risks = np.sqrt(np.maximum(0, np.einsum("bi,ij,bj->b", weights, C, weights)))
    return {"C": C.tolist(), "mu": mu.tolist(), "options": options,
            "front": [{"sig": float(s), "mu": float(m), "w": w.tolist()}
                      for w, s, m in zip(weights, risks, means)]}


def _two_asset(covariance=32., means=(4., 12.), options=None):
    # A two-asset mean fixes its weights uniquely. The minimum-variance
    # allocation follows from differentiating the scalar quadratic in t.
    C = np.array([[16., covariance], [covariance, 400.]])
    t_min = np.clip((16. - covariance) / (416. - 2 * covariance), 0., 1.)
    t = np.linspace(t_min, 1., 101)
    return _case(C, means, np.column_stack([1 - t, t]), options)



class TestPortOpportunities(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.opportunity_js = staticmethod(_opportunity_runner())

    def test_two_asset_hints_are_existing_points_and_fixed_weight_scenarios(self):
        case = _two_asset()
        result = self.opportunity_js([case])[0]
        assert 1 <= len(result["gaps"]) <= 3
        assert 1 <= len(result["diversification"]) <= 3
        assert_allclose(result["correlationShrink"], .2, atol=1e-9, rtol=1e-12)
        C, mu = np.asarray(case["C"]), np.asarray(case["mu"])
        S = np.asarray(result["scenarioC"])
        assert_allclose(S, .8 * C + .2 * np.diag(np.diag(C)), atol=1e-9, rtol=1e-12)
        assert_allclose(np.diag(S), np.diag(C), atol=1e-9, rtol=1e-12)
        assert np.linalg.eigvalsh(S).min() >= -1e-10
        for hint in result["gaps"] + result["diversification"]:
            w = np.asarray(hint["w"])
            t = (hint["y"] - 4.) / 8.
            assert_allclose(w, [1 - t, t], atol=1e-12, rtol=1e-12)
            exact_source = next(p for p in case["front"] if p["w"] == hint["w"])
            assert hint["baseX"] == exact_source["sig"]
            assert hint["y"] == exact_source["mu"]
            assert_allclose(hint["y"], w @ mu, atol=1e-12, rtol=1e-12)
            base_variance = 16 * (1 - t) ** 2 + 64 * t * (1 - t) + 400 * t ** 2
            assert_allclose(hint["baseX"] ** 2, base_variance, atol=1e-10, rtol=1e-12)
            if hint["kind"] == "gap":
                assert hint["x"] == exact_source["sig"]
                assert hint["nearestAssetDistance"] >= .18
            else:
                assert hint["kind"] == "diversification"
                assert_allclose(hint["x"] ** 2, base_variance - .2 * 64 * t * (1 - t), atol=1e-9, rtol=1e-12)
                assert_allclose(hint["x"], np.sqrt(w @ S @ w), atol=1e-10, rtol=1e-12)
                assert_allclose(hint["riskReduction"], hint["baseX"] - hint["x"], atol=1e-9, rtol=1e-12)
                assert_allclose(hint["riskReductionPct"], 100 * (1 - hint["x"] / hint["baseX"]), atol=1e-9, rtol=1e-12)
                assert "가정" in hint["label"] and "동일 비중" in hint["note"]


    def test_negative_and_zero_correlations_do_not_claim_improvement(self):
        cases = [_two_asset(covariance=c) for c in (-64., 0.)]
        for result in self.opportunity_js(cases):
            assert result["gaps"]
            assert result["diversification"] == []


    def test_equal_means_single_asset_and_duplicate_locations_do_not_claim_gaps(self):
        weights = np.column_stack([np.linspace(0, 1, 41), np.linspace(1, 0, 41)])
        cases = [
            _case([[16.]], [4.], [[1.]]),
            _case([[16., 4.], [4., 16.]], [4., 4.], weights),
            _case([[16., 8.], [8., 400.]], [4., 4.], weights),
            _case([[0., 0.], [0., 0.]], [4., 12.], weights),
        ]
        for result in self.opportunity_js(cases):
            assert result["gaps"] == []


    def test_options_off_strength_endpoints_and_input_changes(self):
        cases = [_two_asset(options={"maxPerKind": 0}),
                 _two_asset(options={"correlationShrink": 0}),
                 _two_asset(options={"correlationShrink": 1, "maxPerKind": 1}),
                 _two_asset(options={"correlationShrink": .1, "maxPerKind": 1})]
        disabled, zero, full, small = self.opportunity_js(cases)
        assert disabled["gaps"] == disabled["diversification"] == []
        assert zero["diversification"] == [] and zero["gaps"]
        assert len(full["gaps"]) == len(full["diversification"]) == 1
        assert full["scenarioC"] == [[16., 0.], [0., 400.]]
        assert full["diversification"][0]["riskReduction"] > small["diversification"][0]["riskReduction"]


    def test_invalid_covariance_and_mismatched_moments_are_rejected(self):
        valid = _two_asset()
        bad_matrix = []
        for matrix in ([[16., 32.], [31., 400.]], [[16., 100.], [100., 400.]],
                       [[-1., 0.], [0., 400.]], [[16., None], [None, 400.]], [[16.]]):
            case = copy.deepcopy(valid)
            case["C"] = matrix
            bad_matrix.append(case)
        for result in self.opportunity_js(bad_matrix):
            assert result["gaps"] == result["diversification"] == []
            assert result["scenarioC"] is None
        bad_points = []
        for field, value in (("sig", 1000.), ("mu", -1000.), ("w", [.4, .4]),
                             ("w", [-.1, 1.1]), ("w", [None, 1.])):
            case = copy.deepcopy(valid)
            for point in case["front"]:
                point[field] = value
            bad_points.append(case)
        for result in self.opportunity_js(bad_points):
            assert result["gaps"] == result["diversification"] == []


    def test_multivariate_covariance_identity_and_scale_invariance(self):
        rng = np.random.default_rng(530012)
        A = rng.uniform(.1, 1., (4, 4))
        C = A @ A.T * 50
        mu = np.array([2., 5., 8., 13.])
        # This test isolates moment handling from the frontier solver: each input
        # is a candidate allocation; annotations may retain only non-dominated ones.
        weights = rng.dirichlet(np.ones(4), 300)
        case = _case(C, mu, weights, {"maxPerKind": 3})
        scaled = _case(C * 100, mu * 10, weights, {"maxPerKind": 3})
        first, second = self.opportunity_js([case, scaled])
        assert first["diversification"]
        for hint in first["diversification"]:
            w = np.array(hint["w"])
            diagonal_variance = (w ** 2) @ np.diag(C)
            observed_change = hint["baseX"] ** 2 - hint["x"] ** 2
            assert_allclose(observed_change, .2 * (w @ C @ w - diagonal_variance), atol=1e-9, rtol=1e-12)
        # Gap geometry is unaffected by percent/decimal rescaling or draw ordering.
        assert [p["w"] for p in first["gaps"]] == [p["w"] for p in second["gaps"]]
        reversed_case = copy.deepcopy(case)
        reversed_case["front"].reverse()
        assert self.opportunity_js([reversed_case])[0] == first


    def test_sparse_input_and_near_coincident_assets_do_not_fabricate_coverage(self):
        sparse = _two_asset()
        sparse["front"] = [sparse["front"][0], sparse["front"][-1]]
        duplicate = _two_asset()
        duplicate["front"] = [duplicate["front"][0]] * 100
        cases = [sparse, duplicate,
                 _case([[16., 16.], [16., 16.]], [4., 4. + 1e-11], [[.5, .5], [.25, .75], [0., 1.]])]
        for result in self.opportunity_js(cases):
            assert result["gaps"] == []


if __name__ == "__main__":
    unittest.main()
