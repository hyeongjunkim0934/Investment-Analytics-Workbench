"""Common-origin retrospective FX forecast evaluation, without fitted weights.

C's matured-label monthly forecasts supply the origin/target backbone. A and D
are refitted from daily prefixes, never from the latest fitted parameters. This
is current-vintage pseudo OOS evaluation, not a live trading track record.
"""

from __future__ import annotations

import math
from statistics import NormalDist

import numpy as np
import pandas as pd

import fx_markov
import fx_model_c
import fx_model_d
import fx_simulation
import hedge

SCHEMA = "fx_validation_v1"
HORIZONS = (1, 3, 6, 9, 12)
MAX_ORIGINS = 36
PATH_COUNT = 1000
SEED = 20261110
POINT_KEYS = ("a", "c", "d", "rw", "equal_ac_rw", "shrink_ac_rw")
INTERVAL_KEYS = ("a", "c", "d", "constant", "ewma")
VARIANCE_KEYS = ("d", "constant", "ewma")
MAX_LEVEL = 1e150  # Numerical guard: squared point losses must remain finite.


def _finite(value):
    return isinstance(value, (int, float, np.integer, np.floating)) and not isinstance(value, bool) and math.isfinite(value)


def _positive_level(value):
    return _finite(value) and 0 < value <= MAX_LEVEL


def _finite_tree(value):
    if isinstance(value, dict):
        return all(_finite_tree(v) for v in value.values())
    if isinstance(value, (list, tuple)):
        return all(_finite_tree(v) for v in value)
    return value is None or isinstance(value, (str, bool)) or _finite(value)


def _date(value):
    return pd.Timestamp(value).strftime("%Y-%m-%d")


def _epoch(value):
    return int(pd.Timestamp(value).timestamp())


def _target(origin, months):
    period = pd.Timestamp(origin).to_period("M") + months
    return pd.offsets.BMonthEnd().rollback(period.end_time.normalize())


def _steps(origin, target):
    """Predetermined Mon-Fri count after origin through target; no holidays."""
    return len(pd.bdate_range(pd.Timestamp(origin) + pd.Timedelta(days=1), target))


def _sample(rows):
    return {"n": len(rows), "origin_start": rows[0]["origin_date"] if rows else None,
            "origin_end": rows[-1]["origin_date"] if rows else None,
            "target_start": rows[0]["target_date"] if rows else None,
            "target_end": rows[-1]["target_date"] if rows else None}


def interval_score(actual, lower, upper, alpha=.05):
    """Winkler score in KRW/USD; smaller is better, width alone cannot win."""
    if not all(_finite(v) for v in (actual, lower, upper, alpha)) or not 0 < alpha < 1 or lower > upper:
        raise ValueError("invalid interval score inputs")
    return upper - lower + 2 / alpha * max(lower - actual, 0) + 2 / alpha * max(actual - upper, 0)


def metrics(rows):
    """All models within a metric group use exactly the same evaluation rows."""
    actual = np.array([r["actual"] for r in rows])
    point = {}
    rw_rmse = math.sqrt(float(np.mean((actual - np.array([r["base"] for r in rows])) ** 2))) if rows else None
    for key in POINT_KEYS:
        error = np.array([r["points"][key] for r in rows]) - actual
        rmse = math.sqrt(float(np.mean(error ** 2))) if rows else None
        point[key] = {"n": len(rows), "mae": float(np.mean(np.abs(error))) if rows else None,
                      "rmse": rmse, "theil_u_rw": rmse / rw_rmse if rw_rmse and rmse is not None else None}
    interval = {}
    for coverage, alpha in ((68, .32), (95, .05)):
        low, high = f"lower{coverage}", f"upper{coverage}"
        common = [r for r in rows if all(_finite(r["intervals"][k].get(low)) and
                  _finite(r["intervals"][k].get(high)) for k in INTERVAL_KEYS)]
        result = {}
        for key in INTERVAL_KEYS:
            bands = [(r["actual"], r["intervals"][key][low], r["intervals"][key][high]) for r in common]
            result[key] = {"n": len(common),
                           "coverage": sum(lo <= y <= hi for y, lo, hi in bands) / len(bands) if bands else None,
                           "interval_score": float(np.mean([interval_score(y, lo, hi, alpha) for y, lo, hi in bands])) if bands else None}
        interval[str(coverage)] = {"sample": _sample(common), "models": result}
    variance = {}
    for key in VARIANCE_KEYS:
        scores = [math.log(r["variance"][key]) + r["variance"]["realized"] / r["variance"][key] for r in rows]
        variance[key] = {"n": len(rows), "qlike": float(np.mean(scores)) if scores else None}
    return {"sample": _sample(rows), "point": point, "interval": interval, "variance": variance}


