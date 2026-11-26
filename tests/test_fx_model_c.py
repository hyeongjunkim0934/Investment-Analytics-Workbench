"""Model C calendar, units, alignment and boundary contracts (synthetic inputs)."""

import json
import math

import numpy as np
import pandas as pd
import pytest

import fx_model_c as model


def raw(n=180, start="2000-01-01", constant=False):
    dates = pd.date_range(start, periods=n, freq="BME")
    k = np.arange(n, dtype=float)
    levels = np.full(n, 1234.5) if constant else 1150 * np.exp(.001 * k + .05 * np.sin(k / 5))
    return {
        "bb:달러원": pd.Series(levels, index=dates),
        "info:한국_1y": pd.Series(2 + .7 * np.sin(k / 7), index=dates),
        "info:UST1y": pd.Series(1 + .5 * np.cos(k / 9), index=dates),
    }


def horizon(payload, h):
    return next(row for row in payload["horizons"] if row["horizon_months"] == h)


def test_missing_inputs_do_not_fabricate_forecasts():
    for inputs in ({}, {"bb:달러원": raw()["bb:달러원"]}):
        result = model.build(inputs)
        assert not result["active"] and result["anchor"] is None
        assert result["reason"] and result["horizons"] == []
        json.dumps(result, allow_nan=False)


def test_fixed_contract_levels_contributions_and_identical_oos_comparison():
    result = model.build(raw())
    assert result["active"] and result["schema"] == "fx_model_c_v1"
    assert result["model"]["ridge_lambda"] == 1 and result["model"]["shrinkage"] == .5
    assert result["model"]["parameter_selection"] == "fixed_before_evaluation"
    assert result["sample"]["n_months"] == 180
    assert result["model"]["horizons_months"] == [1, 3, 6, 9, 12]
    assert [row["horizon_months"] for row in result["horizons"]] == [1, 3, 6, 9, 12]
    anchor = result["anchor"]["v"]
    for row in result["horizons"]:
        assert row["active"]
        assert row["n_train"] <= 120
        assert sum(c["log_pct"] for c in row["contributions"]) == pytest.approx(
            100 * math.log(row["point"] / anchor), abs=1e-12)
        assert row["point"] ** 2 == pytest.approx(anchor * row["ridge_point"], rel=3e-15)
        assert row["change_pct"] == pytest.approx(100 * (row["point"] / anchor - 1))
        bt = row["backtest"]
        assert row["metrics"]["n"] == len(bt)
        assert row["metrics"]["rmse"] == pytest.approx(math.sqrt(sum(
            (r["model_c"] - r["actual"]) ** 2 for r in bt) / len(bt)))
        assert row["metrics"]["rw_rmse"] == pytest.approx(math.sqrt(sum(
            (r["base"] - r["actual"]) ** 2 for r in bt) / len(bt)))
        assert row["metrics"]["ridge_rmse"] == pytest.approx(math.sqrt(sum(
            (r["ridge"] - r["actual"]) ** 2 for r in bt) / len(bt)))
    json.dumps(result, allow_nan=False)


def test_nine_month_direct_forecast_preserves_existing_horizons(monkeypatch):
    inputs = raw()
    extended = model.build(inputs)
    nine = horizon(extended, 9)
    assert nine["active"] and nine["n_calibration"] >= 24
    assert pd.Period(nine["target_date"], "M") == pd.Period(extended["model_date"], "M") + 9
    assert all(pd.Period(row["target_date"], "M") == pd.Period(row["origin_date"], "M") + 9
               for row in nine["backtest"])
    monkeypatch.setattr(model, "HORIZONS", (1, 3, 6, 12))
    legacy = model.build(inputs)
    assert [row for row in extended["horizons"] if row["horizon_months"] != 9] == legacy["horizons"]


def test_constant_fx_preserves_exact_anchor_and_no_false_theil_u():
    result = model.build(raw(constant=True))
    assert result["active"]
    for row in result["horizons"]:
        assert row["point"] == row["ridge_point"] == row["rw"] == 1234.5
        assert row["lower68"] == row["upper95"] == 1234.5
        assert row["change_pct"] == row["metrics"]["rmse"] == row["metrics"]["rw_rmse"] == 0
        assert row["metrics"]["theil_u"] is None
        assert row["metrics"]["coverage68"] == row["metrics"]["coverage95"] == 1


@pytest.mark.parametrize("n, active", [(63, False), (64, True)])
def test_training_minimum_counts_only_realized_calendar_labels(n, active):
    result = model.build(raw(n))
    assert horizon(result, 1)["active"] is active
    if active:
        assert horizon(result, 1)["n_train"] == 60
        assert horizon(result, 1)["metrics"]["n"] == 0
        assert horizon(result, 1)["lower68"] is None
    assert not horizon(result, 12)["active"]


