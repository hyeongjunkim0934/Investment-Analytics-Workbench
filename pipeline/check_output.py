#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""배포 게이트 — 빌드 산출물이 JSON 계약을 지키는지 검사하고, 아니면 exit 1.

왜 필요한가: `process.py` 는 `risk.build` / `hedge.build` 를 각각 try/except 로
격리한다. 계산이 깨지면 traceback 을 찍고 경고만 남긴 뒤 **그 JSON 없이** 나머지를
정상 종료(exit 0)로 내보낸다. CI 는 초록으로 끝나고, 대시보드는 해당 섹션이
사라진 채 배포된다. 이 스크립트는 build 와 deploy 사이에서 그 상태를 잡는다.

    python pipeline/check_output.py --out _site/data --max-warnings 20 --min-series 100

표준 라이브러리만 쓴다 — 의존성 설치가 깨진 상황에서도 돌아야 한다.

검사 항목
    1. JSON 파일 집합이 계약(아래 EXPECTED)과 **정확히** 일치 (부족·초과 모두 실패.
       개수를 여기 산문에 적지 않는다 — 실측: 16개가 된 뒤에도 이 줄이 「15개」로
       남아 있었다. 정본은 EXPECTED 목록 하나다)
    2. 전부 파싱 가능한 JSON 이고 비어 있지 않음
    3. meta.json 필수 필드 존재
    4. meta.json.warnings 개수 <= --max-warnings   (등호가 아니라 **상한**:
       경고 수는 데이터에서 오는 수라 정상적으로 변한다)
    5. meta.json.series_count >= --min-series      (고정값이 아니라 **바닥**)
    6. 모든 시계열 페이로드에서 len(t) == len(v)
    7. catalog.json 에 값 배열이 실려 있지 않음 (값 없이 메타데이터만 — 공개 범위 가드)
    8. 계산 페이로드(hedge·alloc·risk·panel)의 최소 스키마 — 화면이 이름으로 집는 키
    9. --dashboard 를 주면 dashboard/app.js 의 FILES 상수와 파일 집합이 일치하는지
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

# process.py 의 payloads 딕셔너리 = dashboard/app.js 의 FILES 상수 = 이 목록.
# 셋 중 하나만 고치면 안 된다.
EXPECTED = [
    "meta", "overview", "risk", "events", "panel", "hedge", "alloc",
    "rates", "irs", "credit", "fx", "inflation", "acwi", "macro", "catalog",
]
META_FIELDS = ["built_at_utc", "last_observation", "series_count", "files", "warnings"]

