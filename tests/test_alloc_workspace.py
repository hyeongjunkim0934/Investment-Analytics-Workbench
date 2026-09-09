"""분류가 다른 두 자산배분 체계의 전환·입력·저장·표본 표시 계약."""
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
                "onlyInstitutionVisible", "pressedState", "tocVisibleTargets", "hashUntouched"):
        assert workspace[key], key
    assert workspace["portToc"] == []
    assert workspace["institutionToc"] == ["alloc-sim-panel", "alloc-summary", "alloc-controls",
                                            "alloc-cards", "alloc-risk-proc"]


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