def test_source_fallback_only_when_primary_has_no_valid_observations():
    inputs = raw()
    expected = model.build(inputs)
    fallback = {**inputs, "info:USDKRW": inputs["bb:달러원"]}
    del fallback["bb:달러원"]
    result = model.build(fallback)
    assert result["source"] == "info:USDKRW" and result["model"]["fallback_used"]
    assert result["horizons"] == expected["horizons"]
    fallback["bb:달러원"] = inputs["bb:달러원"].iloc[-5:]
    result = model.build(fallback)
    assert result["source"] == "bb:달러원" and not result["active"]
    assert result["sample"]["n_months"] == 5


def test_same_day_join_never_fills_rates_from_adjacent_dates():
    inputs = raw()
    inputs["info:UST1y"].index = inputs["info:UST1y"].index + pd.offsets.BDay(1)
    result = model.build(inputs)
    assert not result["active"] and result["sample"]["n_common_daily"] == 0


def test_month_close_requires_latest_shared_date_and_drops_partial_month():
    inputs = raw(180)
    original = model.build(inputs)
    previous = inputs["bb:달러원"].index[-1]
    partial = previous + pd.offsets.MonthBegin(1) + pd.Timedelta(days=20)
    if partial.dayofweek >= 5:
        partial += pd.offsets.BDay(1)
    for key in inputs:
        inputs[key] = pd.concat([inputs[key], pd.Series([float(inputs[key].iloc[-1])], index=[partial])])
    result = model.build(inputs)
    assert result["anchor"] == original["anchor"]
    assert result["horizons"] == original["horizons"]
    assert result["sample"]["latest_common_date"] == partial.strftime("%Y-%m-%d")


def _replace_last_quote(inputs, day, later="2015-11-02", keys=None):
    out = {}
    for key, values in inputs.items():
        values = values.copy()
        if keys is None or key in keys:
            values.index = values.index[:-1].append(pd.DatetimeIndex([day]))
        out[key] = pd.concat([values, pd.Series([float(values.iloc[-1])], index=[pd.Timestamp(later)])]) if later else values
    return out


def test_month_end_weekend_uses_preceding_weekday():
    inputs = raw(180, start="2000-11-01")
    # The final month is October 2015: the 31st is Saturday, decision is Friday30.
    assert inputs["bb:달러원"].index[-1] == pd.Timestamp("2015-10-30")
    result = model.build(inputs)
    assert result["asof"] == result["model_date"] == "2015-10-30"
    assert result["anchor"]["quote_t"] == result["anchor"]["t"]
    assert horizon(result, 1)["target_date"] == "2015-11-30"


def test_month_end_without_common_quote_uses_latest_earlier_quote_of_that_month():
    inputs = raw(180, start="2000-11-01")
    exact = model.build(inputs)
    # No common quote on Friday 30: Tuesday 27 stands in once later data closes the month.
    moved = _replace_last_quote(inputs, "2015-10-27")
    result = model.build(moved)
    assert result["model_date"] == "2015-10-30" and result["asof"] == "2015-10-27"
    assert result["anchor"]["t"] - result["anchor"]["quote_t"] == 3 * 86400
    assert result["anchor"]["v"] == exact["anchor"]["v"]          # same level, earlier observation date
    assert result["sample"]["n_months"] == exact["sample"]["n_months"] == 180
    assert result["model"]["max_endpoint_gap_days"] == 7
    assert horizon(result, 1)["target_date"] == "2015-11-30"
    # Until data reaches the last weekday the month is still open: nothing is assumed.
    open_month = model.build({key: values.loc[:"2015-10-30"] for key, values in moved.items()})
    assert open_month["asof"] == open_month["model_date"] == "2015-09-30"
    assert open_month["sample"]["n_months"] == 179
    # A quote missing in only one input is not a common quote either.
    partial = {key: pd.concat([values, pd.Series([float(values.iloc[-1])], index=[pd.Timestamp("2015-10-29")])]).sort_index()
               for key, values in inputs.items()}
    partial = _replace_last_quote(partial, "2015-10-28", keys={"bb:달러원"})      # FX has 28·29, rates have 29·30
    one_missing = model.build(partial)
    assert one_missing["model_date"] == "2015-10-30" and one_missing["asof"] == "2015-10-29"


def test_month_end_fallback_never_reaches_past_seven_days_or_into_later_dates():
    inputs = raw(180, start="2000-11-01")
    # Tuesday 20 is ten days before the decision date: too old to stand for month-end.
    stale = model.build(_replace_last_quote(inputs, "2015-10-20"))
    assert stale["asof"] == stale["model_date"] == "2015-09-30"
    assert stale["sample"]["n_months"] == 179
    # Friday 23 is exactly seven days: still accepted.
    edge = model.build(_replace_last_quote(inputs, "2015-10-23"))
    assert edge["model_date"] == "2015-10-30" and edge["asof"] == "2015-10-23"
    # The November quote is never borrowed backwards for October.
    assert stale["anchor"]["t"] == stale["anchor"]["quote_t"]


