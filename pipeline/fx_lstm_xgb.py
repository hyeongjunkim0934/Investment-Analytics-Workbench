# -*- coding: utf-8 -*-
"""환율모형B — 오프라인 러너 산출물(`fx_lstm_xgb.json`)을 검증해 `fx.json.lstm_xgb` 로 게시한다.

모형(LSTM·XGBoost walk-forward)은 여기서 돌지 않는다. torch·xgboost 는 파이프라인 고정
의존성(pandas·numpy·openpyxl) 밖이라 `pipeline/research/fx_lstm_xgb_runner.py` 를 별도로 실행한다.
입력 CSV 세 개가 있으면 빌드가 학습하고, 직접 생성한 v2 산출물 게시도 가능하다. 이 모듈은 그 파일을
`port_cma.json` 과 같은 방식(저장소 전체 재귀 탐색)으로 찾아 **스키마를 검증한 뒤 알려진 키만**
게시한다. 파일이 없거나 깨지면 사유와 함께 `active:false` 블록을 항상 게시한다(체인 안전장치 —
게이트 `REQUIRED_KEYS["fx"]` 의 `lstm_xgb`). 다른 모형으로 조용히 대체하지 않는다.

게시 범위: 기준일·예측시점·기준 환율·실제 환율·모형 예측치·요약 지표·모형 설정 메타.
국제수지·금리 피처값은 러너가 애초에 싣지 않는다(비공개 원자료).
"""

from __future__ import annotations

import json
import math
import calendar
from datetime import datetime, timezone
from pathlib import Path

ARTIFACT = "fx_lstm_xgb.json"
SCHEMA = "fx_lstm_xgb/2"
MODELS = ("xgb", "lstm", "ensemble")
SUMMARY_KEYS = ("n", "rmse", "mae", "bias", "theil_u", "hit_rate", "n_direction")
MODEL_META_KEYS = ("name", "target", "unit", "frequency", "features", "ns", "arma", "bop_lag_months",
                   "lstm", "xgb", "ensemble", "benchmark")
RUNNER_KEYS = ("version", "seed", "replicate_notebook", "label_alignment",
               "sequence_alignment", "horizon_unit", "train_window")
RUNNER_CONTRACT = {"version": "2", "replicate_notebook": False,
                   "label_alignment": "calendar_month_target_realized_by_base_date",
                   "sequence_alignment": "last_input_month_matches_label_origin",
                   "horizon_unit": "calendar_month", "train_window": "consecutive_calendar_origin_months"}


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


def _month_key(value):
    """UTC calendar month-end midnight timestamp -> ordinal month, or None."""
    if not _int(value):
        return None
    try:
        date = datetime.fromtimestamp(value, timezone.utc)
    except (ValueError, OverflowError, OSError):
        return None
    if (date.day != calendar.monthrange(date.year, date.month)[1]
            or any((date.hour, date.minute, date.second, date.microsecond))):
        return None
    return date.year * 12 + date.month


def _summary_from_rows(base, actual, pred):
    """Recompute published metrics from the same observed rows; ignore claimed metrics."""
    indices = [i for i, value in enumerate(actual) if value is not None]
    n = len(indices)
    if not n:
        return {name: {"n": 0, **{key: None for key in SUMMARY_KEYS if key != "n"}}
                for name in (*MODELS, "rw")}
    rw_errors = [base[i] - actual[i] for i in indices]
    rw_rmse = math.hypot(*rw_errors) / math.sqrt(n)
    directional = [i for i in indices if actual[i] != base[i]]
    sign = lambda value: (value > 0) - (value < 0)
    out = {}
    for name in (*MODELS, "rw"):
        values = base if name == "rw" else pred[name]
        errors = [values[i] - actual[i] for i in indices]
        rmse = math.hypot(*errors) / math.sqrt(n)
        out[name] = {"n": n, "rmse": rmse, "mae": math.fsum(abs(e) / n for e in errors),
                     "bias": math.fsum(e / n for e in errors),
                     "theil_u": rmse / rw_rmse if rw_rmse else None,
                     "hit_rate": (sum(sign(values[i] - base[i]) == sign(actual[i] - base[i])
                                      for i in directional) / len(directional)
                                  if name != "rw" and directional else None),
                     "n_direction": len(directional) if name != "rw" else 0}
    if any(value is not None and not _finite(value) for row in out.values() for value in row.values()):
        raise ValueError("요약 지표 수치 범위 초과")
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
    if key != f"l{lag}_w{window}":
        return None, f"{key}: key와 lag·window 불일치"
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
    if any(_month_key(t) is None or _month_key(b) is None or _month_key(t) - _month_key(b) != lag
           for t, b in zip(tt, tb)):
        return None, f"{key}: 기준일·타깃이 정확한 달력 월말 lag 지평이 아님"
    if not all(_positive(v) for v in arrays["base"]):
        return None, f"{key}: base 에 비양수·비유한 값"
    actual = arrays["actual"]
    if not all(v is None or _positive(v) for v in actual):
        return None, f"{key}: actual 에 비양수·비유한 값"
    realized = [v is not None for v in actual]
    for m in MODELS:
        if not all(_positive(v) for v in pred[m]):
            return None, f"{key}: pred.{m} 에 비양수·비유한 값"
    if any(not math.isclose(e, x / 2 + l / 2, rel_tol=1e-10, abs_tol=1e-8)
           for x, l, e in zip(pred["xgb"], pred["lstm"], pred["ensemble"])):
        return None, f"{key}: 앙상블이 XGB·LSTM 동일가중 평균과 다름"
    try:
        summary = _summary_from_rows(arrays["base"], actual, pred)
    except (ValueError, OverflowError):
        return None, f"{key}: 요약 지표 수치 범위 초과"
    out = {"key": key, "lag": lag, "window": window, "n": n, "n_realized": int(sum(realized)),
           "t_base": list(tb), "t_target": list(tt), "base": list(arrays["base"]), "actual": list(actual),
           "pred": {m: list(pred[m]) for m in MODELS}, "summary": summary}
    return out, None


