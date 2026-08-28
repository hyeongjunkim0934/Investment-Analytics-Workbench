# -*- coding: utf-8 -*-
"""리스크 스코어보드 — 요인 점수·합성·이벤트 계산.

방법론 (2026-07 walk-forward 검증으로 확정 — pipeline/research/wf_validation.py):
- 지표 점수 = 전체 이력 확장 창 백분위 (0~100, 최소 관측 일별 1000 / 월별 60)
- 현재 위험(스트레스) 합성 = IC가중 + 최소바닥 8%
  · 가중치는 매 4주 재학습(walk-forward), 학습 타깃 = 향후 1개월 실현변동성
  · 엠바고 5주로 타깃 겹침 차단 — 과거 합성값도 당시 가중치로 계산 (사후 적용 금지)
- 잠재 위험(취약성) 합성 = 활성 요인 동일가중
  · 근거: 잠재 층의 목적은 단기 예측이 아닌 축적 감시 — 가중 학습은 모델 랩에서 별도 검증 예정
- 등급 = 점수 4등분: 낮음(<25) 보통(<50) 주의(<75) 경계(≥75)
"""

from __future__ import annotations

import math
from datetime import timedelta

import numpy as np
import pandas as pd

import common
# spearman/auc 는 이 파일에서 직접 쓰고, epoch_seconds 는 재수출이다 —
# 정의는 전부 common 에만 있다 (tests/test_formulas.py 가 동일성을 단정).
from common import auc, epoch_seconds, spearman

MIN_DAILY = 1000      # 일별 지표 최소 관측 (약 4년)
MIN_MONTHLY = 60      # 월별 지표 최소 관측 (5년)
EMBARGO_W = 5         # 주 — 학습 시 타깃 겹침 차단
REFIT_EVERY_W = 4     # 주 — 가중치 재학습 주기
TRAIN_MIN_W = 156     # 주 — 최초 학습에 필요한 최소 표본 (3년)
FLOOR = 0.08          # 최소 가중 바닥 (커버리지 보험)
HIST_WEEKS = 115      # 화면에 게시할 주별 이력 (~26개월)
EVENT_LOOKBACK_D = 45

GRADE_BANDS = [(0, 25, "낮음"), (25, 50, "보통"), (50, 75, "주의"), (75, 100, "경계")]


def chg_of(weekly: pd.Series, cur: float) -> dict:
    """현재 점수의 1개월·3개월·1년 전 대비 변화 — 요인·층이 같은 산식을 쓴다."""
    out = {}
    for k, days in (("m1", 28), ("m3", 91), ("y1", 365)):
        prev = weekly[weekly.index <= weekly.index[-1] - timedelta(days=days)]
        out[k] = round(cur - float(prev.iloc[-1]), 1) if len(prev) else None
    return out


def rank5y(weekly: pd.Series, cur: float) -> float | None:
    """현재 점수가 최근 5년(260주) 주간 이력에서 백분위 몇 %인지 — 층 맥락 표시용."""
    w = weekly.dropna().tail(260)
    if len(w) < 52:
        return None
    return round(float((w <= cur).mean() * 100), 0)


def grade(score) -> str | None:
    if score is None:
        return None
    for lo, hi, name in GRADE_BANDS:
        if score < hi or hi == 100:
            return name
    return None


def pack_series(s: pd.Series, round_to: int = 1) -> dict:
    return common.pack_values(s, round_to)


# ---------------------------------------------------------------------------
# 지표 점수화
# ---------------------------------------------------------------------------

def expanding_pctl(s: pd.Series, min_periods: int) -> pd.Series:
    """전체 이력 확장 창 백분위 (look-ahead 없음)."""
    return s.dropna().expanding(min_periods=min_periods).rank(pct=True) * 100


def transform(pct: pd.Series, mode: str) -> pd.Series:
    if mode == "hi":       # 높을수록 위험
        return pct
    if mode == "lo":       # 낮을수록 위험
        return 100 - pct
    if mode == "up":       # 상방 초과분만 (중앙값 이하 = 0)
        return ((pct - 50) * 2).clip(lower=0)
    raise ValueError(mode)


class Indicator:
    def __init__(self, label, series, mode, fmt, unit="", desc="", monthly=False):
        self.label, self.desc, self.unit, self.fmt = label, desc, unit, fmt
        self.mode = mode
        raw = series.dropna()
        if monthly:
            raw = raw.resample("ME").last().dropna()
        self.raw = raw
        min_p = MIN_MONTHLY if monthly else MIN_DAILY
        self.pct = expanding_pctl(raw, min_p)          # 순수 백분위
        self.score_s = transform(self.pct, mode)       # 위험 점수 시계열
        self.monthly = monthly

    def ok(self) -> bool:
        return len(self.score_s.dropna()) > 0

    def weekly(self) -> pd.Series:
        w = self.score_s.resample("W-FRI").last()
        return w.ffill(limit=6) if self.monthly else w

    def current(self) -> dict:
        v = float(self.raw.iloc[-1])
        sc = float(self.score_s.dropna().iloc[-1])
        pct = float(self.pct.dropna().iloc[-1])
        return {"label": self.label, "desc": self.desc,
                "value": self.fmt.format(v), "unit": self.unit,
                "pctl": round(pct, 1), "score": round(sc, 1),
                "date": self.raw.index[-1].strftime("%Y-%m-%d"),
                "since": int(self.raw.index[0].year),
                "spark": pack_series(
                    self.raw[self.raw.index >= self.raw.index[-1] - pd.DateOffset(months=24)]
                    .resample("W-FRI").last(), 2)}