def skeleton(reason="동일 기준일의 유효한 A/C/D 평가행 없음", *, max_origins=MAX_ORIGINS, path_count=PATH_COUNT):
    return {"schema": SCHEMA, "active": False, "reason": reason,
            "asof": None, "source": None, "pair": "USDKRW", "unit": "KRW/USD",
            "config": {
                "horizons_months": list(HORIZONS), "max_origins": max_origins, "path_count": path_count,
                "seed": SEED, "origin_selection": "most_recent_origin_dates_global_union_before_model_fit",
                "numeric_level_limit": MAX_LEVEL,
                "target_calendar": "exact_last_weekday_of_target_month_no_fill",
                "model_steps": "predetermined_weekdays_after_origin_through_target_no_holiday_calendar",
                "calendar_differs_from_native_21_steps_per_month": True,
                "a_point": "simulated_level_median", "c_point": "native_geometric_log_forecast",
                "d_point": "anchor_exact_zero_log_drift_distribution_median",
                "d_arithmetic_mean_is_direction_forecast": False,
                "equal_weights": {"a": 1 / 3, "c": 1 / 3, "rw": 1 / 3},
                "shrink_weights": {"a": .25, "c": .25, "rw": .5},
                "c_already_has_native_rw_shrinkage": True,
                "weights_fitted": False, "interval_common_subset": True,
                "qlike_target": "squared_terminal_cumulative_log_return_zero_drift_variance_proxy",
                "qlike_forecast": "cumulative_log_variance", "variance_proxy_is_observed_variance": False,
                "overlapping_horizons": True, "independent_sample_count_claimed": False,
                "vintage": "current_dataset_not_point_in_time_vintages",
                "interval_calibration_fitted_here": False, "coverage_guaranteed": False,
                "superiority_established": False, "raw_training_returns_published": False,
            },
            "excluded_models": [{"model": "b", "reason": "별도 월간 입력·학습 아티팩트 경로로 공통 비교에 미포함"}],
            "selected_origins": [], "horizons": []}


def _history(outlook):
    if not isinstance(outlook, dict) or not isinstance(outlook.get("history", {}), dict):
        raise ValueError("일별 환율 이력 객체가 필요합니다.")
    history = outlook.get("history", {})
    ts, values = history.get("t", []), history.get("v", [])
    if not isinstance(ts, list) or not isinstance(values, list) or len(ts) != len(values):
        raise ValueError("일별 환율 이력 배열이 일치하지 않습니다.")
    if not all(_finite(t) and int(t) == t for t in ts) or not all(_positive_level(v) for v in values):
        raise ValueError("일별 환율 날짜·양수 값이 유효하지 않습니다.")
    dates = pd.to_datetime(ts, unit="s")
    if dates.hasnans or not dates.is_unique or not dates.is_monotonic_increasing or any(dates != dates.normalize()) or any(dates.dayofweek > 4):
        raise ValueError("일별 환율은 중복 없는 시간순 평일 관측이어야 합니다.")
    return pd.Series(values, index=dates, dtype=float)


def _fit_origin(levels, origin):
    """Refit both models from the prefix; return only in-memory fit objects."""
    prefix = levels.loc[:origin]
    gaps = prefix.index.to_series().diff().dt.days
    all_returns = np.log(prefix).diff()
    positions = np.flatnonzero((gaps.between(1, hedge.MAX_FX_GAP_DAYS) & all_returns.notna()).to_numpy())[-fx_markov.MAX_RETURNS:]
    if len(positions) < fx_markov.MIN_RETURNS or positions[-1] != len(prefix) - 1:
        raise ValueError("A 일별 학습표본 부족 또는 기준일 직전 장기 공백")
    starts = np.r_[True, np.diff(positions) > 1]
    a = fx_markov.fit_markov(all_returns.iloc[positions].to_numpy(), starts)
    if not a.get("active"):
        raise ValueError("A 추정 비활성: " + a.get("reason", "추정 실패"))
    splits = np.flatnonzero((gaps > hedge.MAX_FX_GAP_DAYS).to_numpy())
    segment = prefix.iloc[int(splits[-1]):] if len(splits) else prefix
    d_returns = np.diff(np.log(segment.to_numpy()))[-fx_model_d.MAX_TRAIN:]
    if len(d_returns) < fx_model_d.MIN_TRAIN:
        raise ValueError("D 최근 연속구간 학습표본 부족")
    d, magnitudes = fx_model_d.fit_garch(d_returns)
    ewma = float(np.mean(d_returns ** 2))
    for value in d_returns:
        ewma = fx_model_d.EWMA_DECAY * ewma + (1 - fx_model_d.EWMA_DECAY) * value * value
    return {"a": a, "d": d, "magnitudes": magnitudes, "constant": float(d["long_run_var"]),
            "ewma": float(ewma), "n_a": len(positions), "n_d": len(d_returns)}


