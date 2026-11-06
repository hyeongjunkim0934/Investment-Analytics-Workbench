"""Behavioral reference-portfolio UI checks with independent scalar moments."""
import json
from html.parser import HTMLParser
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def test_reference_controls_moments_and_source_failures():
    node = shutil.which("node")
    assert node, "Node.js is required for the reference UI regression"
    result = subprocess.run(
        [node, str(ROOT / "tests/reference_portfolio_ui_probe.js")],
        cwd=ROOT, capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr[-8000:]
    checks = json.loads(result.stdout)
    assert len(checks) >= 10 and all(checks.values())


def test_reference_assets_load_before_application():
    class Index(HTMLParser):
        def __init__(self):
            super().__init__()
            self.scripts, self.styles, self.ids = [], [], []

        def handle_starttag(self, tag, attrs):
            attrs = dict(attrs)
            if tag == "script" and attrs.get("src"):
                self.scripts.append(attrs["src"].split("?")[0])
            if tag == "link" and attrs.get("rel") == "stylesheet":
                self.styles.append(attrs.get("href", "").split("?")[0])
            if attrs.get("id"):
                self.ids.append(attrs["id"])

    index = Index()
    index.feed((ROOT / "dashboard/index.html").read_text())
    assert index.scripts.index("reference-portfolio.js") < index.scripts.index("app.js")
    assert "reference-portfolio.css" in index.styles
    assert index.ids.count("alloc-reference-panel") == 1
