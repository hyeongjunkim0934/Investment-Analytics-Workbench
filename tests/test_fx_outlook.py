"""Full-sample FX range: independent sample moments and calendar/anchor checks.

All quotes are synthetic. Expected volatility uses Python statistics on known
generated log returns; no production volatility/range function supplies the oracle.
"""

import datetime as dt
import json
import math
import statistics

import numpy as np
import pandas as pd
import pytest

import fx_outlook
import process


def _levels(n=520, *, end=None):
    dates = (pd.bdate_range(end=end, periods=n + 1) if end
             else pd.bdate_range("2020-01-02", periods=n + 1))
    shocks = [0.0001 + 0.004 * math.sin(i / 3) + 0.002 * math.cos(i / 11)
              for i in range(n)]
    values, total = [1200.0], 0.0
    for value in shocks:
        total += value
        values.append(1200.0 * math.exp(total))
    return pd.Series(values, index=dates), shocks


def _epoch(date):
    return int(dt.datetime.fromisoformat(date).replace(tzinfo=dt.timezone.utc).timestamp())


def _assert_json(row):
    json.dumps(row, allow_nan=False)


def test_full_daily_sample_moments_and_log_symmetric_monthly_range():
    levels, shocks = _levels()
    row = fx_outlook.build({"bb:달러원": levels})
    sigma = statistics.stdev(shocks) * math.sqrt(252)
    assert row["active"] and row["source"] == "bb:달러원"
    assert row["sample"]["n_returns"] == len(shocks)
    assert row["sample"]["n_levels"] == len(levels)
    assert row["sample"]["vol_pct"] == pytest.approx(sigma * 100, abs=5.1e-7)
    assert row["model"]["sigma_annual"] == pytest.approx(sigma, abs=1e-14)
    assert row["model"]["drift"] == 0 and row["model"]["center"] == "median"
    assert row["model"]["calibrated_prediction_interval"] is False
    assert row["sample"]["ddof"] == 1 and row["sample"]["annualization"] == 252
    assert row["history"]["v"] == levels.tolist()
    assert row["asof"] == levels.index[-1].strftime("%Y-%m-%d")
    latest = levels.iloc[-1]
    band = row["range"]
    assert len(band["t"]) == 13
    assert row["anchor"] == {"t": band["t"][0], "v": latest}
    assert band["t"][0] == row["history"]["t"][-1]
    assert band["lower"][0] == band["upper"][0] == band["center"][0] == latest
    for month, lower, center, upper in zip(range(13), band["lower"], band["center"], band["upper"]):
        assert center == latest
        assert math.log(upper / latest) == pytest.approx(sigma * math.sqrt(month / 12), abs=1e-14)
        assert math.log(latest / lower) == pytest.approx(sigma * math.sqrt(month / 12), abs=1e-14)
        assert math.sqrt(lower * upper) == pytest.approx(latest)
    assert band["upper"] == sorted(band["upper"])
    assert band["lower"] == sorted(band["lower"], reverse=True)
    _assert_json(row)


@pytest.mark.parametrize("end, expected", [
    ("2024-01-31", ["2024-01-31", "2024-02-29", "2024-03-31", "2025-01-31"]),
    ("2023-01-31", ["2023-01-31", "2023-02-28", "2023-03-31", "2024-01-31"]),
    ("2024-02-29", ["2024-02-29", "2024-03-29", "2024-04-29", "2025-02-28"]),
])
def test_calendar_month_knots_keep_original_anchor_day_and_leap_rules(end, expected):
    levels, _ = _levels(end=end)
    row = fx_outlook.build({"bb:달러원": levels})
    assert row["active"]
    actual = [row["range"]["t"][i] for i in [0, 1, 2, 12]]
    assert actual == [_epoch(date) for date in expected]
    assert actual[0] == row["history"]["t"][-1]