def _simulate(fit, anchor, origin, steps, path_count):
    seed = SEED + _epoch(origin) // 86400
    a = fit["a"]
    paths_a, _ = fx_simulation.simulate_markov_paths(anchor, a["probabilities"], a["means"], a["variances"],
                a["transition"], steps=steps, path_count=path_count, seed=seed)
    paths_d = fx_model_d.simulate_paths(anchor, fit["d"], fit["magnitudes"], steps=steps,
                                      path_count=path_count, seed=seed + 1000000)
    return paths_a, paths_d


def _band(values):
    q = np.quantile(values, [.025, .16, .84, .975], method="linear")
    return dict(zip(("lower95", "lower68", "upper68", "upper95"), map(float, q)))


def _normal_band(base, variance):
    sd = math.sqrt(variance)
    return {f"{side}{coverage}": base * math.exp(sign * NormalDist().inv_cdf(prob) * sd)
            for coverage, prob in ((68, .84), (95, .975)) for side, sign in (("lower", -1), ("upper", 1))}


def build(outlook, model_c, warn=None, *, max_origins=MAX_ORIGINS, path_count=PATH_COUNT):
    out = skeleton(max_origins=max_origins, path_count=path_count)
    if type(max_origins) is not int or not 1 <= max_origins <= 120 or type(path_count) is not int or not 100 <= path_count <= 20000:
        raise ValueError("validation limits require 1..120 origins and 100..20000 paths")
    try:
        levels = _history(outlook)
    except (ValueError, TypeError, OverflowError) as exc:
        out["reason"] = str(exc)
        return out
    out["source"] = outlook.get("source")
    out["asof"] = _date(levels.index[-1]) if len(levels) else None
    if levels.empty or not isinstance(model_c, dict) or model_c.get("source") != out["source"]:
        out["reason"] = "동일 원천의 일별 환율과 모형 C 역사적 예측이 필요합니다."
        return out
    if not isinstance(model_c.get("horizons", []), list):
        out["reason"] = "모형 C의 지평별 예측 배열이 필요합니다."
        return out
    horizons = {r["horizon_months"]: r for r in model_c.get("horizons", [])
                if isinstance(r, dict) and type(r.get("horizon_months")) is int and r["horizon_months"] in HORIZONS}
    candidates, excluded = {h: [] for h in HORIZONS}, {h: [] for h in HORIZONS}
    for h in HORIZONS:
        seen = set()
        backtest = horizons.get(h, {}).get("backtest", [])
        if not isinstance(backtest, list):
            excluded[h].append({"origin_date": None, "reason": "C 역사적 예측 배열 오류"})
            continue
        for row in backtest:
            try:
                origin, target = pd.Timestamp(row["origin_date"]), pd.Timestamp(row["target_date"])
                if origin != origin.normalize() or target != target.normalize() or origin != _target(origin, 0) or target != _target(origin, h):
                    raise ValueError("달력 월말 기준일·목표일 불일치")
                if origin in seen:
                    raise ValueError("중복 기준일")
                seen.add(origin)
                if origin not in levels.index or target not in levels.index:
                    raise ValueError("기준일 또는 목표일의 실제 환율 관측 없음")
                if row.get("origin_t") != _epoch(origin) or row.get("target_t") != _epoch(target):
                    raise ValueError("날짜와 timestamp 불일치")
                if row.get("origin_quote_date") != _date(origin) or row.get("target_quote_date") != _date(target):
                    raise ValueError("실제 호가일과 기준일·목표일 불일치")
                if not all(_positive_level(row.get(k)) for k in ("base", "actual", "model_c", "rw")):
                    raise ValueError("C 점예측·실현값 오류")
                if type(row.get("n_train")) is not int or row["n_train"] < fx_model_c.MIN_TRAIN or type(row.get("n_calibration")) is not int or row["n_calibration"] < 0:
                    raise ValueError("C 학습·교정 표본수 오류")
                if not math.isclose(row["base"], float(levels.loc[origin]), rel_tol=1e-12) or not math.isclose(row["actual"], float(levels.loc[target]), rel_tol=1e-12) or row["rw"] != row["base"]:
                    raise ValueError("C와 일별 원천의 기준·실현환율 불일치")
                candidates[h].append((origin, target, row))
            except (KeyError, TypeError, ValueError, OverflowError) as exc:
                excluded[h].append({"origin_date": row.get("origin_date") if isinstance(row, dict) else None, "reason": str(exc)})
        candidates[h].sort(key=lambda item: item[0])
    # The cap is global across horizons, chosen by dates before any model fit or score.
    origins = sorted({item[0] for items in candidates.values() for item in items})[-max_origins:]
    selected = set(origins)
    out["selected_origins"] = [_date(x) for x in origins]
    fits = {}
    for origin in origins:
        try:
            fit = _fit_origin(levels, origin)
            steps_set = {_steps(origin, target) for items in candidates.values() for o, target, _ in items if o == origin}
            a_paths, d_paths = _simulate(fit, float(levels.loc[origin]), origin, max(steps_set), path_count)
            # Retain only aggregates, not 36 origins of simulated path matrices.
            samples = {step: {"a_point": float(np.median(a_paths[:, step])),
                             "a_mean": float(a_paths[:, step].mean()), "d_mean": float(d_paths[:, step].mean()),
                             "a_band": _band(a_paths[:, step]), "d_band": _band(d_paths[:, step])}
                       for step in steps_set}
            fits[origin] = (fit, samples)
            del a_paths, d_paths
        except (ValueError, FloatingPointError, OverflowError) as exc:
            fits[origin] = str(exc)
    for h in HORIZONS:
        rows, chosen = [], [item for item in candidates[h] if item[0] in selected]
        for origin, target, c in chosen:
            fitted = fits[origin]
            if isinstance(fitted, str):
                excluded[h].append({"origin_date": _date(origin), "reason": fitted})
                continue
            fit, samples = fitted
            steps, base, actual = _steps(origin, target), float(c["base"]), float(c["actual"])
            sample = samples[steps]
            a_point, c_point = sample["a_point"], float(c["model_c"])
            variances = {"d": float(fx_model_d.expected_variances(fit["d"], steps).sum()),
                         "constant": float(fit["constant"] * steps), "ewma": float(fit["ewma"] * steps),
                         "realized": (math.log(actual) - math.log(base)) ** 2}
            c_band = {key: c.get(key) for key in ("lower68", "upper68", "lower95", "upper95")}
            # Missing C calibration remains missing; every interval model is then
            # scored only on the intersection with C's available prior-error bands.
            for confidence in (68, 95):
                lo, hi = c_band[f"lower{confidence}"], c_band[f"upper{confidence}"]
                if c["n_calibration"] < fx_model_c.MIN_CALIBRATION or not (_positive_level(lo) and _positive_level(hi) and lo <= hi):
                    c_band[f"lower{confidence}"] = c_band[f"upper{confidence}"] = None
            nested = [c_band[k] for k in ("lower95", "lower68", "upper68", "upper95")]
            if not all(_positive_level(v) for v in nested) or nested != sorted(nested):
                c_band = dict.fromkeys(c_band)
            try:
                normal_bands = {key: _normal_band(base, variances[key]) for key in ("constant", "ewma")}
                if not all(0 < variances[k] < 1e150 for k in VARIANCE_KEYS):
                    raise ValueError("예측 로그분산 계산 범위 초과")
            except (ValueError, OverflowError) as exc:
                excluded[h].append({"origin_date": _date(origin), "reason": str(exc)})
                continue
            row = {"origin_t": _epoch(origin), "target_t": _epoch(target),
                   "origin_date": _date(origin), "target_date": _date(target),
                   "base": base, "actual": actual, "model_steps": steps,
                   "n_train": {"a": fit["n_a"], "c": c.get("n_train"), "d": fit["n_d"]},
                   "n_calibration_c": c.get("n_calibration"),
                   "points": {"a": a_point, "c": c_point, "d": base, "rw": base,
                              "equal_ac_rw": a_point / 3 + c_point / 3 + base / 3,
                              "shrink_ac_rw": .25 * a_point + .25 * c_point + .5 * base},
                   "arithmetic_means": {"a": sample["a_mean"], "d": sample["d_mean"]},
                   "intervals": {"a": sample["a_band"], "c": c_band, "d": sample["d_band"],
                                 **normal_bands},
                   "variance": variances}
            if not _finite_tree(row) or not all(_positive_level(v) for v in row["points"].values()) or not _finite_tree(metrics([row])):
                excluded[h].append({"origin_date": _date(origin), "reason": "평가 수치의 유한 계산 범위 초과"})
                continue
            rows.append(row)
        out["horizons"].append({"horizon_months": h, "active": bool(rows),
                                "reason": None if rows else "공통 유효 평가행 부족",
                                "n_candidates": len(candidates[h]), "n_selected": len(chosen),
                                "n_common": len(rows), "rows": rows, "metrics": metrics(rows),
                                "excluded": excluded[h]})
    out["active"] = any(r["active"] for r in out["horizons"])
    if out["active"]:
        out["reason"] = None
    elif warn is not None and origins:
        warn("FX 공통 검증: A/C/D 공통 유효 평가행 없음")
    return out
