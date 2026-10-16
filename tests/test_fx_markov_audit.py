"""Independent small-state path enumeration for the USDKRW Markov model.

Expected values are obtained by enumerating latent-state paths, not by copying
the production forward, smoothing or cumulative-moment recursions. All values
are synthetic; these are implementation checks, not predictive validation.
"""

import itertools
import math

import numpy as np
import pytest

import fx_markov


TRANSITION = np.array([[0.93, 0.06, 0.01], [0.05, 0.90, 0.05], [0.03, 0.12, 0.85]])
MEANS = np.array([-0.002, 0.001, 0.004])
VARIANCES = np.square([0.003, 0.009, 0.025])
CURRENT = np.array([0.2, 0.5, 0.3])


def _observed_path_oracle(observations):
    """Joint density of each full path under the fixed uniform initial prior."""
    posterior_mass = np.zeros((len(observations), 3))
    likelihood = 0.0
    for path in itertools.product(range(3), repeat=len(observations)):
        density = 1 / 3
        for t, (state, observation) in enumerate(zip(path, observations)):
            if t:
                density *= TRANSITION[path[t - 1], state]
            density *= math.exp(-0.5 * (observation - MEANS[state]) ** 2 / VARIANCES[state])
            density /= math.sqrt(2 * math.pi * VARIANCES[state])
        likelihood += density
        for t, state in enumerate(path):
            posterior_mass[t, state] += density
    return math.log(likelihood), posterior_mass / likelihood


def _future_path_oracle(horizon):
    """Enumerate current+future states, integrate independent Gaussian shocks."""
    probability, first, second, multiplier = 0.0, 0.0, 0.0, 0.0
    ending_states = np.zeros(3)
    for path in itertools.product(range(3), repeat=horizon + 1):
        weight = CURRENT[path[0]]
        for left, right in zip(path[:-1], path[1:]):
            weight *= TRANSITION[left, right]
        mean = sum(MEANS[state] for state in path[1:])
        variance = sum(VARIANCES[state] for state in path[1:])
        probability += weight
        ending_states[path[-1]] += weight
        first += weight * mean
        second += weight * (variance + mean * mean)
        multiplier += weight * math.exp(mean + variance / 2)
    assert probability == pytest.approx(1, abs=1e-13)
    return first, second - first * first, multiplier, ending_states


def test_forward_and_smoother_match_full_hidden_path_enumeration():
    observations = np.array([-0.003, 0.011, -0.027, 0.002, 0.006])
    filtered, predicted, loglik = fx_markov.hamilton_filter(
        observations, MEANS, VARIANCES, TRANSITION)
    for length in range(1, len(observations) + 1):
        expected_loglik, posterior = _observed_path_oracle(observations[:length])
        np.testing.assert_allclose(filtered[length - 1], posterior[-1], atol=1e-13, rtol=0)
    assert loglik == pytest.approx(expected_loglik, abs=1e-13)
    smoothed = fx_markov._smooth(
        filtered, predicted, TRANSITION, np.array([True, False, False, False, False]))
    np.testing.assert_allclose(smoothed, posterior, atol=1e-13, rtol=0)


def test_gap_reset_factorizes_likelihood_and_smoothing():
    observations = np.array([-0.003, 0.011, -0.027, 0.002, 0.006])
    starts = np.array([True, False, True, False, False])
    filtered, predicted, loglik = fx_markov.hamilton_filter(
        observations, MEANS, VARIANCES, TRANSITION, starts)
    smoothed = fx_markov._smooth(filtered, predicted, TRANSITION, starts)
    first_ll, first_posterior = _observed_path_oracle(observations[:2])
    second_ll, second_posterior = _observed_path_oracle(observations[2:])
    assert loglik == pytest.approx(first_ll + second_ll, abs=1e-13)
    np.testing.assert_allclose(predicted[2], np.full(3, 1 / 3), atol=1e-15, rtol=0)
    np.testing.assert_allclose(smoothed[:2], first_posterior, atol=1e-13, rtol=0)
    np.testing.assert_allclose(smoothed[2:], second_posterior, atol=1e-13, rtol=0)


