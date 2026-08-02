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
  관측해 평균한 값 × 각 주식의 σ. 자유 모수가 0개다(앵커 자체가 관측값).
  역사적 실현 평균은 기대수익으로 쓰지 않는다(표본 구간 선택 = 답 선택).
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
    "mix": {"국내채권": 42.0, "해외채권": 18.0, "국내주식": 3.0,
            "해외주식": 5.0, "대체투자": 15.0, "단기자금": 5.0},
    "bands": {"국내채권": [20, 55], "해외채권": [0, 30], "국내주식": [0, 10],
              "해외주식": [0, 15], "대체투자": [5, 25], "단기자금": [2, 15]},
    "mix_acct": {"장부가 국내채권": 30.0, "시가 국내채권": 12.0,
                 "장부가 해외채권": 12.0, "시가 해외채권": 6.0,
                 "국내주식": 3.0, "해외주식": 5.0, "대체투자": 15.0, "단기자금": 5.0},
    "bands_acct": {"장부가 국내채권": [15, 45], "시가 국내채권": [0, 25],
                   "장부가 해외채권": [0, 25], "시가 해외채권": [0, 20],
                   "국내주식": [0, 10], "해외주식": [0, 15],
                   "대체투자": [5, 25], "단기자금": [2, 15]},
    "loan_w": 12.0, "loan_y": 4.0,          # 대출금 — 준고정, 최적화 제외 (§7.1)
    "alt_alpha": 3.0, "alt_vol": 8.0,       # 대체 기대 CPI+α, 위험(스무딩 보정 가정)
    "tenor_m": H.DEFAULT_TENOR_M,           # 스왑 만기 9개월 (실무 금액가중평균)
    "h_bond": 90, "h_eq": 90,               # 헤지비율 % — 사용자의 현재 상태로 대체됨
    "start_key": "full", "proxy": "acwi", "cost_key": "smb_last",
    "block_len": 24,
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
    return pd.DataFrame(cols)[SOURCE_LABELS].dropna()


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


def cost_options(S, rates) -> list[dict]:
    """헤지비용 읽는 법 — 전부 [관측]이며 사용자가 드롭다운으로 고른다.

    CIP 항의는 §5.3 에서 폐기된 것(스왑레이트 '변화'의 프록시)과 다르다 —
    여기서는 비용 '수준'의 대안 읽기로만 제시한다(달러 실측과 상관 0.89 검증).
    """
    smb_m = S["info:SMB_USDKRW_3M"].dropna().resample("ME").last().dropna()
    opts = [
        {"key": "smb_last", "label": "3M 스왑레이트 — 최근값",
         "v": round(float(smb_m.iloc[-1]), 2),
         "src": f"info:SMB_USDKRW_3M ({smb_m.index[-1]:%Y-%m})"},
        {"key": "smb_median", "label": f"3M 스왑레이트 — 장기 중앙값 ({len(smb_m)}개월)",
         "v": round(float(smb_m.median()), 2),
         "src": f"info:SMB_USDKRW_3M {smb_m.index[0]:%Y-%m}~{smb_m.index[-1]:%Y-%m}"},
    ]
    hp = S.get("info:USDKRW_HP_12M")
    if hp is not None and len(hp.dropna()):
        hp = hp.dropna()
        opts.append({"key": "hp12m", "label": "헤지 포인트 12M — 실측 최근값",
                     "v": round(float(hp.iloc[-1]), 2),
                     "src": f"info:USDKRW_HP_12M ({hp.index[-1]:%Y-%m-%d})"})
    if "kr3m" in rates and "us3m" in rates:
        opts.append({"key": "cip", "label": "금리차(CIP) 함의 — 한국 3m − 미국 3m",
                     "v": round(rates["kr3m"]["v"] - rates["us3m"]["v"], 2),
                     "src": "info:한국_3m − bb:미국_3m"})
    return opts


# ---------------------------------------------------------------------------
# 2) 재조립·앵커·최적화 (부트스트랩과 점추정 공용 — 브라우저 코드와 같은 산식)
# ---------------------------------------------------------------------------
IX = {k: i for i, k in enumerate(SOURCE_LABELS)}
ECON_ASSETS = ["국내채권", "해외채권", "국내주식", "해외주식", "대체투자", "단기자금"]


def loadings(h_bond: float, h_eq: float, alt_scale: float, proxy: str = "acwi") -> np.ndarray:
    """경제 관점 자산 6 × 원천 10 로딩 행렬. 해외자산 = 현지 + (1−h)e + h·swap."""
    B = np.zeros((6, len(SOURCE_LABELS)))
    B[0, IX["kr_bond"]] = 1
    B[1, IX["us_bond"]], B[1, IX["e_usd"]], B[1, IX["swap"]] = 1, 1 - h_bond, h_bond
    B[2, IX["kospi"]] = 1
    B[3, IX[proxy]], B[3, IX["e_usd"]], B[3, IX["swap"]] = 1, 1 - h_eq, h_eq
    B[4, IX["alt"]] = alt_scale
    B[5, IX["cash"]] = 1
    return B


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


_GRID_H = np.arange(0, 101, 5) / 100.0