def step_text(ind_cur: dict, mode: str) -> str:
    """상세 화면 '점수가 나오는 과정' 문장."""
    base = (f"{ind_cur['label']} 오늘 값 {ind_cur['value']}{ind_cur['unit']}"
            f" → {ind_cur['since']}년 이후 이력에서 백분위 {ind_cur['pctl']:.0f}%")
    if mode == "hi":
        return f"{base} → {ind_cur['score']:.0f}점"
    if mode == "lo":
        return f"{base} → 낮을수록 위험이므로 100 − {ind_cur['pctl']:.0f} = {ind_cur['score']:.0f}점"
    return (f"{base} → 상방 초과분만 반영: max(0, 2×({ind_cur['pctl']:.0f}−50)) "
            f"= {ind_cur['score']:.0f}점")


# ---------------------------------------------------------------------------
# 메인 빌드
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# 요인 정의 (모듈 수준) — 배포 코드(build)와 연구 하네스(research/wf_validation)가
# **같은 정의**를 쓰도록 build() 밖으로 끌어냈다. 예전에는 wf_validation.py 가
# 요인·지표·부호를 자기 파일에 따로 적어 두어, 한쪽만 고치면 "검증된 방법론"과
# "실제 게시되는 점수"가 조용히 갈라졌다.
# ---------------------------------------------------------------------------

def derive_inputs(S: dict, warn=None) -> dict:
    """{key: Series} -> 요인 계산에 쓰는 원천·파생 시리즈 한 벌.

    S 는 process.SERIES 의 값 부분({key: pd.Series}) 이다.
    """
    if warn is None:
        def warn(_msg):
            return None

    def g(key):
        s = S.get(key)
        if s is None:
            warn(f"risk: 시리즈 없음 — {key}")
        return s

    # ----- 원천·파생 시리즈 -----
    kospi = g("bb:한국_KOSPI_TR")
    acwi = g("idx:ACWI")
    usdkrw = g("bb:달러원")          # 2001년 시작 (검증 사양)
    vix, vkospi = g("info:VIX"), g("info:VKOSPI")
    hy, ig = g("bb:미국_하이일드_스프레드"), g("bb:미국_투자등급_스프레드")
    kr3y = g("info:한국_3y")
    kr_card = ((g("info:Card_AA_plus_3y") - kr3y) * 100).dropna()
    fxvol = (usdkrw.pct_change().rolling(20).std() * math.sqrt(252) * 100).dropna()
    # 환율 수준은 구조적 상승 추세라 확장 백분위가 영구 고위험으로 읽힌다(2026-08-24
    # 사용자 지시로 교체) — 이격도 규약(200일선, disp_k200 과 동일)으로 추세를 벗긴다.
    fx_disp = ((usdkrw / usdkrw.rolling(200).mean() - 1) * 100).dropna()
    dd_acwi = (acwi / acwi.cummax() - 1) * 100
    dd_kospi = (kospi / kospi.cummax() - 1) * 100
    us_slope = ((g("info:UST10y") - g("info:UST2y")) * 100).dropna()
    kr_slope = ((g("info:한국_10y") - kr3y) * 100).dropna()
    disp_k = ((kospi / kospi.rolling(120).mean() - 1) * 100).dropna()
    disp_a = ((acwi / acwi.rolling(120).mean() - 1) * 100).dropna()
    disp_k200 = ((kospi / kospi.rolling(200).mean() - 1) * 100).dropna()
    disp_a200 = ((acwi / acwi.rolling(200).mean() - 1) * 100).dropna()
    unemp_us = g("bb:미국_실업률")
    cds_kr, cds_jp, cds_de = (g("bb:한국_CDS_5년물"),
                              g("bb:일본_CDS_5년물"),
                              g("bb:독일_CDS_5년물"))

    # 삼 룰 (미국)
    u_m = unemp_us.resample("ME").last().dropna()
    u3 = u_m.rolling(3).mean()
    sahm = (u3 - u3.rolling(12).min()).dropna()
    sahm_now = float(sahm.iloc[-1])
    sahm_fired = sahm_now >= 0.5

    return {
        "kospi": kospi,
        "acwi": acwi,
        "usdkrw": usdkrw,
        "vix": vix,
        "vkospi": vkospi,
        "hy": hy,
        "ig": ig,
        "kr3y": kr3y,
        "kr_card": kr_card,
        "fxvol": fxvol,
        "fx_disp": fx_disp,
        "dd_acwi": dd_acwi,
        "dd_kospi": dd_kospi,
        "us_slope": us_slope,
        "kr_slope": kr_slope,
        "disp_k": disp_k,
        "disp_a": disp_a,
        "disp_k200": disp_k200,
        "disp_a200": disp_a200,
        "unemp_us": unemp_us,
        "cds_kr": cds_kr,
        "cds_jp": cds_jp,
        "cds_de": cds_de,
        "sahm": sahm,
        "sahm_now": sahm_now,
        "sahm_fired": sahm_fired,
    }


