"""Independent return identities and publication contract for reference portfolios."""
from copy import deepcopy
import json
import math

import numpy as np
import pandas as pd
import pytest

import check_output
import reference_portfolio as ref


def store(n=146):
    dates = pd.date_range("2014-01-31", periods=n, freq="ME")
    rng = np.random.default_rng(214)
    local = rng.normal([.002, .003, .005, .006, .002], [.008, .01, .04, .035, .06], (n - 1, 5))
    fx = rng.normal(.001, .02, n - 1)
    out = {a["source"]: {"s": pd.Series(np.r_[100, 100 * np.cumprod(1 + local[:, i])], index=dates)}
           for i, a in enumerate(ref.ASSETS)}
    out[ref.FX_KEY] = {"s": pd.Series(np.r_[1100, 1100 * np.cumprod(1 + fx)], index=dates)}
    out[ref.RF_KEY] = {"s": pd.Series(np.linspace(1.1, 4.2, n), index=dates)}
    return out, dates, local, fx


def build(s):
    return ref.build(s, lambda _: None)


def gate(block):
    check_output._errors.clear()
    check_output._check_reference_portfolio(block)
    return check_output._errors[:]


def test_portfolio_moments_match_direct_monthly_pnl_and_fx_identity():
    s, dates, local, fx = store()
    r = build(s)
    assert r["active"] and not gate(r)
    w = r["windows"][-1]
    # Strict cutoff drops the final source month. Independent scalar P&L combines
    # local price and FX returns, rather than resampling multiplied index levels.
    monthly = local.copy()
    for i in (1, 3, 4):
        monthly[:, i] = (1 + local[:, i]) * (1 + fx) - 1
    sample = monthly[-121:-1]
    weights = np.array([.15, .25, .2, .3, .1])
    pnl = np.array([sum(float(x) * float(y) for x, y in zip(row, weights)) for row in sample])
    mean = sum(pnl) / 120
    variance = sum((v - mean) ** 2 for v in pnl) / 119
    assert np.dot(w["mean_pct"], weights) == pytest.approx(mean * 1200, abs=1e-8)
    assert weights @ np.array(w["cov"]) @ weights == pytest.approx(variance * 12, abs=1e-12)
    assert w["n_months"] == 120
    assert w["end"] == dates[-2].strftime("%Y-%m-%d")
    assert w["rf_mean_pct"] == pytest.approx(s[ref.RF_KEY]["s"].iloc[-122:-2].mean(), abs=1e-8)


def test_completed_month_is_fixed_by_earliest_source_and_future_month_ignored():
    s, dates, _, _ = store()
    r = build(s)
    changed = deepcopy(s)
    for value in changed.values():
        value["s"].iloc[-1] *= 1.4
    assert build(changed)["windows"] == r["windows"]
    truncated = deepcopy(s)
    truncated[ref.FX_KEY]["s"] = truncated[ref.FX_KEY]["s"].iloc[:-3]
    rr = build(truncated)
    assert rr["data_asof"] == dates[-4].strftime("%Y-%m-%d")
    assert rr["asof"] == dates[-5].strftime("%Y-%m-%d")


def test_fx_is_converted_on_same_observation_date_before_monthly_resampling():
    s, dates, _, _ = store(18)
    # Add a later same-month FX-only print. It must not alter any portfolio value.
    shifted = deepcopy(s)
    extra = dates[7] - pd.Timedelta(days=1)
    for a in ref.ASSETS:
        shifted[a["source"]]["s"] = shifted[a["source"]]["s"].rename(index={dates[7]: extra})
    shifted[ref.FX_KEY]["s"].loc[extra] = s[ref.FX_KEY]["s"].loc[dates[7]]
    base = build(shifted)
    shifted[ref.FX_KEY]["s"].loc[dates[7]] *= 3
    assert build(shifted)["windows"] == base["windows"]