def validate(doc) -> tuple[dict | None, str | None]:
    """러너 산출물 전체를 검증한다. 반환 (정제본, None) 또는 (None, 사유)."""
    if not isinstance(doc, dict):
        return None, "JSON 최상위가 객체가 아님"
    if doc.get("schema") != SCHEMA:
        return None, f"schema 불일치: {doc.get('schema')!r} — 달력·시퀀스 정렬 교정된 {SCHEMA} 러너로 재생성 필요"
    model = doc.get("model") if isinstance(doc.get("model"), dict) else {}
    runner = doc.get("runner") if isinstance(doc.get("runner"), dict) else {}
    if any(runner.get(key) != value or (key == "replicate_notebook" and runner.get(key) is not False)
           for key, value in RUNNER_CONTRACT.items()) or not _int(runner.get("seed")):
        return None, "운영 runner v2의 달력·시퀀스·실현 라벨 정렬 메타데이터 불일치"
    ns = model.get("ns") if isinstance(model.get("ns"), dict) else {}
    if ns.get("fill") not in ("ffill", "none") or not _int(model.get("bop_lag_months"), 2):
        return None, "운영 모형은 NS ffill/none 및 국제수지 공표 지연 2개월 이상 필요"
    if any(model.get(k) != v for k, v in {"name": "lstm_xgb_walk_forward", "target": "spot",
                                         "unit": "KRW/USD", "frequency": "monthly"}.items()):
        return None, "모형 대상·단위·빈도 메타데이터 불일치"
    data = doc.get("data") if isinstance(doc.get("data"), dict) else {}
    try:
        source_end = datetime.strptime(data["table"]["end"], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        cutoff = int(source_end.timestamp())
        if _month_key(cutoff) is None:
            raise ValueError("not month end")
    except (KeyError, TypeError, ValueError, OverflowError):
        return None, "data.table.end 월말 자료 기준일 누락 또는 오류"
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
        if any(t > cutoff for t in clean["t_base"]) or any(
                t > cutoff and value is not None for t, value in zip(clean["t_target"], clean["actual"])):
            return None, f"{clean['key']}: 자료 기준일 이후의 기준일·실현값이 있음"
        combos.append(clean)
    grid = doc.get("grid") if isinstance(doc.get("grid"), dict) else {}
    lags = sorted({c["lag"] for c in combos})
    windows = sorted({c["window"] for c in combos})
    if (any(not isinstance(grid.get(key), list) or not all(_int(value, 1) for value in grid[key])
            for key in ("lags", "windows"))
            or sorted(grid["lags"]) != lags or sorted(grid["windows"]) != windows):
        return None, "grid 가 combos 와 맞지 않음"
    generated = doc.get("generated_at")
    if not isinstance(generated, str) or not generated:
        return None, "generated_at 누락"
    try:
        generated_date = datetime.fromisoformat(generated.replace("Z", "+00:00"))
        if generated_date.tzinfo is None or generated_date < source_end:
            raise ValueError("invalid generated timestamp")
    except (ValueError, TypeError):
        return None, "generated_at 시각·자료 기준일 불일치"
    regime = doc.get("regime_defaults") if isinstance(doc.get("regime_defaults"), dict) else {}
    low, high = regime.get("low_below"), regime.get("high_above")
    regime_defaults = ({"low_below": low, "high_above": high}
                       if _positive(low) and _positive(high) and low < high else None)
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
        return skeleton(f"{ARTIFACT} 없음 — Data 저장소 models/fx_lstm_xgb/에 table.csv·국제수지_1.csv·국제수지_2.csv를 준비하면 빌드에서 자동 학습합니다. v2 러너 산출물 직접 게시도 가능합니다")
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