def factor_specs(D: dict) -> list[dict]:
    """derive_inputs() 결과 -> 요인 정의 리스트 (스트레스 6 + 취약성 5).

    각 원소: dict(key, layer, name, sub, question, tags, inds=[Indicator], note?, pending?)
    연구 하네스는 layer == "stress" 인 요인만 쓴다.
    """
    (vix, vkospi, dd_acwi, dd_kospi,
     hy, ig, kr_card, cds_kr,
     cds_jp, cds_de, fxvol, fx_disp,
     us_slope, kr_slope, disp_k, disp_a,
     disp_k200, disp_a200, unemp_us, sahm_now,
     sahm_fired) = (
        D["vix"], D["vkospi"], D["dd_acwi"], D["dd_kospi"],
        D["hy"], D["ig"], D["kr_card"], D["cds_kr"],
        D["cds_jp"], D["cds_de"], D["fxvol"], D["fx_disp"],
        D["us_slope"], D["kr_slope"], D["disp_k"], D["disp_a"],
        D["disp_k200"], D["disp_a200"], D["unemp_us"], D["sahm_now"],
        D["sahm_fired"])

    FACTORS = [
        # ----- 현재 위험 (스트레스) -----
        dict(key="vol", layer="stress", name="변동성",
             sub="시장이 얼마나 요동치나", question="시장이 얼마나 요동치고 있는가",
             tags=["vol"],
             inds=[Indicator("VIX", vix, "hi", "{:.1f}", desc="미국 주식시장 예상 변동성"),
                   Indicator("VKOSPI", vkospi, "hi", "{:.1f}", desc="국내 주식시장 예상 변동성")]),
        dict(key="dd", layer="stress", name="주식 낙폭",
             sub="고점에서 얼마나 내려왔나", question="주가가 고점 대비 얼마나 내려왔는가",
             tags=["dd"],
             inds=[Indicator("ACWI 고점 대비", dd_acwi, "lo", "{:+.1f}", "%", "글로벌 주식 낙폭"),
                   Indicator("KOSPI TR 고점 대비", dd_kospi, "lo", "{:+.1f}", "%", "국내 주식 낙폭")]),
        dict(key="spread", layer="stress", name="스프레드 확대",
             sub="크레딧 위험보상이 얼마나 치솟았나", question="크레딧 스프레드가 얼마나 벌어졌는가",
             tags=["spread"],
             inds=[Indicator("미국 HY 스프레드", hy, "hi", "{:.2f}", "%p", "미국 하이일드 위험보상"),
                   Indicator("카드채 AA+ 3y − 국고 3y", kr_card, "hi", "{:.0f}", "bp", "국내 크레딧 위험보상")]),
        dict(key="cds", layer="stress", name="국가신용 (CDS)",
             sub="국가 부도 보험료가 오르고 있나", question="국가신용 위험이 커지고 있는가",
             tags=["cds"],
             inds=[Indicator("한국 CDS 5년", cds_kr, "hi", "{:.0f}", "bp"),
                   Indicator("일본 CDS 5년", cds_jp, "hi", "{:.0f}", "bp"),
                   Indicator("독일 CDS 5년", cds_de, "hi", "{:.0f}", "bp")]),
        dict(key="fx", layer="stress", name="환율",
             sub="원화가 얼마나 불안한가", question="원화 환율이 얼마나 불안정한가",
             tags=["fx"],
             inds=[Indicator("달러/원 20일 변동성(연율)", fxvol, "hi", "{:.1f}", "%"),
                   Indicator("달러/원 / 200일선", fx_disp, "hi", "{:+.1f}", "%",
                             desc="추세 대비 원화 약세 이격")],
             note=("수준 지표를 200일선 이격으로 교체(2026-08-24) — 달러/원 수준은 "
                   "구조적 상승 추세라 이력 백분위가 영구히 고위험으로 읽혔습니다. "
                   "이격은 추세 대비 급격한 절하만 잡습니다.")),
        dict(key="curve", layer="stress", name="커브",
             sub="장단기 금리가 침체를 가리키나", question="장단기 금리차가 침체를 예고하는가",
             tags=["curve"],
             inds=[Indicator("미국 10년−2년", us_slope, "lo", "{:+.0f}", "bp"),
                   Indicator("한국 10년−3년", kr_slope, "lo", "{:+.0f}", "bp")],
             note="역전(음수)은 12~18개월 선행 침체 신호 — 1개월 지평 예측력은 낮아 학습 가중이 작고, 최소바닥 8%로 감시를 유지합니다."),
        # ----- 잠재 위험 (취약성) -----
        dict(key="valuation", layer="vuln", name="밸류에이션",
             sub="주가가 이익 대비 얼마나 비싼가", question="주가가 이익 대비 얼마나 비싼가",
             tags=[], pending="포워드 PER 업로드 시 자동 활성화 (KOSPI·ACWI 12M 포워드 PER)"),
        dict(key="disp", layer="vuln", name="과열 이격도",
             sub="주가가 평균 추세보다 얼마나 위에 있나", question="주가가 추세 대비 얼마나 과열됐는가",
             tags=["dd"],
             inds=[Indicator("KOSPI TR / 120일선", disp_k, "up", "{:+.1f}", "%"),
                   Indicator("ACWI / 120일선", disp_a, "up", "{:+.1f}", "%"),
                   Indicator("KOSPI TR / 200일선", disp_k200, "up", "{:+.1f}", "%"),
                   Indicator("ACWI / 200일선", disp_a200, "up", "{:+.1f}", "%")],
             note="하방 이격(추세 아래)은 취약성이 아니라 현재 위험(주식 낙폭)에서 집계합니다."),
        dict(key="revision", layer="vuln", name="이익 리비전",
             sub="이익 전망이 상향인가 하향인가", question="이익 전망이 상향인가 하향인가",
             tags=[], pending="포워드 PER 업로드 시 자동 활성화 (내재 포워드 EPS 3개월 변화율)"),
        dict(key="compress", layer="vuln", name="스프레드 압축",
             sub="크레딧 위험보상이 얼마나 얇아졌나", question="위험보상이 얼마나 얇아져 있는가",
             tags=["spread"],
             inds=[Indicator("미국 HY 스프레드", hy, "lo", "{:.2f}", "%p"),
                   Indicator("미국 IG 스프레드", ig, "lo", "{:.2f}", "%p"),
                   Indicator("카드채 AA+ 3y − 국고 3y", kr_card, "lo", "{:.0f}", "bp")],
             note="좁은 스프레드 = 위험보상 부족 상태의 누적 (안일함)."),
        dict(key="cycle", layer="vuln", name="사이클 위치",
             sub="경기 사이클의 어느 지점인가", question="경기 사이클의 어느 지점에 있는가",
             tags=["cycle"],
             inds=[Indicator("미국 실업률", unemp_us, "lo", "{:.1f}", "%", monthly=True)],
             note=(f"실업률 저점권 = 사이클 후반. 삼 룰(침체 판별): 현재 {sahm_now:+.2f}%p — "
                   f"{'발동' if sahm_fired else '미발동'} (기준 +0.50%p). 한국 실업률 업로드 시 확장.")),
    ]
    return FACTORS


