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


def expected_weight(mu, covariance, lam, lower=0, upper=1):
    """Eliminate w2=1-w1, differentiate decimal-return MVO, then clip to simplex."""
    if lam == 0:
        return upper if mu[0] > mu[1] else lower
    a, cross, b = covariance[0][0], covariance[0][1], covariance[1][1]
    return float(np.clip((b - cross + 100 * (mu[0] - mu[1]) / lam)
                         / (a + b - 2 * cross), lower, upper))


def assert_path(case, dates, scores, mu, covariance, scale=1, lower=0, upper=1):
    assert case["charts"] == 1 and case["csv"] is not None, case["text"]
    assert case["engine"]["keys"] == ["국내채권", "해외주식"]
    np.testing.assert_allclose(case["engine"]["mu"], mu, rtol=0, atol=1e-12)
    np.testing.assert_allclose(case["engine"]["C"], covariance, rtol=0, atol=1e-12)
    rows = list(reversed(case["csv"]["rows"]))
    assert [row[0] for row in rows] == dates  # Includes final four-day partial week.
    for row, score in zip(rows, scores):
        assert row[1] == score  # Measured score remains raw at either lambda scale.
        assert row[2] == score * scale
        bond = expected_weight(mu, covariance, score * scale, lower, upper)
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


def test_tenth_scale_matches_closed_form_for_both_layers(linkage):
    for case, scores in [("scaled", "scores"), ("scaledPotential", "potential")]:
        assert_path(linkage[case], linkage["dates"], linkage[scores], [3, 7],
                    [[16, 8], [8, 100]], scale=.1)
    assert linkage["scaled"]["csv"] != linkage["baseline"]["csv"]


def test_asset_limits_and_free_modes_match_independent_clipping(linkage):
    for case, score_key, scale in [("constrained", "scores", 1),
                                   ("constrainedPotential", "potential", 1),
                                   ("constrainedScaled", "scores", .1)]:
        assert_path(linkage[case], linkage["dates"], linkage[score_key], [3, 7],
                    [[16, 8], [8, 100]], scale=scale, lower=.2, upper=.45)
    assert linkage["freeWithBounds"]["csv"] == linkage["baseline"]["csv"]
    assert linkage["freePotentialWithBounds"]["csv"] == linkage["potentialPath"]["csv"]
    points = linkage["constrained"]["points"]
    assert len(points) == 8
    for layer, score_key in [("stress", "scores"), ("vuln", "potential")]:
        for mode, lo, hi in [("constrained", .2, .45), ("free", 0, 1)]:
            actual = {p["asset"]: p["weight"] for p in points if p["layer"] == layer and p["mode"] == mode}
            bond = expected_weight([3, 7], [[16, 8], [8, 100]], linkage[score_key][-1], lo, hi)
            np.testing.assert_allclose([actual["국내채권"], actual["해외주식"]],
                                       [100 * bond, 100 * (1 - bond)], rtol=0, atol=2e-5)


def test_infeasible_or_malformed_limits_do_not_contaminate_free_comparison(linkage):
    for name in ["infeasibleLower", "infeasibleUpper", "malformedBounds"]:
        case = linkage[name]
        assert case["charts"] == 0 and case["csv"] is None
        assert "보류" in case["text"]
        assert len(case["points"]) == 4
        assert all(point["mode"] == "free" for point in case["points"])
    assert linkage["infeasibleFree"]["csv"] == linkage["baseline"]["csv"]


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
