"""Currency risk statistics: original returns vs published hedge covariance.

Fixtures contain only synthetic prices. The direct transformed-return calculation
is independent of the UI covariance formula and checks 0/partial/full hedges.
"""

import json

import numpy as np
import pandas as pd
import pytest

import common
import hedge
import port


def _daily_levels(n=520):
    dates = pd.bdate_range("2020-01-02", periods=n + 1)
    i = np.arange(n)
    log_returns = 0.0001 + 0.005 * np.sin(i / 3.0) + 0.002 * np.cos(i / 11.0)
    return pd.Series(1200.0 * np.exp(np.r_[0, log_returns.cumsum()]), index=dates), log_returns


def test_daily_full_history_sample_std_and_quote_scale():
    levels, returns = _daily_levels()
    sources = {key: levels * scale for key, scale in zip(hedge.FX_VOL_SOURCES.values(), [1, 0.7, 0.01, 1.3])}
    result = hedge.build_fx_volatility(sources)
    expected = returns.std(ddof=1) * np.sqrt(252) * 100
    for currency in ("USD", "JPY", "EUR", "AUD"):
        row = result[currency]
        assert row["active"] and row["frequency"] == "daily"
        assert row["return_type"] == "log" and row["annualization"] == 252
        assert row["n_returns"] == len(returns)
        assert row["start"] == levels.index[0].strftime("%Y-%m-%d")
        assert row["end"] == levels.index[-1].strftime("%Y-%m-%d")
        assert row["vol_pct"] == pytest.approx(expected, abs=5.1e-7)
        assert row["excluded_long_gaps"] == 0
        assert not {"t", "v", "returns", "levels", "hist"}.intersection(row)
    json.dumps(result, allow_nan=False)


def test_invalid_prices_duplicates_weekends_and_long_gap_do_not_create_fake_returns():
    levels, returns = _daily_levels()
    # Delete a month of levels: the re-entry jump must not count as a daily return.
    clean = levels.drop(levels.index[200:220])
    # These extra rows must not change the clean series: weekend, invalid date,
    # invalid duplicate and a corrected duplicate (the last valid row wins).
    extras = pd.Series([1e9, 2.0, np.nan, np.inf, -1.0, 0.0],
                       index=[pd.Timestamp("2020-01-04"), pd.NaT,
                              levels.index[10], levels.index[11], levels.index[12], levels.index[13]])
    corrected = pd.Series([levels.iloc[30] * 1.4, levels.iloc[30]],
                          index=[levels.index[30], levels.index[30]])
    dirty = pd.concat([clean.iloc[::-1], extras, corrected])
    result = hedge.build_fx_volatility({"bb:달러원": dirty})["USD"]
    # Return k joins level k to k+1; dropped levels 200:220 remove returns 199:220.
    expected_returns = np.r_[returns[:199], returns[220:]]
    assert result["active"]
    assert result["excluded_long_gaps"] == 1
    assert result["n_returns"] == len(expected_returns)
    assert result["vol_pct"] == pytest.approx(expected_returns.std(ddof=1) * np.sqrt(252) * 100, abs=5.1e-7)


def test_holiday_observation_gap_is_kept_but_short_history_is_inactive():
    levels, _ = _daily_levels()
    levels = levels.drop(levels.index[100])
    result = hedge.build_fx_volatility({"bb:달러원": levels})
    usd = result["USD"]
    expected = np.diff(np.log(levels.to_numpy())).std(ddof=1) * np.sqrt(252) * 100
    assert usd["vol_pct"] == pytest.approx(expected, abs=5.1e-7)
    assert usd["excluded_long_gaps"] == 0
    short = hedge.build_fx_volatility({"bb:달러원": levels.iloc[:20]})["USD"]
    assert not short["active"] and short["vol_pct"] is None
    assert short["min_returns"] == hedge.MIN_FX_RETURNS == 252
    assert not result["EUR"]["active"] and result["EUR"]["vol_pct"] is None
    json.dumps(result, allow_nan=False)


def test_observed_zero_volatility_remains_distinct_from_missing():
    levels, _ = _daily_levels()
    levels[:] = 1200.0
    result = hedge.build_fx_volatility({"bb:달러원": levels})
    assert result["USD"]["active"] and result["USD"]["vol_pct"] == 0.0
    assert not result["JPY"]["active"] and result["JPY"]["vol_pct"] is None


def test_existing_spike_filter_removes_quote_error_but_preserves_sustained_move():
    levels, _ = _daily_levels()
    # Large lasting depreciation remains in σ. One ×100 quote followed by the
    # normal quote is the existing source-error convention and is excluded.
    levels.iloc[330:] *= 1.20
    levels.iloc[100] *= 100
    row = hedge.build_fx_volatility({"info:EURKRW": levels})["EUR"]
    reference_levels = levels.drop(levels.index[100])
    reference_returns = np.diff(np.log(reference_levels.to_numpy()))
    assert row["active"] and row["n_excluded_spikes"] == 1
    assert row["n_returns"] == len(reference_returns)
    assert row["vol_pct"] == pytest.approx(reference_returns.std(ddof=1) * np.sqrt(252) * 100, abs=5.1e-7)


