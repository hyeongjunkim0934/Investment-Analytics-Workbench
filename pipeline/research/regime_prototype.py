# -*- coding: utf-8 -*-
"""국면전환(MSM) + EGARCH 시안 — 리스크 스코어보드 이론 보강 모듈 1 (모델 랩).

2026-08-28 사용자 제공 방법론(EGARCH 변동성 필터링 → 2국면 마코프 국면확률 →
리스크 점수 0~100)의 실데이터 검증. 제안서의 「지금 당장 할 일」 그대로:
S&P500 주간 수익률로 국면 확률을 뽑고, 80% 돌파 시점과 실제 폭락 시점의
시차(Lead-Lag)를 분석한다. MS_Regress(R)는 없으므로 손구현(EM + 해밀턴 필터).
scipy 는 이 연구 스크립트에서만 쓴다(파이프라인 고정 의존성 3개 불변).

    python pipeline/research/regime_prototype.py --data-dir <data 저장소 경로>

제안서와 다르게 한 것 둘 (정합성 — 이유를 명시한다):
  ① **Smoothed 와 Filtered 확률을 둘 다 산출**한다. 제안서는 Smoothed 를 점수로
     쓰라고 하지만 Smoothed 는 전체 표본(미래 포함)을 본 사후 판정이라 실시간
     스코어보드에 쓰면 look-ahead 다. 실시간 후보는 Filtered(그 시점까지만) +
     walk-forward 재추정(4주마다, 최초 156주)이고, 둘의 차이가 곧 사후판정 편향의
     크기다 — 그걸 숫자로 잰다.
  ② MSM 은 **수익률 원계열**에 직접 적용한다(평균·분산 국면 의존 — Hamilton 고전형,
     MS_Regress 기본형과 동일). 제안서 그림의 「EGARCH 표준화 잔차에 MSM」은
     표준화가 변동성을 걷어낸 뒤라 변동성 국면이 남지 않는다 — EGARCH 는 비대칭
     계수(φ) 검증용으로 병행한다.

주요 결과 (2026-08-28, 주간 · 표본 2001-12~2026-08, walk-forward filtered 기준):
  S&P500 TR:
    국면: 저변동 μ+19.5%/σ10.9% ↔ 고변동 μ−13.9%/σ28.3% · ③ t-검정 p=0.0016 ✓
    **폭락 8건 전부에서 Filtered 확률이 80% 를 폭락 주 이전(시차 0~+8주)에 돌파**
    — 2008(+8주)·2018(+8주)·2022-06(+7주). 연속 상관으로는 L=4주에 +0.03 으로
    죽는데 사건 단위로는 조기경보가 실재한다: 국면확률은 "폭풍이 이미 형성 중"을
    잡는 도구라, 진행 중인 위기 안에서 최악의 주가 오기 전에 든다.
    VIX 수준과 상관 +0.81 — 중복이 크다(비선형 변환에 가깝다).
  KOSPI TR:
    ③ t-검정 p=0.71 ✗ — 분산 국면은 갈리지만 평균은 안 갈린다(제안서 자체 기준
    미달). 폭락 13건 중 9건 돌파(시차 0~+8주), **2024-08·2025-04 는 놓침**.
    VIX 와 상관 +0.59 — 한국 고유 변동성 정보는 있다.
  Filtered vs Smoothed 상관 +0.79~0.85 — 15~21% 가 사후판정 편향. Smoothed 는
    실시간 점수로 쓰면 안 된다(본문 ① — 시차 표에서도 Smoothed 가 더 일찍 돌파한
    것처럼 보이는 사건들이 그 편향이다).
  EGARCH(1,1): 악재 비대칭 φ 유의 — S&P −0.235(p<0.0001) · KOSPI −0.045(p=0.011).
  구현 노트: MSM(EM+해밀턴 필터)은 numpy 만 쓴다 — 배포 편입 시 의존성 추가 불필요.
    scipy 는 t-검정·EGARCH 최적화에만 사용(연구 전용).
"""

import argparse
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import optimize, stats

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import common  # noqa: E402
import process as P  # noqa: E402

spearman = common.spearman
REFIT_W, TRAIN_MIN_W = 4, 156
SQ2PI = math.sqrt(2.0 / math.pi)


# ---------------- 2국면 가우시안 MSM: 해밀턴 필터 + EM ----------------

def _npdf(x, mu, sig):
    return np.exp(-0.5 * ((x - mu) / sig) ** 2) / (sig * math.sqrt(2 * math.pi))


def _dens(r, mu, sig):
    return np.maximum(np.column_stack([_npdf(r, mu[j], sig[j]) for j in (0, 1)]), 1e-300)


def hamilton_filter(r, mu, sig, p11, p22):
    """filtered P(S_t | r_1..t), 예측확률, 로그우도."""
    n = len(r)
    T = np.array([[p11, 1 - p11], [1 - p22, p22]])
    dens = _dens(r, mu, sig)
    filt = np.zeros((n, 2))
    pred = np.zeros((n, 2))
    # 정상분포 초기값
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


