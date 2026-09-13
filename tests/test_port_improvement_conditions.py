"""Hypothetical new assets: independent covariance and two-asset identities."""
from __future__ import annotations

import copy
import json
from pathlib import Path
import shutil
import subprocess
import unittest

import numpy as np
from numpy.testing import assert_allclose


def _condition_runner():
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js is required to exercise portfolio improvement conditions")
    source = (Path(__file__).resolve().parents[1] / "dashboard" / "port-opportunities.js").read_text()
    source += """
const cases = JSON.parse(require('fs').readFileSync(0, 'utf8'), (_, v) =>
  v === '__NaN' ? NaN : v === '__Infinity' ? Infinity : v);
function freeze(x) {
  if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); }
  return x;
}
process.stdout.write(JSON.stringify(cases.map(c => {
  const before = JSON.stringify(c);
  freeze(c);
  const first = portImprovementConditions(c.C, c.mu, c.references, c.options);
  const repeat = portImprovementConditions(c.C, c.mu, c.references, c.options);
  if (JSON.stringify(c) !== before) throw Error('inputs mutated');
  if (JSON.stringify(first) !== JSON.stringify(repeat)) throw Error('nondeterministic');
  for (const row of first.rows) {
    if (c.references.some(p => row.w === p.w || row.mixWeights === p.w))
      throw Error('weights alias input');
    if (row.augmentedC === c.C || row.augmentedC.some(r => c.C.some(s => r === s)))
      throw Error('covariance aliases input');
  }
  return first;
})));
"""

    def run(cases):
        result = subprocess.run([node, "-e", source], input=json.dumps(cases), text=True,
                                capture_output=True, check=True, timeout=5)
        return json.loads(result.stdout)

    return run


def _case(C=None, mu=None, weights=None, options=None):
    C = np.asarray([[16., 20.], [20., 100.]] if C is None else C, dtype=float)
    mu = np.asarray([4., 12.] if mu is None else mu, dtype=float)
    weights = [[1., 0.], [.5, .5], [0., 1.]] if weights is None else weights
    # These default two-asset allocations are on the exact efficient branch:
    # the scalar minimum-variance weight of asset 2 is negative, clipped to 0.
    references = []
    for i, weights_i in enumerate(weights):
        w = np.asarray(weights_i)
        references.append({"label": f"reference-{i}", "w": w.tolist(),
                           "mu": float(w @ mu), "sig": float(np.sqrt(max(0., w @ C @ w)))})
    result = {"C": C.tolist(), "mu": mu.tolist(), "references": references}
    if options is not None:
        result["options"] = options
    return result


