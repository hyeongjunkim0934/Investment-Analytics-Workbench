"""Real upload controls, route integration, and observable publication states.

Remote APIs are stubbed; this is not a claim that production credentials or the
external Drive synchronizer have been exercised.
"""
from __future__ import annotations

import json
from pathlib import Path
import re
import shutil
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def upload_ui():
    node = shutil.which("node")
    assert node, "Upload 화면 동작 검증에는 node가 필요합니다."
    result = subprocess.run(
        [node, str(Path(__file__).with_name("upload_ui_probe.js"))],
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr[-6000:]
    return json.loads(result.stdout)


def test_upload_navigation_is_beside_pseudo_and_routes(upload_ui):
    nav = upload_ui["navigation"]
    assert nav["adjacent"] and nav["registered"] and nav["visible"] and nav["noBackLink"]
    assert nav["active"] == ["#upload"]
    html = (ROOT / "dashboard/index.html").read_text()
    scripts = re.findall(r'<script\b[^>]*\bsrc="([^"?]+)', html)
    expected = ["data-upload-client.js", "data-upload.js", "app.js"]
    assert [script for script in scripts if script in expected] == expected
    assert re.search(r'<section\b[^>]*\bid="upload"', html)


def test_upload_starts_with_accessible_disabled_controls(upload_ui):
    initial = upload_ui["initial"]
    assert initial["password"] == "password"
    assert initial["live"] == "polite"
    assert initial["submitDisabled"]
    assert ".xlsx" in initial["bbAccept"] and ".xlsx" in initial["infoAccept"]


def test_blank_credentials_do_not_call_remote_api(upload_ui):
    assert upload_ui["blankToken"]["noRequest"]
    assert "토큰" in upload_ui["blankToken"]["status"]


def test_failed_connection_is_recoverable_and_clears_password(upload_ui):
    failed = upload_ui["connectionFailure"]
    assert failed["tokenCleared"] and failed["submitDisabled"] and failed["canReconnect"]
    assert "실패" in failed["status"]


def test_connection_targets_existing_files_on_discovered_branch(upload_ui):
    connected = upload_ui["connection"]
    assert connected["tokenPassed"] and connected["tokenCleared"] and connected["submitEnabled"]
    assert connected["bbTarget"] == "raw/data_bb_대체투자 (2).xlsx"
    assert connected["infoTarget"] == "raw/data_info.xlsx"
    assert "hyeongjunkim0934/Data" in connected["destination"]
    assert "test-default-branch" in connected["destination"]


def test_both_files_are_required_before_any_publish(upload_ui):
    required = upload_ui["pairRequired"]
    assert required["emptyBlocked"] and required["oneBlocked"]
    assert "data_bb" in required["message"] and "data_info" in required["message"]


def test_file_handles_and_connection_survive_theme_and_navigation(upload_ui):
    assert all(upload_ui["rerender"].values()), upload_ui["rerender"]


def test_double_submit_sends_one_pair_and_locks_controls(upload_ui):
    pending = upload_ui["inFlight"]
    assert pending["oneRequest"] and pending["controlsDisabled"] and pending["currentDataUnchanged"]
    assert pending["ariaBusy"] == "true"
    saved = upload_ui["saved"]
    assert saved["sameConnection"] and saved["twoFiles"]
    assert saved["fixedTargets"] == ["raw/data_bb_대체투자 (2).xlsx", "raw/data_info.xlsx"]


def test_saved_commit_is_distinct_from_published_dashboard(upload_ui):
    saved = upload_ui["saved"]
    assert all(saved[key] for key in ["visible", "tokenCleared", "disconnected", "checkEnabled", "refreshDisabled"])
    assert "저장" in saved["message"] and "대기" in saved["deployment"]
    assert saved["commitLink"] == "https://github.com/hyeongjunkim0934/Data/commit/" + "a" * 40
    pending = upload_ui["unpublished"]
    assert pending["refreshDisabled"] and pending["timestampCannotProvePublication"]
    assert "아직 확인하지 못했습니다" in pending["message"]


def test_only_matching_source_sha_enables_refresh_without_credentials(upload_ui):
    deployed = upload_ui["deployed"]
    assert all(deployed[key] for key in ["refreshEnabled", "reloaded", "requestsCacheSafe", "noCredentials", "currentDataUnchanged"])
    assert "반영 완료" in deployed["message"] and "2026-11-06" in deployed["message"]


def test_failed_status_check_does_not_erase_saved_commit_or_market_data(upload_ui):
    failed = upload_ui["checkFailure"]
    assert failed["commitRetained"] and failed["currentDataUnchanged"]
    assert "조회하지 못했습니다" in failed["message"]


def test_conflict_and_ambiguous_commit_do_not_report_false_success(upload_ui):
    failed = upload_ui["publishFailure"]
    assert all(failed[key] for key in ["noSuccessPanel", "tokenCleared", "disconnected", "currentDataUnchanged"])
    assert "충돌" in failed["message"]
    uncertain = upload_ui["uncertain"]
    assert uncertain["visible"] and uncertain["refreshDisabled"] and uncertain["canCheck"]
    assert "미확인" in uncertain["message"]


def test_disconnect_and_restored_page_cannot_reuse_credentials(upload_ui):
    assert all(upload_ui["disconnect"].values()), upload_ui["disconnect"]
    assert all(upload_ui["restoredPage"].values()), upload_ui["restoredPage"]


def test_pending_connection_cannot_restore_credentials_after_page_exit(upload_ui):
    assert all(upload_ui["staleConnection"].values()), upload_ui["staleConnection"]


def test_identical_workbooks_are_distinguished_from_a_new_publication(upload_ui):
    same = upload_ui["unchanged"]
    assert same["visible"] and same["refreshDisabled"] and same["canCheck"] and same["tokenCleared"]
    assert "같아" in same["message"] and "실행하지 않았습니다" in same["message"]
    assert "새 배포를 실행하지 않았습니다" in same["deployment"]
    assert "기존 원본과 동일" in same["commit"]


def test_upload_does_not_persist_secrets_or_mutate_existing_financial_state(upload_ui):
    assert all(upload_ui["privacy"].values()), upload_ui["privacy"]
