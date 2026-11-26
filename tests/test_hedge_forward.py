"""Forward rate differential + constant basis: arithmetic checked against independent closed forms."""
import copy
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
import check_output
import common
import hedge_cip
import hedge_forward as model


def _series(days, kr, us, premium=None):
    """kr/us: {years: [daily values]}; premium: one level for all three HP tenors."""
    index = pd.DatetimeIndex(days)
    out = {}
    for years, kr_key, us_key in model.NODES:
        out[kr_key] = pd.Series(kr[years], index=index, dtype=float)
        out[us_key] = pd.Series(us[years], index=index, dtype=float)
    if premium is not None:
        for key in hedge_cip.PREMIUM_SOURCES.values():
            out[key] = pd.Series(premium, index=index, dtype=float)
    return out


def _flat(days, kr, us, premium=None):
    n = len(days)
    return _series(days, {y: [v] * n for y, v in kr.items()}, {y: [v] * n for y, v in us.items()},
                   None if premium is None else [premium] * n)


DAYS = pd.bdate_range("2030-06-03", periods=10)
KR = {1: 3.0, 2: 3.5, 3: 3.6, 5: 3.9, 10: 4.2}
US = {1: 4.0, 2: 4.1, 3: 4.3, 5: 4.4, 10: 4.9}


def _errors(block):
    check_output._errors.clear()
    check_output._check_hedge_forward(block)
    return list(check_output._errors)


def test_forward_rate_matches_compounding_identity_and_flat_curve():
    # Investing 1y at 3% then at the forward must equal investing 2y at 3.5%.
    f = model.forward_rate(3.0, 3.5, 1, 2)
    assert math.isclose(1.03 * (1 + f / 100), 1.035 ** 2, rel_tol=1e-12)
    # Multi-year segment: 3y at 3.6% then 2 years at the forward equals 5y at 3.9%.
    g = model.forward_rate(3.6, 3.9, 3, 5)
    assert math.isclose(1.036 ** 3 * (1 + g / 100) ** 2, 1.039 ** 5, rel_tol=1e-12)
    assert math.isclose(model.forward_rate(4.0, 4.0, 2, 3), 4.0, abs_tol=1e-12)     # flat curve -> same rate
    assert model.forward_rate(None, 2.5, 0, 1) == 2.5                               # spot segment is the yield
    assert math.isclose(model.forward_rate(-0.5, -0.2, 1, 2), ((0.998 ** 2 / 0.995) - 1) * 100, rel_tol=1e-12)


def test_current_path_is_differential_plus_todays_gap_and_starts_at_todays_premium():
    out = model.build(_flat(DAYS, KR, US, premium=-1.3))
    assert out["active"] and out["asof"] == str(DAYS[-1].date()) and not _errors(out)
    cur = out["current"]
    assert math.isclose(cur["premium"], -1.3) and math.isclose(cur["spread_1y"], -1.0)
    assert math.isclose(cur["gap"], -0.3) and math.isclose(cur["gap_bp"], -30.0)
    assert [s["years"] for s in out["segments"]] == [[0, 1], [1, 2], [2, 3], [3, 5], [5, 10]]
    first = out["segments"][0]
    assert math.isclose(first["implied_premium"], -1.3) and first["change_vs_now"] == 0
    for seg in out["segments"]:
        a, b = seg["years"]
        kr = KR[b] if a == 0 else ((1 + KR[b] / 100) ** b / (1 + KR[a] / 100) ** a) ** (1 / (b - a)) * 100 - 100
        us = US[b] if a == 0 else ((1 + US[b] / 100) ** b / (1 + US[a] / 100) ** a) ** (1 / (b - a)) * 100 - 100
        assert math.isclose(seg["kr"], kr, rel_tol=1e-10) and math.isclose(seg["us"], us, rel_tol=1e-10)
        assert math.isclose(seg["implied_premium"], kr - us - 0.3, rel_tol=1e-10)
        assert math.isclose(seg["change_vs_now"], kr - us + 1.0, abs_tol=1e-10)
    # Adding the same amount to the premium moves every implied value by exactly that amount.
    shifted = model.build(_flat(DAYS, KR, US, premium=-0.8))
    for a, b in zip(out["segments"], shifted["segments"]):
        assert math.isclose(b["implied_premium"] - a["implied_premium"], 0.5, abs_tol=1e-10)
        assert b["diff"] == a["diff"]


