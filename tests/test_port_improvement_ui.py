"""Verify the actual hypothetical-asset panel against independently calculated moments."""
import json
from pathlib import Path
import shutil
import subprocess


def test_improvement_conditions_ui_preserves_financial_inputs_and_shows_correct_moments():
    root = Path(__file__).resolve().parents[1]
    node = shutil.which("node")
    assert node, "Node.js is required to exercise the actual dashboard UI"
    result = subprocess.run(
        [node, str(root / "tests" / "port_improvement_ui_probe.js")],
        cwd=root, capture_output=True, text=True, check=True, timeout=30,
    )
    measured = json.loads(result.stdout)
    assert measured["pass"]
    assert measured["verifiedRows"] >= 7
    for invariant in ("independentMoments", "benchmarkOrder", "unchangedFinancialInputs",
                      "persistence", "invalidRejected", "zeroRiskHandled", "csv"):
        assert measured[invariant]
