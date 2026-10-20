"""Independent latent-path mixture oracle for Monte Carlo distributions.

Enumerate all current/future state sequences and analytically integrate their
Gaussian shocks. This checks the simulation's complete marginal distribution,
not just agreement with the production moment recurrence. Shared model/input
assumptions remain; these are implementation checks, not predictive validation.
"""

import itertools
import math

import numpy as np
import pytest

import fx_simulation


ANCHOR = 1374.125
INITIAL = np.array([0.73, 0.21, 0.06])
TRANSITION = np.array([[0.63, 0.30, 0.07],
                       [0.05, 0.82, 0.13],
                       [0.01, 0.04, 0.95]])
MEANS = np.array([-0.04, 0.015, 0.07])
VARIANCES = np.square([0.01, 0.07, 0.18])
PATH_COUNT = 80_000


def _mixture(horizon):
    """Exact mixture by complete path multiplication, without a forward filter."""
    components = []
    ending = np.zeros(3)
    for states in itertools.product(range(3), repeat=horizon + 1):
        weight = float(INITIAL[states[0]])
        for prior, current in zip(states[:-1], states[1:]):
            weight *= float(TRANSITION[prior, current])
        mean = sum(float(MEANS[state]) for state in states[1:])
        variance = sum(float(VARIANCES[state]) for state in states[1:])
        components.append((weight, mean, variance))
        ending[states[-1]] += weight
    assert sum(row[0] for row in components) == pytest.approx(1, abs=1e-13)
    return components, ending


def _cdf(level, components):
    log_multiplier = math.log(level / ANCHOR)
    return sum(weight * (0.5 + 0.5 * math.erf(
        (log_multiplier - mean) / math.sqrt(2 * variance)))
        for weight, mean, variance in components)


@pytest.fixture(scope="module")
def simulated():
    return fx_simulation.forecast(
        INITIAL, MEANS, VARIANCES, TRANSITION, ANCHOR,
        steps=5, path_count=PATH_COUNT, seed=87013, sample_path_count=0)


@pytest.mark.parametrize("horizon", [1, 3, 5])
def test_quantile_cdf_matches_complete_gaussian_mixture(simulated, horizon):
    components, _ = _mixture(horizon)
    for field, probability in (("lower95", 0.025), ("lower68", 0.16),
                               ("median", 0.5), ("upper68", 0.84),
                               ("upper95", 0.975)):
        actual_probability = _cdf(simulated[field][horizon], components)
        # Fixed seed, pre-specified tolerance in CDF space. The large tolerance
        # covers Monte Carlo sampling error; it is not an OOS coverage claim.
        tolerance = 6 * math.sqrt(probability * (1 - probability) / PATH_COUNT) + 2 / PATH_COUNT
        assert abs(actual_probability - probability) < tolerance, (field, horizon)


@pytest.mark.parametrize("horizon", [1, 3, 5])
def test_level_mean_and_state_mass_match_full_path_integrals(simulated, horizon):
    components, ending = _mixture(horizon)
    expectation = ANCHOR * sum(weight * math.exp(mean + variance / 2)
                               for weight, mean, variance in components)
    second_moment = ANCHOR ** 2 * sum(weight * math.exp(2 * mean + 2 * variance)
                                      for weight, mean, variance in components)
    exact_standard_error = math.sqrt((second_moment - expectation ** 2) / PATH_COUNT)
    assert abs(simulated["mean"][horizon] - expectation) < 6 * exact_standard_error
    for actual, expected in zip(simulated["state_probabilities"][horizon], ending):
        tolerance = 6 * math.sqrt(expected * (1 - expected) / PATH_COUNT) + 2 / PATH_COUNT
        assert abs(actual - expected) < tolerance


def test_mixture_median_is_not_log_mean_or_mean_path(simulated):
    # This deliberately asymmetric case detects a renamed legacy geometric
    # center or a duplicated mean series presented as the median.
    components, _ = _mixture(5)
    geometric_center = ANCHOR * math.exp(sum(weight * mean for weight, mean, _ in components))
    median = simulated["median"][5]
    assert abs(median - geometric_center) > 10
    assert abs(simulated["mean"][5] - median) > 10


def test_one_path_retains_state_throughout_the_horizon():
    # An absorbing, zero-noise model has exactly three possible full paths.
    # Re-sampling the state each day could preserve marginal state masses but
    # creates impossible trajectories and the wrong horizon distribution.
    means = np.array([-0.02, 0.0, 0.03])
    paths, _ = fx_simulation.simulate_markov_paths(
        ANCHOR, [0.4, 0.35, 0.25], means, [0, 0, 0], np.eye(3),
        steps=8, path_count=400, seed=43)
    expected = ANCHOR * np.exp(means[:, None] * np.arange(9)[None, :])
    for path in paths:
        errors = np.max(np.abs(expected - path[None, :]), axis=1)
        assert errors.min() < 1e-9
