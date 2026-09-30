"""Two portfolios preserve independent inputs and share one enforced constraint model."""
import json
from pathlib import Path
import shutil
import subprocess


def test_two_portfolios_migration_constraints_and_live_ui():
    root = Path(__file__).resolve().parents[1]
    node = shutil.which("node")
    assert node, "Node.js is required to exercise the dashboard UI"
    result = subprocess.run(
        [node, str(root / "tests" / "port_comparison_ui_probe.js")],
        cwd=root, capture_output=True, text=True, check=True, timeout=90,
    )
    assert all(json.loads(result.stdout).values())
