"""SAA/TAA scenarios preserve independent drafts and validated applied results."""
import json
from pathlib import Path
import shutil
import subprocess


def test_saa_taa_scenarios_and_residual_weights():
    root = Path(__file__).resolve().parents[1]
    node = shutil.which("node")
    assert node, "Node.js is required to exercise the dashboard UI"
    result = subprocess.run(
        [node, str(root / "tests" / "port_scenarios_ui_probe.js")],
        cwd=root, capture_output=True, text=True, check=True, timeout=90,
    )
    assert all(json.loads(result.stdout).values())
