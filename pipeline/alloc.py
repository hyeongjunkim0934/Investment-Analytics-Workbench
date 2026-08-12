# -*- coding: utf-8 -*-
"""자산배분 시뮬레이터 — 원천 공분산·현재 금리·표본 재추출 사전계산 → alloc.json.

원본 수익률은 게시하지 않는다(라이선스). 게시하는 것은 원천 10개의 월간 수익률
**공분산과 평균**뿐이고, 자산군 수익률·헤지 반영·최적화는 전부 브라우저가
선형 재조립으로 수행한다(환헤지 `hedge.json.sim` 과 같은 패턴).

방법론 — 전부 시장 표준이며 임의 계수를 두지 않는다:
- 평균-분산 최적화 (Markowitz 1952) + 밴드 제약, 투영 경사법(역행렬 불사용 —
  회계 관점의 장부가 채권은 분산 0이라 공분산이 특이행렬이다).
- 기대수익: 채권·현금은 현재 시장금리 [관측]. 주식 ERP 는 **동일 샤프 앵커** —
  채권 시장이 지금 위험 1단위에 주는 보상 (YTM−단기금리)/σ 를 국내·해외 채권에서
  **각 시장 자국통화 기준**으로 관측해 평균한 값 × 각 주식의 자국통화 σ.
  자유 모수가 0개고(앵커 자체가 관측값), 앵커·ERP 가 헤지 슬라이더와 무관하다 —
  헤지비율은 기대수익에 비용항(h×스왑레이트)으로만, 위험에 환노출(1−h)로만
  들어간다(승인 ⑤-ⓑ, 사용자 확정). 역사적 실현 평균은 기대수익으로 쓰지
  않는다(표본 구간 선택 = 답 선택).
- 헤지비용: 현재 수준 = 실측 HP 곡선(3/6/12M)을 **가중평균 스왑 만기**(수기 입력,
  3·6·12·12M+ 혼합의 금액가중)로 보간 [관측, 사용자 확정 정본]. 이력(공분산의
  스왑레이트 요인) = SMB 3M(2001~) — HP 는 2024-10 시작이라 이력용으로는 짧다.
- 환율 기대변동 0 (랜덤워크 가정 — 방향 전망은 모델 랩에서 주입 예정).
- 회계(손익) 관점 = hedge.py 의 §5.3 5항 모형 재사용 (동일 산식·동일 τ 규약).
- 표본 재추출: 순환 블록 부트스트랩 (Künsch 1989; 자기상관 보존), 복제마다
  공분산→σ→앵커→μ→최적화를 전부 재추정. 원본 수익률을 브라우저에 줄 수 없어
  빌드 시점에 기준 상태(아래 defaults)로 사전계산해 분위수만 게시한다.
- 기본 화면의 ±SE 는 σ̂/√(2n) (정규 근사 점근 표준오차) — 브라우저가 계산.

`build(SERIES, warn) -> dict`. 실패는 process.py 의 try/except 가 격리한다.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

import common
import hedge as H

# ---------------------------------------------------------------------------
# 원천 10개 — 라벨과 정의. 브라우저(app.js)의 재조립 코드와 1:1.
# ---------------------------------------------------------------------------
SOURCE_LABELS = ["kr_bond", "us_bond", "kospi", "acwi", "spx",
                 "alt", "cash", "e_usd", "swap", "d_swap"]
SOURCE_DESC = {
    "kr_bond": "국내채권 — 한국 5년 국채 합성 TR (bb:한국_5y, hedge.py synth_bond_tr 재사용)",
    "us_bond": "해외채권 — 미국 종합채권 실지수, 달러표시 (bb:미국종합, §6.1 판정)",
    "kospi":   "국내주식 — KOSPI TR (bb:한국_KOSPI_TR)",
    "acwi":    "해외주식 — MSCI ACWI, 달러표시·현재 PR (idx:ACWI)",
    "spx":     "해외주식 대안 프록시 — S&P500 TR, 달러표시 (bb:미국_S&P500_TR)",
    "alt":     "대체투자 기저 — 한국 근원 CPI 월환산 (bb:한국_core_CPI_yoy). 화면에서 목표 σ로 재척도",
    "cash":    "단기자금 — 한국 3개월 (info:한국_3m)",
    "e_usd":   "달러/원 월간 변화율 (bb:달러원, 스파이크 필터 적용)",
    "swap":    "FX스왑 캐리 — 3M 스왑레이트 월환산 (info:SMB_USDKRW_3M)",
    "d_swap":  "스왑레이트 월간 변화 (스왑 MTM 요인, hedge.py 와 동일 규약)",
}

# 표본 시작 선택지 — "표본 구간을 고른 사람이 답을 고른다"를 화면에서 검사 가능하게.
START_OPTIONS = [("full", None, "공통 표본 전체"),
                 ("y2010", "2010-01-01", "2010년 이후 (금융위기 제외)"),
                 ("y2015", "2015-01-01", "2015년 이후 (저금리기 이후)")]

# 화면 기본값(예시) — 모형 상수가 아니라 **수기 입력 전 자리표시자**다.
# 사용자가 수기 입력(#alloc-sim)을 저장하면 전부 대체된다. 화면에 '예시' 표기.
DEFAULTS = {
    # 대체투자는 지분형/대출형 두 분류(2026-08-12 사용자 지시). **대출금은 배분 우주에서
    # 제외** — 9개 자산군이 합 100 을 만든다(2026-08-12 사용자 지시 — 구 「준고정 12%」
    # 칸은 폐지). 예시 분할·비중은 자리표시자다(공개 저장소 — 실제 북 구성 아님).
    "mix": {"국내채권": 48.0, "해외채권": 21.0, "국내주식": 3.0, "해외주식": 6.0,
            "대체투자(대출형)": 3.0, "대체투자(지분형)": 13.0, "단기자금": 6.0},
    "bands": {"국내채권": [20, 55], "해외채권": [0, 30], "국내주식": [0, 10],
              "해외주식": [0, 15], "대체투자(대출형)": [0, 10],
              "대체투자(지분형)": [0, 25], "단기자금": [2, 15]},
    # 표시 순서 = 2026-08-12 사용자 지정: 장부가 채권 2 → 단기자금 → 주식 2 →
    # 시가 채권 2 → 대체투자(대출형 → 지분형). app.js ALLOC_ACCT 와 1:1.
    "mix_acct": {"장부가 국내채권": 34.0, "장부가 해외채권": 14.0, "단기자금": 6.0,
                 "국내주식": 3.0, "해외주식": 6.0,
                 "시가 국내채권": 14.0, "시가 해외채권": 7.0,
                 "대체투자(대출형)": 3.0, "대체투자(지분형)": 13.0},
    "bands_acct": {"장부가 국내채권": [15, 45], "장부가 해외채권": [0, 25],
                   "단기자금": [2, 15], "국내주식": [0, 10], "해외주식": [0, 15],
                   "시가 국내채권": [0, 25], "시가 해외채권": [0, 20],
                   "대체투자(대출형)": [0, 10], "대체투자(지분형)": [0, 25]},
    "loan_w": 0.0, "loan_y": 0.0,           # 대출금 — 배분 우주에서 제외(2026-08-12), 칸만 유지
    "alt_alpha": 3.0, "alt_vol": 8.0,       # 대체 기대 CPI+α, 위험(스무딩 보정 가정)
    # 기대수익률 디폴트(연 %) — 2026-08-12 사용자 지정 수치. 키인은 **최종치**(헤지비용
    # 반영 후 원화 기대수익)로 그대로 쓰이고, 캐리를 다시 더하지 않는다(중복 가산 금지).
    # 미입력 자산만 앵커/관측+캐리로 도출한다. 장부가 채권 둘은 북일드 칸(by_kr/by_fx)이 정본.
    "by_kr": 3.04, "by_fx": 3.34,
    "mu_over": {"국내채권": 3.25, "해외채권": 2.94, "국내주식": 6.29, "해외주식": 5.43,
                "대체투자(대출형)": 4.39, "대체투자(지분형)": 6.86, "단기자금": 2.09},
    "tenor_m": H.DEFAULT_TENOR_M,           # 가중평균 스왑 만기(월) — 3·6·12·12M+ 혼합의 금액가중, 수기 입력
    "h_bond": 90, "h_eq": 90,               # 헤지비율 % — 사용자의 현재 상태로 대체됨
    # 헤지비율 밴드(내규)는 **기관 내부정보**다. 여기 기본값은 의도적으로 **중립(0~100)**,
    # 즉 "밴드 없음"이며 특정 기관의 내규 숫자를 코드에 박지 않는다(공개 저장소).
    # 사용자가 #alloc-sim 에 입력하면 브라우저 localStorage 에만 남는다.
    "h_bands": {"해외채권": [0, 100], "해외주식": [0, 100]},
    # 일시 초과 허용선 — NAV 감소로 헤지 계약을 즉시 줄이지 못해 생기는 **운영 허용오차**이지
    # 최적화가 고를 수 있는 선택지가 아니다. 그래서 결정범위(h_bands)와 따로 둔다.
    "h_tol_hi": {"해외채권": None, "해외주식": None},
    # 통화 구성 — 기본은 **미입력**이고, 화면에서 「벤치마크 값 채우기」로 CCY_BENCH 를 불러온다.
    "ccy": {"해외채권": {}, "해외주식": {}},
    "start_key": "full", "proxy": "acwi", "cost_key": "hp",   # 비용 정본 = 실측 HP (사용자 확정)
    "block_len": 24,
}

# ---------------------------------------------------------------------------
# 통화 구성 벤치마크 — **공개 벤치마크 값이며 기관 실제 비중이 아니다.**
# 화면 수기입력(#alloc-sim)의 디폴트로만 쓰이고 사용자가 입력하면 전부 대체된다.
# 기관 실제 비중은 브라우저 localStorage 에만 남고 이 저장소에는 올라가지 않는다.
#
# 두 자산군의 **근거 품질이 다르다** — 화면이 그 차이를 그대로 밝힌다:
#   해외채권 = 보유종목 20,000건의 **표시통화(Market Currency) 직접 집계**. 추정 0.
#   해외주식 = 팩트시트의 **국가** 비중을 상장국가 기준으로 통화에 대응시킨 값(추정 있음).
# 주식도 보유종목 파일을 받으면 채권과 같은 품질로 올라간다(§6 데이터 요청).
CCY_BENCH = {
    "해외채권": {
        "asof": "2026-08-03",
        "src": "SPDR Bloomberg Global Aggregate Bond UCITS ETF 보유종목 20,000건",
        "basis": "종목별 표시통화 직접 집계 (시장가치 기준) — 국가→통화 추정 없음",
        "w": {"USD": 45.77, "EUR": 22.95, "CNY": 10.56, "JPY": 7.54,
              "GBP": 3.96, "CAD": 2.61, "AUD": 1.51},
        "krw": 0.99,        # 원화 표시 자산 — 원화 투자자에게는 환노출이 0이다(선택이 아니라 정의)
        "other": 4.11,      # 모형 7통화 밖 18개 통화(CHF·MYR·MXN·IDR·THB 등)
        # 통화별 가중 듀레이션 — dur_by["해외채권"] 의 근거로 함께 싣는다
        "dur": {"USD": 5.41, "EUR": 6.06, "CNY": 5.94, "JPY": 7.67,
                "GBP": 6.98, "CAD": 6.85, "AUD": 5.12},
        "dur_all": 5.93,
        "note": "위안 10.56% 는 2019-04 편입분이다 — 2019년 이전 자료를 쓰면 이 통화가 통째로 빠지고 "
                "엔 비중이 두 배로 잡힌다(2017년 팩트시트 대비 엔 −8.8%p·위안 +10.6%p 실측).",
    },
    "해외주식": {
        "asof": "2026-06-30",
        "src": "MSCI ACWI 지수 국가별 비중 (ETF 월간운용보고서 게재분)",
        "basis": "국가 비중을 **상장국가 기준**으로 통화에 대응 — 중국(4.08%)은 홍콩상장·ADR 이 "
                 "섞여 있어 전액 위안으로 보는 것은 근사다. 보유종목 파일을 받으면 해소된다.",
        "w": {"USD": 62.49, "JPY": 4.94, "CNY": 4.08, "EUR": 3.89,
              "GBP": 2.99, "CAD": 2.89, "AUD": 0.0},
        "krw": 2.83,        # ACWI 는 한국을 포함한다 — 원화 부분은 환노출 0
        "other": 15.89,     # 대만 3.21 · 스위스 2.01 · 기타 10.67 (분해 불가)
        "dur": {}, "dur_all": None,
        "note": "EUR 3.89% 는 프랑스 2.08 + 독일 1.81 뿐이다 — 「기타 10.67%」에 든 "
                "유로존 국가가 더해지지 않아 **유로가 과소평가**돼 있다.",
    },
}

BOOT_REPS = 2000
BOOT_BLOCKS = [12, 24]
BOOT_SEED = 20260801      # 재현성 고정용(모형 모수 아님) — 바꾸면 분위수가 재추출 오차만큼 흔들린다
OPT_ITERS = 1500          # 부트스트랩 내부 최적화 반복 — 점추정 3000회 대비 오차를 checks 에 게시
Q = [5, 25, 50, 75, 95]


# ---------------------------------------------------------------------------
# 1) 원천 프레임
# ---------------------------------------------------------------------------
def sources_frame(S, warn) -> pd.DataFrame:
    def g(key):
        s = S.get(key)
        if s is None:
            warn(f"alloc: 시리즈 없음 — {key}")
        return s

    usdkrw = H.despike(g("bb:달러원"))
    month_start = usdkrw.index[-1].to_period("M").to_timestamp()

    def cut(s):
        return s[s.index < month_start]

    smb = g("info:SMB_USDKRW_3M").resample("ME").last()
    cols = {
        "kr_bond": cut(H.synth_bond_tr(g("bb:한국_5y"))),
        "us_bond": cut(H.mret(g("bb:미국종합"))),
        "kospi":   cut(H.mret(g("bb:한국_KOSPI_TR"))),
        "acwi":    cut(H.mret(g("idx:ACWI"))),
        "spx":     cut(H.mret(g("bb:미국_S&P500_TR"))),
        "alt":     cut((g("bb:한국_core_CPI_yoy").resample("ME").last() / 100 / 12).dropna()),
        "cash":    cut((g("info:한국_3m").resample("ME").last() / 100 / 12).dropna()),
        "e_usd":   cut(H.mret(usdkrw)),
        "swap":    cut((smb / 100 / 12).dropna()),
        "d_swap":  cut((smb / 100).diff().dropna()),
    }
    # dropna 는 build() 쪽에서 — ACWI(2006-12 시작)를 뺀 최장 표본(spx02)도
    # 같은 프레임에서 만들어야 하므로 여기서는 결측을 남겨 둔다.
    return pd.DataFrame(cols)[SOURCE_LABELS]


def market_rates(S, warn) -> dict:
    out = {}
    for k, key in [("kr3m", "info:한국_3m"), ("kr5y", "bb:한국_5y"),
                   ("us_ytm", "info:UST_ALL_YTM"), ("us3m", "bb:미국_3m"),
                   ("cpi", "bb:한국_core_CPI_yoy")]:
        s = S.get(key)
        if s is None:
            warn(f"alloc: 시리즈 없음 — {key}")
            continue
        s = s.dropna()
        out[k] = {"v": round(float(s.iloc[-1]), 3),
                  "date": s.index[-1].strftime("%Y-%m-%d"), "src": key}
    return out


def hp_cost_at(curve: dict, tenor_m: float) -> float:
    """실측 HP 곡선(3/6/12M)을 가중평균 만기(개월)로 선형 보간.

    사용자 실무는 3·6·12·12M 초과 스왑을 섞어 쓰므로 만기를 수기 입력(금액가중
    평균)받아 그 지점의 비용을 읽는다. 12M 초과는 시장 호가가 없어 12M 값으로
    고정한다 — 화면에 그대로 명시. app.js 의 allocHpAt 과 같은 산식.
    """
    xs = [3.0, 6.0, 12.0]
    ys = [curve["3M"], curve["6M"], curve["12M"]]
    t = min(max(float(tenor_m), xs[0]), xs[-1])
    return round(float(np.interp(t, xs, ys)), 3)


def cost_options(S, rates, tenor_m) -> list[dict]:
    """헤지비용 읽는 법 — 전부 [관측]이며 사용자가 드롭다운으로 고른다.

    기본값은 실측 HP(사용자 확정, 2026-08 — 실무 데스크 기준과 일치). 단 HP 는
    2024-10 시작이라 이력이 없어 **공분산의 스왑레이트 요인은 SMB(2001~)** 를
    유지한다 — 수준은 HP, 이력은 SMB 로 역할이 나뉜다(화면 명시).
    CIP 항의는 §5.3 에서 폐기된 것(스왑레이트 '변화'의 프록시)과 다르다 —
    여기서는 비용 '수준'의 대안 읽기로만 제시한다(달러 실측과 상관 0.89 검증).
    """
    opts = []
    # HP 를 읽는 자리는 `common.hp_curve` **하나**다 — hedge.py 도 같은 함수를 부른다.
    # 두 모듈이 각자 읽던 시절에는 산식이 우연히 같아 −0.975% 로 일치했을 뿐이고,
    # 한쪽만 고치면 같은 화면의 두 숫자가 조용히 갈라진다.
    hp = common.hp_curve(S, "USD")
    if hp is not None:
        curve = hp["curve"]
        opts.append({"key": "hp", "label": "실측 헤지 포인트(HP) — 가중평균 만기로 보간",
                     "v": hp_cost_at(curve, tenor_m), "curve": curve,
                     "src": (f"info:USDKRW_HP_3M/6M/12M ({hp['asof']:%Y-%m-%d}, "
                             f"{common.hp_read_label()}) · "
                             "12개월 초과 만기는 12M 값 고정(호가 없음)")})
    smb_m = S["info:SMB_USDKRW_3M"].dropna().resample("ME").last().dropna()
    opts += [
        {"key": "smb_last", "label": "3M 스왑레이트(SMB) — 최근값",
         "v": round(float(smb_m.iloc[-1]), 2),
         "src": f"info:SMB_USDKRW_3M ({smb_m.index[-1]:%Y-%m})"},
        {"key": "smb_median", "label": f"3M 스왑레이트(SMB) — 장기 중앙값 ({len(smb_m)}개월)",
         "v": round(float(smb_m.median()), 2),
         "src": f"info:SMB_USDKRW_3M {smb_m.index[0]:%Y-%m}~{smb_m.index[-1]:%Y-%m}"},
    ]
    if "kr3m" in rates and "us3m" in rates:
        opts.append({"key": "cip", "label": "금리차(CIP) 함의 — 한국 3m − 미국 3m",
                     "v": round(rates["kr3m"]["v"] - rates["us3m"]["v"], 2),
                     "src": "info:한국_3m − bb:미국_3m"})
    return opts


# ---------------------------------------------------------------------------
# 2) 재조립·앵커·최적화 (부트스트랩과 점추정 공용 — 브라우저 코드와 같은 산식)
# ---------------------------------------------------------------------------
IX = {k: i for i, k in enumerate(SOURCE_LABELS)}
# 대출형이 지분형보다 앞 — 2026-08-12 사용자 지정 표시 순서와 일치.
# 해외채권 1·해외주식 3 인덱스는 Xe 산식(unhedged_fx 등)의 계약이라 움직이면 안 된다.
ECON_ASSETS = ["국내채권", "해외채권", "국내주식", "해외주식",
               "대체투자(대출형)", "대체투자(지분형)", "단기자금"]


def loadings(h_bond: float, h_eq: float, alt_scale: float, proxy: str = "acwi") -> np.ndarray:
    """경제 관점 자산 7 × 원천 10 로딩 행렬. 해외자산 = 현지 + (1−h)e + h·swap.

    대체투자 두 분류(지분형·대출형)는 이 프록시층에서 **같은 프록시(alt)를 공유**한다
    — 행이 동일하므로 두 분류는 완전상관이고, 합계 비중이 같으면 총위험도 같다
    (구 단일 「대체투자」와의 연속성). 분류별 위험 구분은 CMA 층의 팩터 매핑이
    담당한다(app.js cmaAltRows — 프록시층은 대조·비상용이라 구분하지 않는다)."""
    B = np.zeros((len(ECON_ASSETS), len(SOURCE_LABELS)))
    B[0, IX["kr_bond"]] = 1
    B[1, IX["us_bond"]], B[1, IX["e_usd"]], B[1, IX["swap"]] = 1, 1 - h_bond, h_bond
    B[2, IX["kospi"]] = 1
    B[3, IX[proxy]], B[3, IX["e_usd"]], B[3, IX["swap"]] = 1, 1 - h_eq, h_eq
    B[4, IX["alt"]] = alt_scale
    B[5, IX["alt"]] = alt_scale
    B[6, IX["cash"]] = 1
    return B


def check_feasible(lo, hi, total):
    """실행 불가능한 밴드 입력을 침묵 속에 흡수하지 않는다 — 명시적 오류.

    (하한 합 > 합계, 상한 합 < 합계 어느 쪽이든 투영이 임의의 점을 돌려주게 되므로
    최적화 전에 반드시 검사한다. app.js 의 allocFeasibility 와 같은 규칙.)
    """
    lo_sum, hi_sum = float(np.sum(lo)), float(np.sum(hi))
    if lo_sum > total + 1e-9:
        raise ValueError(f"alloc: 밴드 하한 합 {lo_sum:.4f} > 투자 합계 {total:.4f} — 실행 불가능한 제약")
    if hi_sum < total - 1e-9:
        raise ValueError(f"alloc: 밴드 상한 합 {hi_sum:.4f} < 투자 합계 {total:.4f} — 실행 불가능한 제약")


def project(w, lo, hi, total):
    """박스 ∩ {합=total} 로의 유클리드 투영 — 이분 40회 (app.js 와 동일)."""
    a, b = -2.0, 2.0
    for _ in range(40):
        m = (a + b) / 2
        if np.clip(w + m, lo, hi).sum(axis=-1).mean() > total:
            b = m
        else:
            a = m
    return np.clip(w + (a + b) / 2, lo, hi)


def project_batch(W, lo, hi, total):
    """W (R,n) 각 행을 독립적으로 투영 — 행별 이분 20회(오차 < 4e-6, 반복당 비용 절약)."""
    a = np.full(W.shape[0], -2.0)
    b = np.full(W.shape[0], 2.0)
    for _ in range(20):
        m = (a + b) / 2
        s = np.clip(W + m[:, None], lo, hi).sum(axis=1)
        over = s > total
        b = np.where(over, m, b)
        a = np.where(over, a, m)
    return np.clip(W + ((a + b) / 2)[:, None], lo, hi)


def optimize(mu, cov, lo, hi, total, target=None, iters=3000):
    """투영 경사법 + (목표수익) 쌍대 상승. app.js 이식본과 동일 알고리즘."""
    w = project(np.full(len(mu), total / len(mu)), lo, hi, total)
    lam = 0.0
    for _ in range(iters):
        grad = cov @ w - lam * mu
        w = project(w - 0.02 * grad / max(np.abs(grad).max(), 1e-12), lo, hi, total)
        if target is not None:
            lam = max(0.0, lam + 3.0 * (target - float(mu @ w)))
    return w


def optimize_batch(MU, COVS, lo, hi, total, targets, iters=OPT_ITERS):
    """복제 R개를 한꺼번에 — MU (R,n), COVS (R,n,n), targets (R,)."""
    R, n = MU.shape
    W = project_batch(np.full((R, n), total / n), lo, hi, total)
    lam = np.zeros(R)
    for _ in range(iters):
        grad = np.einsum("rij,rj->ri", COVS, W) - lam[:, None] * MU
        step = 0.02 * grad / np.maximum(np.abs(grad).max(axis=1, keepdims=True), 1e-12)
        W = project_batch(W - step, lo, hi, total)
        lam = np.maximum(0.0, lam + 3.0 * (targets - np.einsum("ri,ri->r", MU, W)))
    return W


# 환노출 방향 벡터 g = e_usd − swap. 헤지 레버 둘은 **이 하나의 방향의 스칼라배**다:
#   x(hb,he) = x1 + (1−hb)·w채·g + (1−he)·w주·g = x1 + Xe·g
# 따라서 경제 관점 위험은 (hb, he) 를 따로 보지 않고 Xe 하나로만 결정된다.
# 이것은 근사가 아니라 로딩 정의에서 바로 따라 나오는 **항등식**이며(승인 ⑤의 귀결),
# 화면의 '동률 능선' — 같은 Xe 를 만드는 모든 (hb,he) 의 위험이 정확히 같다 — 이 여기서 온다.
FX_DIR = np.zeros(len(SOURCE_LABELS))
FX_DIR[IX["e_usd"]], FX_DIR[IX["swap"]] = 1.0, -1.0
FX_DIR.setflags(write=False)


def unhedged_fx(w, h_bond: float, h_eq: float) -> float:
    """총 미헤지 환노출 Xe = w채(1−h채) + w주(1−h주). 단위는 w 와 같다."""
    return float(w[1]) * (1 - h_bond) + float(w[3]) * (1 - h_eq)


def hedge_quad(covS, w, alt_scale, proxy="acwi"):
    """σ²(Xe) = a0 + 2·a1·Xe + a2·Xe² 의 계수 셋 (Xe 단위는 w 와 같다)."""
    x1 = w @ loadings(1.0, 1.0, alt_scale, proxy)
    Sg = covS @ FX_DIR
    return float(x1 @ covS @ x1), float(x1 @ Sg), float(FX_DIR @ Sg)


def hedge_xe_min(covS, w, alt_scale, proxy="acwi", xe_lo=None, xe_hi=None):
    """위험 최소 Xe — 1차원 2차식의 **폐형 해**. 격자를 쓰지 않으므로 양자화 오차가 0이다.

    (구버전은 5%p 격자에서 (hb,he) 쌍을 argmin 으로 골랐는데, 위 항등식 때문에
    최소점이 무한히 많아 **동점 중 스캔 순서상 먼저 만난 구석**이 나왔다. 하필
    가장 반직관적인 점이 뽑혀 "해외주식 100% 헤지가 최적"으로 읽히는 사고가 있었다.)

    a2 > 0 (환노출 방향의 분산이 양수) 이면 볼록이므로 밴드 구간으로 자른 값이
    곧 제약 하 최소점이다.
    """
    a0, a1, a2 = hedge_quad(covS, w, alt_scale, proxy)
    xe = (-a1 / a2) if a2 > 0 else 0.0
    if xe_lo is not None:
        xe = max(xe, xe_lo)
    if xe_hi is not None:
        xe = min(xe, xe_hi)
    return xe, math.sqrt(max(a0 + 2 * a1 * xe + a2 * xe * xe, 0.0))


def xe_range(w, bands):
    """밴드가 허용하는 Xe 의 [최소, 최대]. bands = ((hb_lo,hb_hi), (he_lo,he_hi)), 전부 소수."""
    (blo, bhi), (elo, ehi) = bands
    return unhedged_fx(w, bhi, ehi), unhedged_fx(w, blo, elo)


def hedge_pair_for_xe(w, xe, cur, bands):
    """목표 Xe 를 만드는 (h채, h주) 는 무한히 많다 — 그중 **현재값에 가장 가까운** 한 점.

    임의 계수 0개다: 직선 w채·hb + w주·he = c 를 밴드 상자와 교차시킨 선분 위로
    현재점을 유클리드 정사영하는 것뿐이며 해가 폐형이다. 밴드 안에서 그 Xe 를
    만들 수 없으면 None 을 돌려준다(호출자가 명시적으로 알린다).
    """
    wb, we = float(w[1]), float(w[3])
    hb0, he0 = cur
    (blo, bhi), (elo, ehi) = bands
    c = wb + we - xe
    if wb <= 1e-12 and we <= 1e-12:          # 해외자산이 없으면 Xe 는 항상 0
        return hb0, he0
    if we <= 1e-12:
        hb = min(max(c / wb, blo), bhi)
        return hb, he0
    if wb <= 1e-12:
        he = min(max(c / we, elo), ehi)
        return hb0, he
    r = wb / we
    hb = (hb0 + r * (c / we - he0)) / (1 + r * r)
    lo = max(blo, (c - we * ehi) / wb)       # he(hb) 도 밴드 안이어야 한다
    hi = min(bhi, (c - we * elo) / wb)
    if lo > hi + 1e-12:
        return None
    hb = min(max(hb, lo), hi)
    return hb, (c - wb * hb) / we


def anchor_of(covS, rates):
    """동일 샤프 앵커 — 각 시장의 **자국통화 기준** (승인 ⑤-ⓑ, 사용자 확정 2026-08).

    분자·분모 모두 환율·헤지 개입 전이다: 국내 (5y − 3m) ÷ σ(국내채권),
    해외 (미 종합 YTM − 미 3m) ÷ σ(미국종합, 달러표시). 따라서 앵커는 헤지
    슬라이더와 **완전히 무관**하고, 헤지비율은 기대수익에 비용항(h × 스왑레이트)
    으로만 들어간다 — "얼마 헤지했고, 비용이 얼마고, 그걸 다 계산한 수익"이라는
    실무 관점과 인과가 일치한다. (구버전은 해외 다리를 원화 헤지 기준으로 재서
    채권 헤지 슬라이더가 국내주식 기대수익까지 움직였다 — 감사 지적으로 교체.)
    """
    sig_krb = math.sqrt(covS[IX["kr_bond"], IX["kr_bond"]]) * 100
    sig_usb = math.sqrt(covS[IX["us_bond"], IX["us_bond"]]) * 100
    prem_kr = rates["kr5y"]["v"] - rates["kr3m"]["v"]
    prem_us = rates["us_ytm"]["v"] - rates["us3m"]["v"]
    return {"value": (prem_kr / sig_krb + prem_us / sig_usb) / 2,
            "kr": {"prem": prem_kr, "sigma": sig_krb},
            "us": {"prem": prem_us, "sigma": sig_usb}}


def mu_vector(covS, rates, d, cost):
    """경제 관점 μ (연 %). ERP = 앵커 × **자국통화 σ** — 둘 다 슬라이더와 무관.

    헤지비율이 기대수익에 미치는 영향은 비용항 h×cost 뿐이고, 위험(σ)에 미치는
    영향은 환노출 (1−h) 뿐이다. 표시용 σ(원화 기준, 헤지 반영)는 별도로 돌려준다.
    """
    h_b, h_e = d["h_bond"] / 100, d["h_eq"] / 100
    a = anchor_of(covS, rates)
    B = loadings(h_b, h_e, 1.0, d["proxy"])
    sig = np.sqrt(np.einsum("ij,jk,ik->i", B, covS, B)) * 100   # 표시용(원화·헤지 반영)
    sig_kospi = math.sqrt(covS[IX["kospi"], IX["kospi"]]) * 100
    sig_eq_loc = math.sqrt(covS[IX[d["proxy"]], IX[d["proxy"]]]) * 100
    return np.array([
        rates["kr5y"]["v"],
        rates["us_ytm"]["v"] + h_b * cost,
        rates["kr3m"]["v"] + a["value"] * sig_kospi,
        rates["us3m"]["v"] + a["value"] * sig_eq_loc + h_e * cost,
        rates["cpi"]["v"] + d["alt_alpha"],      # 대체투자(대출형) — CPI+α [가정] (키인이 대체)
        rates["cpi"]["v"] + d["alt_alpha"],      # 대체투자(지분형) — 같은 자리표시자
        rates["kr3m"]["v"],
    ]), a, sig


def alt_scale_of(covS, alt_vol_pct):
    sig = math.sqrt(covS[IX["alt"], IX["alt"]]) * 100
    return (alt_vol_pct / sig) if sig > 0 else 0.0


# ---------------------------------------------------------------------------
# 3) 부트스트랩 (기준 상태 사전계산)
# ---------------------------------------------------------------------------
def bootstrap(M: pd.DataFrame, rates, d, cost) -> list[dict]:
    """순환 블록 부트스트랩 — 복제마다 공분산→σ→앵커→μ→두 레버 재계산."""
    X = M.values                          # (T, 10) 월간
    T = len(X)
    keys = ECON_ASSETS
    w0 = np.array([d["mix"][k] for k in keys]) / 100
    lo = np.array([d["bands"][k][0] for k in keys]) / 100
    hi = np.array([d["bands"][k][1] for k in keys]) / 100
    total = float(w0.sum())
    check_feasible(lo, hi, total)
    rng = np.random.default_rng(BOOT_SEED)
    out = []
    for L in BOOT_BLOCKS:
        nblk = math.ceil(T / L)
        starts = rng.integers(0, T, size=(BOOT_REPS, nblk))
        idx = (starts[:, :, None] + np.arange(L)[None, None, :]) % T
        idx = idx.reshape(BOOT_REPS, -1)[:, :T]                    # (R, T)
        samples = X[idx]                                           # (R, T, 10)
        mean = samples.mean(axis=1, keepdims=True)
        Z = samples - mean
        COVS_S = np.einsum("rti,rtj->rij", Z, Z) / (T - 1) * 12    # (R,10,10) 연율
        anchors = np.empty(BOOT_REPS)
        d1 = np.empty(BOOT_REPS)
        xe_star = np.empty(BOOT_REPS)
        nA = len(ECON_ASSETS)
        MU = np.empty((BOOT_REPS, nA))
        COVA = np.empty((BOOT_REPS, nA, nA))
        sig_cur = np.empty(BOOT_REPS)
        for r in range(BOOT_REPS):
            covS = COVS_S[r]
            k = alt_scale_of(covS, d["alt_vol"])
            mu, a, _ = mu_vector(covS, rates, d, cost)
            B = loadings(d["h_bond"] / 100, d["h_eq"] / 100, k, d["proxy"])
            C = B @ covS @ B.T
            anchors[r] = a["value"]
            MU[r] = mu
            COVA[r] = C * 10000                                     # %² 단위
            sig_cur[r] = math.sqrt(max(float(w0 @ C @ w0), 0)) * 100
            # 헤지 레버의 자유도는 실질 1개(Xe)다 — 밴드는 사용자 입력이므로
            # 게시하는 분포는 **무제약** Xe* 이고, 밴드 절단은 화면에서 한다.
            xe, smin = hedge_xe_min(covS, w0, k, d["proxy"])
            xe_star[r] = xe * 100
            d1[r] = sig_cur[r] - smin * 100
        targets = np.einsum("ri,i->r", MU, w0)
        W = optimize_batch(MU, COVA, lo, hi, total, targets)
        sig_opt = np.sqrt(np.maximum(np.einsum("ri,rij,rj->r", W, COVA, W), 0))
        d2 = sig_cur - sig_opt
        qs = lambda v: {f"q{q:02d}": round(float(np.percentile(v, q)), 4) for q in Q}
        xe_open = float(w0[1] + w0[3]) * 100      # 전량 미헤지일 때의 Xe (상한)
        out.append({"block_len": L, "n_reps": BOOT_REPS,
                    "anchor": qs(anchors), "d1": qs(d1), "d2": qs(d2),
                    "xe_star": qs(xe_star), "xe_open": round(xe_open, 4),
                    "share_xe_interior": round(float(((xe_star > 0) & (xe_star < xe_open)).mean()), 3)})
    return out


# ---------------------------------------------------------------------------
# 4) build
# ---------------------------------------------------------------------------
def build(series_store: dict, warn) -> dict:
    S = {k: v["s"] for k, v in series_store.items()}
    raw = sources_frame(S, warn)
    M = raw.dropna()
    if len(M) < 120:
        raise ValueError(f"alloc: 공통 표본 {len(M)}개월 < 120 — 원천 시리즈 확인 필요")
    rates = market_rates(S, warn)
    d = dict(DEFAULTS)
    copts = cost_options(S, rates, d["tenor_m"])
    if not any(o["key"] == d["cost_key"] for o in copts):
        d["cost_key"] = copts[0]["key"]     # HP 시리즈 부재 시 폴백(경고는 cost_options 경로에서)
    cost = next(o["v"] for o in copts if o["key"] == d["cost_key"])

    sets = []
    for key, start, label in START_OPTIONS:
        sub = M if start is None else M[M.index >= start]
        if len(sub) < 60:
            continue
        covS = sub.cov().values * 12
        sets.append({"key": key, "label": label,
                     "start": f"{sub.index[0]:%Y-%m}", "end": f"{sub.index[-1]:%Y-%m}",
                     "n_months": int(len(sub)),
                     "mean": [round(float(x) * 12 * 100, 4) for x in sub.mean().values],
                     "cov": [[round(float(v), 10) for v in row] for row in covS]})

    # 최장 표본 — ACWI(공통 표본의 병목, 2006-12 시작)를 빼고 S&P500 TR 전용으로.
    # §7.2-4 의 취지(지수 계열로 25년 공분산)를 표본 선택지로 노출한다.
    # ACWI 행·열은 0 — 이 세트에서는 proxy_only 로 spx 가 강제되어 참조되지 않는다.
    M_spx = raw.drop(columns=["acwi"]).dropna()
    if len(M_spx) >= 60:
        cov9 = M_spx.cov().values * 12
        mean9 = M_spx.mean().values * 12 * 100
        n = len(SOURCE_LABELS)
        cov10 = np.zeros((n, n))
        mean10 = np.zeros(n)
        idx9 = [i for i, k in enumerate(SOURCE_LABELS) if k != "acwi"]
        for a, ia in enumerate(idx9):
            mean10[ia] = round(float(mean9[a]), 4)
            for b, ib in enumerate(idx9):
                cov10[ia, ib] = cov9[a, b]
        sets.append({"key": "spx02", "label": "최장 표본 — S&P500 TR 전용 (ACWI 표본 밖 구간 포함)",
                     "proxy_only": "spx",
                     "start": f"{M_spx.index[0]:%Y-%m}", "end": f"{M_spx.index[-1]:%Y-%m}",
                     "n_months": int(len(M_spx)),
                     "mean": [float(x) for x in mean10],
                     "cov": [[round(float(v), 10) for v in row] for row in cov10]})

    covS = M.cov().values * 12
    k0 = alt_scale_of(covS, d["alt_vol"])
    mu0, a0, sig0 = mu_vector(covS, rates, d, cost)

    # ----- 검증치 게시 (드릴다운 '계산 검증' 표시용) -----
    eig_min = float(np.linalg.eigvalsh(covS).min())
    # 선형 재조립 오차: 정확식 (1+r)(1+(1−h)e)−1+h·f 대비, h=0 에서 최대
    def lin_err(local_col, h):
        j = M[[local_col, "e_usd", "swap"]]
        exact = (1 + j[local_col]) * (1 + (1 - h) * j["e_usd"]) - 1 + h * j["swap"]
        linear = j[local_col] + (1 - h) * j["e_usd"] + h * j["swap"]
        return (float(exact.std()) - float(linear.std())) * math.sqrt(12) * 100
    checks = {
        "min_eig": round(eig_min, 6),
        "lin_err_bond_h0": round(lin_err("us_bond", 0.0), 4),
        "lin_err_eq_h0": round(lin_err("acwi", 0.0), 4),
        "opt_iters_gap": None,   # 아래에서 채움
    }
    # 부트스트랩용 반복 축소(1500)가 점추정(3000)과 얼마나 다른가 — 정직하게 게시
    keys = ECON_ASSETS
    w0 = np.array([d["mix"][kk] for kk in keys]) / 100
    lo = np.array([d["bands"][kk][0] for kk in keys]) / 100
    hi = np.array([d["bands"][kk][1] for kk in keys]) / 100
    check_feasible(lo, hi, float(w0.sum()))
    B0 = loadings(d["h_bond"] / 100, d["h_eq"] / 100, k0, d["proxy"])
    C0 = B0 @ covS @ B0.T * 10000
    tgt = float(mu0 @ w0)
    w_a = optimize(mu0, C0, lo, hi, float(w0.sum()), target=tgt, iters=3000)
    w_b = optimize(mu0, C0, lo, hi, float(w0.sum()), target=tgt, iters=OPT_ITERS)
    checks["opt_iters_gap"] = round(float(np.abs(w_a - w_b).max()) * 100, 4)

    boot = bootstrap(M, rates, d, cost)

    return {
        "asof": f"{M.index[-1]:%Y-%m}",
        "sources": {"labels": SOURCE_LABELS, "desc": SOURCE_DESC},
        "sets": sets,
        "rates": rates,
        "cost_options": copts,
        "anchor_ref": {"basis": "local_ccy",   # 승인 ⑤-ⓑ: 자국통화 기준, 슬라이더 무관
                       "value": round(a0["value"], 6),
                       "kr": {k: round(v, 4) for k, v in a0["kr"].items()},
                       "us": {k: round(v, 4) for k, v in a0["us"].items()}},
        "defaults": d,
        "ccy_bench": CCY_BENCH,
        "boot": {"note": ("기준 상태(defaults·예시 입력)로 빌드 시점 사전계산 — 수기 입력을 "
                          "바꿔도 이 분포는 갱신되지 않습니다(원본 수익률 비공개 제약). "
                          "복제마다 공분산·σ·앵커·μ·최적해를 전부 재추정했습니다."),
                 "rows": boot},
        "checks": checks,
        "acct_model": [
            "① 유효이자 — 상수 (북일드, 수기 입력)",
            "② 환산손익 = 장부금액 × Δ환율",
            "③ 스왑 환파트 = −장부금액 × 헤지비율 × Δ환율 (②와 상쇄)",
            "④ 스왑레이트 캐리 = 장부금액 × 헤지비율 × 체결 스왑레이트",
            "⑤ 스왑 MTM = 장부금액 × 헤지비율 × 잔존만기(만기/2) × (−Δ시장 스왑레이트)",
        ],
        "limits": ("기대수익 디폴트는 사용자 지정 CMA 수치 [키인 정본]입니다 — 키인은 헤지비용 반영 후 "
                   "최종치로 그대로 쓰며 캐리를 다시 더하지 않습니다. 아래는 키인을 비운 자산의 폴백 도출입니다: "
                   "기대수익의 채권·현금은 현재 시장금리 [관측], 주식은 동일 샤프 앵커 [관측→도출], "
                   "대체투자 α·위험과 장부가 북일드는 수기 입력 [가정]입니다. 환율 기대변동은 0으로 "
                   "둡니다(랜덤워크 — 방향 전망은 모델 랩에서). ACWI 는 현재 PR 이라 해외주식 실현 "
                   "수익률이 배당분(연 약 2%p)만큼 과소평가됩니다(§6 TR 확보 시 교체). 앵커와 주식 "
                   "ERP 는 각 시장의 자국통화 기준이라 헤지비율과 무관하며, 헤지비율은 기대수익에 "
                   "비용항(h×스왑레이트)으로만, 위험에 환노출(1−h)로만 들어갑니다. 헤지비용의 현재 "
                   "수준은 실측 HP 곡선을 가중평균 만기로 보간한 값(기본), 이력(공분산의 스왑레이트 "
                   "요인)은 SMB 3M(2001~)입니다 — HP 는 2024-10 시작이라 이력용으로는 짧습니다. "
                   "대체투자는 평가 스무딩으로 실측 변동성이 실제 위험을 과소평가하므로 위험을 "
                   "별도 입력(기본 8%)으로 둡니다. 대체투자는 지분형/대출형 두 분류로 나뉘며, 이 "
                   "프록시층에서는 두 분류가 같은 프록시를 공유합니다(완전상관 — 분류별 위험 구분은 "
                   "벤치마크 층의 팩터 매핑이 담당). 수기 입력은 이 브라우저(localStorage)에만 저장되며 "
                   "서버로 전송되지 않습니다. K-ICS 요구자본 제약은 미반영 — 모델 참고치이지 권고가 "
                   "아닙니다."),
    }
