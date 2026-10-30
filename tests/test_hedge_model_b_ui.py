"""Execute hedge-model-B controls, exports and chart lifecycle in the DOM probe."""

import json
from html.parser import HTMLParser
from pathlib import Path
import shutil
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def test_hedge_model_b_controls_exports_and_lifecycle():
    node = shutil.which("node")
    assert node, "Node.js is required to exercise the dashboard UI"
    result = subprocess.run(
        [node, str(ROOT / "tests" / "hedge_model_b_ui_probe.js")],
        cwd=ROOT, capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr[-8000:]
    measured = json.loads(result.stdout)
    assert measured and all(measured.values())
    assert {
        "initialRender", "applyAndInvalidPreservation", "perMarketStorage",
        "tableChartCsvAgreement", "tabPreservation", "chartLifecycle",
        "missingPayload", "boundsAndTies",
    } <= measured.keys()


def test_hedge_model_b_scripts_loaded_in_dependency_order():
    class Index(HTMLParser):
        def __init__(self):
            super().__init__()
            self.scripts = []
            self.styles = []

        def handle_starttag(self, tag, attrs):
            attrs = dict(attrs)
            if tag == "script" and attrs.get("src"):
                self.scripts.append(attrs["src"].split("?")[0])
            if tag == "link" and attrs.get("rel") == "stylesheet":
                self.styles.append(attrs.get("href", "").split("?")[0])

    index = Index()
    index.feed((ROOT / "dashboard" / "index.html").read_text())
    assert index.scripts.index("hedge-optimizer.js") < index.scripts.index("hedge-model-b.js")
    assert index.scripts.index("hedge-model-b.js") < index.scripts.index("app.js")
    assert "hedge-model-b.css" in index.styles