# 계산 페이로드의 **최소 스키마**. 파일이 있고 JSON 으로 파싱된다고 해서 내용이
# 온전한 것은 아니다 — 실측: `hedge.json` 에서 `asof`·`curves`·`mtm`·`cost_stats`·
# `backtest`·`sim` 을 통째로 지워도 게이트가 exit 0 이었고, 필드 하나를 개명한
# 뮤테이션은 pytest·프로브·게이트 **세 관문 전부 초록**인데 화면의 헤지비용 열이
# 전 통화 `—` 로 비었다. `alloc.json` 에는 이미 필수 키 검사가 있었는데
# `hedge.json`·`risk.json` 에는 없었다.
#
# 여기 적는 것은 **화면이 이름으로 집는 키**다. FX 시뮬레이션은 아래 별도
# 검사에서 배열 정렬·양수 환율·분위수 순서까지 확인해 불완전한 전망 배포를 막는다.
REQUIRED_KEYS = {
    # lstm_xgb = 환율모형B(오프라인 러너 산출물). 파일이 없어도 active:false 블록이
    # 게시돼야 한다 — 부재는 wiring 누락이다.
    "fx": ["ts", "outlook", "markov", "lstm_xgb", "model_c"],  # 결측이어도 비활성 블록은 필수.
    "hedge": ["asof", "default_tenor_m", "matrix", "curves", "backtest",
              "cost_hist_curve", "cost_hist_usd", "cost_dashboard", "cip", "fx_volatility", "cost_stats", "mtm", "sim",
              # ust_merit = 미국채 투자 메리트 모니터(§7.7.14). 시리즈가 없어도
              # active:false 로 항상 게시된다(bm.cma 와 같은 체인 안전장치).
              "ust_merit", "jgb_merit", "agb_merit", "bond_merits",
              "acct_model", "limits"],
    "alloc": ["asof", "sources", "sets", "rates", "cost_options", "anchor_ref",
              "defaults", "ccy_bench", "boot", "checks", "acct_model", "limits",
              # cma = 벤치마크 기반 자본시장가정(bm.build_cma). BM 파일이 없어도
              # active:false 블록이 게시돼야 한다 — 부재는 wiring 누락이다.
              "cma",
              # port = 7자산군 포트폴리오 구성(port.build). 프록시가 없어도
              # active:false 블록이 게시돼야 한다 — cma 와 같은 체인 안전장치.
              "port"],
    "risk":  ["asof", "grade_bands", "howto", "layers", "weights",
              "validation", "factors", "limits",
              # regime = 시장 국면 참고 블록(regime.py). 계산이 실패해도
              # active:false 로 항상 게시된다 — 부재는 wiring 누락이다.
              "regime"],
    "panel": ["asof", "freq", "t", "risk", "risk_meta", "vars",
              "defaults", "n_weeks", "method"],
    # brief = 브리핑 카드 원고(risk.compose_brief). process.py 가 조립 실패를
    # warn 으로 삼키고 exit 0 하므로, 빠진 채 초록 배포되는 것을 여기서 막는다.
    "events": ["asof", "lookback_days", "events", "catalog", "brief"],
}
# 배열 페이로드의 **행 스키마** — 행 하나만 봐도 개명·누락이 드러난다.
# 경로에 `.` 을 쓰면 중첩 배열도 지목할 수 있다(`boot.rows`).
REQUIRED_ROW_KEYS = {
    ("hedge", "matrix"): ["c", "name", "vol_e", "mvh", "corr",
                          "cost_12m", "cost_curve", "src", "active", "sample"],
    ("hedge", "cip.tenors"): ["tenor", "label", "active", "reason", "sources",
                              "t", "kr", "us", "spread", "premium", "gap", "sample", "stats"],
    # 헤지 레버의 자유도는 실질 1개(Xe)다 — 화면이 이 이름으로 집는다.
    # 예전의 hb_star/he_star 는 동점 중 임의의 한 점이라 되살리지 말 것.
    ("alloc", "boot.rows"): ["block_len", "n_reps", "anchor", "d1", "d2",
                             "xe_star", "xe_open", "share_xe_interior"],
}
# 중첩 객체의 필수 키 — 화면 부제가 이 값들로 자기 표본을 밝힌다(하드코딩 금지).
REQUIRED_NESTED_KEYS = {
    ("fx", "model_c"): ["active", "reason", "schema", "asof", "model_date", "pair", "unit",
                         "source", "anchor", "sample", "model", "horizons"],
    ("fx", "markov"): ["active", "source", "pair", "unit", "asof", "anchor",
                       "sample", "model", "diagnostics", "regimes", "current", "transition", "range", "simulation"],
    ("fx", "lstm_xgb"): ["active", "artifact", "path", "schema", "reason", "generated_at",
                         "runner", "model", "data", "grid", "regime_defaults", "combos"],
    ("hedge", "cost_stats"): ["mean", "now", "min", "series", "start", "end",
                              "n_months", "years"],
    ("hedge", "mtm"): ["sigma_ds_3m", "worst_ds", "worst_date", "series",
                       "start", "end", "n_months"],
    ("hedge", "cost_read"): ["label", "window", "asof"],
    ("hedge", "cost_dashboard"): ["JPY", "AUD", "USD"],
    ("hedge", "cip"): ["currency", "premium_method", "tenors"],
}

_errors: list[str] = []
_notes: list[str] = []


def fail(msg: str) -> None:
    _errors.append(msg)


def note(msg: str) -> None:
    _notes.append(msg)


