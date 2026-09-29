# -*- coding: utf-8 -*-
"""관측시점·DXY 단일 출처·직전 관측 표시 회귀. 실제 벤더 값은 사용하지 않는다."""

import json
import shutil
import subprocess
from pathlib import Path

import pandas as pd
import pytest

import process


@pytest.fixture(scope="module")
def freshness_probe():
    node = shutil.which("node")
    assert node, "실제 app.js 동작 확인에 node가 필요합니다"
    result = subprocess.run(
        [node, str(Path(__file__).with_name("data_freshness_probe.js"))],
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr[-4000:]
    return json.loads(result.stdout)


@pytest.mark.parametrize("case,days,check,text", [
    ("same", 0, False, "오늘 관측"),
    ("four", 4, False, "4일 경과"),
    ("five", 5, True, "5일 경과"),
    ("future", -1, True, "관측일 확인"),
    ("missing", None, True, "관측일 확인"),
    ("invalid", None, True, "관측일 확인"),
    ("invalidLeap", None, True, "관측일 확인"),
    ("validLeap", 1, False, "1일 경과"),
    ("invalidToday", None, True, "관측일 확인"),
    ("malformed", None, True, "관측일 확인"),
])
def test_observation_age_checks_real_calendar_days(freshness_probe, case, days, check, text):
    assert freshness_probe["ages"][case] == {"days": days, "check": check, "text": text}


def test_kst_day_rolls_at_1500_utc_including_new_year(freshness_probe):
    assert freshness_probe["kst"] == ["2026-09-08", "2026-09-09", "2027-01-01"]


def test_individual_freshness_uses_card_date_even_without_meta_or_banner(freshness_probe):
    assert freshness_probe["oldBuildBadges"] == freshness_probe["badges"]
    assert freshness_probe["missingMetaBadges"] == freshness_probe["badges"]
    assert freshness_probe["bannerAfterMeta"] is False


def test_route_and_visible_return_refresh_badges_without_banner(freshness_probe):
    assert freshness_probe["beforeRoute"] == [
        {"text": "4일 경과", "check": False, "date": "2026-09-05"}]
    after = freshness_probe["afterRoute"]
    assert after == [{"text": "5일 경과", "check": True, "date": "2026-09-05"}]
    assert freshness_probe["whileHidden"] == after
    assert freshness_probe["afterVisible"] == [
        {"text": "6일 경과", "check": True, "date": "2026-09-05"}]


def test_each_card_badge_updates_across_day_boundary(freshness_probe):
    badges = freshness_probe["badges"]
    assert [x["check"] for x in badges] == [False, False, True, True, True, True]
    assert [x["text"] for x in badges[:3]] == ["오늘 관측", "4일 경과", "5일 경과"]
    assert badges[3]["date"] == ""
    next_day = freshness_probe["nextDayBadges"]
    assert next_day[0] == {"text": "1일 경과", "check": False, "date": "2026-09-09"}
    assert next_day[1] == {"text": "5일 경과", "check": True, "date": "2026-09-05"}
    assert next_day[4] == {"text": "오늘 관측", "check": False, "date": "2026-09-10"}


def test_overview_and_detail_preserve_numeric_change_and_disclose_gap(freshness_probe):
    gap, consecutive, single, legacy = freshness_probe["overview"]
    assert "직전 관측" in gap["delta"] and "▲ 17.90%" in gap["delta"]
    assert gap["period"] == "2026-08-20 → 2026-09-01"
    assert "Infomax" in gap["source"]
    assert "1일" in consecutive["delta"] and consecutive["period"] is None
    assert "직전 관측" in single["delta"] and "17.90" not in single["delta"]
    assert single["period"] is None
    assert "직전 관측" in legacy["delta"]
    detail = freshness_probe["detail"]
    assert "직전 관측" in detail["delta"] and "▲ 17.90%" in detail["delta"]
    assert detail["period"] == gap["period"]


def test_global_freshness_banner_and_its_layout_space_are_removed(freshness_probe):
    root = Path(__file__).resolve().parents[1]
    html = (root / "dashboard" / "index.html").read_text(encoding="utf-8")
    css = (root / "dashboard" / "style.css").read_text(encoding="utf-8")
    assert 'id="data-freshness"' not in html
    assert ".data-freshness" not in css
    assert freshness_probe["routeBanners"] == [
        {"hash": route, "present": False}
        for route in ("#alloc", "#alloc-sim", "#alloc-boot", "#hedge", "#catalog", "#overview")
    ]


def _add(key, dates, values):
    source, name = key.split(":", 1)
    process.add_series(key, source, "합성", name,
                       list(zip(pd.to_datetime(dates), values)))


def test_overview_and_fx_share_canonical_dxy_even_when_bb_is_newer():
    _add("info:DXY", ["2026-09-07", "2026-09-08"], [97.25, 98.50])
    _add("bb:달러지수", ["2026-09-08", "2026-09-09"], [199.8, 200.0])
    overview = process.build_overview()
    cards = [c for c in overview["cards"] if "DXY" in c["label"]]
    assert len(cards) == 1 and cards[0]["key"] == "info:DXY"
    card = cards[0]
    fx = [s for s in process.build_fx()["ts"] if s["key"] == "info:DXY"]
    assert len(fx) == 1
    assert card["source"] == "info" and card["value"] == fx[0]["v"][-1] == 98.50
    fx_date = pd.Timestamp(fx[0]["t"][-1], unit="s").strftime("%Y-%m-%d")
    assert card["date"] == fx_date == "2026-09-08"
    assert card["chg"]["d1"] == pytest.approx(round((98.5 / 97.25 - 1) * 100, 2))


def test_missing_canonical_dxy_does_not_silently_use_bloomberg():
    _add("bb:달러지수", ["2026-09-08", "2026-09-09"], [199.8, 200.0])
    overview, fx = process.build_overview(), process.build_fx()
    assert not [c for c in overview["cards"] if "DXY" in c["label"]]
    assert not [s for s in fx["ts"] if s["key"] in ("info:DXY", "bb:달러지수")]
    assert any("series not found: info:DXY" in message for message in process.WARNINGS)


@pytest.mark.parametrize("dates,label,previous,expected", [
    (["2026-08-20", "2026-09-01"], "직전 관측", "2026-08-20", 17.9),
    (["2026-07-03", "2026-07-06"], "1일", "2026-07-03", 17.9),
    (["2026-07-03", "2026-07-07"], "직전 관측", "2026-07-03", 17.9),
    (["2026-07-06"], "직전 관측", None, None),
])
@pytest.mark.parametrize("kind", ["overview", "acwi"])
def test_previous_observation_metadata_does_not_change_return(dates, label, previous, expected, kind):
    values = [100.0, 117.9] if len(dates) > 1 else [117.9]
    _add("info:DXY" if kind == "overview" else "idx:ACWI", dates, values)
    if kind == "overview":
        row = process.build_overview()["cards"][0]
    else:
        row = process.build_acwi()["stats"]
    assert row["d1_label"] == label
    assert row["previous_date"] == previous
    if expected is None:
        assert row["chg"]["d1"] is None
    else:
        assert row["chg"]["d1"] == pytest.approx(expected)
