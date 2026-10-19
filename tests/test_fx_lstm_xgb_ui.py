"""환율모형B 화면 — 실제 렌더러를 node 에서 실행해 지표·조작·저장·정리·오류 처리를 잰다."""

import json
from html.parser import HTMLParser
from pathlib import Path
import shutil
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def test_fx_lstm_xgb_panel_metrics_controls_storage_and_lifecycle():
    node = shutil.which("node")
    assert node, "Node.js is required to exercise the dashboard UI"
    result = subprocess.run(
        [node, str(ROOT / "tests" / "fx_lstm_xgb_ui_probe.js")],
        cwd=ROOT, capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stderr[-8000:]
    measured = json.loads(result.stdout)
    assert measured and all(measured.values())
    assert {
        "inactiveAndMissingGraceful", "defaultViewAndChartData", "metricsMatchOracle",
        "regimeThresholdsValidatedAndPersisted", "comboModelRangeSwitches", "rawCsvAndTable",
        "hoverTooltip", "viewPersistenceAndCleanup", "tabResizeNameEditingConsensus", "malformedGraceful",
    } <= measured.keys()


def test_fx_lstm_xgb_script_loaded_before_outlook_and_app():
    class Index(HTMLParser):
        def __init__(self):
            super().__init__()
            self.scripts = []

        def handle_starttag(self, tag, attrs):
            attrs = dict(attrs)
            if tag == "script" and attrs.get("src"):
                self.scripts.append(attrs["src"].split("?")[0])

    index = Index()
    index.feed((ROOT / "dashboard" / "index.html").read_text())
    assert index.scripts.index("fx-lstm-xgb.js") < index.scripts.index("fx-outlook.js")
    assert index.scripts.index("fx-outlook.js") < index.scripts.index("app.js")


def test_panel_never_reads_private_feature_values():
    """게시물에는 피처값이 없다 — 화면도 국제수지·금리 필드를 집지 않아야 한다."""
    js = (ROOT / "dashboard" / "fx-lstm-xgb.js").read_text(encoding="utf-8")
    for forbidden in ("경상수지", "증권투자(자산)", "usa_", "kr_", "features_private"):
        assert forbidden not in js, forbidden
