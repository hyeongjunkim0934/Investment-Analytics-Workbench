"""Exercise model-A rendering, exports, fallback and chart lifecycle in Node."""

import json
from html.parser import HTMLParser
from pathlib import Path
import shutil
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def test_fx_markov_chart_state_exports_validation_and_lifecycle():
    node = shutil.which("node")
    assert node, "Node.js is required to exercise the dashboard UI"
    result = subprocess.run(
        [node, str(ROOT / "tests" / "fx_markov_ui_probe.js")],
        cwd=ROOT, capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr[-8000:]
    measured = json.loads(result.stdout)
    assert measured and all(measured.values())
    assert {
        "anchorAndForecastBands", "threeRegimesAndForecastCards",
        "integerDisplayRawCsvHover", "periodLeavesForecastUnchanged",
        "consensusStatePreserved", "modelNameEditingPreserved",
        "chartResizeAndCleanup", "malformedAndInactiveGraceful",
    } <= measured.keys()


def test_fx_markov_script_loaded_before_outlook_and_app():
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
    assert index.scripts.index("fx-markov.js") < index.scripts.index("fx-outlook.js")
    assert index.scripts.index("fx-outlook.js") < index.scripts.index("app.js")
