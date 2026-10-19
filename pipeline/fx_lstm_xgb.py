# -*- coding: utf-8 -*-
"""환율모형B — 오프라인 러너 산출물(`fx_lstm_xgb.json`)을 검증해 `fx.json.lstm_xgb` 로 게시한다.

모형(LSTM·XGBoost walk-forward)은 여기서 돌지 않는다. torch·xgboost 는 파이프라인 고정
의존성(pandas·numpy·openpyxl) 밖이라 `pipeline/research/fx_lstm_xgb_runner.py` 를 **오프라인**으로
돌려 Data 저장소 `models/fx_lstm_xgb/fx_lstm_xgb.json` 에 커밋하고, 이 모듈은 그 파일을
`port_cma.json` 과 같은 방식(저장소 전체 재귀 탐색)으로 찾아 **스키마를 검증한 뒤 알려진 키만**
게시한다. 파일이 없거나 깨지면 사유와 함께 `active:false` 블록을 항상 게시한다(체인 안전장치 —
게이트 `REQUIRED_KEYS["fx"]` 의 `lstm_xgb`). 다른 모형으로 조용히 대체하지 않는다.

게시 범위: 기준일·예측시점·기준 환율·실제 환율·모형 예측치·요약 지표·모형 설정 메타.
국제수지·금리 피처값은 러너가 애초에 싣지 않는다(비공개 원자료).
"""

from __future__ import annotations

import json
import math
from pathlib import Path

ARTIFACT = "fx_lstm_xgb.json"
SCHEMA = "fx_lstm_xgb/1"
MODELS = ("xgb", "lstm", "ensemble")
SUMMARY_KEYS = ("n", "rmse", "mae", "bias", "theil_u", "hit_rate", "n_direction")
MODEL_META_KEYS = ("name", "target", "unit", "frequency", "features", "ns", "arma", "bop_lag_months",
                   "lstm", "xgb", "ensemble", "benchmark")
RUNNER_KEYS = ("version", "seed", "replicate_notebook", "label_alignment")


def skeleton(reason: str | None = None) -> dict:
    """항상 같은 키 집합 — 비활성이어도 화면·게이트가 이름으로 집는다."""
    return {"active": False, "artifact": ARTIFACT, "path": None, "schema": SCHEMA, "reason": reason,
            "generated_at": None, "runner": None, "model": None, "data": None, "grid": None,
            "regime_defaults": None, "combos": []}


def find_artifact(data_dir) -> list[Path]:
    if data_dir is None:
        return []
    return sorted(Path(data_dir).rglob(ARTIFACT))


