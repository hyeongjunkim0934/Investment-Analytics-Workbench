"""Risk lambda descriptions against Python statistics and hand-calculated cases."""
from __future__ import annotations

import json
import math
from pathlib import Path
import shutil
import statistics
import subprocess

import pytest


def observations(values, times=None):
    times = times if times is not None else [i * 7 * 86400 for i in range(len(values))]
    return [{"t": t, "s": value, "lam": value, "w": [.4, .6]}
            for t, value in zip(times, values)]


@pytest.fixture(scope="module")
def measured():
    node = shutil.which("node")
    assert node, "Node.js is required to verify lambda statistics"
    values = [12.34567, 12.34441, 12.34889, 12.34443]
    cases = {
        "empty": observations([]),
        "missing": observations([10, None, 20]),
        "string": observations([10, "12", 20]),
        "single": observations([0]),
        "pair": observations([0, 10]),
        "constant": observations([4, 4, 4, 4]),
        "hand": observations([10, 14, 8, 16]),
        "odd": observations([7, 2, 8, 4, 5]),
        "precision": observations(values),
        "scaled": observations([value * .1 for value in values]),
        "shifted": observations([value + 7 for value in values]),
        "irregular": observations(values, [0, 7 * 86400, 28 * 86400, 31 * 86400]),
        "long": observations([50 + 35 * math.sin(i * .17) for i in range(951)]),
    }
    # Load the production app through the established DOM boot, without invoking
    # the unrelated optimizer probes or copying the statistics implementation.
    script = r"""
const fs = require('node:fs'), path = require('node:path');
const dir = process.cwd();
const source = fs.readFileSync(path.join(dir, 'dashboard_probe.js'), 'utf8');
const bootEnd = source.indexOf('const out = {};');
if (bootEnd < 0) throw new Error('dashboard probe boot boundary missing');
const stats = new Function('require', '__dirname', source.slice(0, bootEnd)
  + '\nreturn vm.runInContext("allocRiskLambdaStats", sandbox);')(require, dir);
const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
const output = {};
for (const [name, points] of Object.entries(cases)) {
  const before = JSON.stringify(points);
  for (const point of points) { Object.freeze(point.w); Object.freeze(point); }
  Object.freeze(points);
  output[name] = {stats: stats(points), unchanged: before === JSON.stringify(points)};
}
process.stdout.write(JSON.stringify(output));
"""
    result = subprocess.run([node, "-e", script], input=json.dumps(cases),
                            cwd=Path(__file__).parent, text=True,
                            capture_output=True, timeout=30)
    assert result.returncode == 0, result.stdout[-2000:] + result.stderr[-4000:]
    return cases, json.loads(result.stdout)


def reference(values):
    """An independent library path; std uses the sample denominator N - 1."""
    return {
        "count": len(values),
        "latest": values[-1] if values else None,
        "mean": statistics.mean(values) if values else None,
        "median": statistics.median(values) if values else None,
        "std": statistics.stdev(values) if len(values) >= 2 else None,
        "min": min(values) if values else None,
        "max": max(values) if values else None,
    }


@pytest.mark.parametrize("name", ["single", "pair", "constant", "odd", "precision", "long"])
def test_level_and_adjacent_change_match_independent_statistics(measured, name):
    cases, output = measured
    values = [point["lam"] for point in cases[name]]
    changes = [later - earlier for earlier, later in zip(values, values[1:])]
    for key, inputs in [("level", values), ("change", changes)]:
        got = output[name]["stats"][key]
        for field, expected in reference(inputs).items():
            if expected is None:
                assert got[field] is None, (name, key, field)
            else:
                assert got[field] == pytest.approx(expected, rel=1e-12, abs=1e-12), (name, key, field)
    assert output[name]["unchanged"], "statistics mutated the plotted observations"


def test_empty_or_invalid_values_are_not_silently_filtered(measured):
    for name in ["empty", "missing", "string"]:
        assert measured[1][name]["stats"] is None
        assert measured[1][name]["unchanged"]


def test_hand_calculated_level_and_changes_preserve_time_order(measured):
    result = measured[1]["hand"]["stats"]
    # [10, 14, 8, 16]: mean/median 12; squared deviations sum to 40.
    assert result["level"] == pytest.approx({
        "count": 4, "latest": 16, "mean": 12, "median": 12,
        "std": math.sqrt(40 / 3), "min": 8, "max": 16,
    })
    # Adjacent changes are [4, -6, 8], not differences of sorted lambda values.
    assert result["change"] == pytest.approx({
        "count": 3, "latest": 8, "mean": 2, "median": 4,
        "std": math.sqrt(52), "min": -6, "max": 8,
    })
    assert measured[1]["hand"]["unchanged"]


def test_scale_changes_all_lambda_units_but_not_sample_counts(measured):
    output = measured[1]
    for series in ["level", "change"]:
        original, scaled = output["precision"]["stats"][series], output["scaled"]["stats"][series]
        assert scaled["count"] == original["count"]
        for field in ["latest", "mean", "median", "std", "min", "max"]:
            assert scaled[field] == pytest.approx(original[field] * .1, rel=1e-11, abs=1e-13)
    assert output["precision"]["stats"]["change"]["std"] > 0
    assert output["precision"]["stats"]["level"]["latest"] == 12.34443


def test_level_translation_leaves_changes_and_dispersion_unchanged(measured):
    output = measured[1]
    original, shifted = output["precision"]["stats"], output["shifted"]["stats"]
    assert shifted["change"] == pytest.approx(original["change"], rel=1e-11, abs=1e-12)
    assert shifted["level"]["std"] == pytest.approx(original["level"]["std"], abs=1e-12)
    for field in ["latest", "mean", "median", "min", "max"]:
        assert shifted["level"][field] == pytest.approx(original["level"][field] + 7)


def test_irregular_dates_do_not_time_weight_or_annualize_observations(measured):
    output = measured[1]
    assert output["irregular"]["stats"] == output["precision"]["stats"]
    assert output["irregular"]["unchanged"]
