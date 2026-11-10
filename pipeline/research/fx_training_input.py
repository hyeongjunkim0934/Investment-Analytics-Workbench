"""Train/publish FX B inside the build checkout without writing the Data remote.

Only the validated public forecast JSON is cached. Input values and subprocess
output are never printed, cached, or uploaded. An incomplete CSV upload blocks
the build rather than allowing an older artifact to masquerade as refreshed.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile

INPUTS = ("table.csv", "국제수지_1.csv", "국제수지_2.csv")
RELATIVE_INPUT_DIR = Path("models/fx_lstm_xgb")
ARTIFACT = "fx_lstm_xgb.json"
CODE_INPUTS = (
    "pipeline/research/fx_lstm_xgb_runner.py", "pipeline/fx_lstm_xgb.py",
    "pipeline/research/fx_training_input.py", "pipeline/requirements.txt",
    "pipeline/research/requirements-fx-training.txt",
    ".github/workflows/build-dashboard.yml",
)
TRAINING_ARGS = ("--lags", "1,3,6,9,12", "--windows", "24,36",
                 "--bop-lag", "2", "--ns-fill", "ffill", "--seed", "20261019")
PACKAGE_NAMES = ("numpy", "pandas", "scikit-learn", "statsmodels", "xgboost", "torch")


class InputError(ValueError):
    """An actionable error whose message contains no private input values."""


def _sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def inspect_inputs(data_dir: Path, repo_root: Path) -> dict:
    folder = data_dir / RELATIVE_INPUT_DIR
    existing = [name for name in INPUTS if (folder / name).exists() or (folder / name).is_symlink()]
    missing = [name for name in INPUTS if name not in existing]
    if missing and existing:
        raise InputError("환율모형B 입력 일부만 존재합니다. CSV 3개를 같은 커밋에 준비하십시오: "
                         + ", ".join(missing))
    if missing:
        return {"ready": False, "status": "inputs_absent", "missing": missing,
                "cache_key": None, "provenance": None}
    if not folder.resolve().is_relative_to(data_dir.resolve()):
        raise InputError("환율모형B 입력은 Data 저장소 내부에 있어야 합니다.")
    for name in INPUTS:
        path = folder / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
            raise InputError("환율모형B 입력은 비어 있지 않은 일반 CSV 파일이어야 합니다: " + name)
    # The normal loader discovers recursively. Do not let another path shadow
    # the result generated for these inputs.
    others = [p for p in data_dir.rglob(ARTIFACT) if p != folder / ARTIFACT]
    if others:
        raise InputError("환율모형B 산출물 경로가 중복됩니다. models/fx_lstm_xgb/ 하나로 통합하십시오.")
    provenance = {
        "version": 1,
        "input_sha256": {name: _sha(folder / name) for name in INPUTS},
        "code_sha256": {name: _sha(repo_root / name) for name in CODE_INPUTS},
        "python": platform.python_version(),
        "platform": platform.system(),
        "machine": platform.machine(),
        "training_args": list(TRAINING_ARGS),
    }
    digest = hashlib.sha256(json.dumps(provenance, sort_keys=True, ensure_ascii=True,
                                      separators=(",", ":")).encode()).hexdigest()
    key = "fx-b-v2-" + digest
    provenance["cache_key"] = key
    return {"ready": True, "status": "inputs_ready", "missing": [],
            "cache_key": key, "provenance": provenance}


def _validate(doc: dict, repo_root: Path) -> dict:
    sys.path.insert(0, str(repo_root / "pipeline"))
    import fx_lstm_xgb
    clean, error = fx_lstm_xgb.validate(doc)
    if error or clean is None:
        raise InputError("환율모형B 산출물 검증 실패 — 정렬·스키마·표본 계약을 확인하십시오.")
    return clean


def cached_artifact(cache_dir: Path, plan: dict, repo_root: Path) -> dict | None:
    if not plan["ready"]:
        return None
    path = cache_dir / ARTIFACT
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        actual = doc.get("data", {}).get("provenance", {})
        if any(actual.get(k) != v for k, v in plan["provenance"].items()):
            return None
        return _validate(doc, repo_root)
    except (OSError, ValueError, TypeError, AttributeError):
        return None


def _atomic_json(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent,
                                     prefix=".fx-b-", suffix=".tmp", delete=False) as stream:
        temporary = Path(stream.name)
        try:
            json.dump(doc, stream, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    temporary.replace(path)


def ensure_artifact(data_dir: Path, repo_root: Path, cache_dir: Path, *, run=subprocess.run) -> str:
    plan = inspect_inputs(data_dir, repo_root)
    if not plan["ready"]:
        return "inputs_absent_manual_artifact_preserved"
    doc = cached_artifact(cache_dir, plan, repo_root)
    status = "validated_cache_reused"
    if doc is None:
        folder = data_dir / RELATIVE_INPUT_DIR
        # Keep an existing artifact untouched until the replacement validates.
        with tempfile.TemporaryDirectory(prefix="fx-b-training-") as temporary:
            output = Path(temporary) / ARTIFACT
            command = [sys.executable, str(repo_root / CODE_INPUTS[0]), "--data-dir", str(folder),
                       "--out", str(output), *TRAINING_ARGS]
            env = dict(os.environ, OMP_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1", MKL_NUM_THREADS="1")
            result = run(command, capture_output=True, text=True, env=env, timeout=10800)
            if result.returncode != 0:
                # Raw exceptions from CSV readers can contain actual cell data.
                raise InputError("환율모형B 학습 실패 — CSV 형식·연속 월 표본·학습 의존성을 확인하십시오.")
            try:
                raw = json.loads(output.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                raise InputError("환율모형B 학습 결과 JSON이 없거나 읽을 수 없습니다.") from None
            if not isinstance(raw, dict) or not isinstance(raw.get("data"), dict):
                raise InputError("환율모형B 학습 결과의 data 메타데이터가 없습니다.")
            raw["data"]["provenance"] = dict(plan["provenance"])
            raw["data"]["provenance"]["package_versions"] = {
                name: importlib.metadata.version(name) for name in PACKAGE_NAMES
            }
            doc = _validate(raw, repo_root)
        # Re-read the inputs after training; changing inputs invalidate this fit.
        if inspect_inputs(data_dir, repo_root)["cache_key"] != plan["cache_key"]:
            raise InputError("환율모형B 학습 중 입력이 바뀌었습니다. 최신 입력으로 다시 실행하십시오.")
        _atomic_json(cache_dir / ARTIFACT, doc)
        status = "trained_and_validated"
    _atomic_json(data_dir / RELATIVE_INPUT_DIR / ARTIFACT, doc)
    return status


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("probe", "check-cache", "ensure"))
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--cache-dir", type=Path, default=Path(".fx-model-b-cache"))
    parser.add_argument("--github-output", type=Path)
    args = parser.parse_args(argv)
    try:
        plan = inspect_inputs(args.data_dir, args.repo_root)
        if args.mode == "ensure":
            print(ensure_artifact(args.data_dir, args.repo_root, args.cache_dir))
            return 0
        hit = cached_artifact(args.cache_dir, plan, args.repo_root) is not None if args.mode == "check-cache" else False
        fields = {"ready": str(plan["ready"]).lower(), "cache_key": plan["cache_key"] or "",
                  "cache_valid": str(hit).lower(), "needs_training": str(plan["ready"] and not hit).lower()}
        if args.github_output:
            with args.github_output.open("a", encoding="utf-8") as output:
                for key, value in fields.items():
                    output.write(f"{key}={value}\n")
        print("FX B: " + plan["status"] + ("; validated cache" if hit else ""))
        return 0
    except (InputError, subprocess.TimeoutExpired) as exc:
        print(str(exc) if isinstance(exc, InputError) else "환율모형B 학습 제한시간(3시간)을 초과했습니다.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
