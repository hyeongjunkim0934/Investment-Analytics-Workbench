# -*- coding: utf-8 -*-
"""USDKRW daily Gaussian Markov switching model, three volatility regimes.

Parameters are estimated once at the latest observation. Historical filtered
probabilities would therefore be retrospective; only the current probability is
published. Forecasts simulate conditional daily state and log-return paths.
Arithmetic mean, median and equal-tail level quantiles summarize those paths.
Exact cumulative-log moments remain a separate analytic diagnostic/benchmark.
Parameter uncertainty and out-of-sample superiority are not estimated.

Only numpy/pandas are required. Multiple deterministic EM starts reduce (but do
not eliminate) local-optimum risk; failed/degenerate fits are never replaced by a
different forecast model. Long gaps split the likelihood into independent blocks.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

import common
import fx_outlook
import fx_simulation
import hedge

MIN_RETURNS = 756
MAX_RETURNS = 2520
N_REGIMES = 3
ANNUALIZATION = 252
EM_MAX_ITER = 180
EM_TOL_PER_OBSERVATION = 1e-6
VARIANCE_FLOOR = 1e-4  # In sample-standardized units: sigma >= 1% of sample sd.
TRANSITION_FLOOR = 1e-8
LABELS = ("저변동", "중변동", "고변동")


def hamilton_filter(returns, means, variances, transition, block_starts=None):
    """Return filtered/predicted probabilities and the observed-data log likelihood.

