"""Synthetic fitting and data contracts; independent moment tests live in audit file.

No private market levels or fitted production parameters are committed here.
"""

import json
import math

import numpy as np
import pandas as pd
import pytest

import fx_markov


def _returns(n=2520):
    rng = np.random.default_rng(426)
    matrix = np.array([[0.98, 0.015, 0.005], [0.015, 0.97, 0.015], [0.005, 0.025, 0.97]])
    states = [0]
    for _ in range(n - 1):
        states.append(rng.choice(3, p=matrix[states[-1]]))
    return rng.normal(np.array([-0.0001, 0.0001, 0.0004])[states],
                      np.array([0.002, 0.006, 0.015])[states])


def _levels(n=800, end="2024-01-31"):
    returns = _returns(n)
    return pd.Series(1200 * np.exp(np.r_[0, np.cumsum(returns)]),
                     index=pd.bdate_range(end=end, periods=n + 1))


def _fixed_fit(returns, block_starts=None):
    return {"active": True, "means": np.array([-0.0002, 0, 0.0003]),
            "variances": np.array([0.002, 0.005, 0.012]) ** 2,
            "transition": np.array([[0.98, 0.015, 0.005], [0.02, 0.96, 0.02], [0.01, 0.04, 0.95]]),
            "probabilities": np.array([0.2, 0.3, 0.5]),
            "diagnostics": {"converged": True, "n_starts": 3}}


@pytest.fixture(scope="module")
def fitted():
    returns = _returns()
    return returns, fx_markov.fit_markov(returns)


def test_multistart_fits_sorted_identifiable_volatility_states(fitted):
    returns, result = fitted
    assert result["active"]
    sigma = np.sqrt(result["variances"])
    assert np.all(np.diff(sigma) > 0)
    # Known generative states are well separated; this checks fitting can recover
    # their scale, not a claim of inferential coverage or forecast superiority.
    assert sigma == pytest.approx([0.002, 0.006, 0.015], rel=0.25)
    assert np.all(result["transition"] >= 0)
    assert result["transition"].sum(axis=1) == pytest.approx(np.ones(3), abs=1e-12)
    assert result["probabilities"].sum() == pytest.approx(1)
    assert np.isfinite(result["means"]).all()
    diagnostic = result["diagnostics"]
    assert diagnostic["n_starts"] == 3
    valid = [row for row in diagnostic["starts"] if row["valid"]]
    assert diagnostic["log_likelihood"] == max(row["log_likelihood"] for row in valid)
    assert all(row["minimum_delta"] >= -1e-6 for row in valid)
    assert min(diagnostic["state_occupancy"]) >= 0.01
    # Recompute using returned (original-unit, sorted) parameters: diagnostics
    # must describe the final parameters, not the previous EM iteration.
    filtered, _, likelihood = fx_markov.hamilton_filter(
        returns, result["means"], result["variances"], result["transition"])
    assert likelihood == pytest.approx(diagnostic["log_likelihood"], abs=1e-9)
    assert filtered[-1] == pytest.approx(result["probabilities"], abs=1e-12)


def test_iteration_limit_never_claims_convergence(monkeypatch):
    monkeypatch.setattr(fx_markov, "EM_MAX_ITER", 1)
    result = fx_markov.fit_markov(_returns(800))
    assert not result["active"]
    assert result["diagnostics"]["n_converged"] == 0
    assert result["diagnostics"]["n_valid"] == 0
    assert all(row["reason"] == "iteration_limit" for row in result["diagnostics"]["starts"])
    json.dumps(result, allow_nan=False)


def test_empty_short_and_constant_data_fail_closed():
    missing = fx_markov.build({})
    short = fx_markov.build({"bb:달러원": _levels(755)})
    constant = fx_markov.build({"bb:달러원": pd.Series(1200.0, index=_levels().index)})
    for result in (missing, short, constant):
        assert not result["active"] and result["reason"]
        assert result["range"] is None and result["current"] is None
        json.dumps(result, allow_nan=False)
    assert short["sample"]["min_returns"] == 756
    assert "변동" in constant["reason"]


def test_data_selection_never_splices_primary_and_fallback(monkeypatch):
    monkeypatch.setattr(fx_markov, "fit_markov", _fixed_fit)
    fallback = _levels()
    short_primary = fallback.iloc[-30:] * 1.2
    result = fx_markov.build({"bb:달러원": short_primary, "info:USDKRW": fallback})
    assert not result["active"] and result["source"] == "bb:달러원"
    assert not result["source_selection"]["fallback_used"]
    invalid_primary = pd.Series([0, -1, np.nan], index=pd.bdate_range("2021-01-01", periods=3))
    result = fx_markov.build({"bb:달러원": invalid_primary, "info:USDKRW": fallback})
    assert result["active"] and result["source"] == "info:USDKRW"
    assert result["source_selection"]["fallback_used"]
    assert not result["source_selection"]["spliced"]
    assert result["anchor"]["v"] == fallback.iloc[-1]