def _finite(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _positive(x) -> bool:
    return _finite(x) and x > 0


def _int(x, minimum=0) -> bool:
    return isinstance(x, int) and not isinstance(x, bool) and x >= minimum


def _clean_summary(summary) -> dict | None:
    if not isinstance(summary, dict):
        return None
    out = {}
    for name in (*MODELS, "rw"):
        row = summary.get(name)
        if not isinstance(row, dict):
            return None
        clean = {}
        for key in SUMMARY_KEYS:
            value = row.get(key)
            if key in ("n", "n_direction"):
                if value is not None and not _int(value):
                    return None
            elif value is not None and not _finite(value):
                return None
            clean[key] = value
        out[name] = clean
    return out


def validate_combo(combo) -> tuple[dict | None, str | None]:
    """조합 하나를 검증하고 알려진 키만 돌려준다. 실패 사유는 사람 문장으로."""
    if not isinstance(combo, dict):
        return None, "조합이 객체가 아님"
    key, lag, window = combo.get("key"), combo.get("lag"), combo.get("window")
    if not isinstance(key, str) or not key:
        return None, "조합 key 누락"
    if not _int(lag, 1) or not _int(window, 2):
        return None, f"{key}: lag·window 가 양의 정수가 아님"
    arrays = {name: combo.get(name) for name in ("t_base", "t_target", "base", "actual")}
    pred = combo.get("pred")
    if not isinstance(pred, dict) or any(not isinstance(pred.get(m), list) for m in MODELS):
        return None, f"{key}: pred.xgb/lstm/ensemble 배열 누락"
    if any(not isinstance(v, list) for v in arrays.values()):
        return None, f"{key}: t_base/t_target/base/actual 배열 누락"
    n = len(arrays["t_base"])
    if n < 1:
        return None, f"{key}: 행이 없음"
    if any(len(v) != n for v in arrays.values()) or any(len(pred[m]) != n for m in MODELS):
        return None, f"{key}: 배열 길이 불일치"
    tb, tt = arrays["t_base"], arrays["t_target"]
    if not all(_int(t) for t in tb) or any(tb[i] <= tb[i - 1] for i in range(1, n)):
        return None, f"{key}: t_base 가 오름차순 정수가 아님"
    if not all(_int(t) and t > b for t, b in zip(tt, tb)):
        return None, f"{key}: t_target 이 t_base 뒤가 아님"
    if not all(_positive(v) for v in arrays["base"]):
        return None, f"{key}: base 에 비양수·비유한 값"
    actual = arrays["actual"]
    if not all(v is None or _positive(v) for v in actual):
        return None, f"{key}: actual 에 비양수·비유한 값"
    realized = [v is not None for v in actual]
    if any(realized[i] and not realized[i - 1] for i in range(1, n)):
        return None, f"{key}: 미실현 행 뒤에 실현 행이 있음"
    for m in MODELS:
        if not all(_positive(v) for v in pred[m]):
            return None, f"{key}: pred.{m} 에 비양수·비유한 값"
    out = {"key": key, "lag": lag, "window": window, "n": n, "n_realized": int(sum(realized)),
           "t_base": list(tb), "t_target": list(tt), "base": list(arrays["base"]), "actual": list(actual),
           "pred": {m: list(pred[m]) for m in MODELS}, "summary": _clean_summary(combo.get("summary"))}
    return out, None


def validate(doc) -> tuple[dict | None, str | None]:
    """러너 산출물 전체를 검증한다. 반환 (정제본, None) 또는 (None, 사유)."""
    if not isinstance(doc, dict):
        return None, "JSON 최상위가 객체가 아님"
    if doc.get("schema") != SCHEMA:
        return None, f"schema 불일치: {doc.get('schema')!r} (기대 {SCHEMA})"
    combos_raw = doc.get("combos")
    if not isinstance(combos_raw, list) or not combos_raw:
        return None, "combos 가 비어 있음"
    combos, keys = [], set()
    for combo in combos_raw:
        clean, error = validate_combo(combo)
        if error:
            return None, error
        if clean["key"] in keys:
            return None, f"조합 key 중복: {clean['key']}"
        keys.add(clean["key"])
        combos.append(clean)
    grid = doc.get("grid") if isinstance(doc.get("grid"), dict) else {}
    lags = sorted({c["lag"] for c in combos})
    windows = sorted({c["window"] for c in combos})
    if sorted(grid.get("lags") or []) != lags or sorted(grid.get("windows") or []) != windows:
        return None, "grid 가 combos 와 맞지 않음"
    generated = doc.get("generated_at")
    if not isinstance(generated, str) or not generated:
        return None, "generated_at 누락"
    model = doc.get("model") if isinstance(doc.get("model"), dict) else {}
    runner = doc.get("runner") if isinstance(doc.get("runner"), dict) else {}
    regime = doc.get("regime_defaults") if isinstance(doc.get("regime_defaults"), dict) else {}
    low, high = regime.get("low_below"), regime.get("high_above")
    regime_defaults = ({"low_below": low, "high_above": high}
                       if _positive(low) and _positive(high) and low < high else None)
    data = doc.get("data") if isinstance(doc.get("data"), dict) else None
    return {"active": True, "artifact": ARTIFACT, "path": None, "schema": SCHEMA, "reason": None,
            "generated_at": generated,
            "runner": {k: runner.get(k) for k in RUNNER_KEYS},
            "model": {k: model.get(k) for k in MODEL_META_KEYS},
            "data": data, "grid": {"lags": lags, "windows": windows},
            "regime_defaults": regime_defaults, "combos": combos}, None


def load(data_dir, warn=None) -> dict:
    """Data 저장소에서 산출물을 찾아 검증한다. 어떤 실패도 active:false 블록으로 게시한다."""
    warn = warn or (lambda msg: None)
    hits = find_artifact(data_dir)
    if not hits:
        return skeleton(f"{ARTIFACT} 없음 — Data 저장소 models/fx_lstm_xgb/ 에 러너 산출물을 커밋하면 표시됩니다")
    if len(hits) > 1:
        warn(f"fx_lstm_xgb: {ARTIFACT} 이 {len(hits)}개 — 정렬 첫 번째({hits[0]})만 씁니다")
    path = hits[0]
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        warn(f"fx_lstm_xgb: {path} 읽기 실패 — {exc}")
        return skeleton(f"{ARTIFACT} 읽기 실패: {exc}")
    clean, error = validate(doc)
    if error:
        warn(f"fx_lstm_xgb: {path} 검증 실패 — {error}")
        return skeleton(f"{ARTIFACT} 검증 실패: {error}")
    try:
        rel = path.relative_to(Path(data_dir))
    except ValueError:
        rel = path
    clean["path"] = str(rel)
    return clean
