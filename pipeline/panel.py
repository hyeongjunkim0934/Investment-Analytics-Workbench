# -*- coding: utf-8 -*-
"""관계분석 패널 — 리스크 지표와 시장 변수의 주간 정렬 패널.

브라우저에서 상관·교차상관(선행/후행)·회귀를 실행할 수 있도록
주간(금요일 기준) 수준(level) 시계열을 정렬해 게시한다.
변환(변화율·bp 변화)과 통계 계산은 클라이언트에서 수행한다.

게시 범위 통제: 아래 VARS 화이트리스트에 있는 변수만 패널에 실린다.
변수를 추가하려면 이 목록에 항목을 넣으면 되고, 벤더 약관상 공개가
곤란한 시리즈는 넣지 않는다.

kind (클라이언트 변환 규칙):
  price — 전기 대비 % 변화
  rate  — 전기 대비 bp 변화 (원자료가 % 단위)
  level — 전기 대비 포인트 변화 (bp 스프레드·지수 등)
"""

from __future__ import annotations

import pandas as pd

# (id, 표시명, 그룹, 단위, kind, 산출식) — 산출식은 SERIES 키 또는 (연산, 인자들)
VARS = [
    ("fx_usdkrw", "달러/원", "FX", "원", "price", "bb:달러원"),
    ("fx_dxy", "달러지수(DXY)", "FX", "pt", "price", "bb:달러지수"),
    ("fx_usdjpy", "달러/엔", "FX", "엔", "price", "bb:달러엔"),
    ("fx_eurkrw", "유로/원", "FX", "원", "price", "info:EURKRW"),

    ("kr_3y", "국고 3년", "금리", "%", "rate", "info:한국_3y"),
    ("kr_10y", "국고 10년", "금리", "%", "rate", "info:한국_10y"),
    ("kr_30y", "국고 30년", "금리", "%", "rate", "info:한국_30y"),
    ("kr_base", "한국 기준금리", "금리", "%", "rate", "info:한국_기준금리"),
    ("us_2y", "미국채 2년", "금리", "%", "rate", "info:UST2y"),
    ("us_10y", "미국채 10년", "금리", "%", "rate", "info:UST10y"),
    ("us_base", "미국 기준금리", "금리", "%", "rate", "bb:미국_기준금리"),
    ("jp_10y", "일본 10년", "금리", "%", "rate", "info:JPY10y"),
    ("de_10y", "독일 10년", "금리", "%", "rate", "info:GER10y"),

    ("kr_slope", "한국 커브 10−3년", "커브", "bp", "level",
     ("spread_bp", "info:한국_10y", "info:한국_3y")),
    ("us_slope", "미국 커브 10−2년", "커브", "bp", "level",
     ("spread_bp", "info:UST10y", "info:UST2y")),

    ("kr_corp_aa", "회사채 AA− 3년 스프레드", "크레딧", "bp", "level",
     ("spread_bp", "info:Corp_AA_minus_3y", "info:한국_3y")),
    ("kr_card_aa", "카드채 AA+ 3년 스프레드", "크레딧", "bp", "level",
     ("spread_bp", "info:Card_AA_plus_3y", "info:한국_3y")),
    ("us_ig", "미국 IG 스프레드", "크레딧", "%p", "level", "bb:미국_투자등급_스프레드"),
    ("us_hy", "미국 HY 스프레드", "크레딧", "%p", "level", "bb:미국_하이일드_스프레드"),
    ("kr_cds", "한국 CDS 5년", "크레딧", "bp", "level", "bb:한국_CDS_5년물"),

    ("kospi", "KOSPI (TR)", "주식", "pt", "price", "bb:한국_KOSPI_TR"),
    ("acwi", "MSCI ACWI", "주식", "pt", "price", "idx:ACWI"),
    ("spx", "S&P500 (TR)", "주식", "pt", "price", "bb:미국_S&P500_TR"),
    ("vkospi", "VKOSPI", "주식", "pt", "level", "info:VKOSPI"),
    ("vix", "VIX", "주식", "pt", "level", "info:VIX"),

    ("wti", "WTI 유가", "원자재", "$", "price", "bb:WTI유가"),
    ("cmdty", "원자재지수", "원자재", "pt", "price", "bb:원자재지수"),

    ("kr_bei10", "한국 BEI 10년", "물가", "%", "rate", "info:KTB_BEI10y"),
    ("us_bei10", "미국 BEI 10년", "물가", "%", "rate", "info:UST_BEI10y"),
    ("us_tips10", "미국 TIPS 10년(실질)", "물가", "%", "rate", "bb:미국_TIPS_10y"),
]

