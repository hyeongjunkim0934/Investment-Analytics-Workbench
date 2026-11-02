"""Model C ES arithmetic checked against an independent variational definition."""

import copy
import json

import numpy as np
import pandas as pd
import pytest

import common
import hedge
import hedge_tail


def variational_es(losses, confidence=.95):
    """min_z z + E[(L-z)+]/(1-alpha), evaluated at every loss breakpoint."""
    values = list(map(float, losses))
    return min(z + sum(max(loss - z, 0) for loss in values)
               / (len(values) * (1 - confidence)) for z in values)


def shocks(n=137):
    k = np.arange(n)
    return pd.DataFrame({"bond": .008 * np.cos(k * 1.13),
                         "fx": .012 * np.sin(k * .73)},
                        index=pd.date_range("2010-01-31", periods=n, freq="ME"))


def build(frame, yield_pct=3., carry_pct=-2.):
    asof = (frame.index[-1] + pd.offsets.MonthEnd(1)).strftime("%Y-%m-%d")
    return hedge_tail.build_tail_risk(frame, yield_pct=yield_pct,
                                      carry_pct=carry_pct, asof=asof)


@pytest.mark.parametrize("losses,confidence", [
    ([1., 1., 1., 2., 2., 9.], .75),
    ([-7., -5., -4., -1.], .95),
    (list(range(137)), .95),
    ([0., 4., 9.], 0.),
    ([1., 1., 1., 1.], .95),
])
def test_fractional_tail_es_matches_independent_variational_identity(losses, confidence):
    assert hedge_tail.expected_shortfall(losses, confidence) == pytest.approx(
        variational_es(losses, confidence), abs=1e-11)


def test_grid_matches_direct_variational_loss_and_preserves_input():
    frame = shocks()
    before = frame.copy(deep=True)
    out = build(frame)
    assert out["active"] and out["unit"] == "monthly_loss_pct"
    assert out["horizon_months"] == 1 and out["confidence"] == .95
    assert out["full"]["tail_mass"] == pytest.approx(6.85)
    assert out["recent"]["tail_mass"] == 6
    assert len(out["grid"]) == 101
    for h in [0, 17, 50, 100]:
        row = out["grid"][h]
        for window, values in [("full", frame), ("recent", frame.iloc[-120:])]:
            b = list(values["bond"])
            f = list(values["fx"])
            bmean, fmean = sum(b) / len(b), sum(f) / len(f)
            loss = [-(3 - (h / 100) * 2) / 12
                    - ((bv - bmean) + (1 - h / 100) * (fv - fmean)) * 100
                    for bv, fv in zip(b, f)]
            assert row[f"{window}_es_pct"] == pytest.approx(variational_es(loss))
        assert row["robust_es_pct"] == max(row["full_es_pct"], row["recent_es_pct"])
    pd.testing.assert_frame_equal(frame, before)
    json.dumps(out, allow_nan=False)


def test_cash_translation_carry_sign_monthly_units_and_negative_es():
    frame = shocks()
    baseline = build(frame, yield_pct=0, carry_pct=0)
    positive_carry = build(frame, yield_pct=12, carry_pct=12)
    for h in [0, 50, 100]:
        assert positive_carry["grid"][h]["robust_es_pct"] == pytest.approx(
            baseline["grid"][h]["robust_es_pct"] - 1 - h / 100)
    flat = frame * 0
    out = build(flat, yield_pct=12, carry_pct=0)
    assert all(row["robust_es_pct"] == pytest.approx(-1) for row in out["grid"])


def test_same_covariance_does_not_imply_same_tail_loss():
    frame = shocks(120) * 0
    symmetric = np.tile([-1., 1.], 60)
    skewed = np.r_[-119., np.ones(119)]
    symmetric = symmetric / symmetric.std(ddof=1) * .01
    skewed = (skewed - skewed.mean()) / skewed.std(ddof=1) * .01
    frame["fx"] = symmetric
    other = frame.copy()
    other["fx"] = skewed
    assert np.allclose(frame.cov(), other.cov())
    a, b = build(frame, 0, 0), build(other, 0, 0)
    assert b["grid"][0]["robust_es_pct"] > a["grid"][0]["robust_es_pct"] * 1.5
    assert a["grid"][100]["robust_es_pct"] == b["grid"][100]["robust_es_pct"] == 0