def test_calendar_gap_is_not_bridged_and_short_trailing_window_not_relabelled():
    s, dates, _, _ = store(90)
    # One absent month invalidates that return and the following monthly return.
    s[ref.ASSETS[2]["source"]]["s"] = s[ref.ASSETS[2]["source"]]["s"].drop(dates[-20])
    r = build(s)
    assert r["active"]
    assert r["contiguous_months"] == 17
    assert [w["key"] for w in r["windows"]] == ["y1"]
    assert r["unavailable_windows"] == [3, 5, 10]
    s[ref.ASSETS[2]["source"]]["s"] = s[ref.ASSETS[2]["source"]]["s"].drop(dates[-5])
    r = build(s)
    assert not r["active"] and r["windows"] == []


def test_exact_twelve_month_boundary_is_included():
    s, _, _, _ = store(14)
    r = build(s)
    assert r["active"] and r["contiguous_months"] == 12
    assert [w["key"] for w in r["windows"]] == ["y1"]


def test_missing_commodity_and_duplicate_domestic_bond_are_partial_not_fabricated():
    s, _, _, _ = store()
    del s[ref.ASSETS[4]["source"]]
    s[ref.ASSETS[0]["source"]] = deepcopy(s[ref.ASSETS[1]["source"]])
    # A spot proxy cannot fill a missing total-return proxy.
    s["bb:원자재지수"] = deepcopy(s[ref.ASSETS[1]["source"]])
    r = build(s)
    assert r["active"] and not gate(r)
    assert [a["available"] for a in r["assets"]] == [False, True, True, True, False]
    assert "완전 중복" in r["assets"][0]["reason"]
    for w in r["windows"]:
        assert w["mean_pct"][0] is None and w["mean_pct"][4] is None
        assert all(value is None for value in w["cov"][0] + w["cov"][4])


@pytest.mark.parametrize("bad", [0, -100, float("inf")])
def test_nonpositive_or_nonfinite_price_disables_affected_asset(bad):
    s, _, _, _ = store()
    s[ref.ASSETS[2]["source"]]["s"].iloc[-10] = bad
    r = build(s)
    assert r["active"] and not r["assets"][2]["available"]
    assert all(w["vol_pct"][2] is None for w in r["windows"])


def test_missing_fx_or_rf_does_not_assume_zero():
    s, _, _, _ = store()
    del s[ref.FX_KEY]
    del s[ref.RF_KEY]
    r = build(s)
    assert r["active"] and not gate(r)
    assert [a["available"] for a in r["assets"]] == [True, False, True, False, False]
    assert all(w["rf_mean_pct"] is None and w["rf_reason"] for w in r["windows"])
    assert not build({})["active"]


def test_gate_rejects_raw_fields_null_fabrication_shape_units_psd_and_dates():
    s, _, _, _ = store()
    original = build(s)
    assert not gate(original)
    mutations = [
        lambda r: r.update(raw_returns=[.1]),
        lambda r: r["windows"][0].update(values=[.1]),
        lambda r: r["windows"][0]["cov"][0].pop(),
        lambda r: r["windows"][0]["cov"][0].__setitem__(0, .8),
        lambda r: r["windows"][0].update(n_months=11),
        lambda r: r["windows"][0].update(start="2020-01-15"),
        lambda r: r["windows"][0]["mean_pct"].__setitem__(2, None),
        lambda r: r["assets"][0].update(available=False, reason="test"),
        lambda r: r["windows"][0]["cov"][0].__setitem__(1, 100),
    ]
    for mutate in mutations:
        r = deepcopy(original)
        mutate(r)
        assert gate(r), mutate
    json.dumps(original, allow_nan=False)


def snapshot_wrapper(block):
    return {"source": {"name": "data_git/data_bb.xlsx", "modified_at": "2026-11-05T01:26:04Z",
                       "sha256": "a8bb9c01041baa4da150063895e447406c02d6caaecff89e049e3b9823b8a44e"},
            "reference": block}


def write_snapshot(directory, wrapper):
    (directory / ref.SNAPSHOT_FILE).write_text(json.dumps(wrapper, ensure_ascii=False), encoding="utf-8")


