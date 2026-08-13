# -*- coding: utf-8 -*-
"""수익률 추정 데이터층 계약 (`pipeline/estimate.py`, §7.8).

이 모듈은 **수익률을 계산하지 않는다** — 계산은 전부 사용자 입력에 달려 있어 브라우저가
한다(그쪽은 `tests/test_dashboard_ux.py` 가 실행으로 본다). 여기서 지키는 것은 셋이다:

1. **연말 앵커가 축약 전 원본에서 나오는가.** YTD 의 분모라 여기가 어긋나면 그 해의
   모든 수익률이 함께 틀린다 — 그런데 값만 봐서는 알 수 없는 종류의 오류다.
2. **요청과 다른 계열을 조용히 내보내지 않는가.** ACWI 는 요청(TR)과 달리 가격지수(PR)
   이므로 `basis_matches_request:false` 로 나가야 하고, 미국채는 총수익 지수가 없으므로
   근사하지 말고 `unavailable` 로 부재를 밝혀야 한다.
3. **시리즈가 없어도 블록이 게시되는가.** 화면이 「왜 수기인가」와 연환산 규약을 적으려면
   `unavailable`/`annualize` 가 부재 상태에서도 있어야 한다(`bm.build_cma` 와 같은 규약).
"""

from __future__ import annotations

import json

import numpy as np
import pandas as pd

import estimate


def _store(**series):
    return {k: {"s": v} for k, v in series.items()}


def _daily(start: str, periods: int, lo: float = 100.0, hi: float = 200.0) -> pd.Series:
    idx = pd.date_range(start, periods=periods, freq="D")
    return pd.Series(np.linspace(lo, hi, periods), index=idx)


# --------------------------------------------------------------------------
# 연말 앵커 — YTD 의 분모
# --------------------------------------------------------------------------

def test_year_end_anchor_is_the_last_observation_of_each_year():
    """앵커는 12/31 이 아니라 **그 해 마지막 관측**이고, 날짜를 함께 실어야 한다.

    12/31 이 휴장이면 앵커는 12/30 이나 12/29 다. 값만 싣고 날짜를 빼면 화면이 어느 날을
    분모로 썼는지 말할 수 없다(조용한 대체 금지).
    """
    idx = pd.to_datetime(["2023-12-28", "2023-12-29", "2024-06-30", "2024-12-30"])
    s = pd.Series([10.0, 11.0, 12.0, 13.0], index=idx)
    ye = estimate._year_end_levels(s)
    assert ye["2023"] == {"v": 11.0, "d": "2023-12-29"}
    assert ye["2024"] == {"v": 13.0, "d": "2024-12-30"}


def test_year_end_anchor_ignores_the_weekly_compaction():
    """앵커는 **축약 전 원본**에서 나와야 한다.

    `_pack` 은 5년보다 오래된 구간을 주별(W-FRI)로 줄인다. 그 계열에서 연말을 뽑으면
    금요일 라벨로 밀려 분모가 실제 연말 종가가 아니게 되고, **그 해의 모든 YTD 가 함께**
    어긋난다 — 값이 그럴듯해서 눈으로는 못 잡는 종류다. 여기서 두 경로를 직접 대조한다.
    """
    s = _daily("2014-01-01", 4200)                      # 약 11.5년, 마지막은 5년 창 안
    ye = estimate._year_end_levels(s)
    packed = estimate._pack(s)
    for year in ("2015", "2016", "2017"):               # 축약 구간에 드는 해들
        raw = s[s.index.year == int(year)].iloc[-1]
        assert abs(ye[year]["v"] - round(float(raw), 4)) < 1e-9, f"{year} 앵커가 원본과 다르다"
    # 축약된 계열에는 그 날짜가 아예 없다 — 앵커를 거기서 뽑았다면 값이 달랐을 것이다
    packed_days = {pd.Timestamp(t, unit="s").date().isoformat() for t in packed["t"]}
    assert ye["2015"]["d"] not in packed_days, (
        "축약 계열이 그 날짜를 갖고 있어 이 테스트가 아무것도 구분하지 못한다")