def _portfolio_fixture(n=156):
    rng = np.random.default_rng(504)
    e = rng.normal(0.0004, 0.027, n)
    local = rng.normal(0.002, 0.012, (n, 6))
    local[:, 4] -= e * 0.65  # Natural currency cushion; hedging can increase risk.
    dates = pd.date_range("2010-01-31", periods=n + 1, freq="ME")
    store = {port.FX_KEY: {"s": pd.Series(1000 * np.r_[1, np.cumprod(1 + e)], index=dates)}}
    unhedged = local.copy()
    for i, asset in enumerate(port.ASSETS):
        store[port.PROXY[asset]] = {"s": pd.Series(100 * np.r_[1, np.cumprod(1 + local[:, i])], index=dates)}
        if asset in port.USD_ASSETS:
            unhedged[:, i] = (1 + local[:, i]) * (1 + e) - 1
    return store, unhedged, e


@pytest.mark.parametrize("hedge_ratio", [0.0, 0.35, 1.0])
def test_window_covariance_matches_direct_transformed_returns(hedge_ratio):
    store, r_u, e = _portfolio_fixture()
    result = port.build(store, lambda _: None)
    h = np.array([hedge_ratio if a in port.USD_ASSETS else 0 for a in port.ASSETS])
    for window in result["windows"]:
        n = window["n_months"]
        fx = window["fx"]
        assert fx["active"] and fx["n_months"] == n
        assert (fx["start"], fx["end"]) == (window["start"], window["end"])
        expected_joint = np.cov(np.column_stack([r_u[-n:], e[-n:]]), rowvar=False, ddof=1) * 12
        np.testing.assert_allclose(fx["cov_asset"], expected_joint[:6, 6], atol=5.1e-13)
        assert fx["var"] == pytest.approx(expected_joint[6, 6], abs=5.1e-13)
        c = np.array(fx["cov_asset"])
        adjusted = np.asarray(window["cov"]) - np.outer(c, h) - np.outer(h, c) + np.outer(h, h) * fx["var"]
        direct = r_u[-n:] - np.outer(e[-n:], h)
        np.testing.assert_allclose(adjusted, np.cov(direct, rowvar=False, ddof=1) * 12, atol=2.1e-12)
        assert np.linalg.eigvalsh(adjusted).min() >= -2.1e-12


def test_missing_fx_observations_are_not_zero_covariance_or_shorter_sample():
    dates = pd.date_range("2020-01-31", periods=24, freq="ME")
    frame = pd.DataFrame({a: np.sin(np.arange(24) + i) / 100 for i, a in enumerate(port.ASSETS)}, index=dates)
    fx = pd.Series(np.cos(np.arange(24)) / 100, index=dates).drop(dates[7])
    result = port._fx_stats(frame, fx)
    assert not result["active"]
    assert result["var"] is None and result["vol_pct"] is None and result["cov_asset"] is None
    assert result["n_months"] == 24


def test_full_hedge_of_pure_fx_asset_keeps_zero_variance_boundary():
    store, _, _ = _portfolio_fixture()
    store[port.PROXY["해외채권"]]["s"][:] = 100.0
    result = port.build(store, lambda _: None)
    i = port.ASSETS.index("해외채권")
    for window in result["windows"]:
        fx = window["fx"]
        assert abs(window["cov"][i][i] - 2 * fx["cov_asset"][i] + fx["var"]) < 2e-12


@pytest.mark.parametrize("sign", [-1, 0, 1])
def test_cost_is_signed_simple_mean_of_same_current_hp_curve(sign):
    dates = pd.bdate_range("2026-09-01", periods=6)
    store = {f"info:USDKRW_HP_{m}": {"s": pd.Series([99, value, value, value, value, value], index=dates)}
             for m, value in zip(common.HP_TENORS, [sign * 1.1, sign * 2.2, sign * 3.9])}
    out = port._hedge_cost(store)["USD"]
    assert out["active"] and out["sign"] == "positive_received"
    assert out["mean_pct"] == pytest.approx(sign * 2.4)
    assert out["curve"] == {m: sign * v for m, v in zip(common.HP_TENORS, [1.1, 2.2, 3.9])}
    del store["info:USDKRW_HP_6M"]
    missing = port._hedge_cost(store)["USD"]
    assert not missing["active"] and missing["mean_pct"] is None
    assert port._hedge_cost({})["USD"]["mean_pct"] is None


def test_portfolio_embeds_cost_when_separate_hedge_payload_is_unavailable():
    store, _, _ = _portfolio_fixture()
    result = port.build(store, lambda _: None)
    assert "USD" in result["hedge_cost"] and not result["hedge_cost"]["USD"]["active"]
    assert result["usd_assets"] == sorted(port.USD_ASSETS)
    for window in result["windows"]:
        assert not {"t", "v", "returns", "levels", "hist"}.intersection(window["fx"])
    json.dumps(result, allow_nan=False)
