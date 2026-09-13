"""Run the real dashboard hint controls, canvas visibility and tooltips."""
import json
from pathlib import Path
import shutil
import subprocess


def test_frontier_opportunity_controls_and_independent_displayed_moments():
    root = Path(__file__).resolve().parents[1]
    node = shutil.which("node")
    assert node, "Node.js is required to exercise the actual dashboard UI"
    result = subprocess.run(
        [node, str(root / "tests" / "port_opportunities_ui_probe.js")],
        cwd=root, capture_output=True, text=True, check=True, timeout=20,
    )
    measured = json.loads(result.stdout)
    assert measured["pass"]
    assert 0 < measured["gaps"] <= 3
    assert 0 < measured["diversification"] <= 3
    assert measured["independentMoments"]
    assert measured["unchangedFinancialInputs"]
    assert measured["hiddenHintsExcluded"]
    assert measured["persistence"]
