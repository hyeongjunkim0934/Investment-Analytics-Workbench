"""Financial statistics, date controls and renderer lifecycle for USD model A."""
import json
from pathlib import Path
import subprocess


def test_usd_cip_statistics_and_ui():
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(['node', str(root / 'tests/hedge_cip_ui_probe.js')],
                            cwd=root, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr[-6000:]
    measured = json.loads(result.stdout)
    assert measured and all(measured.values())