def test_only_dates_with_every_input_are_used_and_nothing_is_carried_forward():
    series = _flat(DAYS, KR, US, premium=-1.0)
    # The newest day lacks one Korean yield: the path must stop at the previous day.
    key = model.NODES[2][1]
    series[key] = series[key].iloc[:-1]
    out = model.build(series)
    assert out["active"] and out["asof"] == str(DAYS[-2].date())
    # A weekend quote and a non-finite value are not observations.
    series = _flat(DAYS, KR, US, premium=-1.0)
    weekend = pd.Timestamp("2030-06-15")
    for name in list(series):
        series[name] = pd.concat([series[name], pd.Series([99.0], index=[weekend])])
    series[model.NODES[0][2]].iloc[-2] = float("nan")
    out = model.build(series)
    assert out["asof"] == str(DAYS[-2].date())
    assert all(abs(v) < 5 for s in out["history"]["segments"] for v in s["diff"])


def test_missing_inputs_are_explicitly_inactive_with_the_reason():
    assert model.build({})["active"] is False and "유효 원천 관측 없음" in model.build({})["reason"]
    series = _flat(DAYS, KR, US, premium=-1.0)
    del series[model.NODES[4][2]]
    out = model.build(series)
    assert not out["active"] and model.NODES[4][2] in out["reason"] and not _errors(out)
    # Yields without any hedge quote: history and track record still publish, the path does not.
    no_hp = model.build(_flat(DAYS, KR, US))
    assert not no_hp["active"] and "HP" in no_hp["reason"] and no_hp["history"]["t"] and no_hp["segments"] == []
    assert not _errors(no_hp)
    # Disjoint dates between curve and quotes.
    series = _flat(DAYS, KR, US)
    late = pd.bdate_range("2031-01-06", periods=5)
    for hp in hedge_cip.PREMIUM_SOURCES.values():
        series[hp] = pd.Series([-1.0] * 5, index=late)
    assert "동일 날짜" in model.build(series)["reason"]


def _monthly(months, spread_path, forward_path):
    """Month-end data where KR 1y = spread, US = 0, and the 1-2y forward differential is chosen."""
    days = pd.DatetimeIndex([m.end_time.normalize() - pd.offsets.BDay(0) if m.end_time.dayofweek < 5
                             else pd.offsets.BMonthEnd().rollback(m.end_time.normalize()) for m in months])
    kr = {y: [] for y in (1, 2, 3, 5, 10)}
    for s, f in zip(spread_path, forward_path):
        y1 = s
        y2 = (math.sqrt((1 + y1 / 100) * (1 + f / 100)) - 1) * 100      # so the 1-2y forward equals f
        kr[1].append(y1); kr[2].append(y2)
        for y in (3, 5, 10):
            kr[y].append(y2)
    us = {y: [0.0] * len(days) for y in (1, 2, 3, 5, 10)}
    return _series(days, kr, us)