def test_forecast_matches_complete_paths_including_arithmetic_level_moment():
    rows = fx_markov.forecast_moments(CURRENT, MEANS, VARIANCES, TRANSITION, steps=5)
    assert rows[0] == {"step": 0, "log_mean": 0.0, "log_variance": 0.0,
                       "expected_multiplier": 1.0, "probabilities": CURRENT.tolist()}
    for horizon, row in enumerate(rows[1:], 1):
        mean, variance, multiplier, ending_states = _future_path_oracle(horizon)
        assert row["log_mean"] == pytest.approx(mean, abs=1e-14)
        assert row["log_variance"] == pytest.approx(variance, abs=1e-14)
        assert row["expected_multiplier"] == pytest.approx(multiplier, abs=1e-13)
        np.testing.assert_allclose(row["probabilities"], ending_states, atol=1e-13, rtol=0)
        assert row["expected_multiplier"] >= math.exp(row["log_mean"])


@pytest.mark.parametrize("kind", ["fixed_state", "iid_states", "identical_emissions"])
def test_long_horizon_variance_agrees_with_independent_boundary_identities(kind):
    horizon = 252
    means, variances, transition = MEANS, VARIANCES, TRANSITION
    average_mean = float(CURRENT @ means)
    between_state_variance = float(CURRENT @ means ** 2) - average_mean ** 2
    if kind == "fixed_state":
        transition = np.eye(3)
        expected_variance = horizon * float(CURRENT @ variances) + horizon ** 2 * between_state_variance
    elif kind == "iid_states":
        transition = np.tile(CURRENT, (3, 1))
        expected_variance = horizon * (float(CURRENT @ variances) + between_state_variance)
    else:
        means = np.full(3, 0.001)
        variances = np.full(3, 0.009 ** 2)
        average_mean = 0.001
        expected_variance = horizon * 0.009 ** 2
    final = fx_markov.forecast_moments(CURRENT, means, variances, transition, steps=horizon)[-1]
    assert final["log_mean"] == pytest.approx(horizon * average_mean, abs=1e-12)
    assert final["log_variance"] == pytest.approx(expected_variance, abs=1e-12)


def test_filter_distant_observation_does_not_flatten_all_state_densities():
    # Every unscaled density underflows here; their likelihood ratios do not.
    observation = 200.0
    mu = np.array([-1.0, 0.0, 1.0])
    var = np.array([1.0, 4.0, 9.0])
    terms = [-0.5 * (math.log(2 * math.pi * v) + (observation - m) ** 2 / v)
             - math.log(3) for m, v in zip(mu, var)]
    offset = max(terms)
    expected = np.array([math.exp(value - offset) for value in terms])
    expected /= expected.sum()
    filtered, _, ll = fx_markov.hamilton_filter([observation], mu, var, TRANSITION)
    np.testing.assert_allclose(filtered[0], expected, atol=1e-14, rtol=0)
    assert ll == pytest.approx(offset + math.log(sum(math.exp(value - offset) for value in terms)))
    assert filtered[0, 2] > 0.999999


def test_state_permutation_changes_no_forecast_moments():
    order = [2, 0, 1]
    original = fx_markov.forecast_moments(CURRENT, MEANS, VARIANCES, TRANSITION, steps=24)
    relabeled = fx_markov.forecast_moments(
        CURRENT[order], MEANS[order], VARIANCES[order], TRANSITION[np.ix_(order, order)], steps=24)
    for left, right in zip(original, relabeled):
        for key in ("log_mean", "log_variance", "expected_multiplier"):
            assert left[key] == pytest.approx(right[key], abs=1e-13)
        np.testing.assert_allclose(np.asarray(left["probabilities"])[order], right["probabilities"],
                                   atol=1e-13, rtol=0)
