"""USDKRW monthly direct ridge with a fixed 50% random-walk shrinkage.

This is an exploratory reduced-form forecast, not a structural UIP estimate or
a reproduction of a KG paper. Inputs are dated market observations, not vintages.
No future labels, full-sample scaling, fitted hyperparameters, or current partial
month enter a historical forecast. The remaining vintage/revision limitation is
explicit in the published metadata.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

import common
import hedge

SCHEMA = "fx_model_c_v1"
HORIZONS = (1, 3, 6, 12)
PRIMARY_SOURCE = "bb:달러원"
FALLBACK_SOURCE = "info:USDKRW"
KR_SOURCE = "info:한국_1y"
US_SOURCE = "info:UST1y"
RIDGE_LAMBDA = 1.0
SHRINKAGE = 0.5
MIN_TRAIN = 60
MAX_TRAIN = 120
MIN_CALIBRATION = 24
ENDPOINT_MAX_DAYS = 0
FEATURES = (
    ("rate_spread", "한미 1년 금리차"),
    ("momentum_1m", "1개월 모멘텀"),
    ("momentum_3m", "3개월 모멘텀"),
)


def _date(value):
    return pd.Timestamp(value).strftime("%Y-%m-%d")


def _epoch(value):
    return int(common.epoch_seconds(pd.DatetimeIndex([value]))[0])


def _decision_date(period):
    """Last weekday of a calendar month; this is not a holiday calendar."""
    return pd.offsets.BMonthEnd().rollback(period.end_time.normalize())


def skeleton(reason="입력 데이터 없음"):
    return {
        "active": False, "reason": reason, "schema": SCHEMA,
        "asof": None, "model_date": None, "pair": "USDKRW", "unit": "KRW/USD",
        "source": PRIMARY_SOURCE, "anchor": None,
        "sample": {"start": None, "end": None, "n_months": 0,
                   "latest_common_date": None, "n_common_daily": 0},
        "model": {
            "name": "monthly_direct_ridge_rw_shrinkage",
            "ridge_lambda": RIDGE_LAMBDA, "shrinkage": SHRINKAGE,
            "min_train": MIN_TRAIN, "max_train": MAX_TRAIN,
            "min_calibration": MIN_CALIBRATION,
            "loss": "mean_squared_log_change_plus_lambda_beta_squared",
            "intercept_penalized": False, "scaling": "training_only_population_std",
            "center": "geometric_log_forecast", "horizons_months": list(HORIZONS),
            "rates": {"kr": KR_SOURCE, "us": US_SOURCE, "unit": "percent_points"},
            "features": [key for key, _ in FEATURES],
            "alignment": "same_date_inner_join_no_fill",
            "month_close": "exact_last_weekday_common_quote_no_holiday_calendar",
            "max_endpoint_gap_days": ENDPOINT_MAX_DAYS,
            "interval": "past_matured_oos_log_error_empirical_quantiles",
            "interval_min_n": MIN_CALIBRATION,
            "interval_quantiles": [0.025, 0.16, 0.84, 0.975],
            "interval_coverage_guaranteed": False,
            "parameter_selection": "fixed_before_evaluation",
            "vintage": "current_dataset_not_point_in_time_vintages",
            "causal": False, "kg_paper_reproduction": False,
            "overlapping_horizons": True,
        },
        "horizons": [],
    }


def _monthly_panel(series):
    source = PRIMARY_SOURCE
    fx = hedge._daily_observations(series.get(source), positive=True)
    if fx.empty:
        source = FALLBACK_SOURCE
        fx = hedge._daily_observations(series.get(source), positive=True)
    rates = [hedge._daily_observations(series.get(key)) for key in (KR_SOURCE, US_SOURCE)]
    daily = pd.concat([fx.rename("fx"), rates[0].rename("kr"), rates[1].rename("us")],
                      axis=1, join="inner").dropna()
    rows = {}
    if daily.empty:
        return source, daily, rows
    latest = daily.index[-1]
    for period, block in daily.groupby(daily.index.to_period("M")):
        quote = block.index[-1]
        decision = _decision_date(period)
        # Require an actual common quote on the scheduled last weekday. A later
        # month's data must not retroactively turn an earlier stale quote into
        # a known month-end observation. Missing local holidays are therefore
        # omitted, not filled; a historical prefix yields the same snapshots.
        if latest < decision or quote != decision:
            continue
        value = block.iloc[-1]
        rows[period] = {"period": period, "date": decision, "quote_date": quote,
                        "spot": float(value["fx"]), "log_spot": math.log(float(value["fx"])),
                        "spread": float(value["kr"] - value["us"])}
    for period, row in rows.items():
        if period - 1 in rows and period - 3 in rows:
            row["x"] = np.array([row["spread"],
                row["log_spot"] - rows[period - 1]["log_spot"],
                row["log_spot"] - rows[period - 3]["log_spot"]], dtype=float)
    return source, daily, rows


def _ridge_fit(x, y):
    """Minimize mean((y-a-Zb)^2)+lambda*b'b, including constant columns."""
    with np.errstate(over="raise", invalid="raise", divide="raise"):
        mean = np.mean(x, axis=0)
        centered = x - mean
        scale = np.sqrt(np.mean(centered * centered, axis=0))
        # A constant predictor contributes exactly zero, with no division by 0.
        constant = scale <= 1e-12 * np.maximum(1.0, np.abs(mean))
        scale = np.where(constant, 1.0, scale)
        z = centered / scale
        z[:, constant] = 0.0
        intercept = float(np.mean(y))
        beta = np.linalg.solve(z.T @ z / len(y) + RIDGE_LAMBDA * np.eye(x.shape[1]),
                               z.T @ (y - intercept) / len(y))
    if not all(np.all(np.isfinite(item)) for item in (mean, scale, beta, intercept)):
        raise ValueError("nonfinite ridge fit")
    return {"mean": mean, "scale": scale, "beta": beta, "intercept": intercept,
            "constant": constant}


