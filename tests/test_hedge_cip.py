"""Synthetic-only USD CIP diagnostics: signs, exact dates and past-only HP reads."""

import json
import math

import numpy as np
import pandas as pd
import pytest

import check_output
import common
import hedge
import hedge_cip


def _fixture(premium=(-3., -2., -1., 0., 1., 2.), spread=None):
    dates = pd.bdate_range("2026-01-05", periods=len(premium))
    if spread is None:
        spread = np.linspace(-2., -1., len(premium))
    sources = {key: pd.Series(premium, index=dates, dtype=float)
               for key in hedge_cip.PREMIUM_SOURCES.values()}
    for _, _, kr, us in hedge_cip.TENOR_SOURCES:
        sources[kr] = pd.Series(np.asarray(spread) + 4., index=dates)
        sources[us] = pd.Series(4., index=dates)
    return sources, dates


def test_exact_signed_one_to_one_relation_has_zero_gap_and_rmse():
    # Six raw quotes produce these hand-computed rolling medians (up to 5 quotes).
    expected = [-3., -2.5, -2., -1.5, -1., 0.]
    sources, dates = _fixture(spread=expected)
    output = hedge_cip.build(sources)
    assert output["currency"] == "USD"
    assert [row["tenor"] for row in output["tenors"]] == ["PR", "3M", "1Y", "2Y", "3Y"]
    assert output["premium_method"]["window"] == common.HP_MEDIAN_N
    for row in output["tenors"]:
        assert row["active"] and row["reason"] is None
        assert row["spread"] == row["premium"] == expected
        assert row["gap"] == [0.] * 6
        assert row["stats"]["correlation"] == pytest.approx(1.)
        assert {key: value for key, value in row["stats"].items() if key != "correlation"} == {
            "gap_bp": 0., "gap_zscore": None, "rmse_bp": 0., "asof": "2026-01-12"}
        assert row["t"] == common.epoch_seconds(dates)
        assert row["sample"] == {"start": "2026-01-05", "end": "2026-01-12", "n": 6}
        assert row["kr"] == [spread + 4. for spread in expected]
        assert row["us"] == [4.] * 6
    json.dumps(output, allow_nan=False)


@pytest.mark.parametrize("premium,spread,gap_bp", [(-1., -2., 100.), (1., 2., -100.), (0., 0., 0.)])
def test_gap_sign_is_premium_minus_korea_minus_us(premium, spread, gap_bp):
    sources, _ = _fixture([premium] * 6, [spread] * 6)
    row = hedge_cip.build(sources)["tenors"][0]
    assert row["premium"] == [premium] * 6
    assert row["spread"] == [spread] * 6
    assert row["stats"]["gap_bp"] == gap_bp
    assert row["stats"]["rmse_bp"] == abs(gap_bp)
    assert row["stats"]["correlation"] is None
    assert row["stats"]["gap_zscore"] is None


def test_negative_correlation_and_rmse_are_levels_and_one_to_one_distance():
    sources, _ = _fixture([1., 2., 3., 4.], [4., 3., 2., 1.])
    row = hedge_cip.build(sources)["tenors"][0]
    assert row["premium"] == [1., 1.5, 2., 2.5]
    assert row["gap"] == [-3., -1.5, 0., 1.5]
    assert row["stats"]["correlation"] == pytest.approx(-1.)
    assert row["stats"]["gap_bp"] == 150.
    # A fitted straight line would give zero residuals; the required 1:1 RMSE does not.
    assert row["stats"]["rmse_bp"] == pytest.approx(math.sqrt(13.5 / 4) * 100)
    # Mean -0.75, squared deviations total 11.25, sample variance 11.25/3.
    assert row["stats"]["gap_zscore"] == pytest.approx(2.25 / math.sqrt(11.25 / 3))


@pytest.mark.parametrize("spread,expected", [([3., 2., 1.], 1.), ([1., 2., 3.], -1.),
                                            ([3., 1., 2.], 0.)])
