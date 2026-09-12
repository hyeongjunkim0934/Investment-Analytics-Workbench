"""Direct measured-risk lambda linkage, verified independently by closed form."""
from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess

import numpy as np
import pytest


@pytest.fixture(scope="module")
def linkage():
    node = shutil.which("node")
    assert node, "Node.js is required to verify production risk linkage"
    probe = Path(__file__).with_name("risk_lambda_integration_probe.js")
    process = subprocess.run([node, str(probe)], capture_output=True, text=True, timeout=30)
    assert process.returncode == 0, process.stdout[-2000:] + process.stderr[-4000:]
    return json.loads(process.stdout)


def expected_weight(mu, covariance, lam):
    """Eliminate w2=1-w1, differentiate decimal-return MVO, then clip to simplex."""
    if lam == 0:
        return float(mu[0] > mu[1])
    a, cross, b = covariance[0][0], covariance[0][1], covariance[1][1]
    return float(np.clip((b - cross + 100 * (mu[0] - mu[1]) / lam)
                         / (a + b - 2 * cross), 0, 1))


def assert_path(case, dates, scores, mu, covariance):
    assert case["charts"] == 1 and case["csv"] is not None, case["text"]
    assert case["engine"]["keys"] == ["국내채권", "해외주식"]
    np.testing.assert_allclose(case["engine"]["mu"], mu, rtol=0, atol=1e-12)
    np.testing.assert_allclose(case["engine"]["C"], covariance, rtol=0, atol=1e-12)
    rows = list(reversed(case["csv"]["rows"]))
    assert [row[0] for row in rows] == dates  # Includes final four-day partial week.
    for row, score in zip(rows, scores):
        assert row[1] == row[2] == score  # No rounding, normalization, or legacy lambda.
        bond = expected_weight(mu, covariance, score)
        np.testing.assert_allclose(row[3:], [100 * bond, 100 * (1 - bond)], rtol=0, atol=2e-5)
        assert abs(sum(row[3:]) - 100) < 1e-8


def test_both_risk_layers_directly_drive_each_dated_optimum(linkage):
    for case, scores in [("baseline", "scores"), ("potentialPath", "potential")]:
        assert_path(linkage[case], linkage["dates"], linkage[scores], [3, 7], [[16, 8], [8, 100]])
    # This economic boundary condition is independent of a particular QP implementation.
    weights = np.array([row[3:] for row in linkage["baseline"]["csv"]["rows"]]) / 100
    lambdas = np.array([row[2] for row in linkage["baseline"]["csv"]["rows"]])
    variance = np.einsum("ij,jk,ik->i", weights, [[16, 8], [8, 100]], weights)
    assert np.all(np.diff(variance[np.argsort(lambdas)]) <= 1e-6)


def test_retired_institution_lambda_does_not_rescale_measured_risk(linkage):
    assert linkage["legacyChanged"]["csv"] == linkage["baseline"]["csv"]


@pytest.mark.parametrize("case,mu,covariance", [
    ("meanChanged", [6, 7], [[16, 8], [8, 100]]),
    ("volatilityChanged", [3, 7], [[64, 16], [16, 100]]),
    ("correlationChanged", [3, 7], [[16, -20], [-20, 100]]),
])
def test_portfolio_input_changes_recompute_without_stale_allocations(linkage, case, mu, covariance):
    assert_path(linkage[case], linkage["dates"], linkage["scores"], mu, covariance)
    assert linkage[case]["csv"] != linkage["baseline"]["csv"]


@pytest.mark.parametrize("case", ["missingPortfolio", "inactivePortfolio", "missingWindow", "invalidRisk"])
def test_unusable_portfolio_clears_results_without_institutional_fallback(linkage, case):
    result = linkage[case]
    assert result["charts"] == 0 and result["csv"] is None
    assert "보류" in result["text"]


def test_failed_allocation_payload_is_reported_without_a_render_exception(linkage):
    result = linkage["missingAllocationPayload"]
    assert not result["threw"], result.get("error")
    assert result["charts"] == 0 and "보류" in result["text"]


def test_portfolio_only_payload_needs_no_retired_institutional_state(linkage):
    assert_path(linkage["portfolioOnlyPayload"], linkage["dates"], linkage["scores"],
                [3, 7], [[16, 8], [8, 100]])
