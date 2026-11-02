"""Independent same-input checks of D's numerics and forecast information sets.

Convolution and exhaustive discrete-path oracles do not call production filters
or simulators. These tests audit implementation, not OOS economic superiority,
independent data provenance, or statistical orthogonality to A/C.
"""

import itertools
import math

import numpy as np
import pandas as pd
import pytest

import fx_model_d as model


def _convolution(returns, omega, alpha, beta, initial):
    """Closed finite lag sum, independently of the production recurrence."""
    return np.array([
        beta ** i * initial
        + omega * sum(beta ** j for j in range(i))
        + alpha * sum(beta ** (i - 1 - j) * float(returns[j]) ** 2 for j in range(i))
        for i in range(len(returns) + 1)
    ])


def _fixture(n=714):
    dates = pd.bdate_range("2019-01-01", periods=n + 1)
    t = np.arange(n, dtype=float)
    returns = (0.001 + 0.007 * (1 + np.sin(t / 37)) * np.sin(t * 1.613)
               + 0.002 * np.cos(t * 0.417))
    return pd.Series(1310 * np.exp(np.r_[0., np.cumsum(returns)]), index=dates)


@pytest.mark.parametrize("alpha,beta", [(0., 0.), (0.15, 0.65), (0.03, 0.965)])
def test_variance_filter_matches_finite_lag_convolution(alpha, beta):
    returns = np.array([0.01, -0.03, 0., 0.006, -0.002, 0.015])
    omega, initial = 0.000003, 0.0002
    actual, next_value = model.filter_variance(returns, omega, alpha, beta, initial)
    expected = _convolution(returns, omega, alpha, beta, initial)
    np.testing.assert_allclose(actual, expected[:-1], rtol=2e-15, atol=1e-20)
    assert next_value == pytest.approx(expected[-1], rel=2e-15)


def test_grid_fit_matches_independent_lag_sum_likelihood():
    t = np.arange(103.)
    r = 0.006 * (1.1 + np.sin(t / 9)) * np.sin(t * 1.11)
    target = math.fsum(float(value) ** 2 for value in r) / len(r)
    candidates = [(0., 0.)] + [(a, persistence - a)
        for a in (0.03, 0.06, 0.10, 0.15)
        for persistence in (0.80, 0.90, 0.95, 0.98, 0.995)]
    scores = []
    for alpha, beta in candidates:
        h = _convolution(r, (1 - alpha - beta) * target, alpha, beta, target)[:-1]
        scores.append(math.fsum(math.log(v) + float(x) ** 2 / v for x, v in zip(r, h)) / len(r))
    winner = min(range(len(scores)), key=scores.__getitem__)
    fit, magnitudes = model.fit_garch(r)
    assert (fit["alpha"], fit["beta"]) == candidates[winner]
    assert fit["objective"] == pytest.approx(scores[winner], rel=2e-14)
    assert fit["long_run_var"] == pytest.approx(target, rel=2e-15)
    assert float(np.mean(magnitudes ** 2)) == pytest.approx(1., rel=2e-15)


def test_direction_reversal_and_return_scale_do_not_change_fitted_dynamics():
    r = np.diff(np.log(_fixture(620).to_numpy()))
    fit, magnitudes = model.fit_garch(r)
    reversed_fit, reversed_magnitudes = model.fit_garch(-r)
    assert fit == reversed_fit
    np.testing.assert_array_equal(magnitudes, reversed_magnitudes)
    scaled, scaled_magnitudes = model.fit_garch(r * 3)
    for key in ("alpha", "beta", "persistence"):
        assert fit[key] == scaled[key]
    for key in ("omega", "long_run_var", "next_var"):
        assert scaled[key] == pytest.approx(9 * fit[key], rel=3e-14)
    np.testing.assert_allclose(magnitudes, scaled_magnitudes, rtol=3e-14)


def _enumerated_paths(anchor, fit, magnitudes, steps):
    """Enumerate signed shocks exactly; no production simulation or moments."""
    possible = [-float(x) for x in magnitudes] + [float(x) for x in magnitudes]
    paths = []
    for shocks in itertools.product(possible, repeat=steps):
        h, cumulative = fit["next_var"], 0.
        path = [anchor]
        for shock in shocks:
            innovation = math.sqrt(h) * shock
            cumulative += innovation
            path.append(anchor * math.exp(cumulative))
            h = fit["omega"] + fit["alpha"] * innovation ** 2 + fit["beta"] * h
        paths.append(path)
    return np.asarray(paths)


def test_simulation_and_expected_variance_match_exhaustive_discrete_paths():
    fit = {"alpha": 0.15, "beta": 0.75, "persistence": 0.9,
           "long_run_var": 0.0004, "omega": 0.00004, "next_var": 0.0012}
    magnitudes = np.sqrt([0.5, 1.5])
    exact = _enumerated_paths(1375., fit, magnitudes, 4)
    sampled = model.simulate_paths(1375., fit, magnitudes, steps=4, path_count=80000, seed=4421)
    n = len(sampled)
    # This samples a finite distribution of 4**4 complete paths. Exact moments
    # are independent of the implementation's GARCH analytic forecast helper.
    for step in (1, 2, 4):
        exact_level = exact[:, step]
        error = exact_level.std(ddof=0) / math.sqrt(n)
        assert abs(sampled[:, step].mean() - exact_level.mean()) < 6 * error
        exact_log = np.log(exact[:, step] / 1375.)
        sampled_log = np.log(sampled[:, step] / 1375.)
        assert abs(sampled_log.mean()) < 6 * exact_log.std() / math.sqrt(n)
        second_error = (exact_log ** 2).std() / math.sqrt(n)
        assert abs(np.mean(sampled_log ** 2) - np.mean(exact_log ** 2)) < 6 * second_error
        expected_sum = sum(fit["long_run_var"] + (fit["next_var"] - fit["long_run_var"])
                           * fit["persistence"] ** k for k in range(step))
        assert np.mean(exact_log ** 2) == pytest.approx(expected_sum, rel=3e-14)
        assert sum(model.expected_variances(fit, step)) == pytest.approx(expected_sum, rel=3e-14)


