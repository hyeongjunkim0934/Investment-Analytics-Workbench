"""Full-history carry histograms and conditional fixed-duration 1Y return ranges.

Synthetic returns are checked by direct sample standard deviation independently
of the production covariance aggregation. No private source values are required.
"""

import copy
import json
import statistics
import numpy as np
import pandas as pd
import pytest

import common
import hedge


def _sources(n_months=72, y0=3.5, fx_scale=1.0):
    dates = pd.date_range("2018-01-31", periods=n_months + 1, freq="BME")
    k = np.arange(n_months)
    yield_steps = 0.055 * np.sin(k * 1.13) + 0.018 * np.cos(k * 0.37)
    yields = np.r_[0., yield_steps.cumsum()]
    yields += y0 - yields[-1]
    fx_log_returns = 0.013 * np.cos(k * 0.79) + 0.004 * np.sin(k * 0.27)
    fx = fx_scale * 1200 * np.exp(np.r_[0., fx_log_returns.cumsum()])
    src = {}
    for spec in hedge.BOND_MERIT_SOURCES.values():
        src[spec["bond"]] = pd.Series(yields, index=dates)
        src[hedge.FX_VOL_SOURCES[spec["currency"]]] = pd.Series(fx, index=dates)
        for m, cost in zip(common.HP_TENORS, [-2., -1., 0.]):
            src[f"info:{spec['currency']}KRW_HP_{m}"] = pd.Series(cost, index=dates)
    src["info:SMB_USDKRW_3M"] = pd.Series(-3., index=dates)
    return src, dates, yields, fx_log_returns


def test_full_daily_distribution_is_not_cut_to_common_bond_history_or_trimmed():
    dates = pd.bdate_range("2000-01-03", periods=1002)
    values = np.r_[np.linspace(-2, 2, 1000), -45., 51.]
    src = {"info:SMB_USDKRW_3M": pd.Series(values, index=dates),
           "info:UST10y": pd.Series([4.], index=[dates[-1]])}
    out = hedge.build_cost_distribution(src, "UST")
    assert out["active"] and out["n"] == len(values)
    assert out["start"] == "2000-01-03" and out["end"] == str(dates[-1].date())
    assert out["min_pct"] == -45 and out["max_pct"] == 51
    assert out["mean_pct"] == pytest.approx(values.mean())
    assert sum(b["count"] for b in out["bins"]) == len(values)
    assert sum(b["frequency_pct"] for b in out["bins"]) == pytest.approx(100)
    assert out["bins"][0]["low"] <= -45 and out["bins"][-1]["high"] >= 51
    assert not {"t", "v", "returns", "levels"}.intersection(out)
    json.dumps(out, allow_nan=False)


def test_distribution_display_crop_uses_full_sample_sigma_without_renormalizing():
    values = np.r_[np.linspace(-2, 2, 1000), -45., 51.]
    raw = pd.Series(values, index=pd.bdate_range("2000-01-03", periods=len(values)))
    source_before = raw.copy()
    row = hedge.build_cost_distribution({"info:SMB_USDKRW_3M": raw}, "UST")
    # Independent scalar sample statistics include the same tails being hidden.
    mean, sigma = statistics.mean(values), statistics.stdev(values)
    low, high = mean - 5 * sigma, mean + 5 * sigma
    assert row["mean_pct"] == pytest.approx(mean)
    assert row["std_pct"] == pytest.approx(sigma)
    assert row["display_low_pct"] == pytest.approx(low)
    assert row["display_high_pct"] == pytest.approx(high)
    assert row["display_n"] == 1000
    assert row["display_tail_policy"] == "omit_abs_z_gte"
    assert row["display_ddof"] == 1 and row["display_sigma_limit"] == 5
    assert row["display_bins"][0]["low"] == row["display_low_pct"]
    assert row["display_bins"][-1]["high"] == row["display_high_pct"]
    assert sum(b["count"] for b in row["display_bins"]) == 1000
    assert sum(b["frequency_pct"] for b in row["display_bins"]) == pytest.approx(1000 / 1002 * 100)
    for i, b in enumerate(row["display_bins"]):
        last = i == len(row["display_bins"]) - 1
        expected = sum(abs(v - mean) < 5 * sigma and b["low"] <= v and
                       (v <= b["high"] if last else v < b["high"]) for v in values)
        assert b["count"] == expected
        assert b["frequency_pct"] == pytest.approx(expected / len(values) * 100)
        assert low <= b["low"] < b["high"] <= high
    assert row["n"] == 1002 and sum(b["count"] for b in row["bins"]) == 1002
    assert row["min_pct"] == -45 and row["max_pct"] == 51
    pd.testing.assert_series_equal(raw, source_before)
    json.dumps(row, allow_nan=False)


