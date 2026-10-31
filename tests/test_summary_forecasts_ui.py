"""Quarterly summary integration uses real DOM events, adapters and downloads."""
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def test_summary_forecasts_render_values_settings_and_csv():
    result = subprocess.run([shutil.which("node"), str(ROOT / "tests/summary_forecasts_ui_probe.js")],
                            cwd=ROOT, capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr[-10000:]
    assert all(json.loads(result.stdout).values())


def test_summary_forecasts_assets_and_container_are_wired():
    html = (ROOT / "dashboard/index.html").read_text()
    assert html.index('id="summary-cards"') < html.index('id="summary-forecasts"') < html.index('id="risk"')
    order = [html.index(f'src="{name}.js?') for name in
             ("fx-model-c", "fx-outlook", "hedge-optimizer", "hedge-model-b", "summary-fx", "summary-hedge", "summary-forecasts", "app")]
    assert order == sorted(order)
    assert 'href="summary-forecasts.css?' in html