def test_pack_keeps_recent_span_daily():
    """최근 구간은 일별 그대로여야 한다 — 기준일 정밀도가 여기에 달려 있다."""
    s = _daily("2014-01-01", 4200)
    packed = estimate._pack(s)
    cutoff = s.index[-1] - pd.DateOffset(years=estimate.DAILY_YEARS)
    recent = [t for t in packed["t"] if pd.Timestamp(t, unit="s") >= cutoff]
    assert len(recent) == int((s.index[-1] - cutoff).days) + 1 or len(recent) >= 1800, (
        f"최근 구간이 일별이 아니다: {len(recent)}개")


# --------------------------------------------------------------------------
# 요청과 실제 계열의 차이를 숨기지 않는가
# --------------------------------------------------------------------------

def test_acwi_is_published_as_price_return_not_total_return():
    """ACWI 는 요청(TR)과 달리 가격지수(PR)다 — 그 사실이 페이로드에 실려야 한다.

    PR 로 TR 칸을 채우면 배당수익률만큼 계통적으로 낮은 값이 보고 숫자로 들어간다.
    채우되 화면이 경고를 달 수 있도록 `basis_matches_request:false` + `caveat` 를 싣는다.
    """
    spec = next(x for x in estimate.INDICES if x["key"] == "acwi")
    assert spec["basis_matches_request"] is False
    assert spec["caveat"], "PR/TR 차이를 설명하는 문장이 없다"
    kospi = next(x for x in estimate.INDICES if x["key"] == "kospi_tr")
    assert kospi["basis_matches_request"] is True, "KOSPI TR 은 요청과 일치한다"


def test_us_treasury_is_declared_unavailable_not_approximated():
    """미국채는 **근사하지 않고 부재를 밝힌다**.

    보유 시리즈는 전부 금리(yield)라 기간수익률을 만들 수 없다. 듀레이션으로 −D·Δy
    근사를 만들 수는 있지만 그것은 실현 성과가 아니라 우리가 지어낸 추정치이고, 실제
    운용성과 칸에 자동으로 넣는 것은 「자의성 금지」 위반이다.
    """
    assert estimate.UNAVAILABLE, "부재 선언이 비어 있다"
    u = estimate.UNAVAILABLE[0]
    assert "해외채권" in " ".join(u["assets"])
    assert u["have_kind"] == "금리(yield)"
    assert u["reason"], "왜 자동 채움이 없는지 화면이 적을 문장이 없다"
    # 미국채가 자동 채움 목록에 슬쩍 들어가 있지 않은지
    assert not [x for x in estimate.INDICES if "채권" in x["asset"]], (
        "채권 자산군에 자동 채움 지수가 붙어 있다 — 총수익 지수가 없으므로 있을 수 없다")


def test_annualize_convention_is_day_count():
    """연환산은 **일수 기준**(2026-08-13 사용자 지시). 월수로 바꾸면 6/30 이 정확히 ×2 가
    되지만 사용자가 일수를 골랐다 — 규약을 코드가 임의로 되돌리지 않게 고정한다."""
    assert estimate.ANNUALIZE["basis"] == "days"
    assert estimate.ANNUALIZE["day_count"] == 365
    assert "주식" in estimate.ANNUALIZE["note"], "주식 제외 규약이 문장에 없다"


# --------------------------------------------------------------------------
# build() — 부재 상태 포함
# --------------------------------------------------------------------------

def test_build_publishes_indices_with_anchors():
    s_kospi = _daily("2020-01-01", 2000, 1000.0, 3000.0)
    s_acwi = _daily("2020-01-01", 2000, 500.0, 900.0)
    warns: list[str] = []
    out = estimate.build(
        _store(**{"bb:한국_KOSPI_TR": s_kospi, "idx:ACWI": s_acwi}), warns.append)
    assert out["active"] is True
    assert [ix["asset"] for ix in out["indices"]] == ["국내주식", "해외주식"]
    for ix in out["indices"]:
        assert len(ix["t"]) == len(ix["v"]) and len(ix["t"]) > 0
        assert ix["year_end"], "연말 앵커가 비어 있다"
        assert all(set(a) == {"v", "d"} for a in ix["year_end"].values())
    assert out["asof"] == max(ix["last"] for ix in out["indices"])
    # 지수 자체에 대한 경고는 없어야 한다(시나리오 축 부재 경고는 이 픽스처에서 정상)
    assert not [w for w in warns if "자동 채움 시리즈 없음" in w]