def test_distribution_exact_five_sigma_observations_are_hidden_only_from_display():
    # n=51, mean=0, sample variance=(25+25)/(51-1)=1 exactly.
    # The FD IQR is zero: one original bin contains both tails and the center.
    values = [-5.] + [0.] * 49 + [5.]
    row = hedge.build_cost_distribution({"info:SMB_USDKRW_3M": pd.Series(
        values, index=pd.bdate_range("2025-01-01", periods=len(values)))}, "UST")
    assert row["mean_pct"] == 0 and row["std_pct"] == 1
    assert row["n"] == 51 and row["bins"][0]["count"] == 51
    assert row["display_n"] == row["display_bins"][0]["count"] == 49
    assert row["display_low_pct"] == -5 and row["display_high_pct"] == 5
    assert row["display_bins"][0]["frequency_pct"] == pytest.approx(49 / 51 * 100)


def test_distribution_source_mapping_signed_constant_and_invalid_observations():
    dates = pd.bdate_range("2025-01-01", periods=8)
    src = {spec["cost"]: pd.Series(float(i), index=dates)
           for i, spec in enumerate(hedge.BOND_MERIT_SOURCES.values())}
    src["info:GERKRW_HP_3M"] = pd.Series(-99., index=dates)
    src["info:EURKRW_HP_3M"].iloc[0] = np.inf
    for i, code in enumerate(hedge.BOND_MERIT_SOURCES):
        row = hedge.build_cost_distribution(src, code)
        assert row["active"] and row["min_pct"] == row["max_pct"] == i
        assert len(row["bins"]) == 1
        assert row["sign"] == "positive_received"
        assert row["n"] == (7 if code == "GER" else 8)
        assert row["std_pct"] == 0 and row["display_n"] == row["n"]
        assert row["display_bins"] == row["bins"]
        assert row["display_low_pct"] < i < row["display_high_pct"]
        json.dumps(row, allow_nan=False)


@pytest.mark.parametrize("values", [[], [np.nan, np.inf, -np.inf], [2.]])
def test_distribution_empty_nonfinite_and_singleton_display(values):
    row = hedge.build_cost_distribution({"info:SMB_USDKRW_3M": pd.Series(
        values, index=pd.bdate_range("2025-01-01", periods=len(values)), dtype=float)}, "UST")
    if values == [2.]:
        assert row["active"] and row["std_pct"] == 0
        assert row["display_n"] == 1 and row["display_bins"] == row["bins"]
        assert row["display_bins"][0]["frequency_pct"] == 100
    else:
        assert not row["active"] and row["n"] == row["display_n"] == 0
        assert row["bins"] == row["display_bins"] == []
        assert row["std_pct"] is row["display_low_pct"] is row["display_high_pct"] is None
    json.dumps(row, allow_nan=False)


@pytest.mark.parametrize("y", [-0.01, 0., 0.035])
def test_duration_matches_independent_discounted_cashflow_price_derivative(y):
    # Coupon is held fixed at the current par yield when differentiating price.
    cashflows = np.full(10, y)
    cashflows[-1] += 1
    years = np.arange(1, 11)
    price = np.sum(cashflows / (1 + y) ** years)
    direct = np.sum(years * cashflows / (1 + y) ** (years + 1)) / price
    assert hedge.par_modified_duration(y) == pytest.approx(direct, rel=1e-12)
    if y == 0:
        assert hedge.par_modified_duration(y) == 10


