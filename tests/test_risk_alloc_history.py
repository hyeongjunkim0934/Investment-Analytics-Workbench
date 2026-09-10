# -*- coding: utf-8 -*-
"""배분 경로의 시의성 계약 — 완료 주간 + 실제 기준일의 최신 위험 점수."""

import math

import pandas as pd
import pytest

import risk


def _dates(payload):
    return pd.to_datetime(payload["t"], unit="s")


def test_weekday_snapshot_replaces_future_friday_without_interpolation():
    # 화요일까지의 자료를 W-FRI로 묶으면 미래 금요일 9/11 버킷이 만들어진다.
    weekly = pd.Series([21.2, 34.5, 76.7], index=pd.to_datetime(
        ["2026-08-28", "2026-09-04", "2026-09-11"]))
    original = weekly.copy()
    result = risk.pack_alloc_history(weekly, pd.Timestamp("2026-09-08"), 50.4)

    assert _dates(result).strftime("%Y-%m-%d").tolist() == [
        "2026-08-28", "2026-09-04", "2026-09-08"]
    assert result["v"] == [21.2, 34.5, 50.4]
    assert result["frequency"] == "weekly+latest"
    assert result["asof"] == "2026-09-08"
    pd.testing.assert_series_equal(weekly, original)


def test_friday_snapshot_matches_header_without_duplicate_timestamp():
    weekly = pd.Series([31.0, 42.0], index=pd.to_datetime(
        ["2026-08-28", "2026-09-04"]))
    result = risk.pack_alloc_history(weekly, pd.Timestamp("2026-09-04"), 42.8)

    assert len(result["t"]) == len(set(result["t"])) == 2
    assert result["v"] == [31.0, 42.8]
    assert _dates(result)[-1] == pd.Timestamp("2026-09-04")


def test_full_weekly_history_is_retained_beyond_the_recent_risk_window():
    dates = pd.date_range("2018-01-05", "2026-09-11", freq="W-FRI")
    weekly = pd.Series([float(i % 101) for i in range(len(dates))], index=dates)
    asof = pd.Timestamp("2026-09-08")
    result = risk.pack_alloc_history(weekly, asof, 46.3)
    eligible = weekly.loc[weekly.index <= asof]

    assert len(result["t"]) == len(eligible) + 1 > risk.HIST_WEEKS
    assert len(result["t"]) > 4 * len(eligible.resample("ME").last())
    assert result["v"][:-1] == eligible.tolist()
    assert _dates(result)[0] == dates[0]
    assert (_dates(result) <= asof).all()


@pytest.mark.parametrize("current", [None, math.nan, math.inf])
def test_missing_current_score_does_not_invent_a_latest_snapshot(current):
    weekly = pd.Series([20.0, 70.0], index=pd.to_datetime(
        ["2026-09-04", "2026-09-11"]))
    result = risk.pack_alloc_history(weekly, pd.Timestamp("2026-09-08"), current)

    assert _dates(result).strftime("%Y-%m-%d").tolist() == ["2026-09-04"]
    assert result["v"] == [20.0]


def test_empty_history_keeps_only_a_valid_latest_snapshot():
    weekly = pd.Series(dtype=float, index=pd.DatetimeIndex([]))
    result = risk.pack_alloc_history(weekly, pd.Timestamp("2026-09-08"), 46.3)
    assert _dates(result).strftime("%Y-%m-%d").tolist() == ["2026-09-08"]
    assert result["v"] == [46.3]
