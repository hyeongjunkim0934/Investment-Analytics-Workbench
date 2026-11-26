"""Forward-implied hedge premium path: real renderer, identities, track record and lifecycle."""
import json
from pathlib import Path
import subprocess


def test_forward_implied_premium_path_ui():
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(['node', str(root / 'tests/hedge_forward_ui_probe.js')],
                            cwd=root, capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr[-6000:]
    measured = json.loads(result.stdout)
    assert measured and all(measured.values())
