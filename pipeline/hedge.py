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


def epoch_seconds(index: pd.DatetimeIndex) -> list[int]:
    delta = index - pd.Timestamp("1970-01-01")
    return [int(x) for x in (delta // pd.Timedelta(seconds=1))]


def pack(s: pd.Series, r: int = 2) -> dict:
    s = s.dropna()
    return {"t": epoch_seconds(s.index), "v": [round(float(v), r) for v in s.values]}


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
    cost_curve, cost_src = {}, {}
    for c in CURRENCIES:
        # 인포맥스 HP 시리즈 키: USDKRW_HP_3M / JPYKRW_HP_3M ...
        hp = {m: S.get(f"info:{'USDKRW' if c == 'USD' else c + 'KRW'}_HP_{m}")
              for m in ["3M", "6M", "12M"]}
        if all(v is not None for v in hp.values()):
            cost_curve[c] = {m: round(float(hp[m].dropna().iloc[-1]), 2) for m in hp}
            cost_src[c] = "실측(HP)"
        elif c in R3M and g(R3M[c]) is not None:
            v = round(float((kr3m - S[R3M[c]]).dropna().iloc[-1]), 2)
            cost_curve[c] = {"3M": v, "6M": v, "12M": v}
            cost_src[c] = "금리차 프록시"
        else:
            cost_curve[c] = None
            cost_src[c] = "데이터 필요"

    # ----- 통화 매트릭스 -----
    matrix = []
    for c in CURRENCIES:
        e = cutm(mret(FX[c]))
        vol_e = float(e.std()) * math.sqrt(12) * 100
        if c in BONDS:
            j = pd.concat([BONDS[c], e], axis=1).dropna()
            j.columns = ["r", "e"]
            mvh = float(1 + j["r"].cov(j["e"]) / j["e"].var()) * 100
            corr = float(j["r"].corr(j["e"]))
        else:
            mvh, corr = None, None
        cc = cost_curve[c]
        matrix.append({
            "c": c, "name": NAME[c], "vol_e": round(vol_e, 1),
            "mvh": None if mvh is None else round(mvh),
            "corr": None if corr is None else round(corr, 2),
            "cost_12m": None if cc is None else cc["12M"],
            "cost_curve": cc, "src": cost_src[c],
            "bond_kind": "실지수" if c == "USD" else ("합성(5y 커브)" if c in BONDS else None),
            "active": cc is not None and c in BONDS,
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

    payload = {
        "asof": usdkrw.index[-1].strftime("%Y-%m-%d"),
        "default_tenor_m": DEFAULT_TENOR_M,
        "matrix": matrix,
        "curves": curves,
        "backtest": backtest,
        "cost_hist_usd": pack(smb_m),
        "cost_stats": {"mean": round(float(smb_m.mean()), 2),
                       "now": round(float(smb_m.iloc[-1]), 2),
                       "min": round(float(smb_m.min()), 2)},
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
        "limits": ("유로·엔·호주·캐나다·파운드 채권은 5년 국채 커브 합성 수익률(실지수 확보 시 교체, "
                   "달러 검증: 실지수와 상관 0.85). 위안은 단기금리·헤지비용 데이터 확보 전까지 비활성. "
                   "캐나다·파운드 헤지비용 '수준'은 금리차 프록시(달러 실측과 상관 0.89 검증). "
                   "스왑 MTM의 Δ스왑레이트는 전 통화에 달러 실측(2001~)을 공통 적용 — 금리차 '변화' "
                   "프록시는 실측과 상관 0.07로 검증에 실패해 채택하지 않았습니다(통화별 실측 확보 시 교체). "
                   "월간 통계는 완성된 달까지만 사용. 스왑 MTM 손실은 스왑레이트 상승 시 발생합니다. "
                   "K-ICS 요구자본·증거금·중도 청산 관점은 미반영. 기대수익 예측이 아닌 변동성·비용 계산기입니다."),
    }
    return payload
