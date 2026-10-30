"""Independent same-input audits for FX C; no financial performance claims.

The oracle builds calendar dictionaries and solves an augmented least-squares
system, rather than using production panel or normal-equation helpers. Timing
checks use full-versus-prefix runs and past-realized forecast error identities.
"""

import math

import numpy as np
import pandas as pd
import pytest

import fx_model_c


def _synthetic(n=184):
    dates = pd.date_range("2007-01-01", periods=n, freq="BME")
    t = np.arange(n, dtype=float)
    increments = 0.002 + 0.014 * np.sin(t / 3.1) - 0.007 * np.cos(t / 8.4)
    fx = 1100 * np.exp(np.cumsum(increments))
    kr = 2.0 + 0.8 * np.sin(t / 13) + 0.15 * np.cos(t / 3.6)
    us = 2.5 + 1.2 * np.cos(t / 16.4)
    return {
        "bb:달러원": pd.Series(fx, index=dates),
        "info:한국_1y": pd.Series(kr, index=dates),
        "info:UST1y": pd.Series(us, index=dates),
    }


def _monthly_dictionary(raw):
    """Fixture dates are already valid final weekdays; do not call production."""
    maps = {k: {pd.Timestamp(d).to_period("M"): float(v) for d, v in s.items()}
            for k, s in raw.items()}
    common = set.intersection(*(set(v) for v in maps.values()))
    return {p: (maps["bb:달러원"][p], maps["info:한국_1y"][p] - maps["info:UST1y"][p])
            for p in common}


def _feature(panel, p):
    if not all(k in panel for k in (p, p - 1, p - 3)):
        return None
    level, spread = panel[p]
    return [spread, math.log(level / panel[p - 1][0]), math.log(level / panel[p - 3][0])]


def _oracle_prediction(panel, origin, horizon):
    # A forecast label is known only if its target month is at/before origin.
    eligible = [p for p in sorted(panel) if p + horizon <= origin and p + horizon in panel
                and _feature(panel, p) is not None]
    eligible = eligible[-120:]
    x = np.asarray([_feature(panel, p) for p in eligible])
    y = np.asarray([math.log(panel[p + horizon][0] / panel[p][0]) for p in eligible])
    mean, std = x.mean(axis=0), x.std(axis=0, ddof=0)
    scale = np.where(std > 1e-12, std, 1)
    design = np.column_stack([np.ones(len(x)), (x - mean) / scale])
    penalty = np.zeros((3, 4))
    penalty[:, 1:] = np.eye(3) * math.sqrt(len(x))
    rhs = np.concatenate([y, np.zeros(3)])
    coefficients = np.linalg.lstsq(np.vstack([design, penalty]), rhs, rcond=None)[0]
    newrow = np.r_[1., (np.asarray(_feature(panel, origin)) - mean) / scale]
    log_prediction = float(newrow @ coefficients)
    return panel[origin][0] * math.exp(log_prediction * 0.5), panel[origin][0] * math.exp(log_prediction), len(x)


def _horizons(payload):
    assert payload["active"], payload.get("reason")
    return {row["horizon_months"]: row for row in payload["horizons"]}


def _period(date):
    return pd.Timestamp(date).to_period("M")


def _q_linear(values, probability):
    ordered = sorted(values)
    offset = (len(ordered) - 1) * probability
    lo, hi = math.floor(offset), math.ceil(offset)
    return ordered[lo] + (offset - lo) * (ordered[hi] - ordered[lo])


def test_latest_centers_match_independent_augmented_least_squares():
    raw = _synthetic()
    panel = _monthly_dictionary(raw)
    result = _horizons(fx_model_c.build(raw))
    for h, row in result.items():
        expected, expected_raw, n = _oracle_prediction(panel, max(panel), h)
        assert row["point"] == pytest.approx(expected, rel=2e-12)
        assert row["ridge_point"] == pytest.approx(expected_raw, rel=2e-12)
        assert row["n_train"] == n
        assert row["rw"] == panel[max(panel)][0]


