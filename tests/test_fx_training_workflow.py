"""Build-time FX B input/cache lifecycle; no private input or network required."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline" / "research"))
import fx_training_input as training


def _inputs(tmp_path):
    data = tmp_path / "Data"
    folder = data / training.RELATIVE_INPUT_DIR
    folder.mkdir(parents=True)
    for name in training.INPUTS:
        (folder / name).write_text("fixture-only," + name, encoding="utf-8")
    return data, folder


def test_absent_inputs_preserve_manual_artifact_without_training(tmp_path):
    data = tmp_path / "Data"
    data.mkdir()
    manual = data / training.ARTIFACT
    manual.write_text("manual content", encoding="utf-8")
    def forbidden(*args, **kwargs):
        pytest.fail("absent inputs must not run training")
    assert not training.inspect_inputs(data, ROOT)["ready"]
    assert training.ensure_artifact(data, ROOT, tmp_path / "cache", run=forbidden) == "inputs_absent_manual_artifact_preserved"
    assert manual.read_text() == "manual content"


def test_partial_input_upload_blocks_old_artifact(tmp_path):
    data, folder = _inputs(tmp_path)
    (folder / training.INPUTS[1]).unlink()
    old = folder / training.ARTIFACT
    old.write_text("old", encoding="utf-8")
    with pytest.raises(training.InputError, match="일부만"):
        training.ensure_artifact(data, ROOT, tmp_path / "cache")
    assert old.read_text() == "old"


def test_input_bytes_and_training_code_both_change_cache_identity(tmp_path):
    data, folder = _inputs(tmp_path)
    repo = tmp_path / "repo"
    for name in training.CODE_INPUTS:
        target = repo / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("original:" + name, encoding="utf-8")
    first = training.inspect_inputs(data, repo)
    assert first == training.inspect_inputs(data, repo)
    (folder / training.INPUTS[0]).write_text("changed-input", encoding="utf-8")
    second = training.inspect_inputs(data, repo)
    assert first["cache_key"] != second["cache_key"]
    (repo / training.CODE_INPUTS[0]).write_text("changed-code", encoding="utf-8")
    assert second["cache_key"] != training.inspect_inputs(data, repo)["cache_key"]
    assert "changed-input" not in json.dumps(first)


def test_ambiguous_artifact_paths_and_symlink_input_rejected(tmp_path):
    data, folder = _inputs(tmp_path)
    other = data / training.ARTIFACT
    other.write_text("old", encoding="utf-8")
    with pytest.raises(training.InputError, match="중복"):
        training.inspect_inputs(data, ROOT)
    other.unlink()
    original = folder / training.INPUTS[0]
    original.unlink()
    target = tmp_path / "external.csv"
    target.write_text("value", encoding="utf-8")
    original.symlink_to(target)
    with pytest.raises(training.InputError, match="일반 CSV"):
        training.inspect_inputs(data, ROOT)


def test_cache_requires_matching_provenance_and_valid_production_artifact(tmp_path, monkeypatch):
    data, _ = _inputs(tmp_path)
    plan = training.inspect_inputs(data, ROOT)
    cache = tmp_path / "cache"
    cache.mkdir()
    path = cache / training.ARTIFACT
    # A cache hit cannot skip the core loader's production schema checks.
    path.write_text(json.dumps({"data": {"provenance": plan["provenance"]}}), encoding="utf-8")
    assert training.cached_artifact(cache, plan, ROOT) is None
    validated = []
    monkeypatch.setattr(training, "_validate", lambda doc, root: validated.append(doc) or doc)
    assert training.cached_artifact(cache, plan, ROOT) is not None
    assert len(validated) == 1
    doc = json.loads(path.read_text())
    doc["data"]["provenance"]["input_sha256"][training.INPUTS[0]] = "bad"
    path.write_text(json.dumps(doc), encoding="utf-8")
    assert training.cached_artifact(cache, plan, ROOT) is None
    assert len(validated) == 1  # stale provenance is rejected before schema validation


def test_real_v2_loader_accepts_cache_and_preserves_only_forecast_artifact(tmp_path):
    from test_fx_lstm_xgb import _artifact
    data, folder = _inputs(tmp_path)
    plan = training.inspect_inputs(data, ROOT)
    cache = tmp_path / "cache"
    cache.mkdir()
    doc = _artifact()
    doc["data"]["provenance"] = plan["provenance"]
    (cache / training.ARTIFACT).write_text(json.dumps(doc), encoding="utf-8")
    assert training.cached_artifact(cache, plan, ROOT)["active"]
    def forbidden(*args, **kwargs):
        pytest.fail("valid matching v2 cache must avoid model retraining")
    assert training.ensure_artifact(data, ROOT, cache, run=forbidden) == "validated_cache_reused"
    published = json.loads((folder / training.ARTIFACT).read_text())
    assert published["schema"] == "fx_lstm_xgb/2"
    assert published["data"]["provenance"] == plan["provenance"]


def test_train_once_then_reuse_and_publish_only_validated_json(tmp_path, monkeypatch):
    data, folder = _inputs(tmp_path)
    cache = tmp_path / "cache"
    calls = []
    monkeypatch.setattr(training, "_validate", lambda doc, root: {**doc, "validated": True})
    monkeypatch.setattr(training.importlib.metadata, "version", lambda name: "test-version")
    def run(command, **kwargs):
        calls.append((command, kwargs))
        output = Path(command[command.index("--out") + 1])
        output.write_text(json.dumps({"data": {}, "forecasts": [1, 2]}), encoding="utf-8")
        return SimpleNamespace(returncode=0, stdout="PRIVATE INPUT", stderr="PRIVATE INPUT")
    assert training.ensure_artifact(data, ROOT, cache, run=run) == "trained_and_validated"
    assert len(calls) == 1
    command, options = calls[0]
    assert command[-len(training.TRAINING_ARGS):] == list(training.TRAINING_ARGS)
    assert "--max-steps" not in command and "--epochs" not in command
    assert options["capture_output"] and options["timeout"] == 10800
    doc = json.loads((folder / training.ARTIFACT).read_text())
    assert doc["validated"] and doc["data"]["provenance"]["package_versions"]["torch"] == "test-version"
    assert list(cache.iterdir()) == [cache / training.ARTIFACT]
    assert "PRIVATE INPUT" not in (cache / training.ARTIFACT).read_text()
    assert training.ensure_artifact(data, ROOT, cache, run=run) == "validated_cache_reused"
    assert len(calls) == 1


def test_failed_fit_does_not_replace_existing_output_or_leak_raw_log(tmp_path, capsys):
    data, folder = _inputs(tmp_path)
    path = folder / training.ARTIFACT
    path.write_text("previous", encoding="utf-8")
    def failed(*args, **kwargs):
        return SimpleNamespace(returncode=1, stderr="secret cell value", stdout="secret cell value")
    with pytest.raises(training.InputError, match="학습 실패") as exc:
        training.ensure_artifact(data, ROOT, tmp_path / "cache", run=failed)
    assert "secret" not in str(exc.value)
    assert path.read_text() == "previous"
    assert not capsys.readouterr().out


def test_input_change_during_fit_rejects_stale_result(tmp_path, monkeypatch):
    data, folder = _inputs(tmp_path)
    cache = tmp_path / "cache"
    monkeypatch.setattr(training, "_validate", lambda doc, root: doc)
    monkeypatch.setattr(training.importlib.metadata, "version", lambda name: "test-version")
    def changing(command, **kwargs):
        Path(command[command.index("--out") + 1]).write_text('{"data": {}}', encoding="utf-8")
        (folder / training.INPUTS[0]).write_text("new version", encoding="utf-8")
        return SimpleNamespace(returncode=0)
    with pytest.raises(training.InputError, match="입력이 바뀌"):
        training.ensure_artifact(data, ROOT, cache, run=changing)
    assert not (folder / training.ARTIFACT).exists()
    assert not (cache / training.ARTIFACT).exists()


def test_probe_outputs_machine_flags_without_private_values(tmp_path, capsys):
    data, _ = _inputs(tmp_path)
    output = tmp_path / "outputs"
    assert training.main(["probe", "--data-dir", str(data), "--github-output", str(output)]) == 0
    fields = dict(line.split("=", 1) for line in output.read_text().splitlines())
    assert fields["ready"] == "true" and fields["cache_key"].startswith("fx-b-v2-")
    assert "fixture-only" not in capsys.readouterr().out


def test_workflow_orders_training_before_normal_loader_and_never_caches_inputs():
    workflow = (ROOT / ".github/workflows/build-dashboard.yml").read_text()
    assert workflow.index("Inspect FX B monthly training inputs") < workflow.index("Build dashboard data")
    assert workflow.index("fx_training_input.py ensure") < workflow.index("python pipeline/process.py")
    assert "path: .fx-model-b-cache/fx_lstm_xgb.json" in workflow
    assert "restore-keys:" not in workflow  # no stale cache fallback
    assert "needs_training == 'true'" in workflow
    assert "timeout-minutes: 240" in workflow
    assert "pip install torch==2.15.0 --index-url https://download.pytorch.org/whl/cpu" in workflow
