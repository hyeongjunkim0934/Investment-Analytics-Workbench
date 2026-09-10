"""자산배분의 세 탭 전환·입력·저장·표본 표시 계약."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.fixture(scope="module")
def workspace():
    node = shutil.which("node")
    assert node, "자산배분 화면 동작 검증에는 node가 필요합니다."
    probe = Path(__file__).with_name("alloc_workspace_probe.js")
    result = subprocess.run([node, str(probe)], capture_output=True, text=True, timeout=180)
    assert result.returncode == 0, result.stderr[-4000:]
    return json.loads(result.stdout)


def test_workspace_scope_and_metadata(workspace):
    for key in ("noRenderErrors", "defaultPort", "portContext", "institutionContext",
                "onlyInstitutionVisible", "pressedState", "portTocRemoved",
                "institutionTocRemoved", "workspaceExplanationRemoved", "hashUntouched"):
        assert workspace[key], key
    assert workspace["workspaceLabels"] == ["포트폴리오", "리스크연계", "기관배분/헤지"]


def test_risk_workspace_is_separate_and_handles_missing_alloc(workspace):
    for key in ("onlyRiskVisible", "riskSettingsReturnsToInstitution",
                "riskMissingAllocClearsOldResult", "riskWarningRecovers"):
        assert workspace[key], key


def test_workspace_preserves_calculations_and_drafts(workspace):
    for key in ("switchDoesNotSave", "switchDoesNotRecalculateNumbers", "portDirty",
                "institutionDirty", "portDraftPreserved", "institutionDraftPreserved",
                "selectionSurvivesRerender", "portDraftSurvivesRerender",
                "portDraftSurvivesInstitutionSave", "institutionDraftSurvivesPortSave",
                "portDraftSurvivesThemeRerender"):
        assert workspace[key], key


def test_workspace_reports_existing_save_contract(workspace):
    for key in ("institutionSaved", "portSaveSemantics", "separateStorage",
                "portExplicitRevertWorks", "newDatasetStartsFromSaved"):
        assert workspace[key], key


def test_workspace_reports_fallback_and_missing_data(workspace):
    for key in ("fallbackShown", "institutionMissingShown", "portWorksWithoutInstitution",
                "portMissingShown", "institutionWorksWithoutPort", "detailSelectsInstitution",
                "finalNoRenderErrors"):
        assert workspace[key], key


def test_model_selects_preserve_engine_and_saved_state(workspace):
    for key in ("modelControlsAreSelects", "windowSelectUpdatesEngine", "mappingSelectUpdatesEngine",
                "sourceSelectUpdatesEngine", "modelSelectionsSurviveSourceSwitch", "missingCmaOptionDisabled"):
        assert workspace[key], key
def test_period_selection_updates_statistics_charts_and_separate_storage(workspace):
    for key in ("availablePeriodsOnly", "periodUpdatesStatistics", "periodUpdatesChart",
                "periodSavesDraft", "periodRetainsFocus", "unavailablePeriodIgnored",
                "institutionPeriodSelected", "periodsStaySeparate",
                "unavailableSavedPeriodFallsBack", "proxyPeriodSelected"):
        assert workspace[key], key


def test_period_dates_apply_only_matching_published_statistics(workspace):
    for key in ("periodDatesInitialized", "periodDatesApply", "invalidPeriodDatesBlocked",
                "periodDatesFollowPreset", "institutionPeriodDatesApply"):
        assert workspace[key], key
