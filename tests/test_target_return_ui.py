"""Target Return cards share applied inputs and update only on explicit Apply."""
import json
from pathlib import Path
import shutil
import subprocess


def test_target_return_cards_and_apply_boundary():
    root = Path(__file__).resolve().parents[1]
    node = shutil.which("node")
    assert node, "Node.js is required to exercise the dashboard UI"
    result = subprocess.run([node, str(root / "tests/target_return_ui_probe.js")],
                            cwd=root, capture_output=True, text=True, check=True, timeout=60)
    assert all(json.loads(result.stdout).values())