def _predict(fit, x):
    with np.errstate(over="raise", invalid="raise", divide="raise"):
        z = (x - fit["mean"]) / fit["scale"]
        z[fit["constant"]] = 0.0
        contributions = z * fit["beta"]
        raw = fit["intercept"] + float(np.sum(contributions))
    if not math.isfinite(raw):
        raise ValueError("nonfinite ridge prediction")
    return raw, [fit["intercept"], *map(float, contributions)]


def _level(log_level):
    value = math.exp(log_level)
    if not math.isfinite(value) or value <= 0:
        raise ValueError("nonpositive/nonfinite forecast level")
    return value


def _bounds(log_point, errors, point=None):
    if len(errors) < MIN_CALIBRATION:
        return {"lower68": None, "upper68": None, "lower95": None, "upper95": None}
    quantiles = np.quantile(errors, [0.16, 0.84, 0.025, 0.975], method="linear")
    return dict(zip(("lower68", "upper68", "lower95", "upper95"),
                    (point if q == 0 and point is not None else _level(log_point + float(q))
                     for q in quantiles)))


def _metrics(backtest):
    n = len(backtest)
    empty = {"n": 0, "rmse": None, "mae": None, "rw_rmse": None,
             "ridge_rmse": None, "theil_u": None, "coverage68": None,
             "coverage95": None, "n_interval": 0}
    if not n:
        return empty
    errors = {key: [row[key] - row["actual"] for row in backtest]
              for key in ("model_c", "rw", "ridge")}
    def rmse(values):
        # hypot avoids overflow from squaring a large but finite level error.
        return math.hypot(*values) / math.sqrt(n)
    c, rw, ridge = [rmse(errors[key]) for key in ("model_c", "rw", "ridge")]
    calibrated = [row for row in backtest if row["lower68"] is not None]
    m = len(calibrated)
    ratio = c / rw if rw > 0 else None
    if not all(math.isfinite(v) for v in (c, rw, ridge)) or (ratio is not None and not math.isfinite(ratio)):
        raise ValueError("nonfinite OOS metric")
    return {"n": n, "rmse": c, "mae": math.fsum(abs(x) / n for x in errors["model_c"]),
            "rw_rmse": rw, "ridge_rmse": ridge, "theil_u": ratio,
            "coverage68": sum(row["lower68"] <= row["actual"] <= row["upper68"]
                              for row in calibrated) / m if m else None,
            "coverage95": sum(row["lower95"] <= row["actual"] <= row["upper95"]
                              for row in calibrated) / m if m else None,
            "n_interval": m}