def kim_smoother(filt, pred, p11, p22):
    n = len(filt)
    T = np.array([[p11, 1 - p11], [1 - p22, p22]])
    sm = np.zeros_like(filt)
    sm[-1] = filt[-1]
    for t in range(n - 2, -1, -1):
        ratio = sm[t + 1] / np.maximum(pred[t + 1], 1e-300)
        sm[t] = filt[t] * (T @ ratio)
        sm[t] = sm[t] / sm[t].sum()
    return sm


def fit_msm(r, iters=200, tol=1e-8, init=None):
    """EM. 상태 1 = 고변동성(σ 큰 쪽으로 정렬해 라벨 고정). init 로 웜스타트."""
    r = np.asarray(r, dtype=float)
    if init is not None:
        mu, sig = init["mu"].copy(), init["sig"].copy()
        p11, p22 = init["p11"], init["p22"]
    else:
        med = np.median(np.abs(r - r.mean()))
        hi = np.abs(r - r.mean()) > med
        mu = np.array([r[~hi].mean(), r[hi].mean()])
        sig = np.array([max(r[~hi].std(), 1e-4), max(r[hi].std(), 1e-4)])
        p11, p22 = 0.95, 0.90
    prev_ll = -np.inf
    for _ in range(iters):
        filt, pred, ll = hamilton_filter(r, mu, sig, p11, p22)
        sm = kim_smoother(filt, pred, p11, p22)
        # 전이 기대횟수 (Kim & Nelson)
        T = np.array([[p11, 1 - p11], [1 - p22, p22]])
        dens = _dens(r, mu, sig)
        xi = np.zeros((2, 2))
        for t in range(1, len(r)):
            joint = np.outer(filt[t - 1], dens[t]) * T
            joint = joint / joint.sum()
            joint = joint * (sm[t] / np.maximum(filt[t], 1e-300))[None, :]
            xi += joint / max(joint.sum(), 1e-300)
        p11 = xi[0, 0] / max(xi[0].sum(), 1e-12)
        p22 = xi[1, 1] / max(xi[1].sum(), 1e-12)
        w = sm
        for j in (0, 1):
            mu[j] = (w[:, j] * r).sum() / max(w[:, j].sum(), 1e-12)
            sig[j] = math.sqrt(max((w[:, j] * (r - mu[j]) ** 2).sum()
                                   / max(w[:, j].sum(), 1e-12), 1e-8))
        if sig[1] < sig[0]:   # 라벨 고정: 1 = 고변동
            mu, sig = mu[::-1].copy(), sig[::-1].copy()
            p11, p22 = p22, p11
        if abs(ll - prev_ll) < tol:
            break
        prev_ll = ll
    return dict(mu=mu, sig=sig, p11=p11, p22=p22, ll=ll)


# ---------------- EGARCH(1,1) MLE (비대칭 검증용) ----------------

def egarch_nll(params, r):
    g0, delta, theta, phi = params
    if not (0 < delta < 0.9999):
        return 1e9
    n = len(r)
    lv = math.log(r.var())
    nll = 0.0
    for t in range(n):
        v = math.exp(lv)
        z = r[t] / math.sqrt(v)
        nll += 0.5 * (math.log(2 * math.pi) + lv + z * z)
        lv = g0 + delta * lv + theta * (abs(z) - SQ2PI) + phi * z
        lv = min(max(lv, -30), 30)
    return nll


def fit_egarch(r):
    r = np.asarray(r, dtype=float)
    r = r - r.mean()
    x0 = np.array([math.log(r.var()) * 0.05, 0.9, 0.2, -0.1])
    res = optimize.minimize(egarch_nll, x0, args=(r,), method="Nelder-Mead",
                            options={"maxiter": 4000, "xatol": 1e-6, "fatol": 1e-6})
    # φ=0 제약 우도비 검정
    def nll_res(p3):
        return egarch_nll([p3[0], p3[1], p3[2], 0.0], r)
    res0 = optimize.minimize(nll_res, x0[:3], method="Nelder-Mead",
                             options={"maxiter": 4000})
    lr = 2 * (res0.fun - res.fun)
    pval = 1 - stats.chi2.cdf(lr, df=1)
    return res.x, lr, pval


