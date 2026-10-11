"""Summary proposals use applied portfolio assumptions and preserve failed updates."""
import json
import math
from pathlib import Path
import shutil
from statistics import NormalDist
import subprocess

import pytest


def test_summary_cards_applied_results_and_invalid_states():
    root = Path(__file__).resolve().parents[1]
    node = shutil.which("node")
    assert node, "Node.js is required to exercise the dashboard UI"
    result = subprocess.run(
        [node, str(root / "tests" / "summary_cards_ui_probe.js")],
        cwd=root, capture_output=True, text=True, check=True, timeout=60,
    )
    assert all(json.loads(result.stdout).values())


def test_return_ranges_match_normal_distribution_and_boundary_conditions():
    """Compare production JS quantiles to Python's inverse CDF and CDF coverage."""
    root = Path(__file__).resolve().parents[1]
    cases = [[7.08, 3.20], [8.04, 3.66], [-2.4, 4.37], [0, 0.01], [4, 0],
             [7.08491, 3.20479]]
    probe = r"""
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync('dashboard/app.js', 'utf8');
const fn = source.slice(source.indexOf('function portSummaryReturnRanges('), source.indexOf('const PORT_SUMMARY_CACHE'));
const ranges = vm.runInNewContext(fn + '; portSummaryReturnRanges');
const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
const invalid = [[null,1],[1,null],[1,-1],[NaN,1],[1,NaN],[Infinity,1],[1,Infinity],['4',1],[1,'2'],[Number.MAX_VALUE,Number.MAX_VALUE]];
console.log(JSON.stringify({valid:cases.map(c=>ranges(...c)),invalid:invalid.map(c=>ranges(...c))}));
"""
    result = subprocess.run([shutil.which("node"), "-e", probe], cwd=root,
                            input=json.dumps(cases), capture_output=True, text=True,
                            check=True, timeout=30)
    actual = json.loads(result.stdout)
    normal = NormalDist()
    for (mu, sigma), ranges in zip(cases, actual["valid"], strict=True):
        assert [r["probability"] for r in ranges] == [68, 90, 95, 99]
        for r in ranges:
            p = r["probability"] / 100
            z = normal.inv_cdf((1 + p) / 2)
            assert r["lower"] == pytest.approx(mu - z * sigma, abs=1e-12)
            assert r["upper"] == pytest.approx(mu + z * sigma, abs=1e-12)
            assert (r["lower"] + r["upper"]) / 2 == pytest.approx(mu, abs=1e-12)
            if sigma:
                coverage = normal.cdf((r["upper"] - mu) / sigma) - normal.cdf((r["lower"] - mu) / sigma)
                assert math.isclose(coverage, p, abs_tol=1e-12)
        assert all(a["lower"] >= b["lower"] and a["upper"] <= b["upper"] for a, b in zip(ranges, ranges[1:]))
    assert actual["invalid"] == [None] * 10
