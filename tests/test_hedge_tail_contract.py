"""Model C tail-loss publication gate: bounded schema, no estimator duplication."""

import copy
import json

import pytest

import check_output
import hedge
from test_hedge_tail import source_series
from test_fx_simulation_contract import fixture as markov_fixture, write_payloads


@pytest.fixture(autouse=True)
def reset_gate():
    check_output._errors.clear()
    check_output._notes.clear()
    yield
    check_output._errors.clear()
    check_output._notes.clear()


@pytest.fixture(scope="module")
def outlook():
    sources, _ = source_series()
    return hedge.build_bond_outlook(sources, "UST")


def errors(outlook):
    check_output._check_hedge_tail({"bond_analytics": {"UST": {"outlook": outlook}}})
    return list(check_output._errors)


def test_valid_active_short_sample_and_inactive_parent(outlook):
    assert not errors(outlook)
    sources, _ = source_series(80)
    assert not errors(hedge.build_bond_outlook(sources, "UST"))
    assert not errors({"active": False, "reason": "missing quotes"})
    check_output._check_hedge_tail({"legacy": True})
    assert not check_output._errors


@pytest.mark.parametrize("mutate", [
    lambda t: t.update(active=1),
    lambda t: t.update(version=True),
    lambda t: t.update(asof="invalid"),
    lambda t: t.update(asof="2025-01-01"),
    lambda t: t.update(unit="annual_loss_pct"),
    lambda t: t.update(horizon_months=12),
    lambda t: t.update(confidence=.975),
    lambda t: t.update(method="normal_approximation"),
    lambda t: t.update(oos_validated=True),
    lambda t: t.update(calibrated_prediction_interval=True),
    lambda t: t["grid"].pop(),
    lambda t: t["grid"][50].update(hedge_pct=51),
    lambda t: t["grid"][50].update(full_es_pct=float("nan")),
    lambda t: t["grid"][50].update(recent_es_pct=float("inf")),
    lambda t: t["grid"][50].update(robust_es_pct=999),
    lambda t: t["full"].update(n_months=119),
    lambda t: t["recent"].update(n_months=121),
    lambda t: t["full"].update(tail_mass=1),
    lambda t: t["recent"].update(end="2019-01-01"),
    lambda t: t["recent"].update(start="2000-01-01"),
    lambda t: t["full"].update(start="invalid"),
    lambda t: t["full"].update(end=t["asof"]),
    lambda t: t["full"].update(excluded_months=999),
    lambda t: t.update(returns=[.1, .2]),
    lambda t: t["grid"][1].update(shocks=[.1, .2]),
])
def test_reject_corrupt_tail_metadata_statistics_alignment_and_raw_data(outlook, mutate):
    broken = copy.deepcopy(outlook)
    mutate(broken["tail_risk"])
    assert errors(broken)


@pytest.mark.parametrize("mutation", ["missing", "inactive_without_reason", "inactive_stale_grid", "sample_mismatch"])
def test_active_parent_requires_explicit_and_consistent_tail_availability(outlook, mutation):
    broken = copy.deepcopy(outlook)
    if mutation == "missing":
        broken.pop("tail_risk")
    elif mutation == "inactive_without_reason":
        broken["tail_risk"] = {"active": False, "grid": []}
    elif mutation == "inactive_stale_grid":
        broken["tail_risk"].update(active=False, reason="short history")
    else:
        broken["sample"]["n_months"] -= 1
    assert errors(broken)


def test_signed_negative_es_is_valid(outlook):
    changed = copy.deepcopy(outlook)
    for row in changed["tail_risk"]["grid"]:
        row.update(full_es_pct=-2., recent_es_pct=-1., robust_es_pct=-1.)
    assert not errors(changed)


def test_normal_deployment_path_runs_tail_gate_but_accepts_legacy_fixture(tmp_path, outlook):
    write_payloads(tmp_path, markov_fixture())
    assert check_output.check(tmp_path, max_warnings=0, min_series=1, dashboard=None) == 0
    path = tmp_path / "hedge.json"
    payload = json.loads(path.read_text())
    payload["bond_analytics"] = {"UST": {"outlook": copy.deepcopy(outlook)}}
    path.write_text(json.dumps(payload))
    check_output._errors.clear()
    check_output._notes.clear()
    assert check_output.check(tmp_path, max_warnings=0, min_series=1, dashboard=None) == 0
    payload["bond_analytics"]["UST"]["outlook"].pop("tail_risk")
    path.write_text(json.dumps(payload))
    check_output._errors.clear()
    check_output._notes.clear()
    assert check_output.check(tmp_path, max_warnings=0, min_series=1, dashboard=None) == 1
    assert any("outlook.tail_risk" in error for error in check_output._errors)