def build(series_store: dict, warn) -> tuple[dict, dict]:
    S = {k: v["s"] for k, v in series_store.items()}
    D = derive_inputs(S, warn)
    FACTORS = factor_specs(D)
    kospi, acwi, usdkrw = D["kospi"], D["acwi"], D["usdkrw"]
    vix, vkospi, hy = D["vix"], D["vkospi"], D["hy"]
    fxvol, us_slope, kr_slope, sahm = D["fxvol"], D["us_slope"], D["kr_slope"], D["sahm"]


    # ----- 요인 점수 계산 -----
    factors_out = []
    weekly_by_key = {}
    for f in FACTORS:
        if f.get("pending"):
            factors_out.append(dict(key=f["key"], layer=f["layer"], name=f["name"],
                                    sub=f["sub"], question=f["question"],
                                    pending=f["pending"], score=None, grade=None))
            continue
        inds = [i for i in f["inds"] if i.ok()]
        if not inds:
            warn(f"risk: 요인 '{f['name']}' 지표 없음 — 건너뜀")
            factors_out.append(dict(key=f["key"], layer=f["layer"], name=f["name"],
                                    sub=f["sub"], question=f["question"],
                                    pending="지표 데이터 부족", score=None, grade=None))
            continue
        # 지표 시작 전(미탄생)은 부분 평균을 허용하되, 이미 시작된 지표가
        # 빠진 주(소스별 최종 관측일 차이로 생기는 꼬리 버킷)는 제외한다 —
        # 일부 지표만 남은 마지막 주가 요인 값을 왜곡하는 것을 막는다.
        cols = pd.concat([i.weekly() for i in inds], axis=1)
        started = pd.concat(
            [(cols.index.to_series() >= c.first_valid_index()) for _, c in cols.items()],
            axis=1)
        complete = cols.notna().sum(axis=1) >= started.sum(axis=1)
        weekly = cols.mean(axis=1)[complete].dropna()
        weekly_by_key[f["key"]] = weekly
        curs = [i.current() for i in inds]
        score = round(float(np.mean([c["score"] for c in curs])), 1)
        f_chg = chg_of(weekly, score)
        steps = [f"{'①②③④⑤'[i]} {step_text(c, ind.mode)}"
                 for i, (c, ind) in enumerate(zip(curs, inds))]
        steps.append(f"요인 점수 = 지표 평균 = {score:.0f}점 → 등급 {grade(score)}")
        hist = weekly.tail(HIST_WEEKS)
        factors_out.append(dict(
            key=f["key"], layer=f["layer"], name=f["name"], sub=f["sub"],
            question=f["question"], tags=f["tags"],
            score=score, grade=grade(score), delta=f_chg["m1"], chg=f_chg,
            hist=pack_series(hist), indicators=curs, steps=steps,
            note=f.get("note")))

    stress_keys = [f["key"] for f in FACTORS if f["layer"] == "stress" and f["key"] in weekly_by_key]
    vuln_keys = [f["key"] for f in FACTORS if f["layer"] == "vuln" and f["key"] in weekly_by_key]
    fmap = {f["key"]: f for f in factors_out}

    # ----- 현재 위험: walk-forward IC가중 + 바닥 -----
    F = pd.DataFrame({k: weekly_by_key[k] for k in stress_keys}).dropna()

    def fwd_vol_target() -> pd.Series:
        out = {}
        for d in F.index:
            vols = []
            for p in (kospi, acwi):
                p = p.dropna()
                i = p.index.searchsorted(d, side="right")
                seg = p.iloc[i:i + 22]
                if len(seg) >= 15:
                    vols.append(float(seg.pct_change().dropna().std() * math.sqrt(252) * 100))
            if vols:
                out[d] = float(np.mean(vols))
        return pd.Series(out)

    tgt = fwd_vol_target()

    def ic_floor_weights(train_idx) -> np.ndarray | None:
        ics = np.array([spearman(F.loc[train_idx, k], tgt.loc[train_idx]) for k in stress_keys])
        w = np.clip(np.nan_to_num(ics), 0, None)
        if w.sum() <= 0:
            return None
        w = w / w.sum()
        w = np.maximum(w, FLOOR)
        return w / w.sum()

    eq_w = np.ones(len(stress_keys)) / len(stress_keys)
    comp_ic = pd.Series(index=F.index, dtype=float)
    comp_eq = pd.Series(F.values @ eq_w, index=F.index)
    cur_w, last_refit = None, None
    refit_marks = set(F.index[::REFIT_EVERY_W])
    for t in F.index:
        if t in refit_marks:
            cutoff = t - pd.Timedelta(weeks=EMBARGO_W)
            train_idx = F.index[(F.index <= cutoff) & F.index.isin(tgt.index)]
            if len(train_idx) >= TRAIN_MIN_W:
                w = ic_floor_weights(train_idx)
                if w is not None:
                    cur_w, last_refit = w, t
        if cur_w is not None:
            comp_ic[t] = float(F.loc[t].values @ cur_w)
    comp_ic = comp_ic.dropna()

    if cur_w is None:       # 학습 표본 부족 → 동일가중 폴백 (경고와 함께)
        warn("risk: IC가중 학습 표본 부족 — 동일가중 폴백")
        cur_w = eq_w
        comp_ic = comp_eq

    stress_cur = round(float(np.array([fmap[k]["score"] for k in stress_keys]) @ cur_w), 1)
    stress_chg = chg_of(comp_ic, stress_cur)
    stress_delta = stress_chg["m1"]

    # 요인별 가중치 주입 (상세 화면 표기용)
    for k, w in zip(stress_keys, cur_w):
        fmap[k]["weight"] = round(float(w), 3)

    # 표본 외 성능 (2010~, 게시용)
    oos = comp_ic.index[comp_ic.index >= "2010-01-01"]

    def fwd_min_target() -> pd.Series:
        out = {}
        for d in F.index:
            mins = []
            for p in (kospi, acwi):
                p = p.dropna()
                i = p.index.searchsorted(d, side="right")
                seg = p.iloc[i:i + 22]
                if len(seg) >= 15 and i > 0:
                    mins.append(float(seg.min() / p.iloc[i - 1] - 1) * 100)
            if mins:
                out[d] = float(np.mean(mins))
        return pd.Series(out)

    fmin = fwd_min_target()
    flag5 = (fmin <= -5).astype(int)
    validation = {
        "window": f"{oos[0].date()} ~ {oos[-1].date()}" if len(oos) else None,
        "n_weeks": int(len(oos)),
        "crisis_weeks": int(flag5.loc[flag5.index.intersection(oos)].sum()),
        "metrics": [
            {"name": "동일가중",
             "ic": round(spearman(comp_eq.loc[oos], tgt), 3),
             "auc5": round(auc(comp_eq.loc[oos], flag5), 3)},
            {"name": "IC가중+바닥8% (채택)",
             "ic": round(spearman(comp_ic.loc[oos], tgt), 3),
             "auc5": round(auc(comp_ic.loc[oos], flag5), 3)},
        ],
        "note": ("walk-forward(매 4주 재학습, 엠바고 5주) 표본 외 비교. "
                 "ic = 향후 1개월 실현변동성과의 순위상관, auc5 = 향후 1개월 −5% 이상 "
                 "하락 주간을 사전 구분하는 능력(0.5=무작위). 전체 비교는 research/wf_validation.py."),
    }

    # ----- 등급 밴드 실증 통계 (2026-08-24 사용자 지시 — 밴드에 과거 실적의 의미를) -----
    # 경계값 재설정이 아니다 — 4등분은 그대로 두고(자의성 없음 유지), 각 구간이
    # 과거에 실제로 무엇을 뜻했는지(다음 1개월 위기 빈도·평균 실현변동성)를 게시한다.
    # 창·타깃은 위 표본 외 검증과 동일한 것을 재사용한다(새 기준 0개).
    comp_oos = comp_ic.loc[oos]
    band_rows = []
    for lo, hi, nm in GRADE_BANDS:
        m = (comp_oos >= lo) & ((comp_oos <= hi) if hi >= 100 else (comp_oos < hi))
        idx = comp_oos[m].index
        bf = idx.intersection(flag5.index)
        bt = idx.intersection(tgt.index)
        band_rows.append({
            "grade": nm, "lo": lo, "hi": hi, "n_weeks": int(len(idx)),
            "crisis_rate_pct": round(float(flag5.loc[bf].mean() * 100), 1) if len(bf) else None,
            "avg_fwd_vol_pct": round(float(tgt.loc[bt].mean()), 1) if len(bt) else None,
        })
    grade_band_stats = {
        "window": validation["window"], "rows": band_rows,
        "note": ("현재 위험 종합점수가 각 구간에 있던 주(2010~)의 다음 1개월 실적 — "
                 "위기주 = −5% 이상 하락, 실현변동성 = KOSPI TR·ACWI 평균(연율 %). "
                 "경계값은 4등분 그대로이며 이 표는 구간의 과거 의미를 보여 주는 참고입니다."),
    }

    # ----- 잠재 위험: 활성 요인 동일가중 -----
    vuln_active = [k for k in vuln_keys]
    VW = pd.DataFrame({k: weekly_by_key[k] for k in vuln_active})
    vuln_weekly = VW.dropna(thresh=2).mean(axis=1)
    vuln_cur = round(float(np.mean([fmap[k]["score"] for k in vuln_active])), 1) if vuln_active else None
    vuln_chg = (chg_of(vuln_weekly, vuln_cur) if vuln_cur is not None
                else {"m1": None, "m3": None, "y1": None})
    vuln_delta = vuln_chg["m1"]

    asof = max(s.dropna().index[-1] for s in
               [kospi, acwi, usdkrw, vix, vkospi, hy] if s is not None)

    # KOSPI 10영업일 전 대비 수익률 — 위험 추이 차트의 실제 상황 대조 축(2026-08-27
    # 사용자 지시). 주간 **최저**를 싣는 이유: 금요일 스냅숏은 주중에 참고선을 뚫었다
    # 반등한 주를 놓친다. 참고선 수치(levels)는 게시하되 의미 문구는 싣지 않는다.
    k10_base, k10_src = S.get("bb:한국_KOSPI_PR"), "bb:한국_KOSPI_PR"
    if k10_base is None:
        k10_base, k10_src = kospi, "bb:한국_KOSPI_TR"
    r10 = (k10_base.dropna().pct_change(10) * 100).dropna()
    kospi10 = {"label": "KOSPI 10영업일 전 대비 수익률 (주간 최저)",
               "src": k10_src, "levels": [-10, -16, -25],
               "hist": pack_series(r10.resample("W-FRI").min().dropna().tail(HIST_WEEKS))}

    risk_payload = {
        "asof": asof.strftime("%Y-%m-%d"),
        "grade_bands": [[lo, hi, nm] for lo, hi, nm in GRADE_BANDS],
        "howto": ("모든 점수는 0~100 — 오늘 수치가 2001년 이후 전체 이력에서 몇 번째로 위험한 "
                  "수준인지(백분위)를 나타냅니다. 0 = 가장 안전했던 수준, 100 = 가장 위험했던 수준, "
                  "50 = 딱 중간. 등급은 점수를 4등분한 것입니다."),
        "layers": {
            "stress": {"name": "현재 위험", "question": "지금 시장이 흔들리고 있는가",
                       "score": stress_cur, "grade": grade(stress_cur), "delta": stress_delta,
                       "chg": stress_chg, "rank5y": rank5y(comp_ic, stress_cur),
                       "method": "IC가중 + 최소바닥 8% (walk-forward 재학습)",
                       "hist": pack_series(comp_ic.tail(HIST_WEEKS))},
            "vuln": {"name": "잠재 위험", "question": "문제가 터지면 크게 다칠 상태인가",
                     "score": vuln_cur, "grade": grade(vuln_cur), "delta": vuln_delta,
                     "chg": vuln_chg,
                     "rank5y": rank5y(vuln_weekly, vuln_cur) if vuln_cur is not None else None,
                     "method": "활성 요인 동일가중",
                     "active": len(vuln_active),
                     "total": len([f for f in FACTORS if f["layer"] == "vuln"]),
                     "hist": pack_series(vuln_weekly.tail(HIST_WEEKS))},
        },
        "grade_band_stats": grade_band_stats,
        "kospi10": kospi10,
        "weights": {
            "items": [{"key": k, "name": fmap[k]["name"], "w": round(float(w), 3)}
                      for k, w in zip(stress_keys, cur_w)],
            "refit": last_refit.strftime("%Y-%m-%d") if last_refit is not None else None,
            "floor": FLOOR,
            "target": "향후 1개월 실현변동성 (KOSPI TR·ACWI 평균)",
            "desc": ("각 요인 점수의 예측력(순위상관)에 비례해 가중하되, 학습이 0으로 보내는 "
                     "요인도 최소 8%를 유지해 감시 커버리지를 지킵니다. 매 4주 재학습, "
                     "학습에는 그 시점 이전 데이터만 사용합니다."),
        },
        "validation": validation,
        "factors": factors_out,
        "limits": ("점수는 과거 분포 대비 현재 상태의 요약이며 수익률 예측이 아닙니다 — 검증 결과 "
                   "어떤 요인도 1개월 뒤 하락폭 자체는 예측하지 못했고, 예측되는 것은 변동성입니다. "
                   "백분위 방식은 전례 없는 수준의 사건을 100점 부근으로만 표현합니다. "
                   "잠재 위험 층은 포워드 PER 데이터 확보 전까지 밸류에이션을 보지 못합니다."),
    }

    events_payload = detect_events(
        S, asof, dict(usdkrw=usdkrw, fxvol=fxvol, hy=hy, vix=vix, vkospi=vkospi,
                      kospi=kospi, acwi=acwi, us_slope=us_slope, kr_slope=kr_slope,
                      sahm=sahm))
    # 관계분석 패널용 주간 시계열 (게시 구간보다 긴 전체 이력)
    weekly_frame = pd.DataFrame({
        "stress": comp_ic, "vuln": vuln_weekly,
        **{k: weekly_by_key[k] for k in weekly_by_key},
    })
    factor_meta = [{"key": f["key"], "name": f["name"], "layer": f["layer"]}
                   for f in factors_out if f.get("score") is not None]

    return risk_payload, events_payload, {"weekly": weekly_frame, "factors": factor_meta}