DEFAULT_VARS = ["fx_usdkrw", "kr_3y", "kr_10y", "us_10y", "kospi"]


def epoch_seconds(index: pd.DatetimeIndex) -> list[int]:
    delta = index - pd.Timestamp("1970-01-01")
    return [int(x) for x in (delta // pd.Timedelta(seconds=1))]


def resolve(spec, S: dict, warn) -> pd.Series | None:
    if isinstance(spec, str):
        s = S.get(spec)
        if s is None:
            warn(f"panel: 시리즈 없음 — {spec}")
        return s
    op = spec[0]
    if op == "spread_bp":
        a, b = S.get(spec[1]), S.get(spec[2])
        if a is None or b is None:
            warn(f"panel: 스프레드 계산 불가 — {spec[1]} / {spec[2]}")
            return None
        return ((a - b) * 100).dropna()
    warn(f"panel: 알 수 없는 연산 — {op}")
    return None


def build(series_store: dict, risk_weekly: dict, warn) -> dict:
    S = {k: v["s"] for k, v in series_store.items()}
    RW = risk_weekly["weekly"]

    master = RW.index                                  # 주간(W-FRI) 기준 인덱스
    out_vars = []
    for vid, name, group, unit, kind, spec in VARS:
        s = resolve(spec, S, warn)
        if s is None:
            continue
        w = s.dropna().resample("W-FRI").last().reindex(master)
        w = w.ffill(limit=3)                           # 휴장 등 짧은 결측만 보정
        if w.notna().sum() < 260:                      # 5년 미만이면 분석 표본 부족
            warn(f"panel: 관측 부족으로 제외 — {name}")
            continue
        dec = 4 if kind == "rate" else 2
        out_vars.append({
            "id": vid, "name": name, "group": group, "unit": unit, "kind": kind,
            "v": [None if pd.isna(x) else round(float(x), dec) for x in w.values],
            "first": str(w.first_valid_index().date()),
        })

    risk_series = {}
    for col in RW.columns:
        v = RW[col].reindex(master)
        risk_series[col] = [None if pd.isna(x) else round(float(x), 2) for x in v.values]

    risk_meta = [{"key": "stress", "name": "현재 위험", "kind": "score"},
                 {"key": "vuln", "name": "잠재 위험", "kind": "score"}]
    for f in risk_weekly["factors"]:
        risk_meta.append({"key": f["key"], "name": f"{f['name']} (요인)",
                          "kind": "score", "layer": f["layer"]})

    return {
        "asof": str(master[-1].date()),
        "freq": "W-FRI",
        "t": epoch_seconds(master),
        "risk": risk_series,
        "risk_meta": [m for m in risk_meta if m["key"] in risk_series],
        "vars": out_vars,
        "defaults": [v for v in DEFAULT_VARS if any(x["id"] == v for x in out_vars)],
        "n_weeks": int(len(master)),
        "method": {
            "transform": ("기본 분석은 '변화' 기준입니다 — 가격·지수는 % 변화, 금리는 bp 변화, "
                          "스프레드·변동성지수는 포인트 변화. 수준(level)끼리의 상관은 두 시계열이 "
                          "모두 추세를 가질 때 실제 관계가 없어도 높게 나오는 '허구적 상관'이 생기므로 "
                          "기본값에서 제외했습니다(토글로 확인은 가능)."),
            "leadlag": ("교차상관 corr(위험지표_{t−k}, 변수_t)를 k = −26~+26주에서 계산합니다. "
                        "최대 상관이 k>0에서 나오면 위험지표가 그만큼 선행, k<0이면 후행입니다. "
                        "점선은 백색잡음 가정의 95% 신뢰구간(±1.96/√n)입니다."),
            "regression": ("동행 회귀: Δ변수_t = α + β·Δ위험_t. 예측 회귀: 향후 h주 변화 = α + β·위험수준_t "
                           "(중첩 표본이므로 Newey-West HAC 표준오차 사용, 시차 = h). "
                           "R²는 설명력이지 인과관계가 아니며, 표본 내 적합도입니다."),
        },
    }