# ---------------- 메인 ----------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True, type=Path)
    args = ap.parse_args()
    P.load_data_dir(args.data_dir)

    for key, label in [("bb:미국_S&P500_TR", "S&P500 TR"), ("bb:한국_KOSPI_TR", "KOSPI TR")]:
        px = P.get(key).dropna()
        wk = px.resample("W-FRI").last().dropna()
        r = (wk.pct_change() * 100).dropna()
        print(f"\n{'='*74}\n[{label}] 주간 수익률 {r.index[0].date()} ~ {r.index[-1].date()} ({len(r)}주)")

        # --- 전체 표본 적합 (제안서 사양: smoothed) + t-검정 ---
        m = fit_msm(r.values)
        filt, pred, _ = hamilton_filter(r.values, m["mu"], m["sig"], m["p11"], m["p22"])
        sm = kim_smoother(filt, pred, m["p11"], m["p22"])
        smoothed = pd.Series(sm[:, 1], index=r.index)
        ann = math.sqrt(52)
        print(f"국면 파라미터: 저변동 μ {m['mu'][0]*52:+.1f}%/년 σ {m['sig'][0]*ann:.1f}%"
              f" · 고변동 μ {m['mu'][1]*52:+.1f}%/년 σ {m['sig'][1]*ann:.1f}%")
        print(f"지속확률 p11 {m['p11']:.3f} (평균 {1/(1-m['p11']):.0f}주) · "
              f"p22 {m['p22']:.3f} (평균 {1/(1-m['p22']):.0f}주)")
        lab = sm[:, 1] > 0.5
        tt = stats.ttest_ind(r.values[lab], r.values[~lab], equal_var=False)
        print(f"③ 국면 이질성 t-검정(수익률 평균): t={tt.statistic:+.2f}, p={tt.pvalue:.4f} "
              f"{'→ 기각(이질적) ✓' if tt.pvalue < 0.05 else '→ 기각 실패 ✗'} · "
              f"고변동 국면 비중 {lab.mean():.0%}")

        # --- walk-forward filtered (실시간 후보) — 재학습 시에만 전체 필터 재실행,
        #     그 사이 주는 증분 갱신 O(1). 웜스타트로 EM 반복을 줄인다.
        rt = pd.Series(index=r.index, dtype=float)
        params, state = None, None
        for i, t in enumerate(r.index):
            if i >= TRAIN_MIN_W and (params is None or i % REFIT_W == 0):
                params = fit_msm(r.values[:i], iters=25 if params else 120, init=params)
                f2, _, _ = hamilton_filter(r.values[:i], params["mu"], params["sig"],
                                           params["p11"], params["p22"])
                state = f2[-1]
            if params is not None:
                T = np.array([[params["p11"], 1 - params["p11"]],
                              [1 - params["p22"], params["p22"]]])
                d = _dens(np.array([r.values[i]]), params["mu"], params["sig"])[0]
                num = (state @ T) * d
                state = num / num.sum()
                rt[t] = state[1]
        rt = rt.dropna()

        # --- 폭락 사건 vs 80% 돌파 시차 ---
        pr_px = P.get(key.replace("_TR", "_PR"))
        base = (pr_px if pr_px is not None else px).dropna()
        wm = (base.pct_change(10) * 100).resample("W-FRI").min().dropna()
        crash, last = [], None
        for d, v in wm[wm <= -10].items():
            if last is None or (d - last).days > 91:
                crash.append(d)
            last = d
        crash = [d for d in crash if d >= rt.index[0]]
        print(f"\n폭락 사건(10영업일 −10% 최초 돌파, 실시간 확률 가용 구간) {len(crash)}건")
        print(f"{'사건':>12} {'Filtered 80% 돌파':>18} {'시차(주)':>8} {'Smoothed 80% 돌파':>18} {'시차(주)':>8}")
        for d in crash:
            row = [str(d.date())]
            for series in (rt, smoothed):
                win = series[(series.index >= d - pd.Timedelta(weeks=8))
                             & (series.index <= d + pd.Timedelta(weeks=8))]
                hit = win[win >= 0.8]
                if len(hit):
                    lead = round((d - hit.index[0]).days / 7)
                    row += [str(hit.index[0].date()), f"{lead:+d}"]
                else:
                    row += ["(±8주 내 없음)", "–"]
            print(f"{row[0]:>12} {row[1]:>18} {row[2]:>8} {row[3]:>18} {row[4]:>8}")

        # --- 선행 프로파일 + 현행 지표와의 중복도 ---
        leads = [0, 1, 2, 4, 8]
        prof = []
        for L in leads:
            pair = pd.concat([rt, wm.shift(-L)], axis=1, sort=True).dropna()
            prof.append(-spearman(pair.iloc[:, 0], pair.iloc[:, 1]))
        print("\n선행 프로파일(Filtered, + = 설명): "
              + "  ".join(f"L={l}: {v:+.2f}" for l, v in zip(leads, prof)))
        vix = P.get("info:VIX")
        if vix is not None:
            vxw = vix.resample("W-FRI").last().dropna()
            pair = pd.concat([rt, vxw], axis=1, sort=True).dropna()
            print(f"현행 변동성 재료(VIX 수준)와의 상관: {spearman(pair.iloc[:, 0], pair.iloc[:, 1]):+.2f}")
        pair = pd.concat([rt, smoothed], axis=1, sort=True).dropna()
        print(f"Filtered vs Smoothed 상관 {spearman(pair.iloc[:, 0], pair.iloc[:, 1]):+.2f} — "
              f"차이가 곧 사후판정 편향이다")

        # --- EGARCH 비대칭 ---
        par, lr, pv = fit_egarch(r.values)
        print(f"\nEGARCH(1,1): 지속성 δ={par[1]:.3f} · 크기효과 θ={par[2]:+.3f} · "
              f"**방향효과 φ={par[3]:+.3f}** (LR φ=0 대비 {lr:.1f}, p={pv:.4f} — "
              f"{'악재 비대칭 유의 ✓' if pv < 0.05 and par[3] < 0 else '유의하지 않음'})")


if __name__ == "__main__":
    main()
