"""Zero-log-drift FX volatility forecasting with variance-targeting GARCH.

The estimator is a disclosed finite-grid Gaussian quasi-likelihood fit, not an
unrestricted MLE. Symmetric, variance-normalized historical innovations preserve
empirical shock magnitudes without importing a directional mean forecast. Model
diversification is a design property; statistical orthogonality is not asserted.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

import common
import hedge

SCHEMA = "fx_model_d_v1"
PRIMARY_SOURCE = "bb:달러원"
FALLBACK_SOURCE = "info:USDKRW"
MIN_TRAIN = 504
MAX_TRAIN = 2520
BACKTEST_STEP = 21
MAX_BACKTEST = 120
PATH_COUNT = 10000
BACKTEST_PATH_COUNT = 2000
SEED = 20261103
EWMA_DECAY = 0.94
HORIZONS = (1, 3, 6, 9, 12)
ALPHAS = (0.03, 0.06, 0.10, 0.15)
PERSISTENCES = (0.80, 0.90, 0.95, 0.98, 0.995)
VAR_FLOOR = 1e-16


def _date(value):
    return pd.Timestamp(value).strftime("%Y-%m-%d")


def _epoch(value):
    return int(common.epoch_seconds(pd.DatetimeIndex([value]))[0])


def _empty_metrics():
    return {"n": 0, "qlike_d": None, "qlike_constant": None, "qlike_ewma": None,
            "mse_d": None, "mse_constant": None, "mse_ewma": None, "coverage95": None}


def skeleton(reason="입력 데이터 없음"):
    return {
        "active": False, "reason": reason, "schema": SCHEMA,
        "pair": "USDKRW", "unit": "KRW/USD", "source": PRIMARY_SOURCE,
        "asof": None, "anchor": None,
        "sample": {"start": None, "end": None, "n_levels": 0, "n_returns": 0,
                   "n_train": 0, "excluded_long_gaps": 0},
        "model": {
            "name": "zero_drift_variance_targeting_garch_fhs",
            "mean_log_return": 0, "direction_forecast": False,
            "innovation": "symmetrized_rms_normalized_historical_residual",
            "min_train": MIN_TRAIN, "max_train": MAX_TRAIN,
            "alpha_grid": list(ALPHAS), "persistence_grid": list(PERSISTENCES),
            "constant_candidate": True, "estimator": "finite_grid_gaussian_qmle",
            "annualization": 252, "steps_per_month": 21,
            "calendar_mapping": "21_model_steps_per_calendar_month_interpolated",
            "interval": "pointwise_equal_tail_conditional_simulation",
            "parameter_uncertainty_included": False,
            "coverage_guaranteed": False, "orthogonality_verified": False,
            "vintage": "current_dataset_not_point_in_time_vintages",
            "kg_paper_reproduction": False, "fallback_used": False,
            "spliced": False, "spike_policy": "retain_all_valid_positive_observations",
            "gap_policy": "latest_segment_after_gap_over_7_calendar_days",
            "risk_loss": "100*(1-S_future/S_anchor), unhedged_long_USD_in_KRW",
            "es_method": "worst_5_percent_fractional_empirical_mass",
            "backtest_target": "mean_of_next_21_close_to_close_squared_log_returns",
            "backtest_qlike": "log(forecast_variance)+realized_variance/forecast_variance",
            "backtest_stride": BACKTEST_STEP, "backtest_max_origins": MAX_BACKTEST,
            "ewma_decay": EWMA_DECAY, "parameter_selection": "training_likelihood_only_fixed_grid",
        },
        "fit": None, "forecast": None, "horizons": [],
        "backtest": {"horizon_steps": BACKTEST_STEP, "rows": [], "metrics": _empty_metrics()},
    }


def _latest_segment(series):
    source = PRIMARY_SOURCE
    levels = hedge._daily_observations(series.get(source), positive=True)
    if levels.empty:
        candidate = hedge._daily_observations(series.get(FALLBACK_SOURCE), positive=True)
        if not candidate.empty:
            source, levels = FALLBACK_SOURCE, candidate
    gaps = levels.index.to_series().diff().dt.days > hedge.MAX_FX_GAP_DAYS
    excluded = int(gaps.sum())
    if excluded:
        levels = levels.iloc[int(np.flatnonzero(gaps.to_numpy())[-1]):]
    return source, levels, excluded


def filter_variance(returns, omega, alpha, beta, initial_variance):
    """h[t] uses only r[:t]; the final scalar is h[T+1] after the last return."""
    r = np.asarray(returns, dtype=float)
    if (r.ndim != 1 or not np.isfinite(r).all()
            or not all(math.isfinite(x) for x in (omega, alpha, beta, initial_variance))
            or omega <= 0 or initial_variance <= 0 or alpha < 0 or beta < 0 or alpha + beta >= 1):
        raise ValueError("invalid GARCH filter input")
    h = float(initial_variance)
    history = np.empty(len(r))
    for i, value in enumerate(r):
        history[i] = h
        h = omega + alpha * value * value + beta * h
    if not np.isfinite(history).all() or not math.isfinite(h) or h <= 0:
        raise ValueError("invalid filtered variance")
    return history, float(h)


def fit_garch(returns):
    """A deterministic training-only finite grid; all-zero histories are unidentified."""
    r = np.asarray(returns, dtype=float)
    if r.ndim != 1 or not len(r) or not np.isfinite(r).all():
        raise ValueError("invalid returns")
    long_var = float(np.mean(r * r))  # zero-mean second moment, not demeaned variance
    if long_var <= VAR_FLOOR or not math.isfinite(long_var):
        raise ValueError("insufficient positive variance")
    candidates = [(0.0, 0.0)] + [(alpha, persistence - alpha)
                                for alpha in ALPHAS for persistence in PERSISTENCES]
    alpha = np.array([a for a, _ in candidates])
    beta = np.array([b for _, b in candidates])
    omega = (1 - alpha - beta) * long_var
    h = np.full(len(candidates), long_var)
    objective = np.zeros(len(candidates))
    for squared in r * r:
        objective += np.log(h) + squared / h
        h = omega + alpha * squared + beta * h
    objective /= len(r)
    winner = int(np.argmin(objective))
    a, b, w = float(alpha[winner]), float(beta[winner]), float(omega[winner])
    history, next_var = filter_variance(r, w, a, b, long_var)
    residuals = r / np.sqrt(history)
    magnitudes = np.abs(residuals) / math.sqrt(float(np.mean(residuals * residuals)))
    fit = {"omega": w, "alpha": a, "beta": b, "persistence": a + b,
           "long_run_var": long_var, "next_var": next_var,
           "objective": float(objective[winner]),
           "grid_boundary": bool(a == max(ALPHAS) or a + b >= max(PERSISTENCES) - 1e-12),
           "n_train": len(r)}
    return fit, magnitudes


def expected_variances(fit, steps):
    """Analytical expected daily variances, with the first value h[T+1]."""
    rho, v, h = fit["persistence"], fit["long_run_var"], fit["next_var"]
    return v + (h - v) * np.power(rho, np.arange(steps))


def simulate_paths(anchor, fit, magnitudes, steps=252, path_count=PATH_COUNT, seed=SEED):
    """Sample sign independently of past shock magnitude, then update path variance."""
    m = np.asarray(magnitudes, dtype=float)
    if (not math.isfinite(anchor) or anchor <= 0 or m.ndim != 1 or not len(m)
            or not np.isfinite(m).all() or np.any(m < 0)
            or not isinstance(steps, int) or steps < 1
            or not isinstance(path_count, int) or path_count < 2):
        raise ValueError("invalid simulation input")
    rng = np.random.Generator(np.random.PCG64(seed))
    paths = np.empty((path_count, steps + 1))
    paths[:, 0] = anchor
    h = np.full(path_count, fit["next_var"])
    cumulative = np.zeros(path_count)
    with np.errstate(over="raise", invalid="raise", divide="raise"):
        for step in range(1, steps + 1):
            z = m[rng.integers(0, len(m), size=path_count)] * (2 * rng.integers(0, 2, size=path_count) - 1)
            r = np.sqrt(h) * z
            cumulative += r
            paths[:, step] = anchor * np.exp(cumulative)
            h = fit["omega"] + fit["alpha"] * r * r + fit["beta"] * h
    if not np.isfinite(paths).all() or np.any(paths <= 0):
        raise ValueError("non-finite FX paths")
    return paths


def tail_risk(levels, anchor):
    """Loss in percentage points; ES integrates exactly 5% empirical tail mass."""
    loss = 100 * (1 - np.asarray(levels, dtype=float) / anchor)
    var = float(np.quantile(loss, 0.95, method="linear"))
    ranked = np.sort(loss)[::-1]
    mass = 0.05 * len(ranked)
    whole = int(math.floor(mass))
    fraction = mass - whole
    total = float(np.sum(ranked[:whole]))
    if fraction:
        total += fraction * float(ranked[whole])
    return var, total / mass


def _forecast(anchor, date, fit, magnitudes):
    paths = simulate_paths(anchor, fit, magnitudes, path_count=PATH_COUNT)
    quantiles = np.quantile(paths, [0.025, 0.16, 0.5, 0.84, 0.975], axis=0, method="linear")
    means = paths.mean(axis=0)
    means[0] = anchor
    expected = expected_variances(fit, 252)
    vol = np.r_[math.sqrt(fit["next_var"] * 252) * 100,
                np.sqrt(np.cumsum(expected) / np.arange(1, 253) * 252) * 100]
    dates = pd.DatetimeIndex([date + pd.DateOffset(months=i) for i in range(13)])
    month_t = common.epoch_seconds(dates)
    times = []
    for step in range(253):
        month, offset = divmod(step, 21)
        times.append(month_t[month] if not offset else
                     round(month_t[month] + (month_t[month + 1] - month_t[month]) * offset / 21))
    forecast = {"t": times, "steps": list(range(253)), "mean": means.tolist(),
                "median": quantiles[2].tolist(), "lower68": quantiles[1].tolist(),
                "upper68": quantiles[3].tolist(), "lower95": quantiles[0].tolist(),
                "upper95": quantiles[4].tolist(), "vol_pct": vol.tolist(),
                "engine": "garch_symmetric_filtered_historical_simulation",
                "path_count": PATH_COUNT, "seed": SEED, "rng": "PCG64",
                "numpy_version": np.__version__, "quantile_method": "linear"}
    horizons = []
    for month in HORIZONS:
        step = 21 * month
        var, es = tail_risk(paths[:, step], anchor)
        row = {"horizon_months": month, "steps": step, "target_t": times[step],
               "target_date": _date(dates[month]), "var95_pct": var, "es95_pct": es}
        row.update({key: forecast[key][step] for key in
                    ("mean", "median", "lower68", "upper68", "lower95", "upper95", "vol_pct")})
        horizons.append(row)
    return forecast, horizons


def _metrics(rows):
    result = _empty_metrics()
    if not rows:
        return result
    realized = np.array([row["realized_variance"] for row in rows])
    result["n"] = len(rows)
    for label, key in (("d", "model_variance"), ("constant", "constant_variance"), ("ewma", "ewma_variance")):
        pred = np.array([row[key] for row in rows])
        result[f"qlike_{label}"] = float(np.mean(np.log(pred) + realized / pred))
        result[f"mse_{label}"] = float(np.mean(np.square(realized - pred)))
    result["coverage95"] = sum(row["lower95"] <= row["actual"] <= row["upper95"] for row in rows) / len(rows)
    return result


def backtest(levels):
    """Fixed 21-observation origins, training-only estimates, non-overlapping targets."""
    r = np.diff(np.log(levels.to_numpy(dtype=float)))
    rows = []
    origins = list(range(MIN_TRAIN, len(r) - BACKTEST_STEP + 1, BACKTEST_STEP))[-MAX_BACKTEST:]
    for count in origins:
        train = r[max(0, count - MAX_TRAIN):count]
        if float(np.mean(train * train)) <= VAR_FLOOR:
            continue
        fit, magnitudes = fit_garch(train)
        origin = levels.index[count]
        target = levels.index[count + BACKTEST_STEP]
        anchor = float(levels.iloc[count])
        # Seed tied to the origin, not the final sample size or loop position.
        seed = SEED + _epoch(origin) // 86400
        paths = simulate_paths(anchor, fit, magnitudes, BACKTEST_STEP, BACKTEST_PATH_COUNT, seed)
        lower, upper = np.quantile(paths[:, -1], [0.025, 0.975], method="linear")
        ewma = float(np.mean(train * train))
        for value in train:
            ewma = EWMA_DECAY * ewma + (1 - EWMA_DECAY) * value * value
        rows.append({"origin_t": _epoch(origin), "target_t": _epoch(target),
                     "base": anchor, "actual": float(levels.iloc[count + BACKTEST_STEP]),
                     "realized_variance": float(np.mean(r[count:count + BACKTEST_STEP] ** 2)),
                     "model_variance": float(np.mean(expected_variances(fit, BACKTEST_STEP))),
                     "constant_variance": fit["long_run_var"], "ewma_variance": ewma,
                     "lower95": float(lower), "upper95": float(upper)})
    return {"horizon_steps": BACKTEST_STEP, "rows": rows, "metrics": _metrics(rows)}


def build(series: dict, warn=None):
    out = skeleton()
    try:
        source, levels, excluded = _latest_segment(series)
        out["source"] = source
        out["model"]["fallback_used"] = source == FALLBACK_SOURCE
        if levels.empty:
            return out
        out.update(asof=_date(levels.index[-1]), anchor={"t": _epoch(levels.index[-1]), "v": float(levels.iloc[-1])})
        returns = np.diff(np.log(levels.to_numpy(dtype=float)))
        train = returns[-MAX_TRAIN:]
        out["sample"].update(start=_date(levels.index[0]), end=out["asof"],
                             n_levels=len(levels), n_returns=len(returns), n_train=len(train),
                             excluded_long_gaps=excluded,
                             train_start=_date(levels.index[-len(train) - 1]))
        if len(train) < MIN_TRAIN:
            out["reason"] = f"최근 연속 구간 일간 수익률 최소 {MIN_TRAIN}개 필요"
            return out
        if float(np.mean(train * train)) <= VAR_FLOOR:
            out["reason"] = "수익률 변동성 부족 — 조건부분산 식별 불가"
            return out
        with np.errstate(over="raise", invalid="raise", divide="raise"):
            fit, magnitudes = fit_garch(train)
            forecast, horizons = _forecast(out["anchor"]["v"], levels.index[-1], fit, magnitudes)
            evaluated = backtest(levels)
        out.update(active=True, reason=None, fit=fit, forecast=forecast,
                   horizons=horizons, backtest=evaluated)
    except (ValueError, TypeError, FloatingPointError, OverflowError) as error:
        out.update(active=False, reason="입력 처리 실패 또는 수치 범위 초과", fit=None,
                   forecast=None, horizons=[], backtest={"horizon_steps": BACKTEST_STEP, "rows": [], "metrics": _empty_metrics()})
        if warn:
            warn(f"fx_model_d: {type(error).__name__}")
    return out