def test_gap_zscore_is_centered_and_uses_sample_standard_deviation(spread, expected):
    # With HP=0, these gap permutations have mean -2 and sample sd 1.
    # This distinguishes centering, sign, and ddof=1 from population sd.
    sources, _ = _fixture([0.] * 3, spread)
    row = hedge_cip.build(sources)["tenors"][0]
    assert row["stats"]["gap_zscore"] == pytest.approx(expected)


@pytest.mark.parametrize("missing_tenor", ["3M", "6M", "12M"])
def test_missing_one_hp_tenor_never_becomes_partial_mean_or_proxy(missing_tenor):
    sources, _ = _fixture()
    missing_key = hedge_cip.PREMIUM_SOURCES[missing_tenor]
    del sources[missing_key]
    output = hedge_cip.build(sources)
    for row in output["tenors"]:
        assert not row["active"] and missing_key in row["reason"]
        assert row["t"] == row["kr"] == row["us"] == row["spread"] == row["premium"] == row["gap"] == []
        assert row["sample"] == {"start": None, "end": None, "n": 0}
        assert all(value is None for value in row["stats"].values())
    json.dumps(output, allow_nan=False)


def test_missing_rate_deactivates_only_its_own_module():
    sources, _ = _fixture()
    del sources["info:UST2y"]
    rows = hedge_cip.build(sources)["tenors"]
    assert [row["active"] for row in rows] == [True, True, True, False, True]
    assert "info:UST2y" in rows[3]["reason"]


def test_each_tenor_joins_actual_dates_without_forward_filling_or_borrowing_asof():
    sources, dates = _fixture()
    # PR overlaps only on day 2 and 4; other modules continue on their own history.
    sources["info:한국_기준금리"] = pd.Series([3., 3.5, 4.], index=dates[[0, 2, 4]])
    sources["bb:미국_기준금리"] = pd.Series([4., 4., 4., 4.], index=dates[[1, 2, 3, 4]])
    # No 12M quote on final day: the average must stop there even though 3M/6M continue.
    sources[hedge_cip.PREMIUM_SOURCES["12M"]] = sources[hedge_cip.PREMIUM_SOURCES["12M"]].iloc[:-1]
    rows = hedge_cip.build(sources)["tenors"]
    pr = rows[0]
    assert pr["t"] == common.epoch_seconds(dates[[2, 4]])
    assert pr["kr"] == [3.5, 4.]
    assert pr["us"] == [4., 4.]
    assert pr["spread"] == [-0.5, 0.]
    assert pr["premium"] == [-2., -1.]
    assert pr["sample"]["n"] == 2
    assert pr["stats"]["asof"] == "2026-01-09"
    assert pr["stats"]["gap_bp"] == -100.
    assert pr["stats"]["gap_zscore"] == pytest.approx(1 / math.sqrt(2))
    assert rows[1]["sample"]["n"] == 5
    assert rows[1]["stats"]["asof"] == "2026-01-09"


def test_no_common_quote_date_is_explicitly_inactive():
    sources, dates = _fixture()
    sources[hedge_cip.PREMIUM_SOURCES["3M"]] = sources[hedge_cip.PREMIUM_SOURCES["3M"]].loc[dates[:2]]
    sources[hedge_cip.PREMIUM_SOURCES["6M"]] = sources[hedge_cip.PREMIUM_SOURCES["6M"]].loc[dates[2:]]
    for row in hedge_cip.build(sources)["tenors"]:
        assert not row["active"] and "동일 날짜 공통 관측 없음" in row["reason"]


def test_single_observation_is_real_data_but_has_no_correlation():
    sources, _ = _fixture([-1.25], [-1.])
    row = hedge_cip.build(sources)["tenors"][0]
    assert row["active"] and row["sample"]["n"] == 1
    assert row["stats"] == {"correlation": None, "gap_bp": -25., "gap_zscore": None,
                            "rmse_bp": 25., "asof": "2026-01-05"}


