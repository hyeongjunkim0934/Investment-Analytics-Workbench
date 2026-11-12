"""Expected-return fallback to the realized sample mean is disclosed above the TAA table."""
import json
from pathlib import Path
import shutil
import subprocess


def test_historical_mean_fallback_warning():
    root = Path(__file__).resolve().parents[1]
    node = shutil.which("node")
    assert node, "Node.js is required to exercise the dashboard UI"
    result = subprocess.run(
        [node, str(root / "tests" / "port_hist_mu_note_probe.js")],
        cwd=root, capture_output=True, text=True, check=True, timeout=90,
    )
    assert all(json.loads(result.stdout).values())