class TestPortImprovementConditions(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.conditions_js = staticmethod(_condition_runner())

    def assert_matrix_and_scalar_identities(self, case, result):
        self.assertIsNone(result["error"])
        self.assertEqual(len(result["rows"]), len(case["references"]))
        C, mu = np.asarray(case["C"]), np.asarray(case["mu"])
        opts = case.get("options", {})
        q, factor, rho = opts.get("weight", .1), opts.get("sigmaFactor", 1.), opts.get("correlation", 0.)
        for reference, row in zip(case["references"], result["rows"]):
            w = np.asarray(reference["w"])
            variance, mean = float(w @ C @ w), float(w @ mu)
            sp, sn = np.sqrt(variance), np.sqrt(variance) * factor
            block = np.asarray(row["augmentedC"])
            mixed = np.r_[w * (1 - q), q]
            covariance = np.asarray(row["covariance"])
            # NumPy eigendecomposition is independent of the browser's PSD test.
            self.assertGreaterEqual(np.linalg.eigvalsh(block).min(), -1e-9 * max(1., np.diag(block).max()))
            assert_allclose(block, block.T, atol=1e-12, rtol=1e-12)
            assert_allclose(block[:-1, :-1], C, atol=1e-12, rtol=1e-12)
            assert_allclose(block[:-1, -1], covariance, atol=1e-12, rtol=1e-12)
            assert_allclose(block[-1, -1], sn ** 2, atol=1e-10, rtol=1e-12)
            assert_allclose(row["mixWeights"], mixed, atol=1e-12, rtol=1e-12)
            assert_allclose(sum(row["mixWeights"]), 1., atol=1e-12, rtol=1e-12)
            assert_allclose([row["baseMu"], row["assetMuMin"], row["mixMu"]], mean,
                            atol=1e-12, rtol=1e-12)
            assert_allclose(row["baseSigma"], sp, atol=1e-12, rtol=1e-12)
            assert_allclose(row["assetSigma"], sn, atol=1e-12, rtol=1e-12)
            assert_allclose(row["mixSigma"] ** 2, mixed @ block @ mixed, atol=1e-10, rtol=1e-12)
            # Collapse all existing assets into P. This scalar variance formula
            # independently checks the augmented-matrix moment calculation.
            scalar_variance = (1 - q) ** 2 * variance + q ** 2 * sn ** 2 + 2 * q * (1 - q) * rho * sp * sn
            assert_allclose(row["mixSigma"] ** 2, scalar_variance, atol=1e-10, rtol=1e-12)
            assert_allclose(row["riskReduction"], sp - row["mixSigma"], atol=1e-12, rtol=1e-12)
            if sp > 0 and sn > 0:
                assert_allclose(w @ covariance / (sp * sn), rho, atol=1e-12, rtol=1e-12)
                # Projection residual, distinct from a blanket equal-correlation assumption.
                residual = sn ** 2 - covariance @ np.linalg.pinv(C) @ covariance
                assert_allclose(residual, sn ** 2 * (1 - rho ** 2), atol=1e-9, rtol=1e-11)
                threshold = (variance - (1 - q) ** 2 * variance - q ** 2 * sn ** 2) / (2 * q * (1 - q) * sp * sn)
                assert_allclose(row["correlationLimit"], threshold, atol=1e-12, rtol=1e-12)
                for i, asset_correlation in enumerate(row["assetCorrelations"]):
                    if C[i, i] == 0:
                        self.assertIsNone(asset_correlation)
                    else:
                        assert_allclose(asset_correlation, covariance[i] / sn / np.sqrt(C[i, i]),
                                        atol=1e-12, rtol=1e-12)
                        self.assertLessEqual(abs(asset_correlation), 1.)
            else:
                self.assertIsNone(row["correlation"])
                self.assertIsNone(row["correlationLimit"])
                self.assertTrue(all(r is None for r in row["assetCorrelations"]))
                assert_allclose(covariance, 0., atol=1e-12, rtol=1e-12)
            expected_gain = sp - np.sqrt(max(0., scalar_variance))
            if abs(expected_gain) > 1e-7:
                self.assertEqual(row["improves"], expected_gain > 0)

    def test_default_conditions_preserve_mean_and_reduce_risk(self):
        case = _case()
        result = self.conditions_js([case])[0]
        self.assert_matrix_and_scalar_identities(case, result)
        for row in result["rows"]:
            self.assertTrue(row["improves"])
            self.assertEqual(row["correlation"], 0.)
            assert_allclose(row["mixSigma"] / row["baseSigma"], np.sqrt(.82), atol=1e-12, rtol=1e-12)

    def test_correlation_endpoints_and_fixed_allocation_identity(self):
        cases = [_case(options={"weight": q, "sigmaFactor": factor, "correlation": rho})
                 for q in (.1, .5, .9) for factor in (0., .5, 1., 3.) for rho in (-1., 0., 1.)]
        for case, result in zip(cases, self.conditions_js(cases)):
            with self.subTest(options=case["options"]):
                self.assert_matrix_and_scalar_identities(case, result)

    def test_clone_high_risk_and_exact_correlation_boundary_do_not_improve(self):
        boundary = ((2 - .5) - .5 * 2 ** 2) / (2 * (1 - .5) * 2)
        scenarios = [
            {"correlation": 1., "sigmaFactor": 1.},
            {"correlation": 1., "sigmaFactor": 3.},
            {"correlation": 0., "sigmaFactor": 100.},
            {"weight": .5, "correlation": 0., "sigmaFactor": 3.},
            {"weight": .5, "correlation": boundary, "sigmaFactor": 2.},
        ]
        cases = [_case(options=opts) for opts in scenarios]
        for case, result in zip(cases, self.conditions_js(cases)):
            self.assert_matrix_and_scalar_identities(case, result)
            self.assertTrue(all(not row["improves"] for row in result["rows"]))

    def test_singular_and_zero_variance_assets_are_explicit(self):
        cases = [
            _case([[16., 16.], [16., 16.]], [4., 4.], [[.5, .5]], {"correlation": rho})
            for rho in (-1., 0., 1.)
        ]
        cases += [_case([[0., 0.], [0., 100.]], [2., 8.], [[1., 0.], [.5, .5]], {"correlation": .5}),
                  _case([[0.]], [2.], [[1.]]),
                  _case(options={"sigmaFactor": 0., "correlation": 1.})]
        results = self.conditions_js(cases)
        for case, result in zip(cases, results):
            self.assert_matrix_and_scalar_identities(case, result)
        zero = results[3]["rows"][0]
        self.assertFalse(zero["improves"])
        self.assertEqual(zero["riskReduction"], 0.)
        self.assertIn("0", zero["reason"])
        self.assertIsNone(results[3]["rows"][1]["assetCorrelations"][0])
        self.assertTrue(all(row["improves"] for row in results[-1]["rows"]))

    def test_invalid_covariances_are_rejected_including_multivariate_non_psd(self):
        cases = []
        for C in ([[16.]], [[16., 20.], [19., 100.]], [[-1., 0.], [0., 100.]],
                  [[16., 50.], [50., 100.]], [[16., "__NaN"], ["__NaN", 100.]],
                  [[16., 20.], [20., "__Infinity"]]):
            case = _case()
            case["C"] = C
            cases.append(case)
        cases.append({"C": [[1., -.9, -.9], [-.9, 1., -.9], [-.9, -.9, 1.]],
                      "mu": [1., 2., 3.], "references": [{"w": [1., 0., 0.]}]})
        for result in self.conditions_js(cases):
            self.assertEqual(result["rows"], [])
            self.assertTrue(result["error"])

    def test_invalid_references_and_options_fail_without_partial_rows(self):
        cases = []
        for key, value in (("w", [.2, .2]), ("w", [-.1, 1.1]), ("w", [None, 1.]),
                           ("mu", 100.), ("sig", 100.), ("sig", "__NaN")):
            case = _case()
            case["references"][-1][key] = value
            cases.append(case)
        case = _case()
        case["references"] *= 2
        cases.append(case)
        for key, values in (("weight", (0., 1., -.1, "__NaN", "__Infinity")),
                            ("sigmaFactor", (-1., "__NaN", "__Infinity")),
                            ("correlation", (-1.1, 1.1, "__NaN", "__Infinity"))):
            for value in values:
                cases.append(_case(options={key: value}))
        for value in (None, [], "invalid"):
            case = _case()
            case["options"] = value
            cases.append(case)
        bad_mu = _case()
        bad_mu["mu"][0] = "__NaN"
        cases.append(bad_mu)
        for result in self.conditions_js(cases):
            self.assertEqual(result["rows"], [])
            self.assertTrue(result["error"])

    def test_multivariate_correlations_units_and_optional_moments(self):
        A = np.array([[1., .2, .1], [.4, 1.5, .2], [.1, .3, 2.]])
        C = A @ A.T * 20
        weights = [[.4, .3, .3], [.2, .2, .6]]
        mu = np.array([3., 6., 11.])
        options = {"weight": .2, "sigmaFactor": 1.3, "correlation": -.4}
        first = _case(C, mu, weights, options)
        scaled = _case(C * 100, mu * 10, weights, options)
        optional = copy.deepcopy(first)
        for reference in optional["references"]:
            reference.pop("mu")
            reference.pop("sig")
        a, b, c = self.conditions_js([first, scaled, optional])
        self.assertEqual(a, c)
        self.assert_matrix_and_scalar_identities(first, a)
        self.assert_matrix_and_scalar_identities(scaled, b)
        for unscaled, rescaled in zip(a["rows"], b["rows"]):
            self.assertNotEqual(unscaled["assetCorrelations"][0], unscaled["assetCorrelations"][1])
            assert_allclose(unscaled["assetCorrelations"], rescaled["assetCorrelations"], atol=1e-12, rtol=1e-12)
            assert_allclose(unscaled["mixWeights"], rescaled["mixWeights"], atol=1e-12, rtol=1e-12)
            assert_allclose(unscaled["correlationLimit"], rescaled["correlationLimit"], atol=1e-12, rtol=1e-12)
            for field in ("baseMu", "baseSigma", "assetMuMin", "assetSigma", "mixMu", "mixSigma", "riskReduction"):
                assert_allclose(rescaled[field], unscaled[field] * 10, atol=1e-10, rtol=1e-12)
            self.assertEqual(unscaled["improves"], rescaled["improves"])

    def test_empty_references_is_valid_and_zero_variance_is_not_repaired(self):
        case = _case()
        case["references"] = []
        self.assertEqual(self.conditions_js([case])[0], {"rows": [], "error": None})
        result = self.conditions_js([_case([[0.]], [2.], [[1.]])])[0]
        self.assertEqual(result["rows"][0]["augmentedC"], [[0., 0.], [0., 0.]])


if __name__ == "__main__":
    unittest.main()
