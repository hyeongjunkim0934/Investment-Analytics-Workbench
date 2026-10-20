"""Numerical identities and boundaries for the FX Monte Carlo engine.

These verify conditional simulation, not out-of-sample predictive performance.
Only synthetic inputs are used. A separate audit enumerates state mixtures.
"""

import json
import math
from statistics import NormalDist

import numpy as np
import pytest

import fx_markov
import fx_simulation


def test_deterministic_cycle_transitions_before_return_and_preserves_anchor():
    anchor = 1341.123456
    means = np.array([-0.01, 0.02, 0.03])
    transition = np.array([[0, 1, 0], [0, 0, 1], [1, 0, 0]])
    output = fx_simulation.forecast([1, 0, 0], means, [0, 0, 0], transition,
                                    anchor, steps=7, path_count=20000)
    expected = anchor * np.exp(np.r_[0, np.cumsum(means[[1, 2, 0, 1, 2, 0, 1]])])
    for key in ("mean", "median", "lower68", "upper68", "lower95", "upper95"):
        np.testing.assert_array_equal(output[key], expected)
        assert output[key][0] == anchor
    assert output["mean_mc_se"] == [0.0] * 8
    np.testing.assert_array_equal(output["state_probabilities"], np.eye(3)[[0, 1, 2, 0, 1, 2, 0, 1]])
    assert all(path == output["mean"] for path in output["sample_paths"])


def test_single_state_lognormal_distribution_matches_closed_form():
    anchor, mu, sigma, horizon, n = 1200.5, 0.001, 0.025, 12, 100000
    result = fx_simulation.forecast([1], [mu], [sigma ** 2], [[1]], anchor,
                                   steps=horizon, path_count=n, seed=283)
    log_mean, log_sigma = horizon * mu, math.sqrt(horizon) * sigma
    exact_mean = anchor * math.exp(log_mean + log_sigma ** 2 / 2)
    assert abs(result["mean"][-1] - exact_mean) < 5 * result["mean_mc_se"][-1]
    normal = NormalDist()
    for field, probability in (("lower95", 0.025), ("lower68", 0.16),
                               ("median", 0.5), ("upper68", 0.84), ("upper95", 0.975)):
        z = normal.inv_cdf(probability)
        exact = anchor * math.exp(log_mean + log_sigma * z)
        density = normal.pdf(z) / (exact * log_sigma)
        quantile_se = math.sqrt(probability * (1 - probability) / n) / density
        assert abs(result[field][-1] - exact) < 5 * quantile_se


def test_seed_reproducibility_sample_prefix_and_no_global_rng_mutation():
    args = ([0.2, 0.8], [-0.001, 0.002], [0.0001, 0.0004], [[0.95, 0.05], [0.1, 0.9]], 1300)
    before = np.random.get_state()
    first = fx_simulation.forecast(*args, steps=15, path_count=1000, seed=7)
    same = fx_simulation.forecast(*args, steps=15, path_count=1000, seed=7, sample_path_count=3)
    different = fx_simulation.forecast(*args, steps=15, path_count=1000, seed=8)
    after = np.random.get_state()
    for key in ("mean", "median", "lower68", "upper68", "lower95", "upper95", "mean_mc_se"):
        assert first[key] == same[key]
    assert first["sample_paths"][:3] == same["sample_paths"]
    assert first["sample_paths"] != different["sample_paths"]
    assert before[0] == after[0] and before[2:] == after[2:]
    np.testing.assert_array_equal(before[1], after[1])
    assert first["seed"] == 7 and first["rng"] == "PCG64"
    assert first["sample_path_selection"] == "first_paths"
    assert not first["parameter_uncertainty_included"]
    json.dumps(first, allow_nan=False)