def test_newer_snapshot_isolated_to_reference_and_preserves_provenance(tmp_path):
    old_store, *_ = store(135)
    current_store, *_ = store(146)
    raw = build(old_store)
    snapshot = build(current_store)
    write_snapshot(tmp_path, snapshot_wrapper(snapshot))
    warnings = []
    result = ref.build_for_data_dir(old_store, warnings.append, tmp_path)
    assert result["windows"] == snapshot["windows"] and result["windows"] != raw["windows"]
    assert result["source_snapshot"] == snapshot_wrapper(snapshot)["source"]
    assert not warnings and not gate(result)
    # Snapshot validation must not mutate gate-global state or its input block.
    assert "source_snapshot" not in snapshot and "source_snapshot" not in raw
    check_output._errors[:] = ["sentinel"]
    ref.prefer_snapshot(raw, tmp_path, warnings.append)
    assert check_output._errors == ["sentinel"]
    check_output._errors.clear()


@pytest.mark.parametrize("raw_n", [146, 150])
def test_equal_or_newer_raw_wins_over_snapshot(tmp_path, raw_n):
    raw_store, *_ = store(raw_n)
    snapshot_store, *_ = store(146)
    write_snapshot(tmp_path, snapshot_wrapper(build(snapshot_store)))
    raw = build(raw_store)
    result = ref.prefer_snapshot(raw, tmp_path, lambda _: None)
    assert result is raw and "source_snapshot" not in result


def test_snapshot_can_supply_missing_raw_and_missing_file_is_noop(tmp_path):
    empty = build({})
    assert ref.prefer_snapshot(empty, tmp_path, lambda _: None) is empty
    source, *_ = store()
    write_snapshot(tmp_path, snapshot_wrapper(build(source)))
    result = ref.build_for_data_dir({}, lambda _: None, tmp_path)
    assert result["active"] and result["source_snapshot"]["name"] == "data_git/data_bb.xlsx"


@pytest.mark.parametrize("mutation", [
    lambda w: w.update(raw_prices=[100]),
    lambda w: w["source"].update(path="../../other-project/data.xlsx"),
    lambda w: w["source"].update(name="other-project/data.xlsx"),
    lambda w: w["source"].update(sha256="bad"),
    lambda w: w["source"].update(modified_at="not-a-date"),
    lambda w: w["reference"]["assets"][1].update(source="info:other"),
    lambda w: w["reference"]["assets"][1].update(currency="KRW"),
    lambda w: w["reference"].update(annualization=252),
    lambda w: w["reference"]["windows"][0].update(raw_returns=[.1]),
    lambda w: w["reference"].update(source_snapshot={}),
    lambda w: w["reference"].update(unavailable_windows=[0.01, 0.02]),
    lambda w: w["reference"].update(defaults=["y10"]),
    lambda w: w["reference"]["windows"][0].update(key=["y1"]),
    lambda w: w["reference"]["windows"][0]["mean_pct"].__setitem__(0, 10 ** 1000),
])
def test_invalid_snapshot_warns_and_retains_raw(tmp_path, mutation):
    source, *_ = store()
    wrapper = snapshot_wrapper(build(source))
    mutation(wrapper)
    write_snapshot(tmp_path, wrapper)
    raw = build({})
    warnings = []
    assert ref.prefer_snapshot(raw, tmp_path, warnings.append) is raw
    assert len(warnings) == 1 and ref.SNAPSHOT_FILE in warnings[0]


def test_snapshot_never_follows_symlink_outside_data_dir(tmp_path):
    source, *_ = store()
    outside = tmp_path / "elsewhere.json"
    outside.write_text(json.dumps(snapshot_wrapper(build(source))), encoding="utf-8")
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / ref.SNAPSHOT_FILE).symlink_to(outside)
    raw = build({})
    warnings = []
    assert ref.prefer_snapshot(raw, data_dir, warnings.append) is raw
    assert warnings
