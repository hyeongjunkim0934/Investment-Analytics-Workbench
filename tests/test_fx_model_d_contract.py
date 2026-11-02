"""Reject partial or semantically corrupted volatility forecasts before publication."""
import copy
import json

import numpy as np
import pandas as pd
import pytest

import check_output
import fx_model_d


@pytest.fixture(scope="module")
def payload():
    rng = np.random.default_rng(722)
    shocks = rng.normal(0, .006, 650)
    levels = pd.Series(1250 * np.exp(np.r_[0, np.cumsum(shocks)]),
                       index=pd.bdate_range("2020-01-01", periods=651))
    result = fx_model_d.build({"bb:달러원": levels})
    assert result["active"] and result["backtest"]["rows"]
    # The deployment gate reads JSON, so inspect the public serialized contract.
    return json.loads(json.dumps(result, allow_nan=False))


def errors(payload):
    check_output._errors.clear()
    check_output._check_fx_model_d(payload)
    return list(check_output._errors)


def test_active_and_inactive_contracts(payload):
    assert not errors(payload)
    assert not errors(fx_model_d.skeleton("데이터 부족"))
    broken = fx_model_d.skeleton()
    broken["reason"] = ""
    assert errors(broken)
    broken = fx_model_d.skeleton()
    broken["forecast"] = {}
    assert errors(broken)


@pytest.mark.parametrize("mutate", [
    lambda p: p.update(active="true"),
    lambda p: p.pop("schema"),
    lambda p: p.update(unit="USD/KRW"),
    lambda p: p.update(source="bb:USDJPY"),
    lambda p: p.update(asof="2000-01-01"),
    lambda p: p["anchor"].update(v=0),
    lambda p: p["anchor"].update(t=1e100),
    lambda p: p["model"].update(mean_log_return=.01),
    lambda p: p["model"].update(orthogonality_verified=True),
    lambda p: p["model"].update(fallback_used=True),
    lambda p: p["sample"].update(n_train=30),
    lambda p: p["fit"].update(persistence=1),
    lambda p: p["fit"].update(omega=.1),
    lambda p: p["fit"].update(n_train=100),
    lambda p: p["forecast"].update(steps=list(range(252))),
    lambda p: p["forecast"]["steps"].__setitem__(1, True),
    lambda p: p["forecast"]["t"].__setitem__(1, p["forecast"]["t"][1] + 300),
    lambda p: p["forecast"]["mean"].__setitem__(0, 1300),
    lambda p: p["forecast"]["mean"].__setitem__(1, float("nan")),
    lambda p: p["forecast"]["median"].__setitem__(1, 1e5),
    lambda p: p["forecast"]["vol_pct"].__setitem__(31, 999),
    lambda p: p["forecast"]["lower68"].pop(),
    lambda p: p["horizons"].pop(3),
    lambda p: p["horizons"][0].update(steps=22),
    lambda p: p["horizons"][0].update(target_date="2000-01-01"),
    lambda p: p["horizons"][0].update(mean=1e4),
    lambda p: p["horizons"][0].update(var95_pct=-90),
    lambda p: p["horizons"][0].update(es95_pct=-1),
    lambda p: p["backtest"].update(horizon_steps=63),
    lambda p: p["backtest"]["metrics"].update(n=999),
    lambda p: p["backtest"]["metrics"].update(qlike_d=1),
    lambda p: p["backtest"]["metrics"].update(mse_constant=1),
    lambda p: p["backtest"]["metrics"].update(coverage95=.333),
    lambda p: p["backtest"]["rows"][0].update(target_t=p["anchor"]["t"] + 86400),
    lambda p: p["backtest"]["rows"][1].update(origin_t=p["backtest"]["rows"][0]["origin_t"]),
    lambda p: p["backtest"]["rows"][0].update(realized_variance=-1),
    lambda p: p["backtest"]["rows"][0].update(model_variance=0),
    lambda p: p["backtest"]["rows"][0].update(realized_variance=1e308),
])
def test_temporal_numerical_and_risk_sign_corruption(payload, mutate):
    broken = copy.deepcopy(payload)
    mutate(broken)
    assert errors(broken)


def test_zero_realization_is_valid_qlike_input(payload):
    flat = copy.deepcopy(payload)
    flat["backtest"]["rows"][0]["realized_variance"] = 0
    flat["backtest"]["metrics"] = fx_model_d._metrics(flat["backtest"]["rows"])
    assert not errors(flat)


def test_pipeline_isolates_model_d_failure(monkeypatch):
    import process
    monkeypatch.setattr(process.fx_markov, "build", lambda *args, **kwargs: {})
    monkeypatch.setattr(process.fx_outlook, "build", lambda *args, **kwargs: {})
    result = process.build_fx()
    assert result["model_d"]["schema"] == "fx_model_d_v1"

    def fail(*args, **kwargs):
        raise ArithmeticError("broken volatility fit")

    monkeypatch.setattr(process.fx_model_d, "build", fail)
    result = process.build_fx()
    assert not result["model_d"]["active"]
    assert result["model_d"]["reason"] and process.WARNINGS
    assert "model_c" in result and "markov" in result
