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


def test_month_end_weekend_uses_preceding_weekday_and_rejects_stale_quote():
    inputs = raw(180, start="2000-11-01")
    # The final month is October 2015: the 31st is Saturday, decision is Friday30.
    assert inputs["bb:달러원"].index[-1] == pd.Timestamp("2015-10-30")
    result = model.build(inputs)
    assert result["model_date"] == "2015-10-30"
    assert horizon(result, 1)["target_date"] == "2015-11-30"
    # A later November observation cannot retroactively complete stale October.
    for key, values in inputs.items():
        values = values.copy()
        values.index = values.index[:-1].append(pd.DatetimeIndex(["2015-10-27"]))
        inputs[key] = pd.concat([values, pd.Series([float(values.iloc[-1])], index=[pd.Timestamp("2015-11-02")])])
    result = model.build(inputs)
    assert result["asof"] == result["model_date"] == "2015-09-30"
    assert result["anchor"]["quote_t"] == result["anchor"]["t"]
    assert result["sample"]["n_months"] == 179
    assert result["model"]["max_endpoint_gap_days"] == 0
    prefix = model.build({key: values.loc[:"2015-10-30"] for key, values in inputs.items()})
    assert result["anchor"] == prefix["anchor"]
    assert result["horizons"] == prefix["horizons"]


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


def test_two_day_stale_historical_month_never_becomes_forecast_origin_later():
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
    assert full["sample"]["n_months"] == 179
    for h in full["horizons"]:
        assert all(bt["origin_date"] != missing.strftime("%Y-%m-%d") for bt in h["backtest"])
        # Forecasts actually available at the preceding completed month agree
        # whenever the h-month future target exists in the extended dataset.
        historical = next((bt for bt in h["backtest"] if bt["origin_date"] == prefix["model_date"]), None)
        if historical:
            estimate = horizon(prefix, h["horizon_months"])
            assert historical["model_c"] == estimate["point"]
            assert historical["ridge"] == estimate["ridge_point"]
            assert historical["n_calibration"] == estimate["n_calibration"]


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