def test_invalid_duplicates_weekends_and_long_gaps_preserve_clean_levels_and_return_policy():
    levels, shocks = _levels()
    retained = levels.drop(levels.index[200:220])
    bad = pd.Series([1e9, 8, np.nan, np.inf, -1, 0, np.nan],
                    index=[pd.Timestamp("2020-01-04"), pd.NaT,
                           levels.index[10], levels.index[11], levels.index[12],
                           levels.index[13], levels.index[-1]])
    duplicate = pd.Series([1400.0, levels.iloc[30]], index=[levels.index[30], levels.index[30]])
    dirty = pd.concat([retained.iloc[::-1], bad, duplicate])
    original = dirty.copy(deep=True)
    row = fx_outlook.build({"bb:달러원": dirty})
    expected_shocks = [*shocks[:199], *shocks[220:]]
    assert row["active"]
    assert row["history"]["v"] == retained.tolist()
    assert row["sample"]["excluded_long_gaps"] == 1
    assert row["sample"]["n_returns"] == len(expected_shocks)
    assert row["model"]["sigma_annual"] == pytest.approx(
        statistics.stdev(expected_shocks) * math.sqrt(252), abs=1e-14)
    assert row["anchor"]["v"] == levels.iloc[-1]
    pd.testing.assert_series_equal(dirty, original)
    _assert_json(row)


def test_single_missing_business_day_is_aggregate_return_but_week_long_gap_is_excluded():
    levels, shocks = _levels()
    short_gap = levels.drop(levels.index[100])
    row = fx_outlook.build({"bb:달러원": short_gap})
    # Return 99 and 100 combine when level 100 is absent. Holiday calendars
    # are not inferred, matching the established full-history FX σ policy.
    expected_shocks = [*shocks[:99], shocks[99] + shocks[100], *shocks[101:]]
    assert row["sample"]["excluded_long_gaps"] == 0
    assert row["sample"]["n_returns"] == len(expected_shocks)
    assert row["model"]["sigma_annual"] == pytest.approx(
        statistics.stdev(expected_shocks) * math.sqrt(252), abs=1e-14)


@pytest.mark.parametrize("gap_days, included", [(7, True), (8, False)])
def test_calendar_gap_cutoff_keeps_seven_days_and_excludes_eight(gap_days, included):
    levels, shocks = _levels(end="2024-01-22")  # Monday, so both endpoints are weekdays.
    extra_date = levels.index[-1] + pd.Timedelta(days=gap_days)
    extra = pd.Series([levels.iloc[-1] * 1.02], index=[extra_date])
    row = fx_outlook.build({"bb:달러원": pd.concat([levels, extra])})
    expected_shocks = [*shocks, *([math.log(1.02)] if included else [])]
    assert row["active"] and row["anchor"]["v"] == extra.iloc[0]
    assert row["sample"]["excluded_long_gaps"] == int(not included)
    assert row["sample"]["n_returns"] == len(expected_shocks)
    assert row["model"]["sigma_annual"] == pytest.approx(
        statistics.stdev(expected_shocks) * math.sqrt(252), abs=1e-14)


def test_all_valid_positive_observations_including_large_reversal_are_retained():
    levels, _ = _levels()
    levels.iloc[330:] *= 1.20
    levels.iloc[100] *= 100.0
    expected_returns = [math.log(right / left)
                        for left, right in zip(levels.tolist(), levels.tolist()[1:])]
    row = fx_outlook.build({"bb:달러원": levels})
    assert row["sample"]["n_excluded_spikes"] == 0
    assert row["sample"]["spike_policy"] == "retain_all_valid_positive_observations"
    assert row["history"]["v"] == levels.tolist()
    assert row["model"]["sigma_annual"] == pytest.approx(
        statistics.stdev(expected_returns) * math.sqrt(252), abs=1e-14)
    assert max(expected_returns) > math.log(1.19)


def test_crisis_twenty_percent_jump_and_eleven_percent_pullback_are_preserved():
    levels, _ = _levels()
    levels.iloc[330:] *= 1.20
    levels.iloc[331:] *= 0.89
    expected_returns = [math.log(right / left)
                        for left, right in zip(levels.tolist(), levels.tolist()[1:])]
    row = fx_outlook.build({"bb:달러원": levels})
    assert row["active"]
    assert row["history"]["v"] == levels.tolist()
    assert row["sample"]["n_levels"] == len(levels)
    assert row["sample"]["n_returns"] == len(levels) - 1
    assert row["sample"]["n_excluded_spikes"] == 0
    assert expected_returns[329] > math.log(1.19)
    assert expected_returns[330] < math.log(0.90)
    assert row["model"]["sigma_annual"] == pytest.approx(
        statistics.stdev(expected_returns) * math.sqrt(252), abs=1e-14)


