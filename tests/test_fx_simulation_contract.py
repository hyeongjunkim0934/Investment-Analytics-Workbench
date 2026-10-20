"""Reject broken forecast distributions at deployment, using synthetic values only."""

import copy
import json

import pytest

import check_output


def fixture():
    anchor = {"t": 1_700_000_000, "v": 1234.5}
    times = [anchor["t"] + i * 86400 for i in range(253)]
    simulation = {
        "schema_version": 1, "engine": "gaussian_markov_log_returns", "rng": "PCG64",
        "numpy_version": "test", "seed": 20261020, "path_count": 20000,
        "interval_type": "pointwise_equal_tail_conditional_prediction",
        "nominal_coverages": [0.68, 0.95], "quantile_method": "linear",
        "calibrated_prediction_interval": False, "parameter_uncertainty_included": False,
        "median_is_realizable_path": False, "dates_are_trading_calendar": False,
        "sample_path_selection": "first_paths", "sample_path_count": 2,
        "mean_mc_se_definition": "sample_level_sd/sqrt(path_count)",
        "calendar_mapping": "21_model_steps_per_calendar_month_interpolated",
        "t": times, "steps": list(range(253)), "mean_mc_se": [0] + [0.2] * 252,
        "state_probabilities": [[0.2, 0.3, 0.5] for _ in times],
    }
    for key, slope in [("mean", 0.3), ("median", 0.2), ("lower68", -0.2),
                       ("upper68", 0.6), ("lower95", -0.4), ("upper95", 0.8)]:
        simulation[key] = [anchor["v"] + i * slope for i in range(253)]
    simulation["sample_paths"] = [simulation["mean"].copy(), simulation["lower95"].copy()]
    model = {key: None for key in check_output.REQUIRED_NESTED_KEYS[("fx", "markov")]}
    model.update(active=True, anchor=anchor, range={"t": times[::21]}, simulation=simulation)
    return model


@pytest.fixture(autouse=True)
def reset_gate():
    check_output._errors.clear()
    check_output._notes.clear()
    yield
    check_output._errors.clear()
    check_output._notes.clear()


def errors(model):
    check_output._check_fx_simulation(model)
    return check_output._errors


def test_valid_distribution_and_skewed_mean_outside_central_interval_are_allowed():
    model = fixture()
    # Rare large realizations can move the mean above even the 97.5th percentile.
    model["simulation"]["mean"][-1] = 10000
    assert errors(model) == []


@pytest.mark.parametrize("mutate", [
    lambda s: s.update(schema_version=True),
    lambda s: s.update(interval_type="whole_path_coverage"),
    lambda s: s.update(parameter_uncertainty_included=True),
    lambda s: s.update(path_count=1),
    lambda s: s.update(seed=True),
    lambda s: s["t"].__setitem__(40, s["t"][39]),
    lambda s: s["steps"].__setitem__(63, 64),
    lambda s: s["median"].pop(),
    lambda s: s["mean"].__setitem__(10, float("nan")),
    lambda s: s["upper95"].__setitem__(10, float("inf")),
    lambda s: s["median"].__setitem__(10, 0),
    lambda s: s["lower68"].__setitem__(10, s["median"][10] + 1),
    lambda s: s["upper95"].__setitem__(10, s["upper68"][10] - 1),
    lambda s: s["mean_mc_se"].__setitem__(1, -0.1),
    lambda s: s["mean_mc_se"].__setitem__(0, 0.1),
    lambda s: s["state_probabilities"].__setitem__(20, [0.2, 0.3, 0.4]),
    lambda s: s["sample_paths"][0].__setitem__(0, 1234),
    lambda s: s.update(sample_path_count=3),
])
def test_malformed_simulation_is_rejected(mutate):
    model = fixture()
    mutate(model["simulation"])
    assert errors(model)


def test_monthly_date_mapping_and_anchor_must_match():
    model = fixture()
    model["range"]["t"][3] += 1
    model["simulation"]["mean"][0] += 0.01
    found = errors(model)
    assert any("월별 기준일" in message for message in found)
    assert any("mean 최신 관측" in message for message in found)


def write_payloads(directory, markov):
    payloads = {name: {} for name in check_output.EXPECTED}
    for name, keys in check_output.REQUIRED_KEYS.items():
        payloads[name].update(dict.fromkeys(keys))
    for (name, block), keys in check_output.REQUIRED_NESTED_KEYS.items():
        payloads[name][block] = dict.fromkeys(keys)
    payloads["meta"] = {"built_at_utc": "2026-10-20", "last_observation": "2026-10-19",
                        "series_count": 100, "files": [], "warnings": []}
    payloads["fx"]["markov"] = markov
    for name, value in payloads.items():
        (directory / f"{name}.json").write_text(json.dumps(value), encoding="utf-8")


@pytest.mark.parametrize("active,simulation_present,expected", [
    (True, True, 0), (True, False, 1), (False, True, 0), (False, False, 1),
])
def test_complete_gate_requires_simulation_key_but_allows_inactive_null(
        tmp_path, active, simulation_present, expected):
    model = copy.deepcopy(fixture())
    model["active"] = active
    if not active:
        model["simulation"] = None
    if not simulation_present:
        del model["simulation"]
    write_payloads(tmp_path, model)
    assert check_output.check(tmp_path, max_warnings=0, min_series=1, dashboard=None) == expected


def test_active_null_and_inactive_stale_distribution_are_rejected():
    model = fixture()
    model["active"] = False
    assert errors(model)
    check_output._errors.clear()
    model.update(active=True, simulation=None)
    assert errors(model)