def _horizon(rows, horizon):
    latest = list(rows.values())[-1]
    period = latest["period"]
    target_date = _decision_date(period + horizon)
    out = {"horizon_months": horizon, "active": False,
           "reason": f"실현된 학습 표본 최소 {MIN_TRAIN}개 필요",
           "target_date": _date(target_date), "target_t": _epoch(target_date),
           "point": None, "ridge_point": None, "rw": latest["spot"],
           "change_pct": None, "lower68": None, "upper68": None,
           "lower95": None, "upper95": None, "n_train": 0, "n_calibration": 0,
           "metrics": _metrics([]), "contributions": [], "backtest": []}
    if "x" not in latest:
        out["reason"] = "최신 월의 1개월·3개월 전 공통 관측 부족"
        return out
    labelled = [(row, rows[p + horizon]) for p, row in rows.items()
                if "x" in row and p + horizon in rows]
    errors = []
    backtest = []
    for origin in rows.values():
        if "x" not in origin:
            continue
        eligible = [(row, target) for row, target in labelled if target["date"] <= origin["date"]]
        train = eligible[-MAX_TRAIN:]
        if len(train) < MIN_TRAIN:
            continue
        x = np.array([row["x"] for row, target in train])
        y = np.array([target["log_spot"] - row["log_spot"] for row, target in train])
        fit = _ridge_fit(x, y)
        raw, contributions = _predict(fit, origin["x"])
        pred = SHRINKAGE * raw
        # Only errors with already observed target months may calibrate a new
        # forecast; h-month overlapping origins do not imply h labels matured.
        prior = [error for target_time, error in errors if target_time <= origin["date"]]
        point = origin["spot"] if pred == 0 else _level(origin["log_spot"] + pred)
        ridge = origin["spot"] if raw == 0 else _level(origin["log_spot"] + raw)
        bounds = _bounds(origin["log_spot"] + pred, prior, point)
        if origin["period"] == period:
            out.update(active=True, reason=None, point=point, ridge_point=ridge,
                       change_pct=math.expm1(pred) * 100, n_train=len(train),
                       n_calibration=len(prior), **bounds)
            out["contributions"] = [
                {"key": key, "label": label, "log_pct": SHRINKAGE * value * 100}
                for (key, label), value in zip((("intercept", "절편"), *FEATURES), contributions)]
        target = rows.get(origin["period"] + horizon)
        if target is not None:
            row = {"origin_t": _epoch(origin["date"]), "target_t": _epoch(target["date"]),
                   "origin_date": _date(origin["date"]), "target_date": _date(target["date"]),
                   "origin_quote_date": _date(origin["quote_date"]),
                   "target_quote_date": _date(target["quote_date"]),
                   "base": origin["spot"], "actual": target["spot"],
                   "model_c": point, "ridge": ridge, "rw": origin["spot"],
                   "n_train": len(train), "n_calibration": len(prior), **bounds}
            backtest.append(row)
            errors.append((target["date"], target["log_spot"] - origin["log_spot"] - pred))
    out["backtest"] = backtest
    out["metrics"] = _metrics(backtest)
    return out


def build(series: dict, warn=None):
    """Produce the additive fx.json.model_c block; invalid data never invents FX."""
    out = skeleton()
    try:
        with np.errstate(over="raise", invalid="raise", divide="raise"):
            source, daily, rows = _monthly_panel(series)
        out["source"] = source
        out["model"]["fallback_used"] = source == FALLBACK_SOURCE
        out["sample"]["n_common_daily"] = len(daily)
        if daily.empty:
            out["reason"] = "원달러·한미 1년 금리의 동일 날짜 관측 없음"
            return out
        out["sample"]["latest_common_date"] = _date(daily.index[-1])
        if not rows:
            out["reason"] = "월말 마지막 평일의 동일 날짜 공통 관측 필요"
            return out
        first, latest = list(rows.values())[0], list(rows.values())[-1]
        out.update(asof=_date(latest["quote_date"]), model_date=_date(latest["date"]),
                   anchor={"t": _epoch(latest["date"]), "v": latest["spot"],
                           "quote_t": _epoch(latest["quote_date"])})
        out["sample"].update(start=_date(first["date"]), end=_date(latest["date"]), n_months=len(rows))
        for horizon in HORIZONS:
            try:
                out["horizons"].append(_horizon(rows, horizon))
            except (ValueError, FloatingPointError, OverflowError, np.linalg.LinAlgError) as error:
                # A failed horizon has no partially populated estimates or OOS
                # rows. Other horizons and the rest of the dashboard survive.
                failed = {"horizon_months": horizon, "active": False,
                          "reason": "수치 범위 초과 또는 추정 실패", "target_date": _date(_decision_date(latest["period"] + horizon)),
                          "target_t": _epoch(_decision_date(latest["period"] + horizon)),
                          "point": None, "ridge_point": None, "rw": latest["spot"],
                          "change_pct": None, "lower68": None, "upper68": None,
                          "lower95": None, "upper95": None, "n_train": 0, "n_calibration": 0,
                          "metrics": _metrics([]), "contributions": [], "backtest": []}
                out["horizons"].append(failed)
                if warn:
                    warn(f"fx_model_c {horizon}M: {type(error).__name__}")
        out["active"] = any(row["active"] for row in out["horizons"])
        out["reason"] = None if out["active"] else "완료 월 기준 실현 학습 표본 또는 유효 입력 부족"
    except (ValueError, TypeError, FloatingPointError, OverflowError, np.linalg.LinAlgError) as error:
        out = skeleton("입력 처리 실패 또는 수치 범위 초과")
        if warn:
            warn(f"fx_model_c: {type(error).__name__}")
    return out