@pytest.mark.parametrize("constant_side", ["spread", "premium"])
def test_decimal_constant_does_not_gain_correlation_from_mean_roundoff(constant_side):
    # Summing 0.1 repeatedly is not exact in binary; a variance-only guard can
    # spuriously report correlation for a mathematically constant series.
    sources, _ = _fixture([0.1] * 10 if constant_side == "premium" else list(range(10)),
                          [0.1] * 10 if constant_side == "spread" else np.arange(10) / 10)
    row = hedge_cip.build(sources)["tenors"][0]
    assert row["active"] and row["sample"]["n"] == 10
    assert row["stats"]["correlation"] is None
    assert math.isfinite(row["stats"]["rmse_bp"])


def test_same_decimal_rate_difference_stays_constant_after_subtraction_roundoff():
    sources, dates = _fixture([1., 2., 3., 4.])
    sources["info:한국_기준금리"] = pd.Series([1.1, 2.1, 3.1, 4.1], index=dates)
    sources["bb:미국_기준금리"] = pd.Series([1., 2., 3., 4.], index=dates)
    row = hedge_cip.build(sources)["tenors"][0]
    # Binary subtraction really yields multiple values, all representing 0.1.
    assert len(set(row["spread"])) > 1
    np.testing.assert_allclose(row["spread"], [0.1] * 4, atol=1e-15, rtol=0)
    assert row["stats"]["correlation"] is None
    assert row["stats"]["gap_bp"] == pytest.approx(240.)
    assert row["stats"]["rmse_bp"] == pytest.approx(math.sqrt((0.9**2 + 1.4**2 + 1.9**2 + 2.4**2) / 4) * 100)


def test_actual_tiny_rate_difference_changes_are_kept_in_correlation():
    sources, dates = _fixture([1., 2., 3., 4.])
    us = np.array([1., 2., 3., 4.])
    spreads = np.array([0.1, 0.10000001, 0.10000002, 0.10000003])
    sources["info:한국_기준금리"] = pd.Series(us + spreads, index=dates)
    sources["bb:미국_기준금리"] = pd.Series(us, index=dates)
    row = hedge_cip.build(sources)["tenors"][0]
    np.testing.assert_allclose(row["spread"], spreads, atol=5e-16, rtol=0)
    assert row["stats"]["correlation"] == pytest.approx(1., abs=1e-12)
    assert row["spread"][-1] - row["spread"][0] > 2.9e-8


def test_constant_decimal_gap_ignores_subtraction_noise_but_small_real_changes_survive():
    sources, dates = _fixture([0.] * 4)
    us = np.array([1., 2., 3., 4.])
    sources["info:한국_기준금리"] = pd.Series(us + 0.1, index=dates)
    sources["bb:미국_기준금리"] = pd.Series(us, index=dates)
    constant = hedge_cip.build(sources)["tenors"][0]
    assert len(set(constant["gap"])) > 1  # Roundoff must not generate a Z score.
    assert constant["stats"]["gap_zscore"] is None
    sources["info:한국_기준금리"] = pd.Series(us + [0.1, 0.10000001, 0.10000002, 0.10000003], index=dates)
    varying = hedge_cip.build(sources)["tenors"][0]
    # The 4 equally spaced gaps have last deviation -1.5e-8, sd sqrt(5/3)e-8.
    assert varying["stats"]["gap_zscore"] == pytest.approx(-1.5 / math.sqrt(5 / 3), abs=1e-7)


def test_past_only_medians_match_monitoring_on_every_clean_prefix_including_rounding():
    sources, dates = _fixture([2.675, 2.685, -3.145, 4.125, 100., -2.055, 1.005])
    # Different 3/6/12M quotes must each be rounded before the arithmetic mean.
    sources[hedge_cip.PREMIUM_SOURCES["6M"]] += 0.113
    sources[hedge_cip.PREMIUM_SOURCES["12M"]] -= 0.271
    result = hedge_cip.premium_history(sources)
    for date in dates:
        prefix = {key: values.loc[:date] for key, values in sources.items()}
        canonical = common.hp_curve(prefix, "USD")["curve"]
        assert result.loc[date] == pytest.approx(sum(canonical.values()) / 3, abs=1e-14)
    assert result.iloc[0] != round(result.iloc[0], 2), "The cross-tenor average must retain precision"


