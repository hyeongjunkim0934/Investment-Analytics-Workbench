"""Scenario visibility never changes nominal portfolio calculations."""
import json
from pathlib import Path
import shutil
import subprocess


def test_frontier_optional_scenarios_and_baseline():
    root = Path(__file__).resolve().parents[1]
    node = shutil.which("node")
    assert node, "Node.js is required to exercise the frontier UI"
    result = subprocess.run(
        [node, str(root / "tests" / "frontier_visibility_ui_probe.js")],
        cwd=root, capture_output=True, text=True, check=True, timeout=45,
    )
    assert all(json.loads(result.stdout).values())
