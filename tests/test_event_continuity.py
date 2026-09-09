# -*- coding: utf-8 -*-
"""이벤트 기간·표본 회귀. 값은 합성이고 기대 σ는 statistics로 계산한다."""

import json
import statistics

import numpy as np
import pandas as pd
import pytest

import common
import risk


def _empty():
    return pd.Series(dtype=float, index=pd.DatetimeIndex([]))


def _payload(s, *, rate=False, asof=None, extra_sources=None):
    names = ("usdkrw", "fxvol", "hy", "vix", "vkospi", "kospi", "acwi",
             "us_slope", "kr_slope", "sahm")
    d = {name: _empty() for name in names}
    sources = {"info:한국_10y": _empty(), "info:UST10y": _empty(),
               "bb:한국_CDS_5년물": _empty()}
    if rate:
        sources["info:UST10y"] = s
    else:
        d["kospi"] = s
    sources.update(extra_sources or {})
    return risk.detect_events(sources, pd.Timestamp(asof or s.index[-1]), d)


def _history(end, n=280, *, rate=False):
    dates = pd.bdate_range(end=end, periods=n)
    if rate:
        values = [2.0 + (0.005 if i % 2 else 0.0) for i in range(n)]
    else:
        values = [100.0 + (0.1 if i % 2 else 0.0) for i in range(n)]
    return pd.Series(values, index=dates)


def _append(s, date, value):
    return pd.concat([s, pd.Series([value], index=pd.DatetimeIndex([date]))])


def _on_date(payload, date):
    return [e for e in payload["events"] if e["date"] == date]


@pytest.mark.parametrize("previous,current,expected", [
    ("2026-07-02", "2026-07-03", True),
    ("2026-07-03", "2026-07-06", True),  # 금→월: 주말만 건너뜀
    ("2026-07-03", "2026-07-07", False), # 월요일 휴장인지 누락인지 확인 불가
    ("2026-07-02", "2026-07-06", False),
    ("2026-07-04", "2026-07-06", False),
    ("2026-07-03", "2026-07-04", False),
    ("2026-07-03", "2026-07-03", False),
    ("2026-07-06", "2026-07-03", False),
    (pd.NaT, "2026-07-03", False),
])
def test_weekday_continuity_definition(previous, current, expected):
    assert common.is_consecutive_weekday_observation(previous, current) == expected


def test_twelve_day_return_is_information_with_dates_and_period():
    s = _history("2026-08-20")
    s = _append(s, "2026-09-01", float(s.iloc[-1]) * 1.179)
    events = _on_date(_payload(s), "2026-09-01")
    assert len(events) == 1
    event = events[0]
    assert event["cat"] == "데이터" and event["sev"] == "정보"
    assert "직전 관측 대비" in event["title"] and "12일" in event["title"]
    assert event["value"] == "+17.9%"
    assert "2026-08-20" in event["rule"] and "2026-09-01" in event["rule"]
    assert "일간 σ 판정 제외" in event["rule"]


@pytest.mark.parametrize("previous,current,days", [
    ("2026-07-03", "2026-07-07", 4),
    ("2026-07-02", "2026-07-06", 4),
])
def test_unverified_weekday_closure_is_not_a_daily_jump(previous, current, days):
    s = _history(previous)
    s = _append(s, current, float(s.iloc[-1]) * 1.2)
    events = _on_date(_payload(s), current)
    assert len(events) == 1
    assert events[0]["sev"] == "정보"
    assert f"{days}일" in events[0]["title"]
    assert "공휴일" in events[0]["rule"] and "미확인" in events[0]["rule"]


@pytest.mark.parametrize("previous,current", [
    ("2026-07-02", "2026-07-03"),
    ("2026-07-03", "2026-07-06"),
])
@pytest.mark.parametrize("rate", [False, True])
def test_consecutive_weekday_and_weekend_jump_still_detected(previous, current, rate):
    s = _history(previous, rate=rate)
    value = float(s.iloc[-1]) + 0.1 if rate else float(s.iloc[-1]) * 1.179
    s = _append(s, current, value)
    events = _on_date(_payload(s, rate=rate), current)
    assert len(events) == 1
    assert events[0]["cat"] == "급변" and events[0]["sev"] == "경계"
    assert "일간 급등" in events[0]["title"]
    assert events[0]["value"] == ("+10.0bp" if rate else "+17.9%")