def hedge_grid_min(covS, w, alt_scale, proxy="acwi"):
    """배분 고정 시 (채권헤지, 주식헤지) 격자에서 총위험 최소점.

    σ²(hb,he) 는 h 의 2차식이므로 계수 6개만 계산해 격자를 닫힌꼴로 평가한다.
    x(hb,he) = x1 + (1−hb)·db + (1−he)·de,  x1 = h=1 로딩.
    """
    n = len(SOURCE_LABELS)
    x1 = w @ loadings(1.0, 1.0, alt_scale, proxy)
    db = np.zeros(n); db[IX["e_usd"]], db[IX["swap"]] = w[1], -w[1]
    de = np.zeros(n); de[IX["e_usd"]], de[IX["swap"]] = w[3], -w[3]
    Sx1, Sdb, Sde = covS @ x1, covS @ db, covS @ de
    c0, cbb, cee = x1 @ Sx1, db @ Sdb, de @ Sde
    c0b, c0e, cbe = x1 @ Sdb, x1 @ Sde, db @ Sde
    u = (1 - _GRID_H)[:, None]        # 채권 축
    v = (1 - _GRID_H)[None, :]        # 주식 축
    var = c0 + 2 * u * c0b + 2 * v * c0e + u * u * cbb + v * v * cee + 2 * u * v * cbe
    i, j = np.unravel_index(np.argmin(var), var.shape)
    return float(_GRID_H[i]) * 100, float(_GRID_H[j]) * 100, math.sqrt(max(float(var[i, j]), 0)) * 100


def anchor_of(covS, rates, h_bond, cost):
    sig_krb = math.sqrt(covS[IX["kr_bond"], IX["kr_bond"]]) * 100
    x = np.zeros(len(SOURCE_LABELS))
    x[IX["us_bond"]], x[IX["e_usd"]], x[IX["swap"]] = 1, 1 - h_bond, h_bond
    sig_usb = math.sqrt(float(x @ covS @ x)) * 100
    prem_kr = rates["kr5y"]["v"] - rates["kr3m"]["v"]
    prem_us = rates["us_ytm"]["v"] + h_bond * cost - rates["kr3m"]["v"]
    return {"value": (prem_kr / sig_krb + prem_us / sig_usb) / 2,
            "kr": {"prem": prem_kr, "sigma": sig_krb},
            "us": {"prem": prem_us, "sigma": sig_usb}}


def mu_vector(covS, rates, d, cost):
    """경제 관점 μ (연 %). 앵커·σ는 covS 에서 — 헤지비율 h 의 함수다(화면에 명시)."""
    h_b, h_e = d["h_bond"] / 100, d["h_eq"] / 100
    a = anchor_of(covS, rates, h_b, cost)
    B = loadings(h_b, h_e, 1.0, d["proxy"])
    sig = np.sqrt(np.einsum("ij,jk,ik->i", B, covS, B)) * 100
    return np.array([
        rates["kr5y"]["v"],
        rates["us_ytm"]["v"] + h_b * cost,
        rates["kr3m"]["v"] + a["value"] * sig[2],
        rates["us3m"]["v"] + a["value"] * sig[3] + h_e * cost,
        rates["cpi"]["v"] + d["alt_alpha"],
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
        hb_star = np.empty(BOOT_REPS)
        he_star = np.empty(BOOT_REPS)
        MU = np.empty((BOOT_REPS, 6))
        COVA = np.empty((BOOT_REPS, 6, 6))
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
            hb, he, smin = hedge_grid_min(covS, w0, k, d["proxy"])
            hb_star[r], he_star[r] = hb, he
            d1[r] = sig_cur[r] - smin
        targets = np.einsum("ri,i->r", MU, w0)
        W = optimize_batch(MU, COVA, lo, hi, total, targets)
        sig_opt = np.sqrt(np.maximum(np.einsum("ri,rij,rj->r", W, COVA, W), 0))
        d2 = sig_cur - sig_opt
        qs = lambda v: {f"q{q:02d}": round(float(np.percentile(v, q)), 4) for q in Q}
        out.append({"block_len": L, "n_reps": BOOT_REPS,
                    "anchor": qs(anchors), "d1": qs(d1), "d2": qs(d2),
                    "hb_star": qs(hb_star), "he_star": qs(he_star),
                    "share_hb_interior": round(float(((hb_star > 0) & (hb_star < 100)).mean()), 3)})
    return out


# ---------------------------------------------------------------------------
# 4) build
# ---------------------------------------------------------------------------
def build(series_store: dict, warn) -> dict:
    S = {k: v["s"] for k, v in series_store.items()}
    M = sources_frame(S, warn)
    if len(M) < 120:
        raise ValueError(f"alloc: 공통 표본 {len(M)}개월 < 120 — 원천 시리즈 확인 필요")
    rates = market_rates(S, warn)
    copts = cost_options(S, rates)
    d = dict(DEFAULTS)
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
        "anchor_ref": {"h_bond": d["h_bond"] / 100, "cost_key": d["cost_key"],
                       "value": round(a0["value"], 6),
                       "kr": {k: round(v, 4) for k, v in a0["kr"].items()},
                       "us": {k: round(v, 4) for k, v in a0["us"].items()}},
        "defaults": d,
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
        "limits": ("기대수익의 채권·현금은 현재 시장금리 [관측], 주식은 동일 샤프 앵커 [관측→도출], "
                   "대체투자 α·위험과 장부가 북일드는 수기 입력 [가정]입니다. 환율 기대변동은 0으로 "
                   "둡니다(랜덤워크 — 방향 전망은 모델 랩에서). ACWI 는 현재 PR 이라 해외주식 실현 "
                   "수익률이 배당분(연 약 2%p)만큼 과소평가됩니다(§6 TR 확보 시 교체). 앵커·σ는 "
                   "헤지비율의 함수이므로 슬라이더를 움직이면 기대수익도 함께 변합니다(화면 명시). "
                   "대체투자는 평가 스무딩으로 실측 변동성이 실제 위험을 과소평가하므로 위험을 "
                   "별도 입력(기본 8%)으로 둡니다. 수기 입력은 이 브라우저(localStorage)에만 저장되며 "
                   "서버로 전송되지 않습니다. K-ICS 요구자본 제약은 미반영 — 모델 참고치이지 권고가 "
                   "아닙니다."),
    }
