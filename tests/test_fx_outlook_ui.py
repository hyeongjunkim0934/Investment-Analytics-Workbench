"""Run the real FX outlook renderer with synthetic prices and a fixed KST clock."""

import json
from html.parser import HTMLParser
from pathlib import Path
import shutil
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def test_fx_outlook_controls_graph_storage_calendar_and_exports():
    node = shutil.which("node")
    assert node, "Node.js is required to exercise the dashboard UI"
    result = subprocess.run(
        [node, str(ROOT / "tests" / "fx_outlook_ui_probe.js")],
        cwd=ROOT, capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr[-8000:]
    measured = json.loads(result.stdout)
    assert measured and all(measured.values())


def test_fx_outlook_navigation_and_script_host_contract():
    class Index(HTMLParser):
        def __init__(self):
            super().__init__()
            self.nav = False
            self.links = []
            self.scripts = []
            self.section = None
            self.forecast_host_section = None

        def handle_starttag(self, tag, attrs):
            attrs = dict(attrs)
            if tag == "nav" and attrs.get("id") == "nav":
                self.nav = True
            if tag == "a" and self.nav:
                self.links.append([attrs.get("href"), ""])
            if tag == "section":
                self.section = attrs.get("id")
            if attrs.get("id") == "fxoutlook-content":
                self.forecast_host_section = self.section
            if tag == "script" and attrs.get("src"):
                self.scripts.append(attrs["src"].split("?")[0])

        def handle_endtag(self, tag):
            if tag == "nav":
                self.nav = False
            if tag == "section":
                self.section = None

        def handle_data(self, data):
            if self.nav and self.links:
                self.links[-1][1] += data.strip()

    index = Index()
    index.feed((ROOT / "dashboard" / "index.html").read_text())
    hrefs = [href for href, _ in index.links]
    assert hrefs[hrefs.index("#hedge") + 1] == "#fxoutlook"
    assert dict(index.links)["#fxoutlook"] == "환율전망"
    assert index.forecast_host_section == "fxoutlook"
    assert index.scripts.index("fx-outlook.js") < index.scripts.index("app.js")