def test_latest_window_caps_returns_and_matches_exact_raw_values(monkeypatch):
    levels = _levels(2800)
    captured = {}

    def spy(returns, starts):
        captured.update(returns=returns.copy(), starts=starts.copy())
        return _fixed_fit(returns, starts)

    monkeypatch.setattr(fx_markov, "fit_markov", spy)
    result = fx_markov.build({"bb:달러원": levels})
    assert result["sample"]["n_returns"] == 2520
    assert result["sample"]["available_n_returns"] == 2800
    assert result["sample"]["start"] == levels.index[-2521].strftime("%Y-%m-%d")
    assert result["sample"]["end"] == levels.index[-1].strftime("%Y-%m-%d")
    assert captured["returns"] == pytest.approx(np.log(levels.to_numpy()[1:] / levels.to_numpy()[:-1])[-2520:])
    assert np.flatnonzero(captured["starts"]).tolist() == [0]


def test_long_gap_excludes_return_and_resets_only_following_filter_block(monkeypatch):
    levels = _levels(850)
    retained = levels.drop(levels.index[400:420])
    # A large genuine move stays in the model; no round-trip spike screen.
    retained.iloc[100] *= 1.3
    invalid = pd.Series([1e9, np.inf, -10, np.nan],
                        index=[pd.Timestamp("2024-01-27"), retained.index[-1],
                               retained.index[-2], retained.index[-1]])
    observed = pd.concat([retained, invalid])
    captured = {}

    def spy(returns, starts):
        captured.update(returns=returns.copy(), starts=starts.copy())
        return _fixed_fit(returns, starts)

    monkeypatch.setattr(fx_markov, "fit_markov", spy)
    result = fx_markov.build({"bb:달러원": observed})
    expected = []
    for i in range(1, len(retained)):
        if (retained.index[i] - retained.index[i - 1]).days <= 7:
            expected.append(math.log(retained.iloc[i] / retained.iloc[i - 1]))
    assert captured["returns"] == pytest.approx(expected, abs=2e-15)
    assert np.flatnonzero(captured["starts"]).tolist() == [0, 399]
    assert result["sample"]["n_blocks"] == 2
    assert result["sample"]["excluded_long_gaps"] == 1
    assert result["anchor"]["v"] == levels.iloc[-1]
    assert max(captured["returns"]) > 0.2


def test_latest_quote_after_long_gap_disables_forecast(monkeypatch):
    levels = _levels()
    extra = pd.Series([levels.iloc[-1] * 1.1], index=[levels.index[-1] + pd.offsets.BDay(20)])

    def must_not_fit(*args):
        raise AssertionError("stale filtered probability must not be used")

    monkeypatch.setattr(fx_markov, "fit_markov", must_not_fit)
    result = fx_markov.build({"bb:달러원": pd.concat([levels, extra])})
    assert not result["active"] and "공백" in result["reason"]
    assert result["anchor"]["v"] == extra.iloc[-1]
    assert result["sample"]["end"] == levels.index[-1].strftime("%Y-%m-%d")


def test_monthly_range_starts_at_observed_anchor_and_uses_252_steps(monkeypatch):
    monkeypatch.setattr(fx_markov, "fit_markov", _fixed_fit)
    levels = _levels()
    result = fx_markov.build({"bb:달러원": levels})
    assert result["active"]
    band = result["range"]
    assert len(band["t"]) == 13
    assert pd.to_datetime(band["t"], unit="s")[1] == pd.Timestamp("2024-02-29")
    assert pd.to_datetime(band["t"], unit="s")[-1] == pd.Timestamp("2025-01-31")
    assert band["t"][0] == result["anchor"]["t"]
    for name in ("lower", "center", "upper", "expected_level"):
        assert band[name][0] == levels.iloc[-1]
    assert all(low <= center <= high for low, center, high in zip(band["lower"], band["center"], band["upper"]))
    assert all(mean >= geometric for mean, geometric in zip(band["expected_level"], band["center"]))
    assert np.log(np.array(band["upper"]) / np.array(band["center"])) == pytest.approx(band["log_sd"])
    assert np.log(np.array(band["center"]) / np.array(band["lower"])) == pytest.approx(band["log_sd"])
    assert result["model"]["horizon_steps"] == 252
    assert result["model"]["steps_per_month"] == 21
    assert result["model"]["center"] == "geometric_mean"
    assert not result["model"]["calibrated_prediction_interval"]
    assert not result["model"]["parameter_uncertainty_included"]
    assert not result["model"]["out_of_sample_validated"]
    assert [row["label"] for row in result["regimes"]] == ["저변동", "중변동", "고변동"]
    json.dumps(result, allow_nan=False)


def test_failed_fit_does_not_silently_use_a_random_walk(monkeypatch):
    monkeypatch.setattr(fx_markov, "fit_markov", lambda *args: {
        "active": False, "reason": "synthetic fit failure", "diagnostics": {"n_valid": 0}})
    result = fx_markov.build({"bb:달러원": _levels()})
    assert not result["active"]
    assert result["reason"] == "synthetic fit failure"
    assert result["range"] is None
    assert result["diagnostics"]["n_valid"] == 0