def test_tail_outlier_is_retained_and_recent_window_is_centered_separately():
    frame = shocks(241) * 0
    frame.iloc[0, 1] = -.4
    # The older crisis remains in full-history ES, even though recent is flat.
    out = build(frame, 0, 0)
    assert out["grid"][0]["full_es_pct"] > 0
    assert out["grid"][0]["recent_es_pct"] == 0
    assert out["grid"][0]["robust_es_pct"] == out["grid"][0]["full_es_pct"]
    shifted = frame.copy()
    shifted.iloc[-120:, :] += [.1, -.2]
    changed = build(shifted, 0, 0)
    assert changed["grid"][0]["recent_es_pct"] == pytest.approx(0, abs=1e-12)


def test_retained_observation_window_reports_missing_calendar_months():
    frame = shocks(135).drop(shocks(135).index[[20, 40, 60]])
    out = build(frame)
    assert out["active"] and out["recent"]["n_months"] == 120
    assert out["full"]["calendar_span_months"] == 135
    assert out["full"]["excluded_months"] == 3
    assert out["recent"]["calendar_span_months"] == 123
    assert out["recent"]["excluded_months"] == 3


@pytest.mark.parametrize("change", ["short", "nan", "duplicate", "same_month", "unsorted", "future"])
def test_invalid_or_insufficient_sample_is_inactive(change):
    frame = shocks()
    asof = "2022-01-31"
    if change == "short":
        frame = frame.iloc[:119]
    elif change == "nan":
        frame.iloc[0, 0] = np.nan
    elif change == "duplicate":
        frame = pd.concat([frame, frame.iloc[-1:]])
    elif change == "same_month":
        frame = pd.concat([frame, frame.iloc[-1:].rename(index=lambda x: x + pd.Timedelta(days=1))])
        # Last observation lands in the next month; insert another in that month.
        frame = pd.concat([frame, frame.iloc[-1:].rename(index=lambda x: x + pd.Timedelta(days=1))])
    elif change == "unsorted":
        frame = frame.iloc[::-1]
    else:
        asof = frame.index[-1].strftime("%Y-%m-%d")
    out = hedge_tail.build_tail_risk(frame, yield_pct=3, carry_pct=-2, asof=asof)
    assert not out["active"] and out["reason"] and out["grid"] == []


def source_series(n=150):
    dates = pd.date_range("2010-01-29", periods=n + 1, freq="BME")
    k = np.arange(n + 1)
    sources = {"info:UST10y": pd.Series(3 + .1 * np.sin(k * .7), index=dates),
               "bb:달러원": pd.Series(1000 * np.exp(.03 * np.sin(k * .43)), index=dates)}
    for tenor in common.HP_TENORS:
        sources[f"info:USDKRW_HP_{tenor}"] = pd.Series(-2., index=dates)
    return sources, dates


def test_parent_hook_preserves_covariance_and_excludes_anchor_and_future_fx():
    sources, dates = source_series()
    before = copy.deepcopy(sources)
    result = hedge.build_bond_outlook(sources, "UST")
    tail = result["tail_risk"]
    assert result["active"] and tail["active"]
    assert tail["full"]["n_months"] == result["sample"]["n_months"]
    assert tail["full"]["start"] == result["sample"]["start"]
    assert tail["full"]["end"] == result["sample"]["end"]
    changed = copy.deepcopy(sources)
    changed["bb:달러원"].iloc[-1] *= 1.02
    future = dates[-1] + pd.offsets.MonthEnd(2)
    changed["bb:달러원"].loc[future] = 9000
    alternate = hedge.build_bond_outlook(changed, "UST")
    assert alternate["tail_risk"] == tail
    assert alternate["risk"] == result["risk"]
    for key in sources:
        pd.testing.assert_series_equal(sources[key], before[key])


def test_short_tail_sample_does_not_disable_legacy_outlook():
    sources, _ = source_series(80)
    result = hedge.build_bond_outlook(sources, "UST")
    assert result["active"] and not result["tail_risk"]["active"]
    assert "120" in result["tail_risk"]["reason"]


def test_only_aggregate_curves_are_published():
    result = build(shocks())
    serialized = json.dumps(result, allow_nan=False)
    for forbidden in ['"bond":', '"fx":', '"returns":', '"levels":', '"losses":', '"shocks":']:
        assert forbidden not in serialized
    assert result["oos_validated"] is False
    assert result["calibrated_prediction_interval"] is False
