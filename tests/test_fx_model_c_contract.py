"""Reject broken public forecast payloads before they reach Pages."""
import copy

import pytest

import check_output
import fx_model_c
from test_fx_model_c import raw


@pytest.fixture(scope="module")
def payload():
    return fx_model_c.build(raw(150))


def errors(payload):
    check_output._errors.clear()
    check_output._check_fx_model_c(payload)
    return list(check_output._errors)


def test_valid_active_inactive_and_short_history_contracts(payload):
    assert not errors(payload)
    assert not errors(fx_model_c.build({}))
    assert not errors(fx_model_c.build(raw(63)))
    assert not errors(fx_model_c.build(raw(64)))


@pytest.mark.parametrize("mutate", [
    lambda p: p.pop("schema"),
    lambda p: p.update(horizons=[]),
    lambda p: p["anchor"].update(v=None),
    lambda p: p["anchor"].update(quote_t=p["anchor"]["t"] - 86400),
    lambda p: p["model"].update(shrinkage=.8),
    lambda p: p["horizons"][0].update(point=float("nan")),
    lambda p: p["horizons"][0].update(ridge_point=1500),
    lambda p: p["horizons"][0].update(change_pct=999),
    lambda p: p["horizons"][0].update(target_t=p["anchor"]["t"]),
    lambda p: p["horizons"][0].update(lower95=1e5),
    lambda p: p["horizons"][0].update(n_calibration=0),
    lambda p: p["horizons"][0]["contributions"][0].update(log_pct=100),
    lambda p: p["horizons"][0]["metrics"].update(n=1),
    lambda p: p["horizons"][0]["metrics"].update(rw_rmse=123456),
    lambda p: p["horizons"][0]["metrics"].update(theil_u=.01),
    lambda p: p["horizons"][0]["metrics"].update(mae=123456),
    lambda p: p["horizons"][0]["metrics"].update(coverage68=.123456),
    lambda p: p["horizons"][0]["backtest"][0].update(target_t=p["anchor"]["t"]+86400),
    lambda p: p["horizons"][0]["backtest"][0].update(n_calibration=25),
])
def test_reject_temporal_numeric_and_same_sample_corruption(payload, mutate):
    broken = copy.deepcopy(payload)
    mutate(broken)
    assert errors(broken)


def test_pipeline_adds_model_c_and_isolates_its_failure(monkeypatch):
    import process
    monkeypatch.setattr(process.fx_markov, "build", lambda raw, warn: {})
    monkeypatch.setattr(process.fx_outlook, "build", lambda raw: {})
    result = process.build_fx()
    assert result["model_c"]["schema"] == "fx_model_c_v1"
    def fail(*args, **kwargs):
        raise ArithmeticError("broken fit")
    monkeypatch.setattr(process.fx_model_c, "build", fail)
    result = process.build_fx()
    assert result["model_c"]["active"] is False
    assert result["model_c"]["reason"] and process.WARNINGS