def test_gap_move_is_excluded_from_next_daily_sigma():
    s = _history("2026-08-20", rate=True)
    s = _append(s, "2026-09-01", float(s.iloc[-1]) + 1.0)
    s = _append(s, "2026-09-02", float(s.iloc[-1]) + 0.1)
    event = _on_date(_payload(s, rate=True), "2026-09-02")[0]
    # 1.0%p의 기간 변화는 빼고, 현재 +0.1%p를 포함한 일변화 250개.
    changes = [float(s.iloc[i] - s.iloc[i - 1]) for i in range(1, 280)] + [0.1]
    sigma = statistics.stdev(changes[-250:])
    assert event["cat"] == "급변" and event["sev"] == "경계"
    assert f"{0.1 / sigma:.1f}σ" in event["rule"]
    assert "250" in event["rule"]


def test_weekend_carry_forward_rows_do_not_change_sigma():
    s = _history("2026-07-03", rate=True)
    s = _append(s, "2026-07-06", float(s.iloc[-1]) + 0.1)
    with_weekends = s.reindex(pd.date_range(s.index[0], s.index[-1])).ffill()
    plain = _on_date(_payload(s, rate=True), "2026-07-06")
    carried = _on_date(_payload(with_weekends, rate=True), "2026-07-06")
    assert plain == carried


@pytest.mark.parametrize("missing", [np.nan, np.inf, -np.inf])
def test_invalid_weekday_observation_is_not_forward_filled(missing):
    s = _history("2026-07-02")
    previous = float(s.iloc[-1])
    s = _append(s, "2026-07-03", missing)
    s = _append(s, "2026-07-06", previous * 1.179)
    events = _on_date(_payload(s), "2026-07-06")
    assert len(events) == 1 and events[0]["sev"] == "정보"
    assert "4일" in events[0]["title"] and events[0]["value"] == "+17.9%"


def test_zero_price_denominator_is_information_not_infinite_jump():
    s = _history("2026-07-02")
    s = _append(s, "2026-07-03", 0.0)
    s = _append(s, "2026-07-06", 1.0)
    payload = _payload(s)
    events = _on_date(payload, "2026-07-06")
    assert len(events) == 1 and events[0]["sev"] == "정보"
    assert "계산 불가" in events[0]["value"]
    assert "직전 값 0" in events[0]["rule"]
    text = json.dumps(payload, ensure_ascii=False, allow_nan=False).lower()
    assert "nanσ" not in text and "infσ" not in text


def test_zero_rate_is_valid_for_bp_change():
    s = _history("2026-07-02", rate=True)
    s = _append(s, "2026-07-03", 0.0)
    s = _append(s, "2026-07-06", 1.0)
    events = _on_date(_payload(s, rate=True), "2026-07-06")
    assert len(events) == 1 and events[0]["cat"] == "급변"
    assert events[0]["value"] == "+100.0bp"


@pytest.mark.parametrize("n", [2, 40, 250])
def test_insufficient_sigma_history_never_emits_nan_sigma_event(n):
    s = _history("2026-07-06", n=n)
    s.iloc[-1] *= 1.179
    assert not [e for e in _payload(s)["events"] if e["cat"] == "급변"]


def test_zero_variance_does_not_emit_jump():
    s = _history("2026-07-06")
    s[:] = 100.0
    assert not [e for e in _payload(s)["events"] if e["cat"] == "급변"]


@pytest.mark.parametrize("gap,expected", [(4, False), (5, True), (14, True), (-1, False)])
def test_source_delay_sign_matches_five_day_boundary(gap, expected):
    asof = pd.Timestamp("2026-08-20")
    last = asof - pd.Timedelta(days=gap)
    source = pd.Series([1.0], index=pd.DatetimeIndex([last]))
    payload = _payload(_history(asof), asof=asof, extra_sources={"idx:test": source})
    delayed = [e for e in payload["events"] if "지수 파일 시계열" in e["title"]]
    assert bool(delayed) == expected
    if expected:
        assert f"{gap}일" in delayed[0]["title"]
        assert delayed[0]["rule"] == "기준일 − 최신 관측일 ≥ 5일"


def test_catalog_discloses_daily_sample_and_unverified_calendar():
    catalog = _payload(_history("2026-07-06"))["catalog"]
    rules = {row["cat"]: row["rule"] for row in catalog}
    assert "250" in rules["급변"] and "평일" in rules["급변"]
    assert "2.5σ" in rules["급변"] and "3.5σ" in rules["급변"]
    assert "공휴일" in rules["데이터"] and "일간 σ" in rules["데이터"]