def test_outlook_covariance_and_ranges_match_direct_transformed_shocks():
    src, dates, yields, fx_r = _sources()
    row = hedge.build_bond_outlook(src, "UST")
    assert row["active"]
    # Final source month is excluded; this is an explicit conservative endpoint
    # rule, so one fewer return than monthly changes is used for risk estimation.
    n = len(yields) - 2
    duration = hedge.par_modified_duration(yields[-1] / 100)
    b = -duration * np.diff(yields)[:-1] / 100
    e = fx_r[:-1]
    risk = row["risk"]
    assert row["sample"]["n_months"] == n
    assert row["sample"]["end"] == str(dates[-2].date())
    direct_cov = np.cov(np.column_stack([b, e]), rowvar=False, ddof=1) * 12
    np.testing.assert_allclose(risk["cov_annual"], direct_cov, atol=1e-15)
    assert risk["hedged_vol_pct"] == pytest.approx(np.std(b, ddof=1) * np.sqrt(12) * 100)
    assert risk["unhedged_vol_pct"] == pytest.approx(np.std(b + e, ddof=1) * np.sqrt(12) * 100)
    assert row["cost"]["mean_pct"] == -1
    assert row["cost"]["curve"] == common.hp_curve(src, "USD")["curve"]
    for kind, mu in (("hedged", 2.5), ("unhedged", 3.5)):
        path = row[kind]
        assert len(path["center"]) == len(row["t"]) == 13
        assert path["lower"][0] == path["upper"][0] == path["center"][0] == 0
        assert path["center"][-1] == pytest.approx(mu)
        assert path["upper"][-1] - path["center"][-1] == pytest.approx(path["vol_pct"])
        assert path["upper"][3] - path["center"][3] == pytest.approx(path["vol_pct"] / 2)
    assert not row["method"]["calibrated_prediction_interval"]
    assert not {"returns", "levels", "hist"}.intersection(row)
    json.dumps(row, allow_nan=False)


def test_natural_fx_cushion_can_make_full_hedge_risk_higher():
    src, dates, yields, _ = _sources()
    d = hedge.par_modified_duration(yields[-1] / 100)
    b = -d * np.diff(yields) / 100
    src["bb:달러원"] = pd.Series(1200 * np.exp(np.r_[0., (-0.8 * b).cumsum()]), index=dates)
    row = hedge.build_bond_outlook(src, "UST")
    assert row["active"] and row["risk"]["reduction_pp"] < 0
    assert row["risk"]["unhedged_vol_pct"] == pytest.approx(row["risk"]["hedged_vol_pct"] * .2)


def test_zero_risk_and_fx_quote_scale_boundary():
    src, _, _, _ = _sources(y0=0.)
    for spec in hedge.BOND_MERIT_SOURCES.values():
        src[spec["bond"]][:] = 0.
    baseline = hedge.build_bond_outlook(src, "JPY")
    src["info:KRWJPY"] *= 100
    scaled = hedge.build_bond_outlook(src, "JPY")
    assert baseline["active"] and baseline["risk"]["hedged_vol_pct"] == 0
    assert baseline["risk"]["unhedged_vol_pct"] == pytest.approx(scaled["risk"]["unhedged_vol_pct"])
    src["info:KRWJPY"][:] = 100
    flat = hedge.build_bond_outlook(src, "JPY")
    assert flat["active"] and flat["risk"]["unhedged_vol_pct"] == 0


def test_current_hp_positive_carry_and_anchor_use_same_information_set():
    src, dates, _, _ = _sources()
    new_day = dates[-1] + pd.offsets.BDay(2)
    for m in common.HP_TENORS:
        key = f"info:EURKRW_HP_{m}"
        src[key] = pd.concat([src[key], pd.Series(4., index=[new_day])])
        src[key].iloc[-5:] = 4.
    row = hedge.build_bond_outlook(src, "GER")
    assert row["active"] and row["asof"] == str(new_day.date())
    assert row["yield_asof"] == row["fx_asof"] == str(dates[-1].date())
    assert row["cost"]["mean_pct"] == 4.
    assert row["hedged"]["mean_pct"] == row["unhedged"]["mean_pct"] + 4.
    assert row["sample"]["end"] <= row["asof"]
    assert max(row["input_age_days"].values()) <= 7
    assert row["sources"]["fx"] == "info:EURKRW"
    assert row["sources"]["bond"] == "info:GER10y"


