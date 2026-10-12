"""Named TAA summaries and owner-managed snapshot sets run through production JS."""
import json
from pathlib import Path
import shutil
import subprocess


def test_summary_scenario_identity_and_owner_snapshot_lifecycle():
    root = Path(__file__).resolve().parents[1]
    node = shutil.which("node")
    assert node, "Node.js is required to exercise the dashboard UI"
    result = subprocess.run(
        [node, str(root / "tests" / "summary_groups_ui_probe.js")],
        cwd=root, capture_output=True, text=True, check=True, timeout=90,
    )
    assert all(json.loads(result.stdout).values())
