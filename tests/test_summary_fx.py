"""Quarterly FX summaries retain each model's information set and interval meaning."""
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def test_summary_fx_quantiles_information_dates_and_missing_data():
    node = shutil.which("node")
    assert node, "Node is required for summary FX adapter tests"
    result = subprocess.run([node, str(ROOT / "tests/summary_fx_probe.js")],
                            cwd=ROOT, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr[-10000:]
    measurements = json.loads(result.stdout)
    assert len(measurements) >= 10 and all(measurements.values())
