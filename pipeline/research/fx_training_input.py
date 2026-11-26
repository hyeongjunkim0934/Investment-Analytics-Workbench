"""Train/publish FX B inside the build checkout without writing the Data remote.

Only the validated public forecast JSON is cached. Input values and subprocess
output are never printed, cached, or uploaded. An incomplete CSV upload blocks
the build rather than allowing an older artifact to masquerade as refreshed.

Inputs live in ``models/fx_lstm_xgb/`` of the Data checkout. The two balance of
payments CSVs are always required. ``table.csv`` is optional: when it is absent
the month-end FX/yield table is derived from the series the dashboard already
parses (``derive_table``), so the yield data needs no separate upkeep. A
committed ``table.csv`` still wins, as an explicit override.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.metadata
import io
import json
import math
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile

INPUTS = ("table.csv", "국제수지_1.csv", "국제수지_2.csv")
TABLE_INPUT, BOP_INPUTS = INPUTS[0], INPUTS[1:]
# Derived table: runner column -> dashboard series key. Spot follows the shared
# FX rule (primary export; the fallback only when the primary has no level).
TABLE_SPOT = ("bb:달러원", "info:USDKRW")
TABLE_YIELDS = (
    ("usa_3m", "info:UST3m"), ("usa_1y", "info:UST1y"), ("usa_3y", "info:UST3y"), ("usa_10y", "info:UST10y"),
    ("kr_3m", "info:한국_3m"), ("kr_1y", "info:한국_1y"), ("kr_3y", "info:한국_3y"), ("kr_10y", "info:한국_10y"),
)
TABLE_MAX_STALE_DAYS = 7      # a month-end value must be observed within the month's last week
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


def month_end_table(series: dict):
    """Month-end ``date, spot, <8 yields>`` frame from daily ``{key: pandas.Series}``.

    Each cell is that series' last valid weekday observation of the month, kept
    only when it falls in the month's final week; otherwise the cell is missing
    (never filled). The last row is the month containing the earliest
    "latest observation" across the nine inputs -- the runner drops that row as
    the incomplete month, so no column contributes a month it has not finished.
    """
    import pandas as pd

    def clean(key, positive):
        raw = series.get(key)
        if raw is None:
            return None
        values = pd.to_numeric(raw, errors="coerce").dropna()
        values = values[values.map(math.isfinite) & (values.index.dayofweek < 5)]
        if positive:
            values = values[values > 0]
        values = values[~values.index.duplicated(keep="last")].sort_index()
        return values if len(values) else None

    spot = next((v for v in (clean(key, True) for key in TABLE_SPOT) if v is not None), None)
    columns = {"spot": spot, **{name: clean(key, False) for name, key in TABLE_YIELDS}}
    absent = [name for name, values in columns.items() if values is None]
    if absent:
        raise InputError("환율모형B 금리·환율 표를 만들 수 없습니다. 원자료에 없는 계열: " + ", ".join(absent))
    asof = min(values.index[-1] for values in columns.values())
    monthly = {}
    for name, values in columns.items():
        values = values[values.index <= asof]
        months = values.index.to_period("M")
        last = values.groupby(months).tail(1)
        periods = last.index.to_period("M")
        stale = (periods.end_time.normalize() - last.index).days > TABLE_MAX_STALE_DAYS
        stale &= periods != asof.to_period("M")
        monthly[name] = pd.Series(last.to_numpy(), index=periods).where(~stale)
    frame = pd.DataFrame(monthly)
    frame = frame.reindex(pd.period_range(frame.index.min(), asof.to_period("M"), freq="M"))
    frame = frame.loc[frame["spot"].first_valid_index():]
    frame.insert(0, "date", [period.end_time.strftime("%Y-%m-%d") for period in frame.index])
    return frame.reset_index(drop=True)


_DERIVED: dict = {}


def derive_table(data_dir: Path, repo_root: Path) -> bytes:
    """CSV bytes of the derived table; memoised on the workbook set it was read from."""
    books = sorted(p for p in data_dir.rglob("*") if p.suffix.lower() in (".xlsx", ".xlsm")
                   and not p.name.startswith("~$") and p.is_file())
    signature = tuple((str(p), p.stat().st_size, p.stat().st_mtime_ns) for p in books)
    if _DERIVED.get("signature") != signature:
        sys.path.insert(0, str(repo_root / "pipeline"))
        try:
            import process
            # The loader narrates series names and warnings; keep this step's log to one status line.
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                process.SERIES.clear()
                process.load_data_dir(data_dir)
            series = {key: item["s"] for key, item in process.SERIES.items()}
        except SystemExit:
            raise InputError("환율모형B 금리·환율 표를 만들 원자료 엑셀을 읽지 못했습니다.") from None
        text = month_end_table(series).to_csv(index=False, lineterminator="\n", float_format="%.10g")
        _DERIVED.update(signature=signature, csv=text.encode("utf-8"))
    return _DERIVED["csv"]


def inspect_inputs(data_dir: Path, repo_root: Path, *, table=derive_table) -> dict:
    folder = data_dir / RELATIVE_INPUT_DIR
    existing = [name for name in INPUTS if (folder / name).exists() or (folder / name).is_symlink()]
    missing = [name for name in INPUTS if name not in existing]
    derived = missing == [TABLE_INPUT]
    if missing and existing and not derived:
        raise InputError("환율모형B 입력 일부만 존재합니다. 국제수지 CSV 2개를 같은 커밋에 준비하십시오: "
                         + ", ".join(name for name in missing if name != TABLE_INPUT))
    if missing and not derived:
        return {"ready": False, "status": "inputs_absent", "missing": missing,
                "cache_key": None, "provenance": None}
    if not folder.resolve().is_relative_to(data_dir.resolve()):
        raise InputError("환율모형B 입력은 Data 저장소 내부에 있어야 합니다.")
    for name in existing:
        path = folder / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
            raise InputError("환율모형B 입력은 비어 있지 않은 일반 CSV 파일이어야 합니다: " + name)
    # The normal loader discovers recursively. Do not let another path shadow
    # the result generated for these inputs.
    others = [p for p in data_dir.rglob(ARTIFACT) if p != folder / ARTIFACT]
    if others:
        raise InputError("환율모형B 산출물 경로가 중복됩니다. models/fx_lstm_xgb/ 하나로 통합하십시오.")
    table_csv = table(data_dir, repo_root) if derived else None
    input_sha = {name: _sha(folder / name) for name in existing}
    if derived:
        input_sha[TABLE_INPUT] = hashlib.sha256(table_csv).hexdigest()
    provenance = {
        "version": 1,
        "input_sha256": {name: input_sha[name] for name in INPUTS},
        "code_sha256": {name: _sha(repo_root / name) for name in CODE_INPUTS},
        "python": platform.python_version(),
        "platform": platform.system(),
        "machine": platform.machine(),
        "training_args": list(TRAINING_ARGS),
    }
    if derived:
        provenance["table_source"] = "dashboard_series_month_end"
    digest = hashlib.sha256(json.dumps(provenance, sort_keys=True, ensure_ascii=True,
                                      separators=(",", ":")).encode()).hexdigest()
    key = "fx-b-v2-" + digest
    provenance["cache_key"] = key
    return {"ready": True, "status": "inputs_ready_table_derived" if derived else "inputs_ready",
            "missing": [], "cache_key": key, "provenance": provenance, "table_csv": table_csv}


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


def ensure_artifact(data_dir: Path, repo_root: Path, cache_dir: Path, *, run=subprocess.run,
                    table=derive_table) -> str:
    plan = inspect_inputs(data_dir, repo_root, table=table)
    if not plan["ready"]:
        return "inputs_absent_manual_artifact_preserved"
    doc = cached_artifact(cache_dir, plan, repo_root)
    status = "validated_cache_reused"
    if doc is None:
        folder = data_dir / RELATIVE_INPUT_DIR
        # Keep an existing artifact untouched until the replacement validates.
        with tempfile.TemporaryDirectory(prefix="fx-b-training-") as temporary:
            output = Path(temporary) / ARTIFACT
            if plan["table_csv"] is not None:
                # Derived table: train from a private scratch folder, never write it into Data.
                folder = Path(temporary) / "inputs"
                folder.mkdir()
                (folder / TABLE_INPUT).write_bytes(plan["table_csv"])
                for name in BOP_INPUTS:
                    (folder / name).write_bytes((data_dir / RELATIVE_INPUT_DIR / name).read_bytes())
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
        if inspect_inputs(data_dir, repo_root, table=table)["cache_key"] != plan["cache_key"]:
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