def _check_fx_model_c(model):
    """Validate displayed forecasts and their same-sample evaluation contract."""
    def invalid(message):
        fail(f"fx.json: model_c: {message}")

    def finite(value):
        try:
            return type(value) in (int, float) and math.isfinite(value)
        except OverflowError:
            return False

    def count(value):
        return type(value) is int and value >= 0

    def positive(value):
        return finite(value) and value > 0

    def interval(row):
        values = [row.get(key) for key in ("lower95", "lower68", "upper68", "upper95")]
        n = row.get("n_calibration")
        if not count(n):
            invalid("구간 교정 표본수가 잘못되었습니다")
        elif n < 24:
            if any(value is not None for value in values):
                invalid("교정 오차 24개 미만에 구간이 있습니다")
        elif not all(positive(value) for value in values) or values != sorted(values):
            invalid("과거오차 구간의 값 또는 순서가 잘못되었습니다")

    if not isinstance(model, dict) or type(model.get("active")) is not bool:
        invalid("active 불리언을 포함한 객체 필요")
        return
    if model.get("schema") != "fx_model_c_v1" or model.get("pair") != "USDKRW" or model.get("unit") != "KRW/USD":
        invalid("스키마·통화·단위 불일치")
    horizons = model.get("horizons")
    if not isinstance(horizons, list):
        invalid("horizons 배열 필요")
        return
    if not model["active"] and not model.get("reason"):
        invalid("비활성 사유 없음")
    if not horizons:
        if model["active"]:
            invalid("활성 모형의 전망 없음")
        return
    if [row.get("horizon_months") if isinstance(row, dict) else None for row in horizons] != [1, 3, 6, 12]:
        invalid("1·3·6·12개월 전망 배열 필요")
        return
    anchor = model.get("anchor") or {}
    if not positive(anchor.get("v")) or not finite(anchor.get("t")) or not finite(anchor.get("quote_t")):
        invalid("기준 환율·시점 누락")
        return
    if anchor["quote_t"] != anchor["t"]:
        invalid("공통 호가일과 의사결정일 불일치")
    spec = model.get("model") or {}
    if spec.get("ridge_lambda") != 1 or spec.get("shrinkage") != 0.5:
        invalid("고정 λ·축소비율 불일치")
    if model["active"] != any(row.get("active") is True for row in horizons):
        invalid("전체·지평별 활성 상태 불일치")
    for row in horizons:
        if type(row.get("active")) is not bool:
            invalid("지평별 active 불리언 필요")
            continue
        if not finite(row.get("target_t")) or row["target_t"] <= anchor["t"]:
            invalid("전망일이 기준일 이후가 아닙니다")
        if not row["active"]:
            if not row.get("reason") or any(row.get(k) is not None for k in ("point", "ridge_point", "change_pct", "lower68", "upper68", "lower95", "upper95")):
                invalid("비활성 전망의 사유·결측 계약 위반")
            continue
        if not all(positive(row.get(k)) for k in ("point", "ridge_point", "rw")) or not finite(row.get("change_pct")):
            invalid("유효하지 않은 환율 전망")
            continue
        if row["rw"] != anchor["v"] or not math.isclose(row["point"] / row["rw"] - 1, row["change_pct"] / 100, abs_tol=1e-10):
            invalid("RW 기준점·변화율 불일치")
        if not math.isclose(math.log(row["point"] / row["rw"]),
                            0.5 * math.log(row["ridge_point"] / row["rw"]), abs_tol=1e-10):
            invalid("C·Ridge 고정 축소 관계 불일치")
        if not count(row.get("n_train")) or not 60 <= row["n_train"] <= 120:
            invalid("학습 표본수 범위 위반")
        contributions = row.get("contributions")
        if not isinstance(contributions, list) or len(contributions) != 4 or not all(isinstance(c, dict) and finite(c.get("log_pct")) for c in contributions):
            invalid("예측 기여도 누락")
        elif not math.isclose(math.fsum(c["log_pct"] for c in contributions) / 100,
                              math.log(row["point"] / row["rw"]), abs_tol=1e-10):
            invalid("기여도 합과 로그 전망 불일치")
        interval(row)
        backtest = row.get("backtest")
        metrics = row.get("metrics")
        if not isinstance(backtest, list) or not isinstance(metrics, dict):
            invalid("평가 행·지표 누락")
            continue
        if metrics.get("n") != len(backtest):
            invalid("평가 표본수 불일치")
        if row.get("n_calibration") != len(backtest):
            invalid("최신 구간 교정 표본수 불일치")
        previous = -math.inf
        valid_rows = []
        for bt in backtest:
            if not isinstance(bt, dict) or not all(finite(bt.get(k)) for k in ("origin_t", "target_t")) or not all(positive(bt.get(k)) for k in ("base", "actual", "model_c", "ridge", "rw")):
                invalid("평가 행 값 누락")
                continue
            if not previous < bt["origin_t"] < bt["target_t"] <= anchor["t"] or bt["base"] != bt["rw"]:
                invalid("평가 시점·RW 기준점 불일치")
            previous = bt["origin_t"]
            interval(bt)
            valid_rows.append(bt)
        if backtest and len(valid_rows) == len(backtest):
            n = len(backtest)
            for bt in backtest:
                matured = sum(old["target_t"] <= bt["origin_t"] for old in backtest)
                if bt.get("n_calibration") != matured:
                    invalid("미실현 예측오차의 교정 사용 또는 교정 표본 누락")
            for key, column in (("rmse", "model_c"), ("rw_rmse", "rw"), ("ridge_rmse", "ridge")):
                expected = math.hypot(*(bt[column] - bt["actual"] for bt in backtest)) / math.sqrt(n)
                if not finite(metrics.get(key)) or not math.isclose(metrics[key], expected, rel_tol=1e-10, abs_tol=1e-8):
                    invalid(f"{key}와 동일 평가 행 불일치")
            expected_mae = math.fsum(abs(bt["model_c"] - bt["actual"]) / n for bt in backtest)
            if not finite(metrics.get("mae")) or not math.isclose(metrics["mae"], expected_mae, rel_tol=1e-10, abs_tol=1e-8):
                invalid("MAE와 동일 평가 행 불일치")
            c_rmse = math.hypot(*(bt["model_c"] - bt["actual"] for bt in backtest)) / math.sqrt(n)
            rw_rmse = math.hypot(*(bt["rw"] - bt["actual"] for bt in backtest)) / math.sqrt(n)
            expected_u = c_rmse / rw_rmse if rw_rmse > 0 else None
            if (expected_u is None and metrics.get("theil_u") is not None) or (expected_u is not None and
                    (not finite(metrics.get("theil_u")) or not math.isclose(metrics["theil_u"], expected_u, rel_tol=1e-10, abs_tol=1e-10))):
                invalid("Theil U와 동일 평가 행 불일치")
            calibrated = [bt for bt in backtest if bt.get("lower68") is not None]
            if metrics.get("n_interval") != len(calibrated):
                invalid("구간 평가 표본수 불일치")
            for level in (68, 95):
                expected = sum(bt[f"lower{level}"] <= bt["actual"] <= bt[f"upper{level}"]
                               for bt in calibrated) / len(calibrated) if calibrated else None
                if metrics.get(f"coverage{level}") != expected:
                    invalid("구간 포함률과 당시 평가 구간 불일치")
        for key in ("coverage68", "coverage95"):
            value = metrics.get(key)
            if value is not None and (not finite(value) or not 0 <= value <= 1):
                invalid("구간 적중률 범위 위반")


