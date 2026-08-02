# -*- coding: utf-8 -*-
"""모델 랩 시안 — 기본 모델 백테스트 하네스 (기능 4 착수 전 검토용).

    python pipeline/research/modellab_prototype.py --data-dir <data 저장소 경로>

CI 에서 돌지 않는 수동 하네스다(wf_validation·alloc_prototype 과 같은 성격).
화면을 만들기 전에, HANDOVER §8 이 예약해 둔 표준 인터페이스와 기본 모델들이
실데이터에서 실제로 어떤 성적을 내는지 본다 — §2: 시안은 반드시 실데이터로.

표준 인터페이스 (§8 합의 그대로):
    입력 = t 시점까지의 데이터  →  출력 = 특정 변수의 k개월 후 전망
    매월 말 전망을 내고, k개월 뒤 실현값과 대조한다(전 구간 표본 외).

기본 모델 — 전부 §8 에 이름이 적힌 것 + 벤치마크. **적합(fitting) 파라미터 0개**:
    랜덤워크      전망 = 현재값. 모든 모델이 넘어야 할 기준선 (Meese-Rogoff 이후 표준)
    커브 내재     국채 커브에서 계산한 포워드 금리. f = (y(T+m)(T+m) − y(m)m)/T,
                 커브 점 사이는 만기 선형 보간 (제로금리 근사 — 한계를 결과에 명시)
    IRS 포워드    시장이 직접 호가하는 포워드(5y3m·5y1y). 국채-스왑 베이시스가
                 섞이는 한계를 명시 (IRS 스팟 시리즈가 없어 베이시스 보정 불가)
    테일러(1993)  기준금리 목표수준 i* = π + 2 + 0.5(π−2) + 0.5·갭. 계수는 원논문
                 그대로(적합 없음). 물가 2개월·IMF 갭 6개월 발표 지연 반영
    포워드 환율   달러원 3개월 = 스팟 × (1 + 스왑레이트 × 90/360). 실측 SMB 사용
    금리평형(UIP) 달러원 12개월 = 스팟 × (1 + 한미 1년 금리차). 1년물은 커브 보간

주식(포워드 어닝일드 − 무위험)은 **12M 선행 PER 확보 후 활성화** — §6 요청 대기.

평가 (§4 원칙 준수):
    MAE·RMSE, RMSE÷랜덤워크(1 미만 = 이김), 방향 적중률,
    IC = Spearman(예측 변화, 실현 변화) — common.spearman 재사용,
    DM t = Diebold-Mariano 형 손실차 검정, **Newey-West HAC(시차 k−1)** —
    k개월 지평을 매월 평가하므로 오차가 MA(k−1)로 중첩되기 때문(§4 명문).
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import common  # noqa: E402
import process as P  # noqa: E402

LAG_CPI_M = 2      # 근원물가 발표 지연(개월) — 보수적
LAG_GAP_M = 6      # IMF 갭 발표 지연(개월) — WEO 반기 발행, 보수적
EVAL_START = "2003-01"


def me(s: pd.Series) -> pd.Series:
    return s.dropna().resample("ME").last()


# ---------------------------------------------------------------------------
# 커브 — 만기 선형 보간과 내재 포워드
# ---------------------------------------------------------------------------
def curve_frame(S, keys: dict[float, str]) -> pd.DataFrame:
    cols = {t: me(S[k]) for t, k in keys.items() if k in S}
    return pd.DataFrame(cols)


def interp_yield(row: pd.Series, t: float) -> float:
    """커브 한 시점(행)에서 만기 t 의 수익률 — 인접 두 점 사이 만기 선형 보간."""
    pts = row.dropna()
    if len(pts) < 2:
        return np.nan
    xs = np.array(sorted(pts.index))
    ys = pts[xs].values
    if t < xs[0] - 1e-9 or t > xs[-1] + 1e-9:
        return np.nan                     # 외삽하지 않는다 (경계점은 포함)
    return float(np.interp(t, xs, ys))


def curve_forward(cf: pd.DataFrame, T: float, m: float) -> pd.Series:
    """만기 T 금리의 m년 뒤 커브 내재 포워드. f = (y(T+m)(T+m) − y(m)m)/T."""
    out = {}
    for dt, row in cf.iterrows():
        y_long = interp_yield(row, T + m)
        y_short = interp_yield(row, m)
        if not (np.isnan(y_long) or np.isnan(y_short)):
            out[dt] = (y_long * (T + m) - y_short * m) / T
    return pd.Series(out)


# ---------------------------------------------------------------------------
# 평가 — 전 구간 표본 외, 중첩 보정(HAC)
# ---------------------------------------------------------------------------
def nw_tstat(d: np.ndarray, lag: int) -> float:
    """평균(d)/HAC 표준오차 — Newey-West(Bartlett), 시차 lag."""
    n = len(d)
    if n < 8:
        return float("nan")
    dc = d - d.mean()
    v = float(dc @ dc) / n
    for j in range(1, min(lag, n - 1) + 1):
        w = 1 - j / (lag + 1)
        v += 2 * w * float(dc[:-j] @ dc[j:]) / n
    se = math.sqrt(max(v, 1e-18) / n)
    return float(d.mean() / se)


def evaluate(target: pd.Series, forecasts: dict[str, pd.Series], k: int) -> list[dict]:
    """target: 월말 수준값. forecasts: 모델별 t 시점에 낸 t+k개월 전망."""
    tgt = target.copy()
    realized = tgt.shift(-k)                       # t 시점 행에 t+k 실현값
    rows = []
    rw_err = None
    idx_all = None
    # 랜덤워크 오차를 먼저 — 공통 표본은 "모든 모델 + RW 가 있는 날"로 맞춘다
    frames = {"랜덤워크": tgt} | forecasts
    df = pd.DataFrame({name: f for name, f in frames.items()})
    df["_real"] = realized
    df.index = pd.DatetimeIndex(df.index)
    df = df[df.index >= pd.Timestamp(EVAL_START)].dropna()
    if len(df) < 24:
        return []
    for name in frames:
        err = (df[name] - df["_real"]).values
        pred_chg = (df[name] - df["랜덤워크"]).values      # 예측 변화 (RW 는 0)
        real_chg = (df["_real"] - df["랜덤워크"]).values
        if name == "랜덤워크":
            rw_err = err
        hits = np.sign(pred_chg) == np.sign(real_chg)
        nz = pred_chg != 0
        row = {
            "model": name, "n": len(df),
            "bias": float(np.mean(err)),
            "mae": float(np.mean(np.abs(err))),
            "rmse": float(np.sqrt(np.mean(err ** 2))),
            "hit": float(np.mean(hits[nz])) if nz.any() else np.nan,
            "ic": common.spearman(pd.Series(pred_chg), pd.Series(real_chg))
                  if nz.any() else np.nan,
        }
        rows.append(row)
    rw_rmse = next(r["rmse"] for r in rows if r["model"] == "랜덤워크")
    for r in rows:
        r["ratio"] = r["rmse"] / rw_rmse if rw_rmse > 0 else np.nan
        if r["model"] == "랜덤워크":
            r["dm_t"] = np.nan
        else:
            err = (df[r["model"]] - df["_real"]).values
            d = err ** 2 - rw_err ** 2                 # 음수 = 모델이 이김
            r["dm_t"] = nw_tstat(d, lag=max(k - 1, 1))
    return rows


def show(title: str, unit: str, rows: list[dict]):
    if not rows:
        print(f"\n[{title}] 표본 부족 — 건너뜀")
        return
    print(f"\n{'─' * 96}\n{title}   (n={rows[0]['n']}, 단위 {unit})\n{'─' * 96}")
    print(f"{'모델':<16}{'편의':>9}{'MAE':>9}{'RMSE':>9}{'÷RW':>7}{'방향적중':>9}{'IC':>8}{'DM t(HAC)':>11}")
    for r in rows:
        dm = "  —" if np.isnan(r["dm_t"]) else f"{r['dm_t']:+.2f}"
        hit = "  —" if np.isnan(r["hit"]) else f"{r['hit']*100:.0f}%"
        ic = "  —" if (isinstance(r["ic"], float) and np.isnan(r["ic"])) else f"{r['ic']:+.2f}"
        print(f"{r['model']:<16}{r['bias']:>+9.3f}{r['mae']:>9.3f}{r['rmse']:>9.3f}{r['ratio']:>7.2f}"
              f"{hit:>9}{ic:>8}{dm:>11}")
    print("  ÷RW < 1 이고 DM t 가 음(−)으로 유의(≈−2 이하)해야 랜덤워크를 이긴 것입니다.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True, type=Path)
    args = ap.parse_args()
    P.load_data_dir(args.data_dir)
    S = {k: v["s"] for k, v in P.SERIES.items()}

    # ----- 커브 -----
    us_curve = curve_frame(S, {0.25: "bb:미국_3m", 0.5: "bb:미국_6m", 1: "bb:미국_1y",
                               2: "bb:미국_2y", 3: "bb:미국_3y", 5: "bb:미국_5y",
                               7: "bb:미국_7y", 10: "bb:미국_10y"})
    kr_curve = curve_frame(S, {0.25: "info:한국_3m", 0.5: "bb:한국_6m", 1: "info:한국_1y",
                               2: "bb:한국_2y", 3: "bb:한국_3y", 5: "bb:한국_5y",
                               7: "bb:한국_7y", 10: "bb:한국_10y"})

    print("모델 랩 시안 — 기본 모델 walk-forward 백테스트 (매월 말 전망, 전 구간 표본 외)")
    print(f"평가 시작 {EVAL_START} · 발표 지연: 물가 {LAG_CPI_M}개월 · IMF 갭 {LAG_GAP_M}개월 "
          f"· HAC 시차 = 지평 − 1")

    # ===== 1) 국채 5년 금리 (자산배분의 국내채권 프록시와 동일 만기) =====
    for ctry, curve, tgt_key, irs3, irs12 in [
        ("미국", us_curve, "bb:미국_5y", "bb:미국_IRS_5y3m", "bb:미국_IRS_5y1y"),
        ("한국", kr_curve, "bb:한국_5y", "bb:한국_IRS_5y3m", "bb:한국_IRS_5y1y"),
    ]:
        tgt = me(S[tgt_key])
        for k, mfrac, irs_key in [(3, 0.25, irs3), (12, 1.0, irs12)]:
            fwd_curve = curve_forward(curve, 5.0, mfrac)
            fc = {"커브 내재": fwd_curve, "IRS 포워드": me(S[irs_key])}
            show(f"{ctry} 국채 5년 — {k}개월 후", "%p", evaluate(tgt, fc, k))

    # ===== 2) 기준금리 — 테일러(1993) 원계수, 적합 없음 =====
    for ctry, pol_key, cpi_key, gap_key in [
        ("미국", "bb:미국_기준금리", "bb:미국_core_PCE_CPI_yoy", "bb:미국_GDP_gap_IMF"),
        ("한국", "bb:한국_기준금리", "bb:한국_core_CPI_yoy", "bb:한국_output_gap_IMF"),
    ]:
        pol = me(S[pol_key])
        pi = me(S[cpi_key]).shift(LAG_CPI_M)
        gap = me(S[gap_key]).shift(LAG_GAP_M)
        taylor = (pi + 2 + 0.5 * (pi - 2) + 0.5 * gap).dropna()
        for k in (3, 12):
            show(f"{ctry} 기준금리 — {k}개월 후", "%p",
                 evaluate(pol, {"테일러(1993)": taylor}, k))

    # ===== 3) 달러원 =====
    fx = me(S["bb:달러원"])
    smb = me(S["info:SMB_USDKRW_3M"])
    fwd3 = (fx * (1 + smb / 100 * 90 / 360)).dropna()
    kr1 = kr_curve.apply(lambda r: interp_yield(r, 1.0), axis=1)
    us1 = us_curve.apply(lambda r: interp_yield(r, 1.0), axis=1)
    uip12 = (fx * (1 + (kr1 - us1) / 100)).dropna()
    show("달러원 — 3개월 후", "원", evaluate(fx, {"포워드(CIP 실측)": fwd3}, 3))
    show("달러원 — 12개월 후", "원", evaluate(fx, {"금리평형(UIP 1y)": uip12}, 12))

    print(f"\n{'─' * 96}")
    print("주식(포워드 어닝일드 − 무위험)은 12M 선행 PER 확보 후 활성화 — §6 데이터 요청 대기.")
    print("커브 내재는 제로금리 근사·만기 선형 보간, IRS 포워드는 국채-스왑 베이시스 미보정 —")
    print("두 한계는 화면에도 그대로 적는다. 모든 모델은 적합 파라미터 0개(원논문 계수·시장 호가 그대로).")


if __name__ == "__main__":
    main()
