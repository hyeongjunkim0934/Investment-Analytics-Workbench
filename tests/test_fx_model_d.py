"""Model D integration, time alignment, and financial boundary conditions."""

import json
import math

import numpy as np
import pandas as pd
import pytest

import fx_model_d as d


def levels(n=800, seed=71):
    rng = np.random.default_rng(seed)
    # Conditional volatility changes, without a built-in direction forecast.
    r = rng.normal(0, np.where(np.arange(n) < n * .75, .004, .012))
    return pd.Series(1200 * np.exp(np.r_[0, np.cumsum(r)]),
                     index=pd.bdate_range("2010-01-04", periods=n + 1))


def test_active_contract_anchor_horizons_and_finite_json():
    s = levels()
    result = d.build({d.PRIMARY_SOURCE: s})
    assert result["active"] and result["reason"] is None
    assert result["schema"] == "fx_model_d_v1"
    assert result["anchor"]["v"] == s.iloc[-1]
    assert result["asof"] == s.index[-1].strftime("%Y-%m-%d")
    assert not result["model"]["orthogonality_verified"]
    f = result["forecast"]
    assert f["steps"] == list(range(253))
    assert len(set(f["t"])) == 253 and f["t"][0] == result["anchor"]["t"]
    for key in ("mean", "median", "lower68", "upper68", "lower95", "upper95"):
        assert len(f[key]) == 253 and f[key][0] == result["anchor"]["v"]
    assert [r["horizon_months"] for r in result["horizons"]] == [1, 3, 6, 9, 12]
    for row in result["horizons"]:
        assert row["steps"] == row["horizon_months"] * 21
        assert row["target_t"] == f["t"][row["steps"]]
        assert row["lower95"] <= row["lower68"] <= row["median"] <= row["upper68"] <= row["upper95"]
        assert row["es95_pct"] >= row["var95_pct"]
        assert row["vol_pct"] > 0
    json.dumps(result, allow_nan=False)


def test_empty_short_and_flat_do_not_silently_replace_model():
    assert not d.build({})["active"]
    assert not d.build({d.PRIMARY_SOURCE: levels(503)})["active"]
    flat = levels(505) * 0 + 1200
    result = d.build({d.PRIMARY_SOURCE: flat})
    assert not result["active"] and "변동성 부족" in result["reason"]
    assert result["forecast"] is None and not result["horizons"]


def test_fallback_is_explicit_and_only_for_empty_primary():
    s = levels(510)
    fallback = d.build({d.PRIMARY_SOURCE: s * np.nan, d.FALLBACK_SOURCE: s})
    assert fallback["active"] and fallback["source"] == d.FALLBACK_SOURCE
    assert fallback["model"]["fallback_used"] and not fallback["model"]["spliced"]
    short = d.build({d.PRIMARY_SOURCE: s.iloc[-20:], d.FALLBACK_SOURCE: s})
    assert not short["active"] and short["source"] == d.PRIMARY_SOURCE


def test_gap_resets_state_and_training_without_compressing_outage():
    first = levels(800)
    recent = levels(530).set_axis(pd.bdate_range(first.index[-1] + pd.Timedelta(days=15), periods=531))
    result = d.build({d.PRIMARY_SOURCE: pd.concat([first, recent])})
    isolated = d.build({d.PRIMARY_SOURCE: recent})
    assert result["active"] and result["sample"]["excluded_long_gaps"] == 1
    assert result["sample"]["n_returns"] == 530
    assert result["fit"] == isolated["fit"]
    assert result["forecast"] == isolated["forecast"]
    assert result["backtest"] == isolated["backtest"]
    too_short = d.build({d.PRIMARY_SOURCE: pd.concat([first, recent.iloc[:40]])})
    assert not too_short["active"]


def test_training_window_cap_and_duplicates_preserve_latest_valid_quote():
    s = levels(2530)
    duplicated = pd.concat([s, pd.Series([np.nan, -5, s.iloc[-1]], index=[s.index[-1]] * 3)])
    source, cleaned, _ = d._latest_segment({d.PRIMARY_SOURCE: duplicated})
    pd.testing.assert_series_equal(cleaned, s, check_freq=False)
    result = d.build({source: cleaned})
    assert result["fit"]["n_train"] == d.MAX_TRAIN
    assert result["sample"]["train_start"] == s.index[-d.MAX_TRAIN - 1].strftime("%Y-%m-%d")