def _check_fx_simulation(markov):
    """Validate the version-1 displayed FX distribution without NumPy or refitting.

The arithmetic mean need not lie inside central prediction intervals for skewed
distributions. Only quantiles are ordered. State frequencies are Monte Carlo
estimates, so the time-zero frequency need not equal the input filtered weights.
"""
    prefix = "fx.json: markov.simulation"

    def invalid(message):
        fail(f"{prefix}: {message}")

    def finite(value):
        try:
            return type(value) in (int, float) and math.isfinite(value)
        except OverflowError:
            return False

    def integer(value, minimum=0):
        return type(value) is int and value >= minimum

    if not isinstance(markov, dict) or type(markov.get("active")) is not bool:
        invalid("active 불리언을 포함한 모형 객체 필요")
        return
    if "simulation" not in markov:
        invalid("필수 키 없음")
        return
    simulation = markov["simulation"]
    if not markov["active"]:
        if simulation is not None:
            invalid("비활성 모형의 시뮬레이션은 null이어야 함")
        return
    if not isinstance(simulation, dict):
        invalid("활성 모형의 시뮬레이션 객체 없음")
        return
    fixed = {
        "engine": "gaussian_markov_log_returns",
        "rng": "PCG64",
        "interval_type": "pointwise_equal_tail_conditional_prediction",
        "nominal_coverages": [0.68, 0.95],
        "quantile_method": "linear",
        "sample_path_selection": "first_paths",
        "mean_mc_se_definition": "sample_level_sd/sqrt(path_count)",
        "calendar_mapping": "21_model_steps_per_calendar_month_interpolated",
    }
    if type(simulation.get("schema_version")) is not int or simulation["schema_version"] != 1:
        invalid("지원하지 않는 schema_version")
    for key, value in fixed.items():
        if simulation.get(key) != value:
            invalid(f"메타데이터 불일치 — {key}")
    for key in ("calibrated_prediction_interval", "parameter_uncertainty_included",
                "median_is_realizable_path", "dates_are_trading_calendar"):
        if simulation.get(key) is not False:
            invalid(f"메타데이터 불일치 — {key}")
    if not isinstance(simulation.get("numpy_version"), str) or not simulation["numpy_version"]:
        invalid("numpy_version 없음")
    if not integer(simulation.get("seed")) or not integer(simulation.get("path_count"), 2):
        invalid("유효한 seed/path_count 필요")

    n = 253
    if (not isinstance(simulation.get("steps"), list)
            or len(simulation["steps"]) != n
            or any(type(step) is not int or step != i for i, step in enumerate(simulation["steps"]))):
        invalid("steps는 0부터 252까지의 정수여야 함")
    anchor = markov.get("anchor")
    if (not isinstance(anchor, dict) or not finite(anchor.get("t"))
            or not finite(anchor.get("v")) or anchor["v"] <= 0):
        invalid("유효한 최신 관측 필요")
        return
    times = simulation.get("t")
    if (not isinstance(times, list) or len(times) != n
            or not all(finite(t) for t in times)
            or times[0] != anchor["t"]
            or any(a >= b for a, b in zip(times, times[1:]))):
        invalid("t 길이·순서·최신 관측 불일치")
    else:
        legacy = markov.get("range")
        if (not isinstance(legacy, dict) or not isinstance(legacy.get("t"), list)
                or times[::21] != legacy["t"]):
            invalid("월별 기준일과 모형 관측일 불일치")

    levels = ("mean", "median", "lower68", "upper68", "lower95", "upper95")
    arrays_valid = True
    for key in levels:
        values = simulation.get(key)
        if (not isinstance(values, list) or len(values) != n
                or not all(finite(v) and v > 0 for v in values)):
            invalid(f"{key} 길이 또는 유한 양수 환율 위반")
            arrays_valid = False
        elif values[0] != anchor["v"]:
            invalid(f"{key} 최신 관측 불일치")
    if arrays_valid:
        order = ("lower95", "lower68", "median", "upper68", "upper95")
        if any(any(a > b for a, b in zip(row, row[1:]))
               for row in zip(*(simulation[key] for key in order))):
            invalid("중첩 분위수 순서 위반")
    se = simulation.get("mean_mc_se")
    if (not isinstance(se, list) or len(se) != n
            or not all(finite(v) and v >= 0 for v in se) or se[0] != 0):
        invalid("mean_mc_se 길이·부호·최신점 위반")
    frequencies = simulation.get("state_probabilities")
    if (not isinstance(frequencies, list) or len(frequencies) != n
            or any(not isinstance(row, list) or len(row) != 3
                   or not all(finite(p) and 0 <= p <= 1 for p in row)
                   or abs(sum(row) - 1) > 1e-8 for row in frequencies)):
        invalid("국면확률 길이·범위·합 위반")
    paths = simulation.get("sample_paths")
    count = simulation.get("sample_path_count")
    if (not integer(count) or not isinstance(paths, list) or count != len(paths)
            or not integer(simulation.get("path_count"), 2) or count > simulation["path_count"]
            or any(not isinstance(row, list) or len(row) != n
                   or not all(finite(v) and v > 0 for v in row)
                   or row[0] != anchor["v"] for row in paths)):
        invalid("표본 경로 길이·개수·최신점 위반")