def test_backtest_metrics_match_hand_computation_and_calendar_month_keys():
    months = pd.period_range("2020-01", periods=40, freq="M")
    rng = np.random.default_rng(7)
    spread = rng.normal(0, 1, 40).round(3)
    forward = (spread + rng.normal(0, 0.5, 40)).round(3)
    out = model.build(_monthly(months, spread, forward))
    row = next(r for r in out["backtest"] if r["horizon_months"] == 12)
    # The latest month is treated as incomplete; origins need a realized value 12 months later.
    usable = 40 - 1
    n = usable - 12
    assert row["active"] and row["n"] == n
    assert row["first_origin"] == "2020-01" and row["last_origin"] == str(months[n - 1])
    f, now, real = forward[:n], spread[:n], spread[12:12 + n]
    assert math.isclose(row["rmse"], math.sqrt(np.mean((f - real) ** 2)), rel_tol=1e-9)
    assert math.isclose(row["rw_rmse"], math.sqrt(np.mean((now - real) ** 2)), rel_tol=1e-9)
    assert math.isclose(row["theil_u"], row["rmse"] / row["rw_rmse"], rel_tol=1e-12)
    assert math.isclose(row["bias"], float(np.mean(f - real)), rel_tol=1e-9, abs_tol=1e-12)
    judged = (np.sign(f - now) != 0) & (np.sign(real - now) != 0)
    assert row["hit_n"] == int(judged.sum())
    assert math.isclose(row["hit_rate"], float((np.sign(f - now)[judged] == np.sign(real - now)[judged]).mean()))
    # 24 months: 39 - 24 = 15 < 24 realized rows -> held back with the reason, no invented metric.
    two = next(r for r in out["backtest"] if r["horizon_months"] == 24)
    assert not two["active"] and two["n"] == 15 and "최소 24개" in two["reason"] and two["rmse"] is None


def test_backtest_perfect_forward_and_missing_month_are_handled_by_month_key_not_row_position():
    months = pd.period_range("2020-01", periods=50, freq="M")
    spread = np.linspace(-2, 2, 50).round(4)
    forward = np.append(spread[12:], [0.0] * 12)             # the forward equals what is realized 12 months later
    series = _monthly(months, spread, forward)
    row = next(r for r in model.build(series)["backtest"] if r["horizon_months"] == 12)
    assert row["rmse"] < 1e-9 and row["theil_u"] < 1e-9 and row["hit_rate"] == 1.0 and abs(row["bias"]) < 1e-9
    # Remove one month entirely: origins whose target month is missing drop out; nothing shifts by a row.
    drop = months[20].end_time.normalize()
    gone = {k: v[~((v.index.year == drop.year) & (v.index.month == drop.month))] for k, v in series.items()}
    again = next(r for r in model.build(gone)["backtest"] if r["horizon_months"] == 12)
    assert again["n"] == row["n"] - 2                                  # month 20 as origin and as target (origin 8)
    assert again["rmse"] < 1e-9


def test_history_is_weekly_last_actual_observation():
    days = pd.bdate_range("2030-06-03", periods=15)                     # three full weeks
    n = len(days)
    kr = {y: list(np.linspace(3, 3.14, n) + 0.1 * i) for i, y in enumerate((1, 2, 3, 5, 10))}
    us = {y: [4.0] * n for y in (1, 2, 3, 5, 10)}
    out = model.build(_series(days, kr, us, [-1.0] * n))
    assert out["history"]["t"] == common.epoch_seconds(pd.DatetimeIndex(["2030-06-07", "2030-06-14", "2030-06-21"]))
    spot = next(s for s in out["history"]["segments"] if s["years"] == [0, 1])
    assert np.allclose(spot["diff"], [kr[1][4] - 4, kr[1][9] - 4, kr[1][14] - 4])
    assert all(len(s["diff"]) == 3 for s in out["history"]["segments"])


