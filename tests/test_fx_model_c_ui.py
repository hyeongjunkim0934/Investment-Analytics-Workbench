"""Exercise model C through the actual dashboard renderer and published payload."""
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def test_fx_model_c_render_controls_exports_validation_and_lifecycle():
    node = shutil.which("node")
    assert node, "Node is required to exercise dashboard behavior"
    result = subprocess.run([node, str(ROOT / "tests/fx_model_c_ui_probe.js")],
                            cwd=ROOT, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr[-10000:]
    measured = json.loads(result.stdout)
    assert measured and all(measured.values())
    assert len(measured) >= 8


def test_fx_model_c_scripts_and_styles_are_loaded():
    html = (ROOT / "dashboard/index.html").read_text()
    assert html.index('src="fx-model-c.js?') < html.index('src="fx-outlook.js?') < html.index('src="app.js?')
    assert 'href="fx-model-c.css?' in html
    assert 'id="fxoutlook-model-c" role="tabpanel" aria-labelledby="fx-outlook-tab-modelC" hidden' in html


def test_actual_model_c_engine_payload_renders_in_browser_layer(tmp_path):
    import numpy as np
    import pandas as pd
    import fx_model_c

    dates = pd.date_range("2000-01-01", periods=180, freq="BME")
    k = np.arange(180)
    payload = fx_model_c.build({
        "bb:달러원": pd.Series(1200 * np.exp(.001 * k + .04 * np.sin(k / 7)), index=dates),
        "info:한국_1y": pd.Series(2 + .4 * np.cos(k / 8), index=dates),
        "info:UST1y": pd.Series(1 + .3 * np.sin(k / 9), index=dates),
    })
    assert payload["active"]
    assert [row["horizon_months"] for row in payload["horizons"]] == [1, 3, 6, 9, 12]
    artifact = tmp_path / "model_c.json"
    artifact.write_text(json.dumps(payload, allow_nan=False))
    env = dict(os.environ, FX_MODEL_C_FIXTURE=str(artifact))
    result = subprocess.run([shutil.which("node"), str(ROOT / "tests/fx_model_c_ui_probe.js")],
                            cwd=ROOT, capture_output=True, text=True, timeout=30, env=env)
    assert result.returncode == 0, result.stderr[-10000:]
