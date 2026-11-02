"""Model C real controls, tab state, CSV and chart lifecycle."""
import json
from html.parser import HTMLParser
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def test_hedge_model_c_controls_exports_and_lifecycle():
    node = shutil.which("node")
    assert node, "Node.js is required for dashboard UI verification"
    result = subprocess.run([node, str(ROOT / "tests/hedge_model_c_ui_probe.js")],
                            cwd=ROOT, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr[-10000:]
    measured = json.loads(result.stdout)
    assert measured and all(measured.values())


def test_hedge_model_c_dependencies_and_panel_are_wired():
    class Index(HTMLParser):
        def __init__(self):
            super().__init__()
            self.scripts, self.styles, self.panels = [], [], {}

        def handle_starttag(self, tag, attrs):
            attrs = dict(attrs)
            if tag == "script" and attrs.get("src"):
                self.scripts.append(attrs["src"].split("?")[0])
            if tag == "link" and attrs.get("rel") == "stylesheet":
                self.styles.append(attrs.get("href", "").split("?")[0])
            if attrs.get("role") == "tabpanel":
                self.panels[attrs.get("id")] = attrs

    index = Index()
    index.feed((ROOT / "dashboard/index.html").read_text())
    assert index.scripts.index("hedge-tail-optimizer.js") < index.scripts.index("hedge-model-c.js") < index.scripts.index("app.js")
    assert "hedge-model-c.css" in index.styles
    assert index.panels["hedge-model-c"]["aria-labelledby"] == "hedge-tab-modelC"
    assert "hidden" in index.panels["hedge-model-c"]
