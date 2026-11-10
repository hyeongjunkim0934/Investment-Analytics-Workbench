import json
from pathlib import Path
import subprocess


def test_common_validation_controls_data_and_csv():
    result = subprocess.run(["node", str(Path(__file__).with_name("fx_validation_ui_probe.js"))],
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    assert all(json.loads(result.stdout).values())