Rows of ``transition`` are current states and columns are next states. Every
independent block starts with fixed uniform probabilities, without a fictitious
transition across missing observations. Log scaling also handles distant tails.
"""
    r = np.asarray(returns, dtype=float)
    mu, var = np.asarray(means, float), np.asarray(variances, float)
    matrix = np.asarray(transition, float)
    starts = np.zeros(len(r), dtype=bool) if block_starts is None else np.asarray(block_starts, bool).copy()
    if len(r) == 0:
        raise ValueError("at least one return is required")
    if mu.shape != (3,) or var.shape != (3,) or matrix.shape != (3, 3):
        raise ValueError("three states are required")
    if (not np.isfinite(r).all() or not np.isfinite(mu).all()
            or not np.isfinite(var).all() or np.any(var <= 0)
            or not np.isfinite(matrix).all() or np.any(matrix < 0)
            or not np.allclose(matrix.sum(axis=1), 1, atol=1e-12, rtol=0)
            or starts.shape != r.shape):
        raise ValueError("invalid HMM parameters")
    starts[0] = True
    log_density = -0.5 * (np.log(2 * math.pi * var)[None, :] + (r[:, None] - mu) ** 2 / var)
    filt, pred = np.empty((len(r), 3)), np.empty((len(r), 3))
    previous = np.full(3, 1 / 3)
    likelihood = 0.0
    for t in range(len(r)):
        prior = np.full(3, 1 / 3) if starts[t] else previous @ matrix
        pred[t] = prior
        # Prior zero is legitimate for deterministic transition boundary tests.
        log_weight = log_density[t] + np.log(np.maximum(prior, np.finfo(float).tiny))
        log_weight[prior == 0] = -np.inf
        offset = float(log_weight.max())
        weight = np.exp(log_weight - offset)
        total = float(weight.sum())
        if not math.isfinite(offset) or not total > 0:
            raise ValueError("non-finite likelihood")
        previous = weight / total
        filt[t] = previous
        likelihood += offset + math.log(total)
    return filt, pred, likelihood


def _smooth(filtered, predicted, transition, block_starts):
    smoothed = filtered.copy()
    for t in range(len(filtered) - 2, -1, -1):
        if block_starts[t + 1]:
            continue
        ratio = smoothed[t + 1] / np.maximum(predicted[t + 1], np.finfo(float).tiny)
        row = filtered[t] * (transition @ ratio)
        smoothed[t] = row / row.sum()
    return smoothed


def _fit_one(z, block_starts, means, variances, transition):
    filt, pred, ll = hamilton_filter(z, means, variances, transition, block_starts)
    minimum_delta, last_delta = None, None
    valid_transition = ~block_starts[1:]
    for iteration in range(1, EM_MAX_ITER + 1):
        smooth = _smooth(filt, pred, transition, block_starts)
        mass = smooth.sum(axis=0)
        next_means = (smooth.T @ z) / mass
        next_variances = np.maximum(
            (smooth * (z[:, None] - next_means) ** 2).sum(axis=0) / mass,
            VARIANCE_FLOOR)
        ratios = smooth[1:][valid_transition] / np.maximum(pred[1:][valid_transition], 1e-300)
        counts = transition * (filt[:-1][valid_transition].T @ ratios)
        if np.any(counts.sum(axis=1) <= 0):
            raise ValueError("state has no expected transitions")
        next_transition = np.maximum(counts / counts.sum(axis=1, keepdims=True), TRANSITION_FLOOR)
        next_transition /= next_transition.sum(axis=1, keepdims=True)
        next_filt, next_pred, next_ll = hamilton_filter(
            z, next_means, next_variances, next_transition, block_starts)
        last_delta = next_ll - ll
        minimum_delta = last_delta if minimum_delta is None else min(minimum_delta, last_delta)
        if last_delta < -1e-6:
            return {"converged": False, "valid": False,
                    "iterations": iteration, "reason": "likelihood_decreased",
                    "log_likelihood": ll, "last_delta": last_delta, "minimum_delta": minimum_delta}
        means, variances, transition = next_means, next_variances, next_transition
        filt, pred, ll = next_filt, next_pred, next_ll
        if abs(last_delta) <= EM_TOL_PER_OBSERVATION * len(z):
            break
    converged = abs(last_delta) <= EM_TOL_PER_OBSERVATION * len(z)
    smooth = _smooth(filt, pred, transition, block_starts)
    occupancy = smooth.mean(axis=0)
    valid = (converged and np.min(occupancy) >= 0.01
             and np.min(variances) > VARIANCE_FLOOR * 1.001)
    reason = (None if valid else "iteration_limit" if not converged else
              "state_occupancy_below_one_percent" if np.min(occupancy) < 0.01 else "variance_floor")
    return {"converged": converged, "valid": bool(valid), "reason": reason,
            "iterations": iteration, "log_likelihood": ll, "last_delta": last_delta,
            "minimum_delta": minimum_delta, "means": means, "variances": variances,
            "transition": transition, "filtered": filt[-1], "occupancy": occupancy}


def fit_markov(returns, block_starts=None):
    """Fit three fixed deterministic starts, choose highest valid converged likelihood.

