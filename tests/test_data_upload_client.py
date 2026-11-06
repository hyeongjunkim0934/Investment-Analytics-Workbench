"""Atomic browser upload and failure paths, using a simulated Git commit graph."""
from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess

import pytest


@pytest.fixture(scope="module")
def checks():
    node = shutil.which("node")
    assert node, "Node.js is required to exercise the browser upload transport."
    result = subprocess.run(
        [node, str(Path(__file__).with_name("upload_client_probe.js"))],
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr[-6000:]
    return json.loads(result.stdout)


@pytest.mark.parametrize("name", [
    "atomic_existing_paths_and_preserved_unrelated_files",
    "identical_pair_creates_no_commit_or_ref_update",
    "repository_privacy_permissions_and_complete_tree",
    "invalid_pair_has_no_remote_mutation",
    "concurrent_update_before_upload_stops_all_writes",
    "concurrent_update_before_ref_preserves_other_writer",
    "default_branch_change_stops_upload",
    "lost_success_response_recovers_by_readback",
    "unknown_final_outcome_has_commit_id_without_retry",
    "ref_rejection_is_not_success",
    "token_error_redaction_and_no_persistence",
    "notification_is_scoped_to_uploaded_commit",
    "xlsx_structure_and_case_insensitive_names",
])
def test_upload_client_behavior(checks, name):
    assert checks[name]