@pytest.mark.parametrize("mutate", [
    lambda b: b.update(schema="other"),
    lambda b: b.update(currency="JPY"),
    lambda b: b["method"].update(forecast_skill_claimed=True),
    lambda b: b["current"].update(gap=b["current"]["gap"] + 0.01),
    lambda b: b["current"].update(gap_bp=1.0),
    lambda b: b["segments"][1].update(diff=b["segments"][1]["diff"] + 0.01),
    lambda b: b["segments"][2].update(implied_premium=0.0),
    lambda b: b["segments"][0].update(kr=9.0),
    lambda b: b["segments"][1].update(years=[2, 3]),
    lambda b: b["segments"][3].update(us=float("nan")),
    lambda b: b.update(segments=[]),
    lambda b: b.update(asof="2000-01-01"),
    lambda b: b["history"]["segments"][0]["diff"].pop(),
    lambda b: b["history"].update(t=list(reversed(b["history"]["t"]))),
    lambda b: b.update(backtest="none"),
    lambda b: b["backtest"][0].update(active=True, rmse=1.0, rw_rmse=2.0, theil_u=0.9, bias=0.0, hit_rate=0.5, hit_n=1, n=5),
    lambda b: b["backtest"][0].update(active=True, rmse=1.0, rw_rmse=2.0, theil_u=0.5, bias=0.0, hit_rate=1.5, hit_n=1, n=5),
    lambda b: b["backtest"][0].update(active=True, rmse=1.0, rw_rmse=2.0, theil_u=0.5, bias=0.0, hit_rate=0.5, hit_n=9, n=5),
    lambda b: b["backtest"][0].update(reason=None),
    lambda b: b.update(active=False, reason=None),
])
def test_gate_rejects_broken_blocks(mutate):
    block = model.build(_flat(DAYS, KR, US, premium=-1.3))
    assert not _errors(block)
    broken = copy.deepcopy(block)
    mutate(broken)
    assert _errors(broken)


def test_hedge_payload_keeps_publishing_when_the_forward_block_fails(monkeypatch):
    import hedge
    warnings = []
    monkeypatch.setattr(hedge.hedge_forward, "build", lambda series: (_ for _ in ()).throw(RuntimeError("secret 1234.5")))
    block = hedge._forward({}, warnings.append)
    assert block["active"] is False and block["reason"] and not _errors(block)
    assert len(warnings) == 1 and "RuntimeError" in warnings[0] and "1234.5" not in warnings[0]


def test_path_stops_where_hedge_quotes_stop_and_never_reuses_an_older_quote():
    n = len(DAYS)
    kr = {y: list(v + 0.01 * np.arange(n)) for y, v in KR.items()}          # yields move every day
    us = {y: [v] * n for y, v in US.items()}
    series = _series(DAYS, kr, us, [-1.3] * n)
    for hp in hedge_cip.PREMIUM_SOURCES.values():
        series[hp] = series[hp].iloc[:-2]                                    # quotes end two days before yields
    out = model.build(series)
    assert out["asof"] == str(DAYS[-3].date())
    assert math.isclose(out["current"]["spread_1y"], kr[1][n - 3] - US[1], abs_tol=1e-12)
    assert math.isclose(out["segments"][0]["kr"], kr[1][n - 3], abs_tol=1e-12)
    # The yield history still runs to the latest yield date.
    assert out["history"]["t"][-1] == common.epoch_seconds(DAYS[-1:])[0]


def test_direction_hit_rate_leaves_out_calls_and_outcomes_with_no_direction():
    months = pd.period_range("2020-01", periods=40, freq="M")
    spread = np.array([0.0, 1.0] * 20)
    forward = spread.copy()
    forward[::3] += 0.5                       # every third origin calls a rise; the rest call "no change"
    row = next(r for r in model.build(_monthly(months, spread, forward))["backtest"] if r["horizon_months"] == 12)
    # Twelve months later the spread is identical (period 2), so no realized direction exists at all.
    assert row["n"] == 27 and row["hit_n"] == 0 and row["hit_rate"] is None
    assert not _errors({**model.skeleton(), "backtest": [row], "reason": "x"})
    # Shift the cycle so outcomes do move: only origins with a call are judged.
    spread = np.array([0.0, 0.0, 1.0, 2.0, 1.0] * 8).astype(float)       # period 5: twelve months later differs
    forward = spread.copy()
    forward[::2] += 0.5
    row = next(r for r in model.build(_monthly(months, spread, forward))["backtest"] if r["horizon_months"] == 12)
    f, now, real = forward[:27], spread[:27], spread[12:39]
    judged = (f != now) & (real != now)                     # exact in the fixture's own numbers
    assert 0 < row["hit_n"] == int(judged.sum()) < row["n"]
    assert math.isclose(row["hit_rate"], float((np.sign(f - now)[judged] == np.sign(real - now)[judged]).mean()))
