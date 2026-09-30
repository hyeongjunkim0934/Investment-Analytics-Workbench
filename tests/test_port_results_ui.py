"""Portfolio result tabs stay separate from editable financial state."""
import json
from pathlib import Path
import shutil
import subprocess


def test_portfolio_results_tabs_and_manual_inputs():
    root = Path(__file__).resolve().parents[1]
    node = shutil.which("node")
    assert node, "Node.js is required to exercise the dashboard UI"
    result = subprocess.run(
        [node, str(root / "tests" / "port_results_ui_probe.js")],
        cwd=root, capture_output=True, text=True, check=True, timeout=30,
    )
    assert all(json.loads(result.stdout).values())