def test_build_stays_publishable_when_a_series_is_missing():
    """시리즈가 빠져도 나머지는 나가고, 빠진 것은 **경고로 남는다**(조용히 삼키지 않는다)."""
    warns: list[str] = []
    out = estimate.build(_store(**{"bb:한국_KOSPI_TR": _daily("2020-01-01", 800)}), warns.append)
    assert out["active"] is True
    assert [ix["asset"] for ix in out["indices"]] == ["국내주식"]
    assert any("idx:ACWI" in w for w in warns), f"빠진 시리즈를 알리지 않았다: {warns}"


def test_build_publishes_block_even_with_no_series_at_all():
    """지수가 하나도 없어도 블록은 나간다 — 화면이 규약과 부재 사유를 적어야 하기 때문."""
    warns: list[str] = []
    out = estimate.build(_store(), warns.append)
    assert out["active"] is False
    assert out["reason"]
    assert out["unavailable"] == estimate.UNAVAILABLE
    assert out["annualize"] == estimate.ANNUALIZE
    assert out["axes"] == [] and out["scenario"] == estimate.SCENARIO_MODEL
    # 지수 2개 + 시나리오 축(지수 참조 2개 제외한 4개) 전부가 경고로 남는다
    assert len(warns) == len(estimate.INDICES) + len(estimate.SCENARIO_AXES)


def test_payload_is_json_serialisable_and_carries_no_raw_leak_beyond_indices():
    """게시물은 JSON 직렬화가 되어야 하고, 실리는 값은 **선언된 지수뿐**이어야 한다."""
    out = estimate.build(_store(**{
        "bb:한국_KOSPI_TR": _daily("2021-01-01", 900),
        "idx:ACWI": _daily("2021-01-01", 900),
    }), lambda m: None)
    blob = json.dumps(out, ensure_ascii=False)
    assert json.loads(blob) == out
    assert set(out) == {"active", "asof", "asof_all", "indices", "axes",
                        "unavailable", "annualize", "scenario"}
    declared = {x["src"] for x in estimate.INDICES}
    assert {ix["src"] for ix in out["indices"]} <= declared


# --------------------------------------------------------------------------
# 화면과의 이름 계약
# --------------------------------------------------------------------------

def test_index_asset_names_exist_in_the_dashboard_asset_list():
    """`INDICES[].asset` 은 `app.js` 의 `EST_ASSETS` 이름과 **문자 단위로** 같아야 한다.

    다르면 화면이 그 행을 못 찾아 자동 채움이 **조용히** 사라진다(오류가 나지 않는다).
    """
    import re
    from pathlib import Path
    js = (Path(__file__).resolve().parents[1] / "dashboard" / "app.js").read_text(encoding="utf-8")
    block = re.search(r"const EST_ASSETS = \[(.*?)\n\];", js, re.S)
    assert block, "app.js 에서 EST_ASSETS 를 찾지 못했습니다"
    names = re.findall(r'key:\s*"([^"]+)"', block.group(1))
    assert len(names) == 11, f"자산군이 11개가 아닙니다: {names}"
    for spec in estimate.INDICES:
        assert spec["asset"] in names, f"{spec['asset']} 이 EST_ASSETS 에 없습니다"
    for u in estimate.UNAVAILABLE:
        for a in u["assets"]:
            assert a in names, f"부재 선언의 {a} 이 EST_ASSETS 에 없습니다"


def test_default_asof_is_where_every_index_reaches_not_the_furthest():
    """기본 기준일(`asof_all`)은 **모든 지수가 도달한 날**이어야 한다(§7.8.1).

    `asof`(가장 멀리 간 날)를 화면 기본값으로 쓰면, 늦게 끝나는 지수 하나 때문에 다른
    지수의 자동값이 **처음부터 묵은 채로** 뜬다 — 실측: 기본 2026-08-06 에서 ACWI 는
    2026-07-21 관측(16일 묵음)을 기준일 값처럼 보여주고 있었다. 첫 화면부터 어긋난
    수를 보여줄 이유가 없다.
    """
    out = estimate.build(_store(**{
        "bb:한국_KOSPI_TR": _daily("2024-01-01", 900),      # 더 멀리 간다
        "idx:ACWI": _daily("2024-01-01", 800),              # 먼저 끝난다
    }), lambda m: None)
    lasts = [ix["last"] for ix in out["indices"]]
    assert out["asof"] == max(lasts), "asof 는 가장 멀리 간 날이어야 한다(참고용)"
    assert out["asof_all"] == min(lasts), "asof_all 이 모든 지수가 도달한 날이 아니다"
    assert out["asof_all"] < out["asof"], "이 픽스처는 두 날짜가 갈려야 검사가 성립한다"


