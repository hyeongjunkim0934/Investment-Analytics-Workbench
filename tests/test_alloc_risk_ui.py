"""리스크 연계의 탭·실제 관측 빈도·시계열 기하·내보내기 검증."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.fixture(scope="module")
def risk_ui():
    node = shutil.which("node")
    assert node, "리스크 화면 검증에는 node가 필요합니다."
    probe = Path(__file__).with_name("alloc_risk_ui_probe.js")
    result = subprocess.run([node, str(probe)], capture_output=True, text=True, timeout=180)
    assert result.returncode == 0, result.stdout[-2000:] + result.stderr[-4000:]
    return json.loads(result.stdout)


def test_risk_tabs_and_range_preserve_accessible_state(risk_ui):
    assert risk_ui["tabsAndFocus"]
    assert risk_ui["weeklyLatestAndRange"]


def test_risk_exports_preserve_actual_dates_raw_precision_and_complete_allocations(risk_ui):
    assert risk_ui["rawExports"]


def test_risk_plot_uses_date_distances_and_chart_local_tooltip(risk_ui):
    assert risk_ui["chartGeometryAndCleanNotes"]
    assert risk_ui["tooltipInteraction"]


def test_risk_invalid_history_never_leaks_stale_or_monthly_results(risk_ui):
    assert risk_ui["rejectsBrokenFutureAndMonthlyFallback"]


def test_risk_recomputes_for_changed_cma_and_asset_constraints(risk_ui):
    assert risk_ui["cacheRespondsToInputs"]