def test_zero_drift_symmetrization_and_deterministic_simulation():
    fit, magnitudes = d.fit_garch(np.full(504, .007))
    assert np.allclose(magnitudes, 1)
    first = d.simulate_paths(1200, fit, magnitudes, steps=21, path_count=20000, seed=9)
    second = d.simulate_paths(1200, fit, magnitudes, steps=21, path_count=20000, seed=9)
    np.testing.assert_array_equal(first, second)
    assert abs(np.log(first[:, -1] / 1200).mean()) < .001
    assert abs(np.log(first[:, -1] / 1200).mean() - 21 * .007) > .1
    assert np.all(first[:, 0] == 1200)


def test_forecast_variance_uses_closed_form_mean_reversion():
    fit = {"persistence": .9, "long_run_var": .0001, "next_var": .0004}
    expected = d.expected_variances(fit, 5)
    np.testing.assert_allclose(expected, [.0004, .00037, .000343, .0003187, .00029683])
    assert expected[0] == fit["next_var"]


def test_es_fractional_tail_mass_and_loss_sign():
    # N=25 gives a 1.25-observation tail: full largest loss plus 1/4 next.
    losses = np.arange(25, dtype=float)
    var, es = d.tail_risk(100 * (1 - losses / 100), 100)
    assert var == pytest.approx(22.8)
    assert es == pytest.approx((24 + .25 * 23) / 1.25)
    gain_var, gain_es = d.tail_risk(np.full(100, 110), 100)
    assert gain_var == pytest.approx(-10) and gain_es == pytest.approx(-10)


def test_backtest_dates_targets_and_future_perturbation_invariance():
    s = levels(800)
    shorter = d.backtest(s.iloc[:650])
    modified = s.copy()
    modified.iloc[650:] *= np.exp(np.arange(len(modified) - 650) * .015)
    original = d.backtest(s)
    changed = d.backtest(modified)
    before = [row for row in original["rows"] if row["target_t"] <= d._epoch(s.index[649])]
    after = [row for row in changed["rows"] if row["target_t"] <= d._epoch(s.index[649])]
    assert shorter["rows"] == before == after
    # At an origin before the perturbation, even its yet-unrealized forecast must
    # be unchanged; only its later realized target/variance may differ.
    for left, right in zip(original["rows"], changed["rows"]):
        if left["origin_t"] < d._epoch(s.index[650]):
            for key in ("model_variance", "constant_variance", "ewma_variance", "lower95", "upper95"):
                assert left[key] == right[key]
    r = np.diff(np.log(s.to_numpy()))
    for row in original["rows"]:
        i = s.index.get_loc(pd.Timestamp(row["origin_t"], unit="s"))
        assert row["target_t"] == d._epoch(s.index[i + 21])
        assert row["realized_variance"] == pytest.approx(np.mean(r[i:i + 21] ** 2))
    assert all(a["target_t"] <= b["origin_t"] for a, b in zip(original["rows"], original["rows"][1:]))


def test_backtest_metrics_share_all_rows_and_allow_zero_realization():
    rows = [{"realized_variance": rv, "model_variance": p,
             "constant_variance": p * 2, "ewma_variance": p * 3,
             "lower95": 950, "upper95": 1050, "actual": actual}
            for rv, p, actual in [(0, .0001, 1000), (.0002, .0002, 1100)]]
    metrics = d._metrics(rows)
    assert metrics["n"] == 2 and metrics["coverage95"] == .5
    assert metrics["qlike_d"] == pytest.approx((math.log(.0001) + math.log(.0002) + 1) / 2)
    assert metrics["mse_d"] == pytest.approx(.0001 ** 2 / 2)
    assert all(value is None for key, value in d._metrics([]).items() if key != "n")


def test_fit_reflection_invariance_does_not_import_a_direction_signal():
    r = np.diff(np.log(levels().to_numpy()))
    fit, mag = d.fit_garch(r)
    reflected, reflected_mag = d.fit_garch(-r)
    assert fit == reflected
    np.testing.assert_array_equal(mag, reflected_mag)
    assert np.mean(mag ** 2) == pytest.approx(1)


def test_bad_filter_or_simulation_inputs_fail_explicitly():
    with pytest.raises(ValueError):
        d.fit_garch([0, 0])
    with pytest.raises(ValueError):
        d.filter_variance([.01], .001, .2, .8, .01)
    fit, mag = d.fit_garch([.01, -.01] * 252)
    with pytest.raises(ValueError):
        d.simulate_paths(-1, fit, mag)