# ---------------------------------------------------------------------------
# 이벤트 검출
# ---------------------------------------------------------------------------

def detect_events(S: dict, asof: pd.Timestamp, d: dict) -> dict:
    events = []
    win_start = asof - timedelta(days=EVENT_LOOKBACK_D)

    def ev(date, sev, cat, title, value, rule, tags):
        events.append({"date": date.strftime("%Y-%m-%d"), "sev": sev, "cat": cat,
                       "title": title, "value": value, "rule": rule, "tags": tags})

    def scan_jump(s, name, is_rate, tags):
        s = s.dropna()
        chg = s.diff() if is_rate else s.pct_change() * 100
        sigma = chg.rolling(250).std()
        seen_days = set()
        for dt, c in chg[chg.index > win_start].items():
            sg = sigma.loc[:dt].iloc[-1] if len(sigma.loc[:dt]) else None
            if not sg or abs(c) <= 2.5 * sg or dt.date() in seen_days:
                continue
            seen_days.add(dt.date())
            unit = "bp" if is_rate else "%"
            v = c * 100 if is_rate else c
            ev(dt, "경계" if abs(c) > 3.5 * sg else "주의", "급변",
               f"{name} 일간 {'급등' if c > 0 else '급락'}", f"{v:+.1f}{unit}",
               f"일변동 |{c/sg:.1f}σ| > 2.5σ (최근 1년 σ)", tags)

    scan_jump(S.get("info:한국_10y"), "국고 10년", True, ["curve"])
    scan_jump(S.get("info:UST10y"), "미국채 10년", True, ["curve"])
    scan_jump(d["usdkrw"], "달러/원", False, ["fx"])
    scan_jump(d["kospi"], "KOSPI TR", False, ["dd", "vol"])
    scan_jump(d["acwi"], "ACWI", False, ["dd", "vol"])
    scan_jump(d["hy"], "미국 HY 스프레드", True, ["spread"])

    def scan_pctl_cross(s, name, tags, thr=90):
        pct = expanding_pctl(s, MIN_DAILY)
        recent = pct[pct.index > win_start]
        prev = None
        for dt, p in recent.items():
            if prev is not None:
                if prev < thr <= p:
                    ev(dt, "경계", "백분위", f"{name} 전체 이력 백분위 {thr}% 진입",
                       f"{p:.0f}%", f"확장 창 백분위 {thr}% 상향 돌파", tags)
                elif p < thr <= prev:
                    ev(dt, "정보", "백분위", f"{name} 백분위 {thr}% 이탈",
                       f"{p:.0f}%", f"확장 창 백분위 {thr}% 하향 이탈", tags)
            prev = p

    scan_pctl_cross(d["vkospi"], "VKOSPI", ["vol"])
    scan_pctl_cross(d["vix"], "VIX", ["vol"])
    scan_pctl_cross(d["fxvol"], "달러/원 변동성", ["fx"])
    scan_pctl_cross(d["hy"], "미국 HY 스프레드", ["spread"])
    scan_pctl_cross(S.get("bb:한국_CDS_5년물"), "한국 CDS 5년", ["cds"])

    for sl, nm in [(d["us_slope"], "미국 커브(10y−2y)"), (d["kr_slope"], "한국 커브(10y−3y)")]:
        recent = sl[sl.index > win_start - timedelta(days=5)]
        for i in range(1, len(recent)):
            a, b = float(recent.iloc[i - 1]), float(recent.iloc[i])
            if recent.index[i] <= win_start:
                continue
            if a >= 0 > b:
                ev(recent.index[i], "경계", "커브", f"{nm} 역전 발생", f"{b:+.0f}bp",
                   "10y−단기 스프레드 음전환", ["curve"])
            elif a < 0 <= b:
                ev(recent.index[i], "정보", "커브", f"{nm} 역전 해소", f"{b:+.0f}bp",
                   "10y−단기 스프레드 양전환", ["curve"])

    sahm = d["sahm"]
    recent = sahm[sahm.index > win_start]
    for i, (dt, v) in enumerate(recent.items()):
        prev_v = sahm.shift(1).loc[dt]
        if not pd.isna(prev_v) and prev_v < 0.5 <= v:
            ev(dt, "경계", "사이클", "삼 룰 발동 — 미국 침체 신호", f"{v:+.2f}%p",
               "실업률 3개월 평균이 12개월 저점 대비 +0.5%p 이상", ["cycle"])

    for prefix, label in [("bb:", "블룸버그(data_bb)"), ("info:", "인포맥스(data_info)"),
                          ("idx:", "지수 파일")]:
        lasts = [s.dropna().index[-1] for k, s in S.items() if k.startswith(prefix) and len(s.dropna())]
        if not lasts:
            continue
        last = max(lasts)
        gap = (asof - last).days
        if gap >= 5:
            ev(last, "정보", "데이터", f"{label} 시계열이 기준일보다 {gap}일 뒤처짐",
               f"최종 {last.date()}", "최신 관측일 − 기준일 ≥ 5일", ["data"])

    events.sort(key=lambda e: e["date"], reverse=True)
    catalog = [
        {"cat": "급변", "rule": "일간 변동 |2.5σ| 초과 (최근 1년 σ, 금리 bp·가격 %) — 3.5σ 초과 시 경계로 상향", "sev": "주의→경계"},
        {"cat": "백분위", "rule": "VIX·VKOSPI·스프레드·환율변동성·CDS의 전체 이력 백분위 90% 진입/이탈", "sev": "경계/정보"},
        {"cat": "커브", "rule": "미 10y−2y · 한 10y−3y 역전 발생/해소", "sev": "경계/정보"},
        {"cat": "사이클", "rule": "삼 룰 발동 (미국 실업률 3개월 평균이 12개월 저점 +0.5%p 이상)", "sev": "경계"},
        {"cat": "데이터", "rule": "소스별 최신 관측일이 기준일보다 5일 이상 뒤처짐", "sev": "정보"},
    ]
    return {"asof": asof.strftime("%Y-%m-%d"), "lookback_days": EVENT_LOOKBACK_D,
            "events": events[:40], "catalog": catalog}