def test_persistent_state_is_retained_through_each_complete_path():
    probabilities = np.array([0.2, 0.3, 0.5])
    means = np.array([-0.02, 0.01, 0.04])
    n, horizon, anchor = 30000, 21, 1000
    paths, frequencies = fx_simulation.simulate_markov_paths(
        anchor, probabilities, means, [0, 0, 0], np.eye(3),
        steps=horizon, path_count=n, seed=19)
    labels = np.argmin(abs(np.log(paths[:, 1:] / anchor)[:, :1] - means), axis=1)
    expected = anchor * np.exp(means[labels, None] * np.arange(horizon + 1))
    np.testing.assert_allclose(paths, expected, rtol=2e-15)
    np.testing.assert_array_equal(frequencies, np.tile(frequencies[0], (horizon + 1, 1)))
    assert np.all(abs(frequencies[0] - probabilities) < 5 * np.sqrt(probabilities * (1 - probabilities) / n))


def test_multistate_mc_mean_matches_exact_exponential_moment_recursion():
    p = np.array([0.1, 0.4, 0.5])
    mu = np.array([-0.001, 0.0003, 0.002])
    var = np.square([0.003, 0.01, 0.03])
    matrix = np.array([[0.97, 0.02, 0.01], [0.02, 0.96, 0.02], [0.03, 0.07, 0.90]])
    steps, anchor = 63, 1300.5
    analytic = fx_markov.forecast_moments(p, mu, var, matrix, steps=steps)
    simulated = fx_simulation.forecast(p, mu, var, matrix, anchor,
                                      steps=steps, path_count=60000, seed=418)
    for step in (1, 21, 42, 63):
        exact = anchor * analytic[step]["expected_multiplier"]
        assert abs(simulated["mean"][step] - exact) < 5 * simulated["mean_mc_se"][step]
    assert np.allclose(np.sum(simulated["state_probabilities"], axis=1), 1, atol=1e-15)


def test_summary_quantiles_are_level_statistics_and_allow_skew_mean_outside_band():
    paths = np.array([[1341.45, 1], [1341.45, 1], [1341.45, 1],
                      [1341.45, 1], [1341.45, 1000]], dtype=float)
    result = fx_simulation.summarize_paths(paths, sample_path_count=0)
    assert result["mean"][1] == 200.8
    assert result["median"][1] == 1
    assert result["lower68"][1] == 1
    assert result["upper68"][1] == pytest.approx(360.64)
    assert result["sample_paths"] == []
    assert result["mean"][0] == 1341.45
    assert result["mean_mc_se"][0] == 0
    # Only 1% tail mass: the mean can lie above even the 95% central interval.
    long_tail = np.ones((100, 1))
    long_tail[-1, 0] = 10000
    tail = fx_simulation.summarize_paths(long_tail)
    assert tail["mean"][0] > tail["upper95"][0]


def test_zero_horizon_is_exact_anchor_and_valid_json():
    result = fx_simulation.forecast([1], [0.2], [0.01], [[1]], 1.23,
                                   steps=0, path_count=100, sample_path_count=0)
    assert result["steps"] == [0]
    assert result["mean"] == result["median"] == result["lower95"] == result["upper95"] == [1.23]
    assert result["mean_mc_se"] == [0]
    assert result["sample_path_count"] == 0
    json.dumps(result, allow_nan=False)


@pytest.mark.parametrize("change", [
    {"anchor": 0}, {"anchor": float("inf")}, {"probabilities": [0.5]},
    {"variances": [-1]}, {"transition": [[0.9]]}, {"means": [float("nan")]},
    {"steps": -1}, {"steps": 1.5}, {"path_count": 1}, {"seed": -1}, {"seed": True},
])
def test_invalid_sampler_inputs_fail_closed(change):
    arguments = dict(anchor=1000, probabilities=[1], means=[0], variances=[0.0001],
                     transition=[[1]], steps=1, path_count=10, seed=1)
    arguments.update(change)
    with pytest.raises(ValueError):
        fx_simulation.simulate_markov_paths(**arguments)


def test_overflow_is_not_clipped_into_a_fake_forecast():
    with pytest.raises((ValueError, FloatingPointError)):
        fx_simulation.forecast([1], [1000], [0], [[1]], 1000, steps=2, path_count=10)
