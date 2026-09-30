"""Verify hedge overlays, hover/CSV, and fixed-benchmark TE against return observations."""
import json
from pathlib import Path
import shutil
import subprocess


def test_portfolio_fx_hedge_controls_and_covariance():
    root = Path(__file__).resolve().parents[1]
    node = shutil.which("node")
    assert node, "Node.js is required to exercise the dashboard UI"
    result = subprocess.run(
        [node, str(root / "tests" / "port_hedge_ui_probe.js")],
        cwd=root, capture_output=True, text=True, check=True, timeout=45,
    )
    measured = json.loads(result.stdout)
    assert all(measured.values())
