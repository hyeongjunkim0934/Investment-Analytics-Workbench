"""Mutation checks against the independent standard-library deployment gate."""
import copy
from datetime import datetime, timezone
import math

import pytest
import fx_validation
import fx_validation_contract


@pytest.fixture
def payload():
    epoch = lambda s: int(datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp())
    row = {"origin_date": "2020-01-31", "target_date": "2020-02-28",
           "origin_t": epoch("2020-01-31"), "target_t": epoch("2020-02-28"),
           "base": 100., "actual": 110., "model_steps": 20, "n_calibration_c": 24,
           "points": {"a": 105., "c": 108., "d": 100., "rw": 100.,
                      "equal_ac_rw": 313./3, "shrink_ac_rw": 103.25},
           "intervals": {k: {"lower95": 80., "lower68": 90., "upper68": 115., "upper95": 120.}
                         for k in fx_validation.INTERVAL_KEYS},
           "variance": {"d": .01, "constant": .02, "ewma": .03, "realized": math.log(1.1)**2}}
    p = fx_validation.skeleton(max_origins=1, path_count=100)
    p.update(active=True, reason=None, asof="2020-03-02", source="bb:달러원", selected_origins=["2020-01-31"])
    for h in [1, 3, 6, 9, 12]:
        rows = [copy.deepcopy(row)] if h == 1 else []
        p["horizons"].append({"horizon_months": h, "n_candidates": len(rows), "n_selected": len(rows),
                              "n_common": len(rows), "rows": rows, "metrics": fx_validation.metrics(rows)})
    return p


def test_valid_and_inactive_contract(payload):
    assert not fx_validation_contract.errors(payload)
    assert not fx_validation_contract.errors(fx_validation.skeleton("입력 부족"))
    assert fx_validation_contract.errors(None)


@pytest.mark.parametrize("mutate", [
    lambda p: p.update(active="true"),
    lambda p: p.update(unit="USD/KRW"),
    lambda p: p.update(asof="2020-01-01"),
    lambda p: p["config"].update(weights_fitted=True),
    lambda p: p["selected_origins"].append("2020-01-31"),
    lambda p: p["horizons"][0].update(n_common=2),
    lambda p: p["horizons"][0]["rows"][0].update(model_steps=21),
    lambda p: p["horizons"][0]["rows"][0]["points"].update(d=102),
    lambda p: p["horizons"][0]["rows"][0]["points"].update(equal_ac_rw=100),
    lambda p: p["horizons"][0]["rows"][0]["variance"].update(realized=.1),
    lambda p: p["horizons"][0]["rows"][0]["intervals"]["a"].update(lower95=150),
    lambda p: p["horizons"][0]["metrics"]["point"]["a"].update(rmse=999),
    lambda p: p["horizons"][0]["metrics"]["interval"]["95"]["models"]["d"].update(coverage=.5),
    lambda p: p["horizons"][0]["metrics"]["variance"]["d"].update(qlike=99),
])
def test_corruption_rejected(payload, mutate):
    mutate(payload)
    assert fx_validation_contract.errors(payload)


def test_gate_matches_actual_source_and_c_backtest(payload):
    row = payload["horizons"][0]["rows"][0]
    history = {"t": [row["origin_t"], row["target_t"]], "v": [100., 110.]}
    c = _source_c(row)
    assert not fx_validation_contract.errors(payload, history=history, model_c=c)
    history["v"][1] = 111.
    assert fx_validation_contract.errors(payload, history=history, model_c=c)
    history["v"][1] = 110.
    c["horizons"][0]["backtest"][0]["model_c"] = 109.
    assert fx_validation_contract.errors(payload, history=history, model_c=c)


def _source_c(row):
    return {"horizons": [{"horizon_months": 1, "backtest": [{
        "origin_t": row["origin_t"], "target_t": row["target_t"],
        "base": row["base"], "actual": row["actual"], "model_c": row["points"]["c"],
        "n_calibration": row["n_calibration_c"], **row["intervals"]["c"],
    }]}]}


@pytest.mark.parametrize("mutate", [
    lambda row: row["intervals"]["c"].update(lower95=70.),
    lambda row: row.update(n_calibration_c=25),
    lambda row: row.update(n_calibration_c=24.),
])
def test_gate_rejects_changed_c_bounds_or_count_even_when_metrics_are_recomputed(payload, mutate):
    horizon = payload["horizons"][0]
    row = horizon["rows"][0]
    source = _source_c(row)
    mutate(row)
    horizon["metrics"] = fx_validation.metrics(horizon["rows"])
    issues = fx_validation_contract.errors(payload, model_c=source)
    assert any("C 구간 원천" in issue or "C 교정 표본수" in issue for issue in issues)


@pytest.mark.parametrize("mutation", [
    {"n_calibration": 23},
    {"lower68": None},
    {"upper95": None},
    {"lower68": 70.},  # Each pair is ordered, but the 68% interval is not nested.
    {"upper95": 1e151},
    {"lower95": None, "lower68": None, "upper68": None, "upper95": None},
])
def test_gate_independently_applies_all_or_none_c_interval_normalization(payload, mutation):
    horizon = payload["horizons"][0]
    row = horizon["rows"][0]
    source = _source_c(row)
    source["horizons"][0]["backtest"][0].update(mutation)
    row["n_calibration_c"] = mutation.get("n_calibration", row["n_calibration_c"])
    row["intervals"]["c"] = dict.fromkeys(row["intervals"]["c"])
    horizon["metrics"] = fx_validation.metrics(horizon["rows"])
    assert not fx_validation_contract.errors(payload, model_c=source)
    # Even internally consistent recomputed scores cannot revive unusable bands.
    row["intervals"]["c"] = {"lower95": 80., "lower68": 90., "upper68": 115., "upper95": 120.}
    horizon["metrics"] = fx_validation.metrics(horizon["rows"])
    assert any("C 구간 원천" in issue for issue in fx_validation_contract.errors(payload, model_c=source))


@pytest.mark.parametrize("mutation", [
    {"base": 101.}, {"actual": 111.}, {"n_calibration": True}, {"n_calibration": -1},
])
def test_gate_rejects_mismatched_c_source_values_or_invalid_calibration(payload, mutation):
    source = _source_c(payload["horizons"][0]["rows"][0])
    source["horizons"][0]["backtest"][0].update(mutation)
    assert fx_validation_contract.errors(payload, model_c=source)