def test_outlier_median_uses_no_future_quotes_and_allows_short_initial_window():
    raw = [-1., -1., -1., -1., 99., 2., 2., 2.]
    sources, _ = _fixture(raw)
    result = hedge_cip.premium_history(sources)
    assert result.tolist() == [-1., -1., -1., -1., -1., -1., 2., 2.]
    short_sources = {key: values.iloc[:4] for key, values in sources.items()}
    assert hedge_cip.premium_history(short_sources).tolist() == result.iloc[:4].tolist()
    assert hedge_cip.premium_history(short_sources).iloc[0] == -1.


def test_missing_quote_uses_last_valid_observations_but_does_not_fill_that_date():
    sources, dates = _fixture([0., 2., 4., 6., 8., 10., 12.])
    sources[hedge_cip.PREMIUM_SOURCES["3M"]].iloc[1] = np.nan
    result = hedge_cip.premium_history(sources)
    assert dates[1] not in result.index
    # At day 5, 3M's five valid quotes are [0,4,6,8,10], other tenors use [2,4,6,8,10].
    assert result.loc[dates[5]] == 6.
    assert result.loc[dates[2]] == pytest.approx((2. + 2. + 2.) / 3)
    assert len(result) == 6


def test_sorting_invalid_quotes_weekends_and_duplicate_dates_preserve_clean_result():
    sources, dates = _fixture()
    expected = hedge_cip.build(sources)
    dirty = {}
    for key, values in sources.items():
        extras = pd.Series([np.inf, np.nan, 900., 800., "bad", -999., values.iloc[2]],
                           index=[dates[0], dates[1], pd.NaT, pd.Timestamp("2026-01-10"),
                                  dates[3], dates[2], dates[2]], dtype=object)
        dirty[key] = pd.concat([values.iloc[::-1], extras])
    result = hedge_cip.build(dirty)
    assert result == expected
    json.dumps(result, allow_nan=False)


def test_all_missing_sources_keep_five_json_safe_modules():
    result = hedge_cip.build({})
    assert len(result["tenors"]) == 5
    assert all(not row["active"] and row["reason"] for row in result["tenors"])
    json.dumps(result, allow_nan=False)


def test_hedge_payload_wires_cip_without_mutating_monitoring(parsed):
    _, process = parsed
    warnings = []
    result = hedge.build(process.SERIES, warnings.append)
    plain = {key: value["s"] for key, value in process.SERIES.items()}
    assert result["cip"] == hedge_cip.build(plain)
    assert result["cost_dashboard"]["USD"]["curve"] == common.hp_curve(plain, "USD")["curve"]


@pytest.mark.parametrize("field", ["kr", "us", "spread", "premium", "gap"])
def test_deployment_gate_checks_cip_common_date_array_lengths(field):
    sources, _ = _fixture()
    result = hedge_cip.build(sources)
    check_output._errors.clear()
    try:
        check_output._walk_ts(result, "hedge.cip", [0])
        assert not check_output._errors
        result["tenors"][0][field].pop()
        check_output._walk_ts(result, "hedge.cip", [0])
        assert any(f"t/{field}" in message for message in check_output._errors)
    finally:
        check_output._errors.clear()


@pytest.mark.parametrize("field", ["kr", "us", "gap_zscore"])
def test_deployment_gate_rejects_missing_card_input_and_zscore_fields(field):
    sources, _ = _fixture()
    result = hedge_cip.build(sources)
    row = result["tenors"][0]
    del (row["stats"] if field == "gap_zscore" else row)[field]
    check_output._errors.clear()
    try:
        check_output._walk_ts(result, "hedge.cip", [0])
        assert any(field in message for message in check_output._errors)
    finally:
        check_output._errors.clear()