def _walk_ts(obj, path, seen):
    """페이로드 어디에 있든 {"t": [...], "v": [...]} 를 찾아 길이를 대조한다."""
    if isinstance(obj, dict):
        # CIP arrays use named series rather than v; preserve their common-date
        # alignment just as strictly as the generic t/v contract below.
        if "tenor" in obj and isinstance(obj.get("t"), list) and "spread" in obj:
            for key in ("kr", "us", "spread", "premium", "gap"):
                if not isinstance(obj.get(key), list) or len(obj[key]) != len(obj["t"]):
                    fail(f"{path}: t/{key} 배열 길이 불일치")
            if not isinstance(obj.get("stats"), dict) or "gap_zscore" not in obj["stats"]:
                fail(f"{path}: stats 에 필수 키 없음 — gap_zscore")
        if isinstance(obj.get("t"), list) and isinstance(obj.get("v"), list):
            seen[0] += 1
            if len(obj["t"]) != len(obj["v"]):
                fail(f"{path}: t/v 길이 불일치 ({len(obj['t'])} vs {len(obj['v'])})")
        for k, v in obj.items():
            _walk_ts(v, f"{path}.{k}", seen)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            _walk_ts(v, f"{path}[{i}]", seen)


def check(out: Path, max_warnings: int, min_series: int, dashboard: Path | None) -> int:
    if not out.is_dir():
        fail(f"출력 디렉터리가 없습니다: {out}")
        return report()

    found = sorted(p.stem for p in out.glob("*.json"))
    expected = sorted(EXPECTED)
    if found != expected:
        missing = sorted(set(expected) - set(found))
        extra = sorted(set(found) - set(expected))
        if missing:
            fail("JSON 누락 %d개: %s — risk/hedge 계산이 조용히 실패했을 때 나타나는 "
                 "전형적인 증상입니다 (빌드 로그의 traceback 확인)" % (len(missing), ", ".join(missing)))
        if extra:
            fail("계약에 없는 JSON %d개: %s — payloads/FILES/EXPECTED 세 곳을 함께 "
                 "고쳤는지 확인하세요" % (len(extra), ", ".join(extra)))
    else:
        note(f"JSON {len(found)}/{len(expected)}개")

    payloads = {}
    for name in found:
        p = out / f"{name}.json"
        if p.stat().st_size == 0:
            fail(f"{p.name}: 빈 파일")
            continue
        try:
            payloads[name] = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            fail(f"{p.name}: JSON 파싱 실패 — {e}")

    meta = payloads.get("meta")
    if meta is None:
        fail("meta.json 을 읽지 못했습니다")
    else:
        for f in META_FIELDS:
            if f not in meta:
                fail(f"meta.json: 필수 필드 없음 — {f}")
        warns = meta.get("warnings", [])
        if len(warns) > max_warnings:
            fail(f"경고 {len(warns)}건 > 상한 {max_warnings}건 — 파서가 시리즈를 "
                 f"대량으로 놓쳤을 수 있습니다. 첫 3건: {warns[:3]}")
        else:
            note(f"경고 {len(warns)}건 (상한 {max_warnings})")
        n = meta.get("series_count", 0)
        if not isinstance(n, int) or n < min_series:
            fail(f"시리즈 {n}개 < 바닥 {min_series}개 — 업로드가 깨졌을 수 있습니다")
        else:
            note(f"시리즈 {n}개 (바닥 {min_series})")

    checked = 0
    for name, keys in REQUIRED_KEYS.items():
        obj = payloads.get(name)
        if obj is None:
            continue                       # 파일 누락은 위에서 이미 실패로 잡았다
        if not isinstance(obj, dict):
            fail(f"{name}.json: 최상위가 객체가 아닙니다 ({type(obj).__name__})")
            continue
        gone = [k for k in keys if k not in obj]
        if gone:
            fail(f"{name}.json: 필수 키 없음 — {', '.join(gone)} "
                 f"(계산이 부분 실패했거나 필드명이 바뀌었습니다. "
                 f"화면이 이 이름으로 집으므로 해당 카드가 빈 채로 배포됩니다)")
        else:
            checked += 1
    for (name, arr), keys in REQUIRED_ROW_KEYS.items():
        rows = payloads.get(name)
        for step in arr.split("."):
            rows = (rows or {}).get(step) if isinstance(rows, dict) else None
        if not isinstance(rows, list):
            continue                       # 위 REQUIRED_KEYS 가 이미 잡는다
        if not rows:
            fail(f"{name}.json: {arr} 가 비었습니다")
            continue
        gone = sorted({k for r in rows if isinstance(r, dict) for k in keys if k not in r})
        if gone:
            fail(f"{name}.json: {arr}[] 행에 필수 키 없음 — {', '.join(gone)}")
    for (name, sub), keys in REQUIRED_NESTED_KEYS.items():
        obj = (payloads.get(name) or {}).get(sub)
        if not isinstance(obj, dict):
            continue                       # 위 REQUIRED_KEYS 가 이미 잡는다
        gone = [k for k in keys if k not in obj]
        if gone:
            fail(f"{name}.json: {sub} 에 필수 키 없음 — {', '.join(gone)} "
                 f"(화면 부제가 이 값으로 자기 표본을 밝힙니다)")
    if checked:
        note(f"계산 페이로드 필수 키 {checked}/{len(REQUIRED_KEYS)}개 확인")

    fx = payloads.get("fx")
    if isinstance(fx, dict):
        _check_fx_simulation(fx.get("markov"))
        _check_fx_model_c(fx.get("model_c"))

    seen = [0]
    for name, obj in payloads.items():
        _walk_ts(obj, name, seen)
    note(f"시계열 페이로드 {seen[0]}개 t/v 길이 확인")

    cat = payloads.get("catalog")
    if isinstance(cat, dict):
        rows = cat.get("series", [])
        bad = [r.get("key") for r in rows
               if isinstance(r, dict) and any(k in r for k in ("t", "v", "values"))]
        if bad:
            fail(f"catalog.json 에 값이 실렸습니다 ({len(bad)}건, 예: {bad[:3]}) — "
                 "카탈로그는 값 없이 메타데이터만 게시해야 합니다")
        note(f"카탈로그 {len(rows)}행 (값 없음 확인)")

    if dashboard is not None:
        if not dashboard.is_file():
            fail(f"대시보드 파일이 없습니다: {dashboard}")
        else:
            src = dashboard.read_text(encoding="utf-8")
            m = re.search(r"FILES\s*=\s*\[(.*?)\]", src, re.S)
            if not m:
                fail(f"{dashboard.name}: FILES 상수를 찾지 못했습니다")
            else:
                files = sorted(re.findall(r'["\']([A-Za-z_]+)["\']', m.group(1)))
                if files != expected:
                    fail(f"{dashboard.name} 의 FILES({len(files)}) 와 계약({len(expected)}) 불일치: "
                         f"only-in-app={sorted(set(files) - set(expected))} "
                         f"only-in-contract={sorted(set(expected) - set(files))}")
                else:
                    note(f"app.js FILES {len(files)}개 일치")
    return report()