Initialization, sample length, state count and convergence tolerance are fixed
engineering choices; none was selected on a forecast evaluation sample.
"""
    r = np.asarray(returns, float)
    if len(r) < 3 or not np.isfinite(r).all():
        return {"active": False, "reason": "유효한 추정 수익률 부족", "diagnostics": {}}
    scale = float(r.std())
    if not math.isfinite(scale) or scale <= 1e-10:
        return {"active": False, "reason": "수익률 변동이 없어 3개 국면 추정 불가", "diagnostics": {}}
    center = float(r.mean())
    z = (r - center) / scale
    starts = np.zeros(len(r), bool) if block_starts is None else np.asarray(block_starts, bool).copy()
    starts[0] = True
    seeds = [([0, 0, 0], [0.35, 0.8, 1.8], [0.97, 0.95, 0.90]),
             ([-0.2, 0.1, 0.25], [0.5, 1.0, 2.0], [0.85, 0.85, 0.85]),
             ([0.2, -0.15, 0], [0.3, 0.65, 1.5], [0.99, 0.97, 0.95])]
    results, details = [], []
    for index, (mu, sigma, persistence) in enumerate(seeds):
        matrix = np.array([[(1 - stay) / 2] * 3 for stay in persistence])
        np.fill_diagonal(matrix, persistence)
        try:
            result = _fit_one(z, starts, np.array(mu, float), np.square(sigma), matrix)
            result["log_likelihood"] -= len(r) * math.log(scale)
        except (ValueError, FloatingPointError, OverflowError) as exc:
            result = {"converged": False, "valid": False, "reason": str(exc),
                      "iterations": None, "log_likelihood": None}
        details.append({"start": index + 1, **{key: result.get(key) for key in
                       ("converged", "valid", "reason", "iterations", "log_likelihood",
                        "last_delta", "minimum_delta")}})
        if result.get("valid"):
            results.append((index, result))
    diagnostics = {"starts": details, "n_starts": len(seeds),
                   "n_converged": sum(bool(item["converged"]) for item in details),
                   "n_valid": len(results), "max_iterations": EM_MAX_ITER,
                   "tolerance_per_observation": EM_TOL_PER_OBSERVATION,
                   "variance_floor_relative_to_sample": VARIANCE_FLOOR,
                   "initial_probability": [1 / 3] * 3,
                   "global_optimum_guaranteed": False}
    if not results:
        return {"active": False, "reason": "수렴·국면 유효성 검사를 통과한 추정 결과 없음",
                "diagnostics": diagnostics}
    best_index, best = max(results, key=lambda item: item[1]["log_likelihood"])
    order = np.argsort(best["variances"])
    means = center + scale * best["means"][order]
    variances = scale ** 2 * best["variances"][order]
    sigma_ratio = float(math.sqrt(variances[-1] / variances[0]))
    min_adjacent_ratio = float(np.sqrt(variances[1:] / variances[:-1]).min())
    diagnostics.update({"selected_start": best_index + 1, "converged": True,
                        "log_likelihood": best["log_likelihood"],
                        "iterations": best["iterations"],
                        "state_occupancy": best["occupancy"][order].tolist(),
                        "high_low_sigma_ratio": sigma_ratio,
                        "min_adjacent_sigma_ratio": min_adjacent_ratio,
                        "weak_volatility_separation": min_adjacent_ratio < 1.1,
                        "weak_separation_threshold": 1.1,
                        "weak_separation_is_significance_test": False})
    return {"active": True, "means": means, "variances": variances,
            "transition": best["transition"][np.ix_(order, order)],
            "probabilities": best["filtered"][order], "diagnostics": diagnostics}


def forecast_moments(probabilities, means, variances, transition, steps=252):
    """Exact conditional cumulative-log-return moments, with time 0 included.

