# -*- coding: utf-8 -*-
"""시장 국면(2국면 MSM) 참고 블록 → risk.json["regime"].

§5.1 다자산 국면 레이어 실험(2026-08-31, research/regime_layer.py)의 채택분 ⓐ다:
국면 이질성 검정을 통과한 3개 시장(해외주식·채권·원자재)의 **고변동 국면 확률**을
리스크 화면에 참고로 게시한다. **등급·경보·이벤트에는 반영하지 않는다** — 같은
실험이 그 대체를 기각했다(기관 경보 기준 시장 KOSPI 패널에서 동일 오경보율 하
현행 점수 열세). 국내주식(p=0.71)·환율(p=0.17)은 검정 미달이라 싣지 않는다.

산식: 주간(W-FRI) 수익률에 2국면 가우시안 MSM(EM + 해밀턴 필터 — research/
regime_prototype.py 의 손구현을 이식, 전이 기대횟수는 표준 Kim–Nelson 폐형으로
벡터화). **numpy·pandas 만 쓴다** — 파이프라인 고정 의존성 3개 불변.

정직성 규약 둘 (화면이 둘 다 적는다):
  ① 게시 확률은 **Filtered**(각 시점까지의 데이터만) — Smoothed 는 사후판정이라
     쓰지 않는다(연구 실측: 15~21% 가 사후판정 편향).
  ② 파라미터는 **전체 표본으로 1회 추정**한다. 헤드라인(현재값)은 지금까지의
     데이터만 쓰므로 실시간 정합이지만, **이력 구간에는 파라미터 사후성이 남는다**
     — 매 빌드 walk-forward 재추정은 파이프라인 예산(40~55초)을 시장당 ~70초로
     초과해 채택하지 않았고, walk-forward 정합 검증은 연구 하네스 몫이다.
     이 사실은 `param_note` 로 게시돼 화면 카드가 접지 않고 적는다.

이질성 검정(Welch t)은 매 빌드 재계산해 `ttest_p` 로 게시한다 — 데이터가 갱신돼
미달로 돌아서면 화면이 ⚠ 를 달되, **시장 목록 자체는 조용히 바꾸지 않는다**
(MARKETS 상수가 정본). p 값은 정규근사(math.erfc) — 국면별 표본이 수백이라
t 분포와의 차이는 소수 4자리 밖이다(scipy 를 파이프라인에 들이지 않는 값).

시리즈가 없거나 표본이 짧으면 해당 행을 active:false + 사유로 게시한다
(조용한 대체 금지). 블록 전체는 항상 게시된다 — 부재는 wiring 누락이며
check_output.py 의 REQUIRED_KEYS["risk"] 가 잡는다.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

import risk

# 검정 통과 3개 시장 고정 (2026-08-31 실험 §5.1 — 목록 변경은 재실험 후 사용자 합의)
MARKETS = [
    ("해외주식", "bb:미국_S&P500_TR", "S&P500 TR"),
    ("채권", "bb:미국종합", "미국 종합채권 지수"),
    ("원자재", "bb:S&P GSCI TR CME", "S&P GSCI TR"),
]
MIN_W = 260           # 최소 5년 주간 표본 — 미만이면 active:false
EM_ITERS = 120
EM_TOL = 1e-6


def _dens(r: np.ndarray, mu: np.ndarray, sig: np.ndarray) -> np.ndarray:
    out = np.column_stack([
        np.exp(-0.5 * ((r - mu[j]) / sig[j]) ** 2) / (sig[j] * math.sqrt(2 * math.pi))
        for j in (0, 1)])
    return np.maximum(out, 1e-300)


def hamilton_filter(r, mu, sig, p11, p22):
    """filtered P(S_t | r_1..t), 예측확률, 로그우도 — regime_prototype 과 동일."""
    n = len(r)
    T = np.array([[p11, 1 - p11], [1 - p22, p22]])
    dens = _dens(r, mu, sig)
    filt = np.zeros((n, 2))
    pred = np.zeros((n, 2))
    pi0 = np.array([(1 - p22), (1 - p11)])
    pi0 = pi0 / pi0.sum()
    ll = 0.0
    prev = pi0
    for t in range(n):
        pr = prev @ T if t else pi0
        pred[t] = pr
        num = pr * dens[t]
        c = num.sum()
        ll += math.log(c)
        filt[t] = num / c
        prev = filt[t]
    return filt, pred, ll


def _kim_smoother(filt, pred, p11, p22):
    n = len(filt)
    T = np.array([[p11, 1 - p11], [1 - p22, p22]])
    sm = np.zeros_like(filt)
    sm[-1] = filt[-1]
    for t in range(n - 2, -1, -1):
        ratio = sm[t + 1] / np.maximum(pred[t + 1], 1e-300)
        sm[t] = filt[t] * (T @ ratio)
        sm[t] = sm[t] / sm[t].sum()
    return sm


def fit_msm(r: np.ndarray) -> dict:
    """EM. 상태 1 = 고변동(σ 정렬로 라벨 고정). 전이 기대횟수는 Kim–Nelson 폐형:
    P(S_{t-1}=i, S_t=j | 전체) = filt[t-1,i]·T[i,j]·sm[t,j]/pred[t,j] — 시점 축을
    행렬곱 하나로 접어 research 구현의 시점 루프를 없앴다(수치 결과는 동일 산식)."""
    r = np.asarray(r, dtype=float)
    med = np.median(np.abs(r - r.mean()))
    hi = np.abs(r - r.mean()) > med
    mu = np.array([r[~hi].mean(), r[hi].mean()])
    sig = np.array([max(r[~hi].std(), 1e-4), max(r[hi].std(), 1e-4)])
    p11, p22 = 0.95, 0.90
    prev_ll = -np.inf
    for _ in range(EM_ITERS):
        filt, pred, ll = hamilton_filter(r, mu, sig, p11, p22)
        sm = _kim_smoother(filt, pred, p11, p22)
        T = np.array([[p11, 1 - p11], [1 - p22, p22]])
        B = sm[1:] / np.maximum(pred[1:], 1e-300)
        xi = T * (filt[:-1].T @ B)
        p11 = xi[0, 0] / max(xi[0].sum(), 1e-12)
        p22 = xi[1, 1] / max(xi[1].sum(), 1e-12)
        for j in (0, 1):
            wj = sm[:, j]
            mu[j] = (wj * r).sum() / max(wj.sum(), 1e-12)
            sig[j] = math.sqrt(max((wj * (r - mu[j]) ** 2).sum() / max(wj.sum(), 1e-12), 1e-8))
        if sig[1] < sig[0]:
            mu, sig = mu[::-1].copy(), sig[::-1].copy()
            p11, p22 = p22, p11
        if abs(ll - prev_ll) < EM_TOL:
            break
        prev_ll = ll
    return dict(mu=mu, sig=sig, p11=p11, p22=p22)


def welch_p(a: np.ndarray, b: np.ndarray) -> float | None:
    """Welch t 의 양측 p, 정규근사. 한쪽 표본이 비면 판정 불가(None)."""
    if len(a) < 2 or len(b) < 2:
        return None
    va, vb = a.var(ddof=1) / len(a), b.var(ddof=1) / len(b)
    denom = math.sqrt(max(va + vb, 1e-300))
    t = (a.mean() - b.mean()) / denom
    return math.erfc(abs(t) / math.sqrt(2))


def build(series_store: dict, warn) -> dict:
    ann = math.sqrt(52)
    rows, asof_all = [], []
    for name, key, src in MARKETS:
        entry = series_store.get(key)
        if entry is None:
            warn(f"regime: 시리즈 없음 — {key}")
            rows.append({"name": name, "src": src, "active": False,
                         "note": f"시리즈 없음({key})"})
            continue
        wk = entry["s"].dropna().resample("W-FRI").last().dropna()
        r = (wk.pct_change() * 100).dropna()
        if len(r) < MIN_W:
            rows.append({"name": name, "src": src, "active": False,
                         "note": f"주간 표본 {len(r)}주 — 최소 {MIN_W}주 미달"})
            continue
        m = fit_msm(r.values)
        filt, pred, _ = hamilton_filter(r.values, m["mu"], m["sig"], m["p11"], m["p22"])
        prob = pd.Series(filt[:, 1] * 100.0, index=r.index)
        # 검정 라벨만 Smoothed 다 — 국면 분류는 모형 진단이라 사후 판정이 맞는 자리
        # (연구 하네스와 같은 규약). 게시 확률(위 prob)에는 쓰지 않는다.
        sm = _kim_smoother(filt, pred, m["p11"], m["p22"])
        lab = sm[:, 1] > 0.5
        p = welch_p(r.values[lab], r.values[~lab])
        asof_all.append(r.index[-1])
        rows.append({
            "name": name, "src": src, "active": True,
            "asof": r.index[-1].strftime("%Y-%m-%d"),
            "prob": round(float(prob.iloc[-1]), 1),
            "mu": [round(m["mu"][0] * 52, 1), round(m["mu"][1] * 52, 1)],
            "sig": [round(m["sig"][0] * ann, 1), round(m["sig"][1] * ann, 1)],
            "p_stay": [round(m["p11"], 3), round(m["p22"], 3)],
            "ttest_p": None if p is None else round(p, 4),
            "hist": risk.pack_series(prob.tail(risk.HIST_WEEKS)),
        })

    return {
        "active": any(x["active"] for x in rows),
        "asof": max(asof_all).strftime("%Y-%m-%d") if asof_all else None,
        "rows": rows,
        "label": "시장 국면 (참고)",
        "scope_note": "참고 표시 전용 — 현재·잠재 위험 점수, 등급, 이벤트 검출에 반영되지 않습니다. "
                      "국내주식·환율은 국면 이질성 검정 미달로 싣지 않습니다(2026-08-31 실험).",
        "param_note": "확률은 각 시점까지의 데이터만 본 Filtered 값이지만, 모델 파라미터는 "
                      "전체 표본으로 추정합니다 — 과거 구간은 사후 재계산이라 당시 실시간 "
                      "열람과 다를 수 있습니다(현재값은 실시간 정합).",
        "method": "주간 수익률의 2국면 가우시안 마코프 전환 모형(EM + 해밀턴 필터). "
                  "고변동 국면 확률 0~100%. 국면 이질성(Welch t, 정규근사)은 매 빌드 재계산.",
    }
