"""Seeded conditional FX path simulation and model-independent summaries.

The sampler and summarizer are separate so future innovation/state models can
produce the same ``(path, horizon)`` level array without changing the chart
contract. Intervals are pointwise, conditional on fitted parameters. They do not
include parameter uncertainty and are not empirically calibrated coverage.
"""

from __future__ import annotations

import math

import numpy as np


DEFAULT_PATH_COUNT = 20_000
DEFAULT_SEED = 20261020
DEFAULT_SAMPLE_PATH_COUNT = 12


def _integer(value, minimum):
    return isinstance(value, (int, np.integer)) and not isinstance(value, (bool, np.bool_)) and value >= minimum


def simulate_markov_paths(anchor, probabilities, means, variances, transition,
                          steps=252, path_count=DEFAULT_PATH_COUNT, seed=DEFAULT_SEED):
    """Draw iid paths with state transitions BEFORE each next-period return.

``transition[i, j]`` is P(next=j | current=i). Each path first draws its current
state from the latest filtered probabilities, then retains its own state through
the horizon. Shocks are independent conditional on states. ``means`` and
``variances`` are one-step LOG-return parameters, so there is no extra -sigma²/2.
Only synthetic paths are returned; no realized history is copied into them.
"""
    p = np.asarray(probabilities, dtype=float)
    mu = np.asarray(means, dtype=float)
    var = np.asarray(variances, dtype=float)
    matrix = np.asarray(transition, dtype=float)
    k = len(p) if p.ndim == 1 else 0
    if (not k or mu.shape != (k,) or var.shape != (k,) or matrix.shape != (k, k)
            or not np.isfinite(anchor) or anchor <= 0
            or not _integer(steps, 0) or not _integer(path_count, 2) or not _integer(seed, 0)
            or not all(np.isfinite(a).all() for a in (p, mu, var, matrix))
            or np.any(p < 0) or not np.isclose(p.sum(), 1, atol=1e-12, rtol=0)
            or np.any(var < 0) or np.any(matrix < 0)
            or not np.allclose(matrix.sum(axis=1), 1, atol=1e-12, rtol=0)):
        raise ValueError("invalid FX simulation parameters")
    rng = np.random.Generator(np.random.PCG64(int(seed)))
    cumulative = np.cumsum(matrix, axis=1)
    cumulative[:, -1] = 1.0
    initial = np.cumsum(p)
    initial[-1] = 1.0
    state = np.searchsorted(initial, rng.random(path_count), side="right")
    paths = np.empty((path_count, steps + 1), dtype=float)
    paths[:, 0] = anchor
    frequencies = np.empty((steps + 1, k), dtype=float)
    frequencies[0] = np.bincount(state, minlength=k) / path_count
    log_return = np.zeros(path_count)
    sigma = np.sqrt(var)
    with np.errstate(over="raise", invalid="raise"):
        for step in range(1, steps + 1):
            state = np.sum(rng.random(path_count)[:, None] >= cumulative[state], axis=1)
            log_return += mu[state] + sigma[state] * rng.standard_normal(path_count)
            paths[:, step] = anchor * np.exp(log_return)
            frequencies[step] = np.bincount(state, minlength=k) / path_count
    if not np.isfinite(paths).all() or np.any(paths <= 0):
        raise ValueError("FX simulation paths exceed finite positive range")
    return paths, frequencies


def summarize_paths(paths, sample_path_count=DEFAULT_SAMPLE_PATH_COUNT):
    """Summarize FX LEVELS cross-sectionally at every horizon, including t=0.

Sample lines are the first iid draws, never selected by their shape or outcome.
The Monte Carlo standard error describes numerical mean-estimation error, not
the predictive uncertainty bands. Median and quantiles are not complete paths.
"""
    values = np.asarray(paths, dtype=float)
    if (values.ndim != 2 or values.shape[0] < 2 or values.shape[1] < 1
            or not np.isfinite(values).all() or np.any(values <= 0)
            or not _integer(sample_path_count, 0)):
        raise ValueError("invalid FX simulation path matrix")
    quantiles = np.quantile(values, [0.025, 0.16, 0.5, 0.84, 0.975], axis=0, method="linear")
    mean = values.mean(axis=0)
    standard_error = values.std(axis=0, ddof=1) / math.sqrt(len(values))
    # A repeated non-integer anchor can accumulate rounding error under mean/
    # std reduction. Deterministic columns have exactly zero sampling error.
    constant = np.all(values == values[0], axis=0)
    mean[constant] = values[0, constant]
    standard_error[constant] = 0.0
    if not np.isfinite(mean).all() or not np.isfinite(standard_error).all():
        raise ValueError("FX simulation summaries exceed finite range")
    return {"steps": list(range(values.shape[1])), "mean": mean.tolist(),
            "median": quantiles[2].tolist(), "lower68": quantiles[1].tolist(),
            "upper68": quantiles[3].tolist(), "lower95": quantiles[0].tolist(),
            "upper95": quantiles[4].tolist(), "mean_mc_se": standard_error.tolist(),
            "sample_paths": values[:sample_path_count].tolist()}


def forecast(probabilities, means, variances, transition, anchor, steps=252,
             path_count=DEFAULT_PATH_COUNT, seed=DEFAULT_SEED,
             sample_path_count=DEFAULT_SAMPLE_PATH_COUNT):
    """Return the versioned, JSON-compatible distribution contract, without dates."""
    paths, frequencies = simulate_markov_paths(
        anchor, probabilities, means, variances, transition, steps, path_count, seed)
    result = summarize_paths(paths, sample_path_count)
    result.update({"schema_version": 1, "engine": "gaussian_markov_log_returns",
                   "seed": int(seed), "path_count": int(path_count), "rng": "PCG64",
                   "numpy_version": np.__version__, "state_probabilities": frequencies.tolist(),
                   "interval_type": "pointwise_equal_tail_conditional_prediction",
                   "nominal_coverages": [0.68, 0.95], "quantile_method": "linear",
                   "calibrated_prediction_interval": False,
                   "parameter_uncertainty_included": False,
                   "sample_path_selection": "first_paths",
                   "sample_path_count": len(result["sample_paths"]),
                   "mean_mc_se_definition": "sample_level_sd/sqrt(path_count)",
                   "median_is_realizable_path": False})
    return result
