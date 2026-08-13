# -*- coding: utf-8 -*-
"""환헤지 시뮬레이터 — 통화별 분석·시뮬레이터 데이터 계산.

방법론 (2026-07 초안 논의로 확정):
- 7통화 (USD·EUR·JPY·CNY·AUD·CAD·GBP), 크로스 환율은 달러원 기준 산출
- 경제(시가) 관점: 자산-환율 공분산(자연 쿠션) 반영 최소분산 헤지비율(MVH)
- 회계(손익) 관점: 장부가 채권은 가격변동 미반영, 손익 = 유효이자(상수)
  + (1−h)×환산손익 + h×스왑레이트 캐리(체결 시 확정) + h×스왑 MTM(잔존만기×Δ스왑레이트)
- 헤지비용: 실측(HP 3/6/12M) 우선, 캐나다·파운드는 금리차 프록시
  (달러 기준 실측과 상관 0.89 검증), 달러 장기 이력은 SMB 3M 스왑레이트(2001~)
- 채권 프록시: 달러 = 실지수(미국종합), 기타 = 5년 국채 커브 합성 TR
  (달러로 검증: 실지수와 상관 0.85)
- 단일일 데이터 오류(급등 후 익일 복귀)는 스파이크 필터로 제거
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

import common
# 재수출 — 정의는 common 에만 있다 (tests/test_formulas.py 가 동일성을 단정).
from common import epoch_seconds

CURRENCIES = ["USD", "EUR", "JPY", "CNY", "AUD", "CAD", "GBP"]
NAME = {"USD": "달러", "EUR": "유로", "JPY": "엔", "CNY": "위안",
        "AUD": "호주달러", "CAD": "캐나다달러", "GBP": "파운드"}
DEFAULT_TENOR_M = 9        # 사용자 실무 기준: 금액가중평균 9개월


def despike(s: pd.Series, thr: float = 0.10) -> pd.Series:
    """하루 튀고 다음날 복귀하는 단일일 데이터 오류 제거."""
    chg = s.pct_change()
    bad = (chg.abs() > thr) & (chg.shift(-1).abs() > thr) & (chg * chg.shift(-1) < 0)
    return s[~bad]


def mret(s: pd.Series) -> pd.Series:
    return s.dropna().resample("ME").last().pct_change().dropna()


def synth_bond_tr(y_series: pd.Series, T: int = 5) -> pd.Series:
    """5년 par 쿠폰채 듀레이션 근사 월간 TR: y/12 − D(y)·Δy."""
    y = y_series.dropna().resample("ME").last() / 100
    # y = 0(2022년 일본 등)에서 0/0을 피한다 — 극한값 D→T
    D = ((1 - (1 + y) ** (-T)) / y).where(y != 0, float(T))
    return (y.shift(1) / 12 - D.shift(1) * y.diff()).dropna()


def pack(s: pd.Series, r: int = 2) -> dict:
    return common.pack_values(s, r)


def build(series_store: dict, warn) -> dict:
    S = {k: v["s"] for k, v in series_store.items()}

    def g(key):
        s = S.get(key)
        if s is None:
            warn(f"hedge: 시리즈 없음 — {key}")
        return s

    usdkrw = despike(g("bb:달러원"))
    # 마지막 달은 소스별 관측 종료일이 달라(예: bb 07-20 vs info 07-27) 미완성 월 —
    # 월간 통계·공분산에서 제외한다.
    month_start = usdkrw.index[-1].to_period("M").to_timestamp()

    def cutm(s: pd.Series) -> pd.Series:
        return s[s.index < month_start]
    FX = {
        "USD": usdkrw,
        "EUR": despike(g("info:EURKRW")),
        "JPY": despike(g("info:KRWJPY")),          # 100엔당 원
        "CNY": despike((usdkrw / despike(g("info:USDCNY"))).dropna()),
        "AUD": despike(g("info:AUDKRW")),
        "CAD": despike((usdkrw / despike(g("bb:달러캐나다달러"))).dropna()),
        "GBP": despike((despike(g("bb:파운드달러")) * usdkrw).dropna()),
    }
    BONDS = {
        "USD": cutm(mret(g("bb:미국종합"))),
        "EUR": cutm(synth_bond_tr(g("bb:유로_5y"))),
        "JPY": cutm(synth_bond_tr(g("bb:일본_5y"))),
        "AUD": cutm(synth_bond_tr(g("bb:호주_5y"))),
        "CAD": cutm(synth_bond_tr(g("bb:캐나다_5y"))),
        "GBP": cutm(synth_bond_tr(g("bb:영국_5y"))),
    }
    eq = cutm(mret(g("idx:ACWI")))
    eq_sp = cutm(mret(g("bb:미국_S&P500_TR")))
    kr3m = g("info:한국_3m")
    R3M = {"USD": "bb:미국_3m", "EUR": "bb:유로_3m", "JPY": "bb:일본_3m",
           "AUD": "bb:호주_3m", "CAD": "bb:캐나다_3m", "GBP": "bb:영국_3m"}

    # ----- 헤지비용: 통화별 현재 커브(3/6/12M) + 출처 -----
    # 읽는 법은 `common.hp_curve` **한 곳**에만 있다 — alloc.py 도 같은 함수를 부른다.
    # 예전에는 두 모듈이 같은 시리즈를 각자 `iloc[-1]` 로 읽었고, 우연히 같은 값이
    # 나와 문제가 안 보였다. 한쪽만 바꾸면 같은 화면의 두 숫자가 조용히 갈라진다.
    hp_label = common.hp_read_label()
    cost_curve, cost_src = {}, {}
    hp_asof = None
    for c in CURRENCIES:
        hp = common.hp_curve(S, c)
        if hp is not None:
            cost_curve[c] = hp["curve"]
            cost_src[c] = f"실측(HP) · {hp_label}"
            hp_asof = hp["asof"] if hp_asof is None else max(hp_asof, hp["asof"])
        elif c in R3M and g(R3M[c]) is not None:
            v = round(float((kr3m - S[R3M[c]]).dropna().iloc[-1]), 2)
            cost_curve[c] = {"3M": v, "6M": v, "12M": v}
            cost_src[c] = "금리차 프록시"
        else:
            cost_curve[c] = None
            cost_src[c] = "데이터 필요"

    # ----- 통화 매트릭스 -----
    def span(idx) -> dict | None:
        """표본 구간을 그대로 게시한다 — 통일하지 않는다.

        같은 행 안에서도 열마다 표본이 다르다. `vol_e` 는 환율 월수익률만 쓰므로
        조인 **전**에 계산되고, `mvh`/`corr` 은 채권 프록시와 조인한 **뒤**라
        짧은 쪽에 맞춰 잘린다(실측: EUR·JPY 는 305 vs 294, AUD 는 267 vs 267).
        표에는 「변동성·MVH·상관 = 월간 수익률」 한 줄만 있어 같은 표본으로 읽혔다.

        통일하지 말 것 — 짧은 쪽에 맞추면 EUR·JPY 변동성이 11개월치를 버리고,
        긴 쪽에 맞출 방법은 없다. 게시만 하면 자의성이 0이다.
        """
        if idx is None or not len(idx):
            return None
        return {"start": idx[0].strftime("%Y-%m"),
                "end": idx[-1].strftime("%Y-%m"), "n": int(len(idx))}

    matrix = []
    for c in CURRENCIES:
        e = cutm(mret(FX[c]))
        vol_e = float(e.std()) * math.sqrt(12) * 100
        if c in BONDS:
            j = pd.concat([BONDS[c], e], axis=1).dropna()
            j.columns = ["r", "e"]
            mvh = float(1 + j["r"].cov(j["e"]) / j["e"].var()) * 100
            corr = float(j["r"].corr(j["e"]))
            fit_idx = j.index
        else:
            mvh, corr, fit_idx = None, None, None
        cc = cost_curve[c]
        matrix.append({
            "c": c, "name": NAME[c], "vol_e": round(vol_e, 1),
            "mvh": None if mvh is None else round(mvh),
            "corr": None if corr is None else round(corr, 2),
            "cost_12m": None if cc is None else cc["12M"],
            "cost_curve": cc, "src": cost_src[c],
            "bond_kind": "실지수" if c == "USD" else ("합성(5y 커브)" if c in BONDS else None),
            "active": cc is not None and c in BONDS,
            "sample": {"vol": span(e.index), "fit": span(fit_idx)},
        })

    # ----- 달러: 헤지비율-변동성 곡선, 백테스트, 비용 25년 -----
    e_usd = cutm(mret(FX["USD"]))
    smb3 = g("info:SMB_USDKRW_3M")
    c_m = cutm((smb3.resample("ME").last() / 100 / 12).dropna())

    def vol_curve(r):
        j = pd.concat([r, e_usd], axis=1).dropna()
        j.columns = ["r", "e"]
        vr, ve, cre = j["r"].var(), j["e"].var(), j["r"].cov(j["e"])
        return [round(math.sqrt(max(vr + (1 - h / 100) ** 2 * ve + 2 * (1 - h / 100) * cre, 0) * 12) * 100, 2)
                for h in range(0, 101, 5)]

    curves = {"bond": vol_curve(BONDS["USD"]), "equity": vol_curve(eq_sp)}

    backtest = {}
    for label, r in [("미국 채권(종합)", BONDS["USD"]), ("미국 주식(S&P500 TR)", eq_sp)]:
        df = pd.concat([r, e_usd, c_m], axis=1).dropna()
        df.columns = ["r", "e", "f"]
        rows = []
        for h in [0, 0.5, 1.0]:
            rk = (1 + df["r"]) * (1 + (1 - h) * df["e"]) - 1 + h * df["f"]
            cum = (1 + rk).cumprod()
            yrs = len(rk) / 12
            rows.append({"h": int(h * 100),
                         "cagr": round(((cum.iloc[-1]) ** (1 / yrs) - 1) * 100, 2),
                         "vol": round(float(rk.std()) * math.sqrt(12) * 100, 1),
                         "mdd": round(float((cum / cum.cummax() - 1).min()) * 100, 1)})
        backtest[label] = {"period": f"{df.index[0].strftime('%Y-%m')} ~ {df.index[-1].strftime('%Y-%m')}",
                           "rows": rows}

    smb_m = smb3.resample("ME").last().dropna()
    ds_usd = cutm(smb_m.diff().dropna())    # 스왑레이트 월간 변화 (%p)
    # MTM = τ×(−Δs): 손실은 스왑레이트가 '상승'하는 달에 발생 → 최악 손실월 = Δs 최대월
    mtm_stats = {"sigma_ds_3m": round(float(ds_usd.std()), 2),
                 "worst_ds": round(float(ds_usd.max()), 2),
                 "worst_date": str(ds_usd.idxmax().date()),
                 "series": "3개월 스왑레이트 월간 변화(SMB)",
                 "start": ds_usd.index[0].strftime("%Y-%m"),
                 "end": ds_usd.index[-1].strftime("%Y-%m"),
                 "n_months": int(len(ds_usd)),
                 "corr_ds_e": round(float(ds_usd.corr(e_usd.loc[e_usd.index.intersection(ds_usd.index)] * 100)), 2)}

    # ----- 시뮬레이터 공분산 (월간, 연율화) -----
    cols = {}
    for c in CURRENCIES:
        cols[f"e_{c}"] = cutm(mret(FX[c]))
        if c in BONDS:
            cols[f"b_{c}"] = BONDS[c]
    cols["eq"] = eq
    # 스왑레이트 변화(MTM) 팩터: 전 통화에 달러 실측(SMB, 2001~)을 공통 적용.
    # 검증 결과 금리차 '변화' 프록시는 실제 스왑레이트 변화와 상관 0.07에
    # 불과하고 변동성을 41% 과소평가 — KRW 크로스커런시 스왑의 변동은
    # 원화 자금시장 공통요인이 지배하므로 달러 실측이 더 나은 대용이다.
    for c in CURRENCIES:
        if c in BONDS or c == "USD":
            cols[f"ds_{c}"] = ds_usd / 100
    Mx = pd.DataFrame(cols).dropna()
    labels = list(Mx.columns)
    cov = (Mx.cov() * 12).round(8)

    # ----- 헤지비용 일별 이력 (달러 3/6/12M) -----
    # 예전에는 `fx.json` 이 실었다. 이 값은 시세가 아니라 **시뮬레이터가 만기를
    # 보간하는 곡선의 원자료**이므로(hedgeCostAt 이 쓰는 3/6/12M 이 바로 이것),
    # 환헤지 화면의 질문 안에 있다. 무엇보다 `renderHedge` 가 `DATA.fx` 를 읽으면
    # fx.json 하나가 깨질 때 #hedge 까지 「데이터 없음」이 된다 —
    # Promise.allSettled 의 부분 실패는 정상 경로이므로 그 전파를 끊는다.
    # **fx.json 쪽에서는 제거한다** — 같은 값이 두 JSON 에 실리면 새 이중 진실이다.
    cost_hist_curve = {}
    for m in ["3M", "6M", "12M"]:
        s = g(f"info:USDKRW_HP_{m}")
        if s is not None:
            cost_hist_curve[m] = pack(s.dropna(), 3)

    # ----- 미국채 투자 메리트 — 헤지 후 원화수익률 vs 국고 (2026-08-12 사용자 요청) -----
    # 사용자 관심 관계: 위험수준 ↔ 환헤지 비용, 그리고 "비용은 미국채 수익률에서
    # 차감된다"는 맥락의 투자 메리트. 산식은 항등식 수준이라 임의 계수가 없다:
    #   헤지 후 UST = UST10y + 스왑레이트  (부호 규약 공유 — 양수 = 받음이므로 덧셈.
    #                                       내는 국면에서는 스왑레이트가 음수라 차감이 된다)
    #   메리트 스프레드 = 헤지 후 UST − 국고10y
    # 이력 축은 SMB 3M 연율(2001~) — 화면 매트릭스의 현재 수준(HP 12M)과 계열이 다르므로
    # 화면이 반드시 두 만기를 구분해 적어야 한다(cost_stats 의 역할 분담과 동일).
    # 시리즈가 없으면 active:false 로 게시한다(bm.build_cma 와 같은 체인 안전장치).
    ust10 = g("info:UST10y")
    ktb10 = g("info:한국_10y")
    if ust10 is None or ktb10 is None:
        ust_merit = {"active": False, "reason": "원천 시리즈 없음 (info:UST10y / info:한국_10y)"}
    else:
        jm = pd.concat([ust10, ktb10, smb3], axis=1).dropna()
        jm.columns = ["ust", "ktb", "cost"]
        wk = jm.resample("W-FRI").last().dropna()
        hedged = wk["ust"] + wk["cost"]
        spread = hedged - wk["ktb"]
        cur = float(spread.iloc[-1])
        ust_merit = {
            "active": True,
            "asof": wk.index[-1].strftime("%Y-%m-%d"),
            "freq": "W-FRI",
            "series": {"cost": "3개월 스왑레이트(SMB, 연율)", "ust": "미국채 10년",
                       "ktb": "국고 10년"},
            "start": wk.index[0].strftime("%Y-%m"),
            "n_weeks": int(len(wk)),
            "t": epoch_seconds(wk.index),
            "cost": [round(float(x), 3) for x in wk["cost"]],
            "ust": [round(float(x), 3) for x in wk["ust"]],
            "ktb": [round(float(x), 3) for x in wk["ktb"]],
            "hedged": [round(float(x), 3) for x in hedged],
            "spread": [round(float(x), 3) for x in spread],
            "now": {"cost": round(float(wk["cost"].iloc[-1]), 3),
                    "ust": round(float(wk["ust"].iloc[-1]), 3),
                    "ktb": round(float(wk["ktb"].iloc[-1]), 3),
                    "hedged": round(float(hedged.iloc[-1]), 3),
                    "spread": round(cur, 3),
                    # 현재 스프레드의 자기 이력 내 백분위 — 관측 통계(임의 기준 아님)
                    "spread_pctile": round(float((spread <= cur).mean() * 100), 1)},
        }

    payload = {
        "asof": usdkrw.index[-1].strftime("%Y-%m-%d"),
        "default_tenor_m": DEFAULT_TENOR_M,
        # 헤지비용 커브를 어떻게 읽었는지 — 화면 부제가 이 값을 그대로 쓴다.
        # 하드코딩하면 `HP_MEDIAN_N` 을 되돌려도 화면 문장만 남는다
        # (이 저장소는 「25년 평균」 하드코딩으로 같은 사고를 한 번 겪었다).
        "cost_read": {"label": hp_label, "window": common.HP_MEDIAN_N,
                      "asof": None if hp_asof is None else hp_asof.strftime("%Y-%m-%d")},
        "matrix": matrix,
        "curves": curves,
        "backtest": backtest,
        "cost_hist_curve": cost_hist_curve,
        "cost_hist_usd": pack(smb_m),
        "ust_merit": ust_merit,
        # 계열명·표본기간·관측수를 함께 싣는다 — 화면이 「25년 평균」을 하드코딩하고
        # 있었다. 표본이 늘거나 줄어도 문장이 25년에 멈춰 있으면 거짓이 된다
        # (이 저장소는 「주식 10%는 어느 산식에서도 나오지 않는 수」로 같은 사고를
        # 한 번 겪었다). 수준은 HP, 이력은 SMB 라는 역할 분담도 여기서 밝힌다.
        "cost_stats": {"mean": round(float(smb_m.mean()), 2),
                       "now": round(float(smb_m.iloc[-1]), 2),
                       "min": round(float(smb_m.min()), 2),
                       "series": "3개월 스왑레이트(SMB, 월말)",
                       "start": smb_m.index[0].strftime("%Y-%m"),
                       "end": smb_m.index[-1].strftime("%Y-%m"),
                       "n_months": int(len(smb_m)),
                       "years": round(len(smb_m) / 12, 1)},
        "mtm": mtm_stats,
        "sim": {"labels": labels, "cov": cov.values.tolist(),
                "sample": f"{Mx.index[0].strftime('%Y-%m')} ~ {Mx.index[-1].strftime('%Y-%m')}",
                "n_months": int(len(Mx))},
        "acct_model": [
            "① 유효이자 — 상수 (변동성 없음)",
            "② 환산손익 = 장부금액 × Δ환율",
            "③ 스왑 환파트 = −장부금액 × 헤지비율 × Δ환율 (②와 동액 상쇄)",
            "④ 스왑레이트 캐리 = 장부금액 × 헤지비율 × 체결 스왑레이트 (계약 기간 확정)",
            "⑤ 스왑 MTM = 장부금액 × 헤지비율 × 잔존만기 × (−Δ시장 스왑레이트)",
        ],
        "limits": (f"유로·엔·호주·캐나다·파운드 채권은 5년 국채 커브 합성 수익률(실지수 확보 시 교체, "
                   "달러 검증: 실지수와 상관 0.85). 위안은 단기금리·헤지비용 데이터 확보 전까지 비활성. "
                   "캐나다·파운드 헤지비용 '수준'은 금리차 프록시(달러 실측과 상관 0.89 검증). "
                   "스왑 MTM의 Δ스왑레이트는 전 통화에 달러 실측(2001~)을 공통 적용 — 금리차 '변화' "
                   "프록시는 실측과 상관 0.07로 검증에 실패해 채택하지 않았습니다(통화별 실측 확보 시 교체). "
                   "월간 통계는 완성된 달까지만 사용. 스왑 MTM 손실은 스왑레이트 상승 시 발생합니다. "
                   f"헤지비용 커브는 {hp_label}입니다 — 일간 호가 변화의 1차 자기상관이 "
                   "12계열 전부 음수(−0.15~−0.63)라 되돌아오는 측정잡음이고, 최신 호가를 "
                   "그대로 쓰면 한 번의 빌드로 게시값이 최대 5.50%p 움직입니다(중앙값 적용 후 0.53%p). "
                   "대신 표시가 2영업일 뒤처집니다. "
                   "중앙값은 커브의 비단조성을 고치지 못합니다 — 3/6/12개월이 한 방향으로 "
                   "정렬되지 않는 날이 달러 34.2%→34.8%, 유로 26.4%→28.8%, 엔 10.0%→10.6%, "
                   "호주 23.0%→23.0% 로 오히려 늘거나 그대로입니다(비단조성은 잡음이 아니라 "
                   "커브의 실제 성질입니다). "
                   "K-ICS 요구자본·증거금·중도 청산 관점은 미반영. 기대수익 예측이 아닌 변동성·비용 계산기입니다."),
    }
    return payload
