"""Execute hedge chart controls against synthetic data, without private sources."""
import json
from pathlib import Path
import shutil
import subprocess


def test_hedge_analytics_charts_controls_exports_and_fallback():
    root = Path(__file__).resolve().parents[1]
    node = shutil.which("node")
    assert node, "Node.js is required to exercise the dashboard UI"
    result = subprocess.run(
        [node, str(root / "tests" / "hedge_analytics_ui_probe.js")],
        cwd=root, capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr[-6000:]
    measured = json.loads(result.stdout)
    assert measured and all(measured.values())