def test_lagged_spot_does_not_displace_current_yield_but_old_risk_is_inactive():
    src, dates, yields, _ = _sources()
    src["bb:달러원"] = src["bb:달러원"].iloc[:-1]
    row = hedge.build_bond_outlook(src, "UST")
    assert row["active"] and row["yield_pct"] == yields[-1]
    assert row["yield_asof"] == str(dates[-1].date())
    assert row["fx_asof"] == str(dates[-2].date())
    assert row["sample"]["age_days"] <= 62
    src["bb:달러원"] = src["bb:달러원"].iloc[:-3]
    stale = hedge.build_bond_outlook(src, "UST")
    assert not stale["active"] and "위험표본" in stale["reason"]


@pytest.mark.parametrize("case", ["missing", "nonfinite", "stale_cost", "stale_yield", "short"])
def test_missing_stale_or_short_outlook_is_inactive_without_cost_proxy(case):
    src, dates, _, _ = _sources(n_months=20 if case == "short" else 72)
    if case == "missing":
        del src["info:AUDKRW_HP_6M"]
    elif case == "nonfinite":
        src["info:AUDKRW_HP_6M"][:] = np.inf
    elif case == "stale_cost":
        src["info:AUDKRW_HP_6M"] = src["info:AUDKRW_HP_6M"].iloc[:-1]
    elif case == "stale_yield":
        src["info:AUD10y"] = src["info:AUD10y"].iloc[:-1]
    row = hedge.build_bond_outlook(src, "AUD")
    assert not row["active"] and row["reason"]
    assert "hedged" not in row and "risk" not in row
    json.dumps(row, allow_nan=False)


def test_monthly_same_day_pairing_no_stale_endpoints_or_gap_bridging():
    src, dates, _, _ = _sources()
    # Drop one entire month and make another month stale for the joint pair.
    old = dates[25]
    for key in ("info:UST10y", "bb:달러원"):
        src[key] = src[key].drop([dates[10], old])
        stale = old - pd.Timedelta(days=14)
        if stale.dayofweek > 4:
            stale -= pd.offsets.BDay(1)
        src[key] = pd.concat([src[key], pd.Series(4. if key == "info:UST10y" else 1200., index=[stale])]).sort_index()
    row = hedge.build_bond_outlook(src, "UST")
    assert row["active"]
    assert row["sample"]["excluded_stale_months"] == 1
    assert row["sample"]["excluded_gap_months"] == 2
    assert row["sample"]["n_months"] == len(dates) - 2 - 4
    # Independent leg resampling would incorrectly pair these different dates.
    # The production exact-date intersection must discard the entire month.
    changed = dates[40]
    value = src["info:UST10y"].loc[changed]
    src["info:UST10y"] = src["info:UST10y"].drop(changed)
    src["info:UST10y"].loc[changed - pd.offsets.BDay(1)] = value
    repeated = hedge.build_bond_outlook(src, "UST")
    assert repeated["sample"]["n_months"] == row["sample"]["n_months"] - 2
    assert repeated["sample"]["excluded_gap_months"] == row["sample"]["excluded_gap_months"] + 1


def test_empty_monthly_history_and_additive_pipeline_contract(parsed):
    src, _, _, _ = _sources(n_months=0)
    assert not hedge.build_bond_outlook(src, "UST")["active"]
    _, process = parsed
    saved = copy.deepcopy(process.SERIES)
    out = hedge.build(process.SERIES, lambda _: None)
    assert set(out["bond_analytics"]) == {"UST", "JPY", "AUD", "GER"}
    assert out["ust_merit"]["cost"] == out["bond_merits"]["UST"]["cost"]
    for key in process.SERIES:
        pd.testing.assert_series_equal(process.SERIES[key]["s"], saved[key]["s"])
    json.dumps(out["bond_analytics"], allow_nan=False)
