"""CMA inputs: independent mixture moments and actual allocation/UI integration."""
from __future__ import annotations

import json
import math
from pathlib import Path
import shutil
import subprocess

import pytest


@pytest.fixture(scope="module")
def cma():
    node = shutil.which("node")
    assert node, "CMA 화면·계산 검증에는 Node.js가 필요합니다."
    probe = Path(__file__).with_name("cma_ui_probe.js")
    run = subprocess.run([node, str(probe)], capture_output=True, text=True, timeout=60)
    assert run.returncode == 0, run.stderr[-8000:]
    return json.loads(run.stdout)


def test_mixture_mean_and_total_variance_independently(cma):
    # Eight equally likely point observations reproduce the conditional moments:
    # optimistic 10±8 (2 points), neutral 4±5 repeated (4), pessimistic −2±12 (2).
    # Population, not sample, variance is appropriate for a probability distribution.
    points = [18, 2, 9, -1, 9, -1, 10, -14]
    mean = sum(points) / len(points)
    variance = sum((value - mean) ** 2 for value in points) / len(points)
    assert mean == 4
    assert variance == 82.5
    assert cma["moments"]["mu"] == pytest.approx(mean)
    assert cma["moments"]["sig"] == pytest.approx(math.sqrt(variance))
    assert cma["moments"]["sig"] != pytest.approx(0.25 * 8 + 0.5 * 5 + 0.25 * 12)
    assert all(cma["boundaries"].values()), cma["boundaries"]


def test_only_valid_explicitly_applied_inputs_replace_manual_values(cma):
    assert all(cma["application"].values()), cma["application"]
    assert all(cma["invalidDraft"].values()), cma["invalidDraft"]
    assert all(cma["persistence"].values()), cma["persistence"]


def test_covariance_hedge_and_linked_risk_share_cma_assumptions(cma):
    assert all(cma["model"].values()), cma["model"]
    assert cma["modelValues"]["covariance"] == pytest.approx(0.3 * 3.5 * math.sqrt(82.5))
    assert cma["modelValues"]["hedgedMean"] == pytest.approx(4 - 0.5 * 2.4)
    assert cma["modelValues"]["hedgedVariance"] == pytest.approx(82.5 - 5 * math.sqrt(82.5) + 25)
    assert cma["modelValues"]["hedgedCovariance"] == pytest.approx(0.3 * 3.5 * math.sqrt(82.5) - 3.5)


def test_asset_hover_keyboard_and_cma_route(cma):
    assert all(cma["hover"].values()), cma["hover"]
    assert all(cma["navigation"].values()), cma["navigation"]
    assert cma["noNetwork"]


def test_bad_saved_content_and_missing_market_data_are_safe(cma):
    assert all(cma["storageSafety"].values()), cma["storageSafety"]