def test_missing_calendar_month_is_not_compressed_into_one_observation():
    raw = _synthetic()
    missing = raw["bb:달러원"].index[125]
    raw = {k: s.drop(missing) for k, s in raw.items()}
    panel = _monthly_dictionary(raw)
    result = _horizons(fx_model_c.build(raw))
    for h, row in result.items():
        expected, expected_raw, n = _oracle_prediction(panel, max(panel), h)
        assert row["point"] == pytest.approx(expected, rel=2e-12)
        assert row["ridge_point"] == pytest.approx(expected_raw, rel=2e-12)
        assert row["n_train"] == n


@pytest.mark.parametrize("level", [1100.0, 1350.25])
def test_constant_level_has_exact_zero_error_and_complete_zero_width_coverage(level):
    raw = _synthetic()
    raw["bb:달러원"].iloc[:] = level
    result = _horizons(fx_model_c.build(raw))
    for row in result.values():
        assert row["point"] == row["ridge_point"] == row["rw"] == level
        assert row["lower68"] == row["upper68"] == level
        assert row["lower95"] == row["upper95"] == level
        assert row["metrics"]["rmse"] == row["metrics"]["rw_rmse"] == 0
        assert row["metrics"]["theil_u"] is None
        assert row["metrics"]["coverage68"] == row["metrics"]["coverage95"] == 1


def test_historical_predictions_and_bounds_are_invariant_to_future_input_values():
    raw = _synthetic()
    cutoff = raw["bb:달러원"].index[132]
    changed = {key: values.copy() for key, values in raw.items()}
    for key, values in changed.items():
        future = values.index > cutoff
        values.loc[future] *= 4.0 if key == "bb:달러원" else -3.0
    left, right = _horizons(fx_model_c.build(raw)), _horizons(fx_model_c.build(changed))
    for h in left:
        a = [r for r in left[h]["backtest"] if r["target_date"] <= cutoff.strftime("%Y-%m-%d")]
        b = [r for r in right[h]["backtest"] if r["target_date"] <= cutoff.strftime("%Y-%m-%d")]
        assert a == b


def test_truncated_run_latest_forecast_equals_same_origin_in_full_history():
    raw = _synthetic()
    cutoff = raw["bb:달러원"].index[132]
    truncated = {key: values.loc[:cutoff].copy() for key, values in raw.items()}
    full = _horizons(fx_model_c.build(raw))
    prefix = _horizons(fx_model_c.build(truncated))
    for h, current in prefix.items():
        original = next(r for r in full[h]["backtest"] if r["origin_date"] == str(cutoff.date()))
        assert current["point"] == original["model_c"]
        assert current["ridge_point"] == original["ridge"]
        assert current["rw"] == original["rw"]
        for name in ("n_train", "n_calibration", "lower68", "upper68", "lower95", "upper95"):
            assert current[name] == original[name]


