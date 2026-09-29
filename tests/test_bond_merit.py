"""국채 메리트의 부호·동일일 관측·주간 날짜·게시 연결을 합성자료로 검사한다."""

import calendar

import numpy as np
import pandas as pd
import pytest

import hedge


def source(currency="JPY"):
    dates = pd.to_datetime(["2030-01-07", "2030-01-11", "2030-01-14", "2030-01-16"])
    return {
        f"info:{currency}10y": pd.Series([1., 2., 3., 4.], index=dates),
        "info:한국_10y": pd.Series([3., 3., 3., 3.], index=dates),
        f"info:{currency}KRW_HP_3M": pd.Series([0.4, 0.5, -0.2, -0.6], index=dates),
    }


@pytest.mark.parametrize("currency,label", [("JPY", "일본 국채"), ("AUD", "호주 국채")])
def test_merit_uses_signed_same_currency_carry_and_actual_observation_dates(currency, label):
    S = source(currency)
    other = "AUD" if currency == "JPY" else "JPY"
    S.update({k: v * 10 for k, v in source(other).items() if k != "info:한국_10y"})
    m = hedge.build_bond_merit(S, currency, label)
    assert m["active"]
    assert m["foreign"] == [2., 4.]
    assert m["cost"] == [0.5, -0.6]
    assert m["hedged"] == [2.5, 3.4]
    assert m["spread"] == [-0.5, 0.4]
    assert m["asof"] == "2030-01-16"  # Wednesday, not the unobserved Friday Jan 18.
    assert m["t"] == [calendar.timegm(pd.Timestamp(d).timetuple())
                      for d in ("2030-01-11", "2030-01-16")]
    assert m["n_weeks"] == 2
    assert m["now"]["spread_pctile"] == 100.
    for key in ("foreign", "ktb", "cost", "hedged", "spread"):
        assert m["now"][key] == m[key][-1]
    assert m["sources"]["cost"] == f"info:{currency}KRW_HP_3M"
    assert m["series"]["foreign"] == f"{label} 10년"


def test_merit_drops_incomplete_dates_before_weekly_selection_without_filling():
    S = source()
    S["info:JPYKRW_HP_3M"].iloc[-1] = np.nan
    S["info:한국_10y"].iloc[-2] = np.inf
    original = {key: value.copy() for key, value in S.items()}
    m = hedge.build_bond_merit(S, "JPY", "일본 국채")
    assert m["asof"] == "2030-01-11"
    assert m["n_weeks"] == 1
    assert m["now"]["hedged"] == 2.5
    assert m["now"]["spread"] == -0.5
    for key in S:
        pd.testing.assert_series_equal(S[key], original[key])


@pytest.mark.parametrize("case", ["missing", "empty", "nonfinite", "disjoint"])
def test_merit_returns_inactive_with_reason_when_common_observation_is_unavailable(case):
    S = source()
    if case == "missing":
        del S["info:JPYKRW_HP_3M"]
    elif case == "empty":
        S["info:JPY10y"] = pd.Series(dtype=float, index=pd.DatetimeIndex([]))
    elif case == "nonfinite":
        S["info:JPY10y"][:] = np.inf
    else:
        S["info:JPY10y"].index += pd.Timedelta(days=100)
    m = hedge.build_bond_merit(S, "JPY", "일본 국채")
    assert m["active"] is False and m["reason"]


def test_hedge_build_wires_japanese_and_australian_merits_without_cross_currency_mix(parsed):
    _, p = parsed
    dates = p.SERIES["info:한국_10y"]["s"].dropna().index[-4:]
    for currency in ("JPY", "AUD"):
        for key, values in source(currency).items():
            if key == "info:한국_10y":
                continue
            if currency == "AUD" and key.endswith("10y"):
                values = values + 1
            values.index = dates
            p.SERIES[key] = {"s": values}
    p.SERIES["info:한국_10y"]["s"].loc[dates] = 3.
    m = hedge.build(p.SERIES, lambda _message: None)
    assert m["jgb_merit"]["now"]["hedged"] == 3.4
    assert m["agb_merit"]["now"]["hedged"] == 4.4
    assert m["jgb_merit"]["now"]["spread"] == 0.4
    assert m["agb_merit"]["now"]["spread"] == 1.4