The first/second state-joint moments retain Cov(r_t,r_s) induced by switching
means. The exponential moment separately yields E[S_h], which generally differs
from exp(E[log S_h]); neither is substituted for the simulated level summaries.
"""
    p = np.asarray(probabilities, float).copy()
    mu, var, matrix = np.asarray(means, float), np.asarray(variances, float), np.asarray(transition, float)
    if (p.shape != (3,) or mu.shape != (3,) or var.shape != (3,) or matrix.shape != (3, 3)
            or not isinstance(steps, int) or steps < 0
            or not all(np.isfinite(a).all() for a in (p, mu, var, matrix))
            or np.any(p < 0) or not np.isclose(p.sum(), 1, atol=1e-12, rtol=0)
            or np.any(var < 0) or np.any(matrix < 0)
            or not np.allclose(matrix.sum(axis=1), 1, atol=1e-12, rtol=0)):
        raise ValueError("invalid forecast parameters")
    first, second, exp_joint = np.zeros(3), np.zeros(3), p.copy()
    exp_increment = np.exp(mu + var / 2)
    rows = [{"step": 0, "log_mean": 0.0, "log_variance": 0.0,
             "expected_multiplier": 1.0, "probabilities": p.tolist()}]
    for step in range(1, steps + 1):
        p = p @ matrix
        carried_first, carried_second = first @ matrix, second @ matrix
        first = carried_first + p * mu
        second = carried_second + 2 * mu * carried_first + p * (var + mu ** 2)
        exp_joint = (exp_joint @ matrix) * exp_increment
        mean = float(first.sum())
        variance = float(second.sum()) - mean ** 2
        if variance < -1e-10 or not np.isfinite(exp_joint).all():
            raise ValueError("invalid cumulative forecast moment")
        rows.append({"step": step, "log_mean": mean, "log_variance": max(0.0, variance),
                     "expected_multiplier": float(exp_joint.sum()), "probabilities": p.tolist()})
    return rows


def build(series: dict, warn=None) -> dict:
    """Raw ``{key: pd.Series}`` -> additive ``fx.json.markov`` payload."""
    source = fx_outlook.PRIMARY_SOURCE
    levels = hedge._daily_observations(series.get(source), positive=True)
    fallback_used = False
    if levels.empty:
        candidate = hedge._daily_observations(series.get(fx_outlook.FALLBACK_SOURCE), positive=True)
        if not candidate.empty:
            source, levels, fallback_used = fx_outlook.FALLBACK_SOURCE, candidate, True
    gaps = levels.index.to_series().diff().dt.days
    all_returns = np.log(levels).diff()
    valid = gaps.between(1, hedge.MAX_FX_GAP_DAYS) & all_returns.notna()
    positions = np.flatnonzero(valid.to_numpy())[-MAX_RETURNS:]
    returns = all_returns.iloc[positions]
    block_starts = np.r_[True, np.diff(positions) > 1] if len(positions) else np.array([], bool)
    latest_date = levels.index[-1] if len(levels) else None
    anchor = ({"t": common.epoch_seconds(pd.DatetimeIndex([latest_date]))[0],
               "v": float(levels.iloc[-1])} if len(levels) else None)
    sample = {"start": (levels.index[positions[0] - 1].strftime("%Y-%m-%d") if len(returns) else None),
              "end": returns.index[-1].strftime("%Y-%m-%d") if len(returns) else None,
              "n_returns": len(returns), "available_n_returns": int(valid.sum()),
              "n_blocks": int(block_starts.sum()), "min_returns": MIN_RETURNS,
              "max_returns": MAX_RETURNS, "frequency": "daily", "return_type": "log",
              "scope": "latest_valid_daily_returns", "annualization": ANNUALIZATION,
              "max_gap_days": hedge.MAX_FX_GAP_DAYS,
              "excluded_long_gaps": max(0, len(levels) - 1 - int(valid.sum())),
              "gap_policy": "exclude_gap_return_and_reset_filter_block",
              "spike_policy": "retain_all_valid_positive_observations"}
    model = {"name": "gaussian_markov_switching_3_regime", "n_regimes": 3,
             "observation": "daily_log_return", "regime_labels": "ascending_volatility",
             "center": "monte_carlo_mean_and_median", "horizon_months": 12, "horizon_steps": 252,
             "steps_per_month": 21, "calendar_mapping": "21_model_steps_per_calendar_month",
             "coverage": "pointwise_model_conditional_68_and_95_percent",
             "calibrated_prediction_interval": False, "parameter_uncertainty_included": False,
             "center_formula": "cross-sectional arithmetic mean and median of simulated S_h",
             "range_formula": "empirical quantiles [0.16,0.84] and [0.025,0.975] of simulated S_h",
             "uncertainty_source": "state_transitions_and_conditional_return_shocks",
             "legacy_range": "analytic_geometric_center_and_log_plus_minus_one_sd",
             "probability_type": "filtered", "parameters": "latest_window_full_sample_EM",
             "out_of_sample_validated": False}
    out = {"active": False, "pair": "USDKRW", "unit": "KRW/USD", "source": source,
           "source_selection": {"primary": fx_outlook.PRIMARY_SOURCE,
                                "fallback": fx_outlook.FALLBACK_SOURCE,
                                "policy": "canonical_bb_explicit_info_fallback_if_no_valid_levels",
                                "fallback_used": fallback_used, "spliced": False},
           "asof": latest_date.strftime("%Y-%m-%d") if latest_date is not None else None,
           "anchor": anchor, "sample": sample, "model": model, "diagnostics": {},
           "regimes": [], "current": None, "transition": None, "range": None,
           "simulation": None}
    if levels.empty:
        return {**out, "reason": "유효한 원달러 환율 시리즈 없음"}
    if len(returns) < MIN_RETURNS:
        return {**out, "reason": f"3국면 추정에 일간 수익률 최소 {MIN_RETURNS}개 필요"}
    if returns.index[-1] != latest_date:
        return {**out, "reason": "최신 환율 직전 장기 공백으로 현재 국면확률 추정 불가"}
    try:
        fitted = fit_markov(returns.to_numpy(), block_starts)
        out["diagnostics"] = fitted["diagnostics"]
        if not fitted["active"]:
            return {**out, "reason": fitted["reason"]}
        mu, var, matrix, probability = (fitted[key] for key in
                                        ("means", "variances", "transition", "probabilities"))
        moments = forecast_moments(probability, mu, var, matrix)
        knots = pd.DatetimeIndex([latest_date + pd.DateOffset(months=month) for month in range(13)])
        selected = [moments[21 * month] for month in range(13)]
        log_mean = [row["log_mean"] for row in selected]
        log_sd = [math.sqrt(row["log_variance"]) for row in selected]
        latest = anchor["v"]
        center = [latest * math.exp(value) for value in log_mean]
        lower = [latest * math.exp(value - sd) for value, sd in zip(log_mean, log_sd)]
        upper = [latest * math.exp(value + sd) for value, sd in zip(log_mean, log_sd)]
        expected = [latest * row["expected_multiplier"] for row in selected]
        if not all(math.isfinite(value) and value > 0 for value in center + lower + upper + expected):
            raise ValueError("환율 모형 범위가 유한 수치 범위를 초과함")
        simulation = fx_simulation.forecast(probability, mu, var, matrix, latest)
        # Keep the established 21-model-observations/calendar-month mapping.
        # Interior timestamps interpolate each month boundary; they are display
        # coordinates, not a forecast of actual trading/holiday dates.
        month_seconds = common.epoch_seconds(knots)
        timestamps = []
        for step in simulation["steps"]:
            month, offset = divmod(step, 21)
            timestamp = (month_seconds[month] if not offset else
                         round(month_seconds[month] + (month_seconds[month + 1] - month_seconds[month]) * offset / 21))
            timestamps.append(timestamp)
        simulation.update({"t": timestamps,
                           "calendar_mapping": "21_model_steps_per_calendar_month_interpolated",
                           "dates_are_trading_calendar": False})
        next_mean = float((probability @ matrix) @ mu)
        next_variance = float((probability @ matrix) @ (var + mu ** 2) - next_mean ** 2)
        out.update({"active": True, "transition": matrix.tolist(),
                    "current": {"probabilities": probability.tolist(),
                                "regime": int(np.argmax(probability)),
                                "sigma_next_annual_pct": math.sqrt(max(0, next_variance) * 252) * 100,
                                "mean_next_daily": next_mean},
                    "regimes": [{"id": j, "label": label, "mu_daily": float(mu[j]),
                                 "sigma_daily": math.sqrt(var[j]),
                                 "mu_annual_pct": float(mu[j]) * 252 * 100,
                                 "sigma_annual_pct": math.sqrt(var[j] * 252) * 100,
                                 "probability": float(probability[j]),
                                 "expected_duration_days": float(1 / (1 - matrix[j, j]))}
                                for j, label in enumerate(LABELS)],
                    "simulation": simulation,
                    "range": {"t": common.epoch_seconds(knots), "center": center,
                              "role": "legacy_analytic_diagnostic",
                              "lower": lower, "upper": upper, "expected_level": expected,
                              "log_mean": log_mean, "log_sd": log_sd,
                              "state_probabilities": [row["probabilities"] for row in selected]}})
    except (ValueError, FloatingPointError, OverflowError) as exc:
        if warn:
            warn(f"fx_markov: {exc}")
        return {**out, "reason": f"3국면 모형 계산 불가: {exc}"}
    return out