def test_usd_holder_loss_direction_and_fractional_expected_shortfall():
    # 23 equal-mass scenarios mean exactly 1.15 observations in the worst 5%.
    loss = np.linspace(-7., 15., 23)
    anchor = 1400.
    var, es = model.tail_risk(anchor * (1 - loss / 100), anchor)
    offset = 0.95 * (len(loss) - 1)
    lower, fraction = math.floor(offset), offset % 1
    expected_var = loss[lower] * (1 - fraction) + loss[lower + 1] * fraction
    expected_es = (loss[-1] + 0.15 * loss[-2]) / 1.15
    assert var == pytest.approx(expected_var, abs=2e-14)
    assert es == pytest.approx(expected_es, abs=2e-14)
    assert es >= var > 0
    # Favorable USD appreciation is a signed gain, never relabeled as a loss.
    gain_var, gain_es = model.tail_risk(np.full(23, anchor * 1.01), anchor)
    assert gain_var == pytest.approx(-1.)
    assert gain_es == pytest.approx(-1.)


def test_backtest_forecasts_are_unchanged_by_later_prices_and_sample_extension():
    levels = _fixture()
    cutoff = levels.index[630]
    original = model.backtest(levels)
    changed = levels.copy()
    mask = changed.index > cutoff
    changed.loc[mask] *= np.exp(np.linspace(0.1, 0.6, int(mask.sum())))
    perturbed = model.backtest(changed)
    past = lambda result: [row for row in result["rows"]
                            if pd.Timestamp(row["target_t"], unit="s") <= cutoff]
    assert past(original) == past(perturbed)
    assert past(original) == model.backtest(levels.loc[:cutoff])["rows"]
    forecast_keys = ("base", "model_variance", "constant_variance", "ewma_variance", "lower95", "upper95")
    for left, right in zip(original["rows"], perturbed["rows"]):
        if pd.Timestamp(left["origin_t"], unit="s") <= cutoff:
            assert all(left[key] == right[key] for key in forecast_keys)


def test_backtest_maturity_nonoverlap_actual_variance_and_baseline_units():
    levels = _fixture(588)
    result = model.backtest(levels)
    rows = result["rows"]
    assert len(rows) == 4
    logs = [math.log(float(v)) for v in levels]
    returns = [logs[i + 1] - logs[i] for i in range(len(logs) - 1)]
    for i, row in enumerate(rows):
        count = 504 + 21 * i
        assert row["origin_t"] == levels.index[count].timestamp()
        assert row["target_t"] == levels.index[count + 21].timestamp()
        assert row["actual"] == levels.iloc[count + 21]
        realized = math.fsum(value * value for value in returns[count:count + 21]) / 21
        train_variance = math.fsum(value * value for value in returns[:count]) / count
        assert row["realized_variance"] == pytest.approx(realized, rel=1e-13)
        assert row["constant_variance"] == pytest.approx(train_variance, rel=1e-13)
        ewma_oracle = 0.94 ** count * train_variance + 0.06 * math.fsum(
            0.94 ** (count - 1 - j) * value * value for j, value in enumerate(returns[:count]))
        assert row["ewma_variance"] == pytest.approx(ewma_oracle, rel=1e-13)
        if i:
            assert rows[i - 1]["target_t"] == row["origin_t"]
    for label, field in (("d", "model_variance"), ("constant", "constant_variance"), ("ewma", "ewma_variance")):
        score = math.fsum(math.log(row[field]) + row["realized_variance"] / row[field] for row in rows) / len(rows)
        assert result["metrics"]["qlike_" + label] == pytest.approx(score, rel=2e-15)


def test_zero_realized_window_has_finite_qlike_and_no_nan():
    levels = _fixture(546)
    levels.iloc[505:526] = levels.iloc[504]
    result = model.backtest(levels)
    assert result["rows"][0]["realized_variance"] == 0
    for key in ("qlike_d", "qlike_constant", "qlike_ewma"):
        assert math.isfinite(result["metrics"][key])


def test_long_gap_does_not_splice_segments_or_choose_longer_fallback():
    source = _fixture(620)
    dates = source.index.to_list()
    for i in range(590, len(dates)):
        dates[i] += pd.Timedelta(days=28)
    gapped = pd.Series(source.to_numpy(), index=dates)
    payload = model.build({"bb:달러원": gapped, "info:USDKRW": _fixture(850)})
    assert not payload["active"]
    assert payload["source"] == "bb:달러원"
    assert payload["sample"]["n_returns"] == 30
    assert payload["sample"]["excluded_long_gaps"] == 1
    assert payload["backtest"]["rows"] == []
    assert payload["anchor"]["t"] == dates[-1].timestamp()
