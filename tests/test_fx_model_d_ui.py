"""Run the actual model-D renderer, controls and exports in the DOM harness."""
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def test_model_d_renderer_controls_contract_and_lifecycle():
    node = shutil.which("node")
    assert node, "Node is required for the dashboard probes"
    result = subprocess.run([node, str(ROOT / "tests/fx_model_d_ui_probe.js")],
                            cwd=ROOT, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr[-10000:]
    measured = json.loads(result.stdout)
    assert len(measured) >= 8 and all(measured.values())


def test_model_d_script_style_and_panel_are_connected():
    html = (ROOT / "dashboard/index.html").read_text()
    assert html.index('src="fx-model-d.js?') < html.index('src="fx-outlook.js?') < html.index('src="app.js?')
    assert 'href="fx-model-d.css?' in html
    assert 'id="fxoutlook-model-d" role="tabpanel" aria-labelledby="fx-outlook-tab-modelD" hidden' in html


def test_model_d_engine_payload_reaches_real_renderer(tmp_path):
    import os
    import numpy as np
    import pandas as pd
    import fx_model_d

    rng = np.random.default_rng(31)
    series = pd.Series(1300 * np.exp(np.r_[0, np.cumsum(rng.normal(0, .006, 530))]),
                       index=pd.bdate_range("2020-01-01", periods=531))
    payload = fx_model_d.build({fx_model_d.PRIMARY_SOURCE: series})
    assert payload["active"]
    fixture = tmp_path / "model_d.json"
    fixture.write_text(json.dumps(payload, allow_nan=False))
    env = dict(os.environ, FX_MODEL_D_FIXTURE=str(fixture))
    result = subprocess.run([shutil.which("node"), str(ROOT / "tests/fx_model_d_ui_probe.js")],
                            cwd=ROOT, capture_output=True, text=True, timeout=30, env=env)
    assert result.returncode == 0, result.stderr[-10000:]