def test_missing_empty_and_invalid_only_have_safe_inactive_payload():
    invalid = pd.Series([0, -1, np.inf, np.nan], index=[pd.Timestamp("2024-01-01"),
                                                     pd.Timestamp("2024-01-02"),
                                                     pd.Timestamp("2024-01-03"), pd.NaT])
    for sources in ({}, {"bb:달러원": pd.Series(dtype=float)}, {"bb:달러원": invalid}):
        row = fx_outlook.build(sources)
        assert not row["active"] and row["range"] is None and row["anchor"] is None
        assert row["history"] == {"t": [], "v": []}
        assert row["sample"]["vol_pct"] is None and row["model"]["sigma_annual"] is None
        assert row["asof"] is None and row["sample"]["n_returns"] == 0
        assert row["reason"]
        _assert_json(row)


def test_minimum_252_returns_zero_vol_and_short_history_are_distinct():
    levels, _ = _levels(252)
    levels[:] = 1325.0
    active = fx_outlook.build({"bb:달러원": levels})
    assert active["active"] and active["sample"]["n_returns"] == 252
    assert active["sample"]["vol_pct"] == active["model"]["sigma_annual"] == 0
    for key in ("lower", "center", "upper"):
        assert active["range"][key] == [1325.0] * 13
    inactive = fx_outlook.build({"bb:달러원": levels.iloc[1:]})
    assert not inactive["active"] and inactive["range"] is None
    assert inactive["sample"]["n_returns"] == 251
    assert inactive["history"]["v"] == [1325.0] * 252
    assert inactive["anchor"]["v"] == 1325.0 and inactive["asof"] == active["asof"]
    _assert_json(active)
    _assert_json(inactive)


def test_explicit_info_fallback_only_when_primary_has_no_valid_levels_and_no_splicing():
    levels, _ = _levels()
    fallback = fx_outlook.build({"info:USDKRW": levels})
    assert fallback["active"] and fallback["source"] == "info:USDKRW"
    assert fallback["source_selection"]["fallback_used"]
    assert not fallback["source_selection"]["spliced"]
    bad_primary = pd.Series([-2], index=[pd.Timestamp("2020-01-02")])
    assert fx_outlook.build({"bb:달러원": bad_primary, "info:USDKRW": levels}) == fallback
    # A valid but short canonical source must not silently be replaced by a
    # different, longer export (nor borrow its older returns/latest quote).
    primary = levels.iloc[:5] * 0.9
    canonical = fx_outlook.build({"bb:달러원": primary, "info:USDKRW": levels})
    assert not canonical["active"] and canonical["source"] == "bb:달러원"
    assert not canonical["source_selection"]["fallback_used"]
    assert canonical["history"]["v"] == primary.tolist()
    assert canonical["anchor"]["v"] == primary.iloc[-1]


def test_build_fx_addition_uses_unpacked_history_and_preserves_legacy_ts():
    levels, shocks = _levels(3200)
    keys = ["info:USDKRW", process.DXY_KEY, "info:USDJPY", "info:EURKRW", "info:KRWJPY", "info:USDCNY"]
    for key in [*keys, "bb:달러원"]:
        process.SERIES[key] = {"s": levels, "source": "synthetic", "category": "환율", "name": key}
    legacy = process.series_group(list(zip(keys, ["달러/원", "달러지수", "달러/엔", "유로/원", "원/100엔", "달러/위안"])))
    row = process.build_fx()
    assert set(row) == {"ts", "outlook"}
    assert row["ts"] == legacy
    assert len(row["ts"][0]["t"]) < len(levels)
    assert row["outlook"]["sample"]["n_levels"] == len(levels)
    assert row["outlook"]["history"]["v"] == levels.tolist()
    assert row["outlook"]["history"]["t"][0] == _epoch(levels.index[0].strftime("%Y-%m-%d"))
    assert row["outlook"]["model"]["sigma_annual"] == pytest.approx(
        statistics.stdev(shocks) * math.sqrt(252), abs=1e-14)
    _assert_json(row)
