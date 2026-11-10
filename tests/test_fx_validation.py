"""Shared-origin metrics and causal-prefix tests on synthetic FX/rate data."""

import copy
import json
import math
from statistics import NormalDist

import numpy as np
import pandas as pd
import pytest

import fx_model_c
import fx_outlook
import fx_validation as validation


def source_data(n=2800):
    rng = np.random.default_rng(81103)
    dates = pd.bdate_range("2010-01-04", periods=n)
    i = np.arange(n - 1)
    returns = rng.normal(.00003, np.where((i // 180) % 3 == 0, .003, .009))
    fx = pd.Series(1200 * np.exp(np.r_[0, returns.cumsum()]), index=dates)
    return {"bb:달러원": fx,
            "info:한국_1y": pd.Series(2.5 + .5 * np.sin(np.arange(n) / 150), index=dates),
            "info:UST1y": pd.Series(3 + .7 * np.cos(np.arange(n) / 100), index=dates)}


@pytest.fixture(scope="module")
def inputs():
    data = source_data()
    return data, fx_outlook.build(data), fx_model_c.build(data)


def fast_markov(returns, block_starts=None):
    """Cheap deterministic fitted surrogate; tests still exercise prefix routing.

    Production EM is separately exercised below and by the Markov audit suite.
    This avoids dozens of identical expensive EM fits in alignment/metric tests.
    """
    r = np.asarray(returns)
    mean, variance = float(r.mean()), float(r.var())
    return {"active": True, "means": np.array([mean - .0001, mean, mean + .0001]),
            "variances": variance * np.array([.5, 1, 1.5]),
            "transition": np.full((3, 3), 1 / 3), "probabilities": np.full(3, 1 / 3)}


@pytest.fixture
def fast_fit(monkeypatch):
    monkeypatch.setattr(validation.fx_markov, "fit_markov", fast_markov)


def test_metrics_match_independent_scalar_calculations_and_common_interval_subset():
    rows = []
    for i, actual in enumerate((90., 115., 130.)):
        intervals = {key: {"lower68": 95., "upper68": 110., "lower95": 80., "upper95": 120.}
                     for key in validation.INTERVAL_KEYS}
        if i == 0:
            intervals["c"] = {key: None for key in intervals["c"]}
        rows.append({"origin_date": f"2020-0{i+1}-28", "target_date": f"2021-0{i+1}-28",
                     "base": 100., "actual": actual,
                     "points": {key: 100. if key in ("d", "rw") else 105. for key in validation.POINT_KEYS},
                     "intervals": intervals,
                     "variance": {"d": .02, "constant": .03, "ewma": .04, "realized": math.log(actual / 100) ** 2}})
    result = validation.metrics(rows)
    assert result["point"]["a"]["mae"] == pytest.approx((15 + 10 + 25) / 3)
    assert result["point"]["a"]["rmse"] == pytest.approx(math.sqrt((225 + 100 + 625) / 3))
    assert result["point"]["rw"]["theil_u_rw"] == pytest.approx(1)
    for key in validation.INTERVAL_KEYS:
        score = result["interval"]["95"]["models"][key]
        assert score["n"] == 2 and score["coverage"] == .5
        # Width 40; the second retained actual exceeds upper bound by 10.
        assert score["interval_score"] == pytest.approx((40 + (40 + 40 * 10)) / 2)
    assert result["interval"]["95"]["sample"]["origin_start"] == "2020-02-28"
    assert result["variance"]["d"]["qlike"] == pytest.approx(
        sum(math.log(.02) + math.log(y / 100) ** 2 / .02 for y in (90, 115, 130)) / 3)
    assert validation.metrics([])["point"]["a"]["rmse"] is None
    assert validation.interval_score(75, 80, 120) == 240
    with pytest.raises(ValueError):
        validation.interval_score(1, 2, 1)


def test_shared_origin_contract_fixed_benchmarks_and_independent_variance(inputs, fast_fit):
    _, outlook, c = inputs
    result = validation.build(outlook, c, max_origins=14, path_count=100)
    assert result["active"] and result["schema"] == "fx_validation_v1"
    assert len(result["selected_origins"]) == 14
    assert [h["horizon_months"] for h in result["horizons"]] == [1, 3, 6, 9, 12]
    assert all(h["n_common"] > 0 for h in result["horizons"])
    levels = validation._history(outlook)
    for horizon in result["horizons"]:
        assert horizon["n_common"] == len(horizon["rows"])
        assert all(m["n"] == horizon["n_common"] for m in horizon["metrics"]["point"].values())
        for row in horizon["rows"]:
            origin = pd.Timestamp(row["origin_date"])
            target = pd.Timestamp(row["target_date"])
            n = len(pd.bdate_range(origin + pd.Timedelta(days=1), target))
            assert row["model_steps"] == n
            assert all(type(v) is float for v in row["variance"].values())
            assert row["actual"] == levels.loc[target]
            p = row["points"]
            assert p["d"] == p["rw"] == row["base"]
            assert p["equal_ac_rw"] == pytest.approx((p["a"] + p["c"] + p["rw"]) / 3)
            assert p["shrink_ac_rw"] == pytest.approx(.25 * p["a"] + .25 * p["c"] + .5 * p["rw"])
            r = np.diff(np.log(levels.loc[:origin].to_numpy()))[-validation.fx_model_d.MAX_TRAIN:]
            v = float(np.mean(r * r))
            ewma = v
            for x in r:
                ewma = .94 * ewma + .06 * x * x
            assert row["variance"]["constant"] == pytest.approx(v * n)
            assert row["variance"]["ewma"] == pytest.approx(ewma * n)
            expected_upper = row["base"] * math.exp(NormalDist().inv_cdf(.975) * math.sqrt(v * n))
            assert row["intervals"]["constant"]["upper95"] == pytest.approx(expected_upper)
    assert result["config"]["weights_fitted"] is False
    assert result["config"]["superiority_established"] is False
    assert result["excluded_models"][0]["model"] == "b"
    json.dumps(result, allow_nan=False)


def test_future_fx_and_rate_perturbations_cannot_change_past_forecast(inputs, fast_fit):
    data, outlook, c = inputs
    first = validation.build(outlook, c, max_origins=1, path_count=100)
    assert first["active"]
    origin = pd.Timestamp(first["selected_origins"][-1])
    changed = {key: values.copy() for key, values in data.items()}
    for key, values in changed.items():
        values.loc[values.index > origin] = values.loc[values.index > origin] * (1.4 if key == "bb:달러원" else -3)
    second = validation.build(fx_outlook.build(changed), fx_model_c.build(changed), max_origins=1, path_count=100)
    assert first["selected_origins"] == second["selected_origins"]
    for a, b in zip(first["horizons"], second["horizons"], strict=True):
        for ra, rb in zip(a["rows"], b["rows"], strict=True):
            assert ra["origin_date"] == rb["origin_date"]
            assert ra["actual"] != rb["actual"]
            for key in ("points", "intervals", "arithmetic_means", "n_train", "n_calibration_c"):
                assert ra[key] == rb[key]
            for key in validation.VARIANCE_KEYS:
                assert ra["variance"][key] == rb["variance"][key]
    assert first["horizons"][0]["metrics"] != second["horizons"][0]["metrics"]


def test_simulation_seed_is_independent_of_later_target_availability(inputs, fast_fit):
    _, outlook, c = inputs
    # One older origin with all horizons has varying maximum simulation length.
    common = set.intersection(*[{r["origin_date"] for r in h["backtest"]} for h in c["horizons"]])
    origin = sorted(common)[-1]
    slim = copy.deepcopy(c)
    for h in slim["horizons"]:
        h["backtest"] = [r for r in h["backtest"] if r["origin_date"] == origin]
    all_h = validation.build(outlook, slim, max_origins=1, path_count=100)
    one_h = copy.deepcopy(slim)
    one_h["horizons"] = [one_h["horizons"][0]]
    one = validation.build(outlook, one_h, max_origins=1, path_count=100)
    assert all_h["horizons"][0]["rows"] == one["horizons"][0]["rows"]


def test_missing_endpoint_is_excluded_without_filling(inputs, fast_fit):
    _, outlook, c = inputs
    baseline = validation.build(outlook, c, max_origins=1, path_count=100)
    row = baseline["horizons"][0]["rows"][0]
    changed = copy.deepcopy(outlook)
    i = changed["history"]["t"].index(row["target_t"])
    del changed["history"]["t"][i], changed["history"]["v"][i]
    result = validation.build(changed, c, max_origins=1, path_count=100)
    h = result["horizons"][0]
    assert all(r["target_t"] != row["target_t"] for r in h["rows"])
    assert any("관측 없음" in r["reason"] for r in h["excluded"])


def test_absent_malformed_short_and_failed_model_are_explicit(inputs, fast_fit, monkeypatch):
    _, outlook, c = inputs
    for bad in (None, [], {"history": None}, {"history": {"t": [1], "v": []}}):
        assert not validation.build(bad, None)["active"]
    assert not validation.build(outlook, {"source": outlook["source"], "horizons": None})["active"]
    assert not validation.build(outlook, {**c, "source": "other"})["active"]
    short = fx_outlook.build(source_data(30))
    assert not validation.build(short, c)["active"]
    monkeypatch.setattr(validation.fx_markov, "fit_markov", lambda *a: {"active": False, "reason": "fixture_failure"})
    result = validation.build(outlook, c, max_origins=1, path_count=100)
    assert not result["active"]
    assert any("fixture_failure" in r["reason"] for h in result["horizons"] for r in h["excluded"])
    with pytest.raises(ValueError):
        validation.build(outlook, c, max_origins=0)
    with pytest.raises(ValueError):
        validation.build(outlook, c, path_count=True)


def test_native_a_and_d_prefix_refits_execute_without_recursive_backtests(monkeypatch):
    data = source_data(1100)
    levels = data["bb:달러원"]
    monkeypatch.setattr(validation.fx_model_d, "backtest", lambda *a: pytest.fail("recursive backtest"))
    fit = validation._fit_origin(levels, levels.index[-1])
    assert fit["a"]["active"]
    assert fit["n_a"] == fit["n_d"] == len(levels) - 1
    a, d = validation._simulate(fit, float(levels.iloc[-1]), levels.index[-1], 23, 100)
    assert a.shape == d.shape == (100, 24)
    assert np.isfinite(a).all() and np.isfinite(d).all()


def test_nonfinite_metadata_and_extreme_point_are_rejected_before_json(inputs, fast_fit):
    _, outlook, c = inputs
    bad = copy.deepcopy(c)
    for horizon in bad["horizons"]:
        for i, row in enumerate(horizon["backtest"]):
            if i % 2:
                row["model_c"] = 1e308
            else:
                row["n_calibration"] = float("nan")
    result = validation.build(outlook, bad, max_origins=1, path_count=100)
    assert not result["active"]
    assert all(h["n_candidates"] == 0 for h in result["horizons"])
    json.dumps(result, allow_nan=False)
    malformed = {**c, "horizons": [{"horizon_months": [], "backtest": []}]}
    assert not validation.build(outlook, malformed)["active"]


def test_c_calibration_minimum_cannot_be_bypassed_by_supplied_bounds(inputs, fast_fit):
    _, outlook, c = inputs
    changed = copy.deepcopy(c)
    for horizon in changed["horizons"]:
        for row in horizon["backtest"]:
            row["n_calibration"] = 0
    result = validation.build(outlook, changed, max_origins=1, path_count=100)
    horizon = result["horizons"][0]
    assert horizon["n_common"] == 1
    for confidence in ("68", "95"):
        assert horizon["metrics"]["interval"][confidence]["sample"]["n"] == 0
        assert all(model["coverage"] is None for model in horizon["metrics"]["interval"][confidence]["models"].values())
