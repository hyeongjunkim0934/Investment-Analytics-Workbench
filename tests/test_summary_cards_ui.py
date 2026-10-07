"""Summary applied-state UI plus an independent central-normal interval oracle."""
import json
from pathlib import Path
import shutil
from statistics import NormalDist
import subprocess

import pytest


@pytest.fixture(scope="module")
def summary_probe():
    root = Path(__file__).resolve().parents[1]
    node = shutil.which("node")
    assert node, "Node.js is required to exercise the dashboard UI"
    result = subprocess.run(
        [node, str(root / "tests" / "summary_cards_ui_probe.js")],
        cwd=root, capture_output=True, text=True, check=True, timeout=60,
    )
    return json.loads(result.stdout)


def test_summary_cards_applied_results_and_invalid_states(summary_probe):
    assert all(value is True for name, value in summary_probe.items() if name != "rangeCases")


def test_summary_return_ranges_match_independent_normal_quantiles(summary_probe):
    normal = NormalDist()
    cases = summary_probe["rangeCases"]
    assert len(cases) == 4
    for case in cases:
        mu, sigma = case["metrics"]["mu"], case["metrics"]["sig"]
        rows = case["rows"]
        assert [row["probability"] for row in rows] == [68, 90, 95, 99]
        for row in rows:
            probability = row["probability"] / 100
            z = normal.inv_cdf((1 + probability) / 2)
            assert row["z"] == pytest.approx(z, abs=2e-12)
            assert row["lower"] == pytest.approx(mu - z * sigma, abs=2e-11)
            assert row["upper"] == pytest.approx(mu + z * sigma, abs=2e-11)
            if sigma:
                actual_coverage = normal.cdf((row["upper"] - mu) / sigma) - normal.cdf(
                    (row["lower"] - mu) / sigma
                )
                assert actual_coverage == pytest.approx(probability, abs=1e-12)
            else:
                assert row["lower"] == row["upper"] == mu