# ---------------------------------------------------------------------------
# 이벤트 브리핑 원고 — "AI 앵커"의 원고를 **파이프라인이 템플릿으로 조립**한다.
# LLM 없음: title/value 를 원문 그대로 끼우고 문장 틀은 아래 f-string 이 전부라,
# 같은 events 로는 항상 같은 원고가 나오고 화면 타임라인과 한 글자도 어긋날 수 없다
# (자의성 금지 — docs/HANDOVER.md §4·§5.2.1). 형식은 사용자가 승인한 C 선별형:
# 머리(건수) → 경계·주의 전건(최신순) → 규칙은 타임라인에 위임 → 고지.
# 호출 자리는 process.py — 시장 폭 이벤트가 병합된 **뒤**여야 전건이 실린다.
# ---------------------------------------------------------------------------
BRIEF_DISCLAIMER = ("이 브리핑은 검출 규칙이 만든 이벤트를 그대로 읽은 것으로, "
                    "해석·전망을 담지 않습니다. 모델 참고치입니다.")


def compose_brief(events: list[dict], asof: str, lookback_days: int) -> list[str]:
    """이벤트 목록 → 브리핑 문장 리스트. 표시·낭독 양쪽이 이 한 벌을 쓴다.

    여는 문장의 구간은 기준일이 아니라 **실제 이벤트 날짜의 최소~최대**다 —
    시장 폭 이벤트는 데일리 리포트에서 와서 bb/info 기준일(asof)보다 뒤일 수 있어,
    "asof 기준"이라 말하면 그보다 뒤 날짜의 이벤트와 모순되기 때문이다.
    """
    if not events:
        return [f"기준일 {asof}까지 최근 {lookback_days}일 창에서 검출된 이벤트가 없습니다.",
                BRIEF_DISCLAIMER]

    n = {"경계": 0, "주의": 0, "정보": 0}
    for e in events:
        n[e["sev"]] = n.get(e["sev"], 0) + 1
    dates = sorted(e["date"] for e in events)
    cross_year = dates[0][:4] != dates[-1][:4]

    def dt(d: str) -> str:
        y, m, day = d.split("-")
        return (f"{y}년 " if cross_year else "") + f"{int(m)}월 {int(day)}일"

    span = (f"{dt(dates[0])} 하루 동안" if dates[0] == dates[-1]
            else f"{dt(dates[0])}부터 {dt(dates[-1])}까지")
    head = (f"{span} 검출된 이벤트는 모두 {len(events)}건 — "
            f"경계 {n['경계']} · 주의 {n['주의']} · 정보 {n['정보']}.")
    picked = [e for sev in ("경계", "주의")
              for e in sorted((e for e in events if e["sev"] == sev),
                              key=lambda x: x["date"], reverse=True)]
    if not picked:
        return [head + " 경계·주의 단계는 없습니다.",
                "정보 단계 이벤트는 아래 타임라인에 있습니다. " + BRIEF_DISCLAIMER]
    lines = [head + " 경계·주의만 읽습니다."]
    lines += [f"[{e['sev']}] {dt(e['date'])} — {e['title']} ({e['value']})" for e in picked]
    lines.append("검출 규칙은 아래 타임라인·방법론에 있습니다. " + BRIEF_DISCLAIMER)
    return lines