def test_scenario_axes_are_published_with_kind_and_no_duplication():
    """시나리오 축(§7.10) — `kind` 가 변화량의 뜻을 정하고, 지수 축은 중복 게시하지 않는다.

    rate(금리·스왑)는 **차이**, price(지수·환율)는 **변화율**이다. 이 구분을 화면이 스스로
    정하게 두면 금리를 비율로 나누는 사고가 조용히 난다. KOSPI TR·ACWI 는 이미 `indices`
    에 연말 앵커까지 실려 있으므로 축은 `index` 참조만 하고 값을 다시 싣지 않는다.
    """
    out = estimate.build(_store(**{
        "bb:한국_KOSPI_TR": _daily("2024-01-01", 900),
        "idx:ACWI": _daily("2024-01-01", 900),
        "info:한국_10y": _daily("2024-01-01", 900, 3.0, 4.0),
        "info:UST10y": _daily("2024-01-01", 900, 4.0, 5.0),
        "bb:달러원": _daily("2024-01-01", 900, 1300.0, 1400.0),
        "info:SMB_USDKRW_3M": _daily("2024-01-01", 900, -2.0, -1.0),
    }), lambda m: None)
    axes = {a["key"]: a for a in out["axes"]}
    assert set(axes) == {a["key"] for a in estimate.SCENARIO_AXES}
    assert {k for k, a in axes.items() if a["kind"] == "rate"} == {"kr_rate", "us_rate", "swap"}
    assert {k for k, a in axes.items() if a["kind"] == "price"} == {"usdkrw", "kospi", "acwi"}
    for k in ("kospi", "acwi"):
        assert "t" not in axes[k] and axes[k]["index"], f"{k} 축이 값을 중복 게시한다"
    for k in ("kr_rate", "us_rate", "usdkrw", "swap"):
        assert len(axes[k]["t"]) == len(axes[k]["v"]) > 0
        assert axes[k]["unit"] in ("bp", "%")


def test_scenario_model_states_the_signs_the_screen_must_use():
    """산식·부호·한계는 페이로드가 정본이고 **화면이 그대로 적는다**.

    방법론을 코드 주석에만 두면 화면과 어긋나도 아무도 모른다. 특히 장부가 규약과
    1차 근사(볼록성 미반영)·평행이동 가정은 결과 해석을 바꾸는 문장이라 반드시 나가야 한다.
    """
    m = estimate.SCENARIO_MODEL
    assert "캐리" in m["formula"] and "스왑 MTM" in m["formula"]
    joined = " ".join(m["terms"])
    assert "−듀레이션" in joined, "가격효과의 음부호가 산식에 없다"
    assert "1 − 헤지비율" in joined, "환효과가 미헤지분 비례임을 밝히지 않는다"
    assert "원가법" in m["book_value"] and "0" in m["book_value"]
    assert "볼록성" in m["limits"] and "평행이동" in m["limits"]


def test_scenario_axes_survive_missing_series():
    """축 시리즈가 빠져도 나머지는 나가고 빠진 것은 경고로 남는다(수기 입력으로 살아 있어야)."""
    warns: list[str] = []
    out = estimate.build(_store(**{
        "bb:한국_KOSPI_TR": _daily("2024-01-01", 400),
        "idx:ACWI": _daily("2024-01-01", 400),
    }), warns.append)
    assert out["active"] is True
    assert {a["key"] for a in out["axes"]} == {"kospi", "acwi"}
    for k in ("info:한국_10y", "info:UST10y", "bb:달러원", "info:SMB_USDKRW_3M"):
        assert any(k in w for w in warns), f"{k} 부재를 알리지 않았다"