def test_intervals_use_only_previously_matured_errors_and_metrics_use_same_origins():
    result = _horizons(fx_model_c.build(_synthetic()))
    for h, horizon in result.items():
        rows = horizon["backtest"]
        for i, row in enumerate(rows):
            assert _period(row["target_date"]) == _period(row["origin_date"]) + h
            eligible = [r for r in rows[:i] if r["target_date"] <= row["origin_date"]]
            assert row["n_calibration"] == len(eligible)
            bounds = ("lower68", "upper68", "lower95", "upper95")
            if len(eligible) < 24:
                assert all(row[name] is None for name in bounds)
            else:
                errors = [math.log(r["actual"] / r["model_c"]) for r in eligible]
                for name, q in zip(bounds, (0.16, 0.84, 0.025, 0.975)):
                    expected = row["model_c"] * math.exp(_q_linear(errors, q))
                    assert row[name] == pytest.approx(expected, rel=3e-12)
        m = horizon["metrics"]
        assert m["n"] == len(rows)
        for metric, key in (("rmse", "model_c"), ("rw_rmse", "rw"), ("ridge_rmse", "ridge")):
            expected = math.sqrt(math.fsum((r[key] - r["actual"]) ** 2 for r in rows) / len(rows))
            assert m[metric] == pytest.approx(expected, rel=1e-13)
        assert m["theil_u"] == pytest.approx(m["rmse"] / m["rw_rmse"], rel=1e-13)
        assert horizon["n_calibration"] == len(rows)
        calibrated = [r for r in rows if r["lower68"] is not None]
        assert m["n_interval"] == len(calibrated)
        for p in (68, 95):
            coverage = sum(r[f"lower{p}"] <= r["actual"] <= r[f"upper{p}"] for r in calibrated) / len(calibrated)
            assert m[f"coverage{p}"] == coverage


def test_forecast_contributions_sum_to_log_change_without_claiming_causality():
    result = _horizons(fx_model_c.build(_synthetic()))
    for row in result.values():
        total = math.fsum(item["log_pct"] for item in row["contributions"])
        assert total == pytest.approx(100 * math.log(row["point"] / row["rw"]), abs=2e-12)
        assert row["change_pct"] == pytest.approx(100 * math.expm1(total / 100), abs=2e-12)


def test_fast_fx_updates_do_not_advance_common_month_or_select_longer_fallback():
    raw = _synthetic()
    baseline = fx_model_c.build(raw)
    extra_dates = pd.date_range(raw["bb:달러원"].index[-1] + pd.offsets.BMonthEnd(), periods=24, freq="BME")
    updated = {key: values.copy() for key, values in raw.items()}
    updated["bb:달러원"] = pd.concat([raw["bb:달러원"], pd.Series(9999., index=extra_dates)])
    updated["info:USDKRW"] = pd.Series(7777., index=updated["bb:달러원"].index)
    assert fx_model_c.build(updated) == baseline
    updated["bb:달러원"] = raw["bb:달러원"].iloc[-12:]
    short = fx_model_c.build(updated)
    assert not short["active"]
    assert short["source"] == "bb:달러원"


def test_missing_final_weekday_month_is_excluded_consistently_before_and_after_future_data():
    raw = _synthetic()
    quote_index = 125
    close_date = raw["bb:달러원"].index[quote_index]
    quote_date = close_date - pd.offsets.BDay(2)
    changed = {}
    for key, values in raw.items():
        dates = list(values.index)
        dates[quote_index] = quote_date
        changed[key] = pd.Series(values.to_numpy(), index=dates)
    full_payload = fx_model_c.build(changed)
    prefix_payload = fx_model_c.build({k: v.loc[:close_date] for k, v in changed.items()})
    full, prefix = _horizons(full_payload), _horizons(prefix_payload)
    assert prefix_payload["model_date"] == str(raw["bb:달러원"].index[quote_index - 1].date())
    omitted_month = close_date.to_period("M")
    for h, horizon in full.items():
        assert all(_period(r["origin_date"]) != omitted_month and _period(r["target_date"]) != omitted_month
                   for r in horizon["backtest"])
        old_rows = [r for r in horizon["backtest"] if r["target_date"] <= prefix_payload["model_date"]]
        assert old_rows == prefix[h]["backtest"]
        comparison = next((r for r in horizon["backtest"] if r["origin_date"] == prefix_payload["model_date"]), None)
        if comparison is None:
            assert _period(prefix_payload["model_date"]) + h == omitted_month
            continue
        assert comparison["model_c"] == prefix[h]["point"]
        assert comparison["ridge"] == prefix[h]["ridge_point"]
        for name in ("n_train", "n_calibration", "lower68", "upper68", "lower95", "upper95"):
            assert comparison[name] == prefix[h][name]