def report() -> int:
    for n in _notes:
        print(f"  ok  {n}")
    if _errors:
        print("", file=sys.stderr)
        for e in _errors:
            print(f"::error::배포 게이트: {e}", file=sys.stderr)
        print(f"\n배포 게이트 실패 — {len(_errors)}건. 배포하지 않습니다.", file=sys.stderr)
        return 1
    print("배포 게이트 통과.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="빌드 산출물 JSON 계약 검사")
    ap.add_argument("--out", required=True, type=Path, help="process.py 의 --out 디렉터리")
    ap.add_argument("--max-warnings", type=int, default=20,
                    help="meta.json.warnings 개수 상한 (등호 아님). 기준선 수치는 데이터에서 "
                         "오는 수라 여기 적지 않는다 — CLAUDE.md 의 기준선 문장이 정본 "
                         "(실측: 7건이라 적혀 있던 동안 실제 기준선은 15건이었다)")
    ap.add_argument("--min-series", type=int, default=100,
                    help="meta.json.series_count 바닥 (고정값 아님). 기준선 수치는 "
                         "CLAUDE.md 참조 (실측: 444개라 적혀 있던 동안 실제는 481개였다)")
    ap.add_argument("--dashboard", type=Path, default=None,
                    help="dashboard/app.js 경로 — 주면 FILES 상수까지 대조")
    a = ap.parse_args()
    return check(a.out, a.max_warnings, a.min_series, a.dashboard)


if __name__ == "__main__":
    sys.exit(main())
