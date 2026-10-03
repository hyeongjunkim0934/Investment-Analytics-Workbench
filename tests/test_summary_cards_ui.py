"""Summary proposals use applied portfolio assumptions and preserve failed updates."""
import json
from pathlib import Path
import shutil
import subprocess


def test_summary_cards_applied_results_and_invalid_states():
    root = Path(__file__).resolve().parents[1]
    node = shutil.which("node")
    assert node, "Node.js is required to exercise the dashboard UI"
    result = subprocess.run(
        [node, str(root / "tests" / "summary_cards_ui_probe.js")],
        cwd=root, capture_output=True, text=True, check=True, timeout=60,
    )
    assert all(json.loads(result.stdout).values())