def test_missing_exact_month_endpoint_is_excluded_without_row_shift():
    inputs = raw(180)
    missing_month = inputs["bb:달러원"].index[-20].to_period("M")
    for key, values in inputs.items():
        dates = values.index.tolist()
        dates[-20] = missing_month.start_time + pd.Timedelta(days=10)
        values = values.copy()
        values.index = pd.DatetimeIndex(dates)
        inputs[key] = values
    result = model.build(inputs)
    assert result["sample"]["n_months"] == 179
    for row in result["horizons"]:
        for bt in row["backtest"]:
            origin = pd.Period(bt["origin_date"], "M")
            target = pd.Period(bt["target_date"], "M")
            assert target == origin + row["horizon_months"]
            assert origin != missing_month and target != missing_month


def test_two_day_early_historical_month_end_is_used_with_its_actual_quote_date():
    inputs = raw(180)
    missing = inputs["bb:달러원"].index[100]
    for key, values in inputs.items():
        dates = values.index.tolist()
        dates[100] = missing - pd.offsets.BDay(2)
        values = values.copy()
        values.index = pd.DatetimeIndex(dates)
        inputs[key] = values
    full = model.build(inputs)
    prefix = model.build({key: values.loc[:missing] for key, values in inputs.items()})
    assert prefix["model_date"] == inputs["bb:달러원"].index[99].strftime("%Y-%m-%d")
    assert full["sample"]["n_months"] == 180
    label, quoted = missing.strftime("%Y-%m-%d"), (missing - pd.offsets.BDay(2)).strftime("%Y-%m-%d")
    seen = 0
    for h in full["horizons"]:
        for bt in h["backtest"]:
            # The decision label stays the month's last weekday; the quote date is the real one.
            if bt["origin_date"] == label:
                assert bt["origin_quote_date"] == quoted
                seen += 1
            if bt["target_date"] == label:
                assert bt["target_quote_date"] == quoted
                seen += 1
            assert bt["origin_quote_date"] <= bt["origin_date"] and bt["target_quote_date"] <= bt["target_date"]
        # Forecasts actually available at the preceding completed month agree
        # whenever the h-month future target exists in the extended dataset.
        historical = next((bt for bt in h["backtest"] if bt["origin_date"] == prefix["model_date"]), None)
        if historical:
            estimate = horizon(prefix, h["horizon_months"])
            assert historical["model_c"] == estimate["point"]
            assert historical["ridge"] == estimate["ridge_point"]
            assert historical["n_calibration"] == estimate["n_calibration"]
    assert seen > 0


def test_calibration_count_requires_matured_errors_and_quantiles_match():
    result = model.build(raw())
    for row in result["horizons"]:
        for index, bt in enumerate(row["backtest"]):
            past = [r for r in row["backtest"][:index] if r["target_t"] <= bt["origin_t"]]
            assert bt["n_calibration"] == len(past)
            if len(past) < 24:
                assert bt["lower68"] is None and bt["upper95"] is None
            else:
                residuals = [math.log(r["actual"]) - math.log(r["model_c"]) for r in past]
                q16, q84 = np.quantile(residuals, [.16, .84])
                assert bt["lower68"] == pytest.approx(bt["model_c"] * math.exp(q16))
                assert bt["upper68"] == pytest.approx(bt["model_c"] * math.exp(q84))
        assert row["n_calibration"] == len(row["backtest"])
        calibrated = [b for b in row["backtest"] if b["lower68"] is not None]
        assert row["metrics"]["n_interval"] == len(calibrated)


def test_negative_rates_and_constant_predictor_are_valid():
    inputs = raw()
    inputs["info:한국_1y"].iloc[:] = -.75
    inputs["info:UST1y"].iloc[:] = -1.25
    result = model.build(inputs)
    assert result["active"]
    for row in result["horizons"]:
        assert row["contributions"][1]["log_pct"] == 0
    json.dumps(result, allow_nan=False)


def test_invalid_duplicates_do_not_erase_valid_quotes_or_mutate_inputs():
    inputs = raw()
    original = {key: values.copy(deep=True) for key, values in inputs.items()}
    expected = model.build(inputs)
    key = "bb:달러원"
    inputs[key] = pd.concat([inputs[key].iloc[::-1], pd.Series(
        [np.nan, np.inf, -10, 0, 9999],
        index=[original[key].index[5], original[key].index[7], original[key].index[10],
               original[key].index[12], pd.Timestamp("2000-01-08")])])
    result = model.build(inputs)
    assert result["horizons"] == expected["horizons"]
    for name in ("info:한국_1y", "info:UST1y"):
        pd.testing.assert_series_equal(inputs[name], original[name])


def test_extreme_finite_rates_fail_closed_without_nonfinite_json():
    inputs = raw()
    inputs["info:한국_1y"] = inputs["info:한국_1y"] * 1e300
    warnings = []
    result = model.build(inputs, warn=warnings.append)
    assert not result["active"] and warnings
    assert all(not h["active"] and not h["backtest"] for h in result["horizons"])
    json.dumps(result, allow_nan=False)
