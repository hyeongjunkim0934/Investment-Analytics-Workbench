# -*- coding: utf-8 -*-
"""자산배분 시뮬레이터 시안 — 실데이터 계산 하네스 (기능 2 착수 전 검토용).

    python pipeline/research/alloc_prototype.py --data-dir <data 저장소 경로>

CI 빌드에 포함되지 않는다. `wf_validation.py` 와 같은 위치·같은 성격의 수동
하네스이며, 화면 설계를 확정하기 전에 **실데이터가 실제로 어떤 숫자를 내는지**
보기 위한 것이다(HANDOVER §2: 시안은 반드시 실데이터로 계산한다).

정한 것 — 이후 논의로 바뀔 수 있는 지점은 전부 상수로 뽑아 두었다:

1. **기대수익은 관측된 것과 가정한 것을 섞지 않고 나눠 적는다.**
   채권·현금은 현재 시장금리에서 그대로 온다(관측). 주식은 시장이 값을 주지 않으므로
   **ERP 를 명시적 입력**으로 두고, 역사적 실현치는 참고로 병기하되 그것을 기대수익으로
   쓰지는 않는다 — 19년 표본의 산술평균을 기대수익으로 삼으면 표본 구간을 고른 사람이
   답을 고른 것이 된다(HANDOVER §4 자의성 금지). 대신 ERP 를 흔들어 **민감도**를 보여준다.
   KOSPI·ACWI 12M 포워드 PER 이 확보되면(§6 높음) 주식도 관측값으로 옮겨간다 —
   그때 바뀌는 것은 `expected_returns()` 한 함수뿐이다.
2. **프록시는 ETF 가 아니라 지수·금리 계열.** ETF 계열은 시작일이 제각각이라
   공통 구간이 8년으로 줄고, `미국*` 계열은 원화 환산이라 FX 가 이미 들어 있어
   헤지비율 슬라이더와 이중계상된다(HANDOVER §6.1). 국내채권은 `hedge.py` 가 이미
   검증한 `synth_bond_tr()` 를 재사용한다.
3. **관점 두 벌, 자산군 목록도 두 벌.** 경제(시가) 관점에는 장부가/시가 구분이 **없다**
   — 같은 채권을 어떻게 회계처리하든 경제적 가치 변동은 같다. 두 줄로 나눠 두면
   상관 1.00 인 중복 자산이 생겨 공분산이 특이행렬이 된다. 구분은 회계 관점에서만 둔다.
4. **대체투자의 위험은 CPI 변동성이 아니다.** 기대수익을 CPI+α 로 두기로 합의했다고
   해서 위험까지 CPI 에서 가져오면 변동성이 0.3% 로 나와 최적화기가 한도까지 사들인다.
   위험은 별도 입력으로 둔다(기본 8%). 평가가 스무딩되는 자산이라 실측 변동성 자체가
   실제 위험을 과소평가한다는 점도 화면에 적어야 한다.
5. **대출금은 최적화 대상이 아니다**(§7.1 준고정). 비중을 고정하고 상관행렬에서도 뺀다.
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import hedge as H  # noqa: E402
import process as P  # noqa: E402

# ---------------------------------------------------------------------------
# 화면 입력값이 될 가정들 — 여기 있는 값은 전부 §7.3 의 "수기 입력" 후보다.
# 실제 화면에서는 localStorage 로 사용자가 넣는다. 여기서는 예시값.
# ---------------------------------------------------------------------------
ERP_KR = 5.0             # 국내주식 리스크 프리미엄 (%p, 무위험금리 위)
ERP_GL = 5.0             # 해외주식 리스크 프리미엄 (%p)
ALT_ALPHA = 3.0          # 대체투자 기대수익 = 기대 CPI + α
ALT_VOL = 8.0            # 대체투자 위험 (%) — 실측이 아니라 가정. 스무딩 때문에 실측은 과소평가
LOAN_YIELD = 4.0         # 약관대출 수익률 (준고정, 최적화 제외)
LOAN_WEIGHT = 12.0       # 약관대출 비중 (고정)
SWAP_TENOR_M = H.DEFAULT_TENOR_M   # 9개월 — 사용자 실무의 금액가중평균
HEDGE_RATIO = 0.9        # 해외자산 기본 헤지비율

# 예시 현재 배분 (대출금 제외 88%). 실제 값은 사용자 수기 입력.
MIX_ECON = {"국내채권": 42.0, "해외채권": 18.0, "국내주식": 3.0,
            "해외주식": 5.0, "대체투자": 15.0, "단기자금": 5.0}
MIX_ACCT = {"장부가 국내채권": 30.0, "시가 국내채권": 12.0,
            "장부가 해외채권": 12.0, "시가 해외채권": 6.0,
            "국내주식": 3.0, "해외주식": 5.0, "대체투자": 15.0, "단기자금": 5.0}
BANDS = {
    "국내채권": (20, 55), "해외채권": (0, 30),
    "장부가 국내채권": (15, 45), "시가 국내채권": (0, 25),
    "장부가 해외채권": (0, 25), "시가 해외채권": (0, 20),
    "국내주식": (0, 10), "해외주식": (0, 15),
    "대체투자": (5, 25), "단기자금": (2, 15),
}


# ---------------------------------------------------------------------------
# 1) 원천 시리즈 → 월간 수익률 블록
# ---------------------------------------------------------------------------
def blocks(S, warn):
    def g(k):
        s = S.get(k)
        if s is None:
            warn(f"alloc: 시리즈 없음 — {k}")
        return s

    usdkrw = H.despike(g("bb:달러원"))
    month_start = usdkrw.index[-1].to_period("M").to_timestamp()

    def cut(s):
        return s[s.index < month_start]

    smb = g("info:SMB_USDKRW_3M").resample("ME").last()
    return dict(
        e_usd=cut(H.mret(usdkrw)),                          # 달러원 월간 변화율
        kr_bond=cut(H.synth_bond_tr(g("bb:한국_5y"))),       # 국내채권 5년 합성 TR
        us_bond=cut(H.mret(g("bb:미국종합"))),               # 해외채권 (달러표시 — §6.1)
        kospi=cut(H.mret(g("bb:한국_KOSPI_TR"))),
        acwi=cut(H.mret(g("idx:ACWI"))),                    # 달러표시 · 현재 PR (§6)
        cash=cut((g("info:한국_3m").resample("ME").last() / 100 / 12).dropna()),
        cpi=cut((g("bb:한국_core_CPI_yoy").resample("ME").last() / 100 / 12).dropna()),
        swap=cut((smb / 100 / 12).dropna()),                # 스왑레이트 캐리 (월)
        d_swap=cut((smb / 100).diff().dropna()),            # 스왑레이트 변화 (%→소수)
    )


def to_krw(local, X, h=HEDGE_RATIO):
    """해외자산 원화수익률 = 현지수익률 + (1−h)×환율변동 + h×스왑레이트."""
    j = pd.concat({"r": local, "e": X["e_usd"], "f": X["swap"]}, axis=1, sort=True).dropna()
    return (1 + j["r"]) * (1 + (1 - h) * j["e"]) - 1 + h * j["f"]


def scale_to_vol(s, target_pct):
    """수익률 시리즈의 상관구조는 두고 변동성만 목표치로 맞춘다(대체투자 위험 가정용)."""
    cur = float(s.std()) * math.sqrt(12) * 100
    return s if cur <= 0 else (s - s.mean()) * (target_pct / cur) + s.mean()


# ---------------------------------------------------------------------------
# 2) 관점별 자산군 수익률
# ---------------------------------------------------------------------------
def econ_assets(X):
    """경제(시가) 관점 — 장부가/시가 구분 없음."""
    alt = scale_to_vol(X["cpi"] + ALT_ALPHA / 100 / 12, ALT_VOL)
    return {"국내채권": X["kr_bond"], "해외채권": to_krw(X["us_bond"], X),
            "국내주식": X["kospi"], "해외주식": to_krw(X["acwi"], X),
            "대체투자": alt, "단기자금": X["cash"]}


def acct_assets(X):
    """회계(손익) 관점 — HANDOVER §5.3 의 5항 모형.

    장부가 국내채권: 유효이자만                       → 변동성 0
    장부가 해외채권: 유효이자 + (1−h)Δ환율 + h·s₀ + h·τ·(−Δs)
    시가 자산·주식·대체·현금: 경제 관점과 동일
    """
    h, tau = HEDGE_RATIO, SWAP_TENOR_M / 12 / 2
    by_kr = float(X["kr_bond"].tail(60).mean())     # 예시 북일드 (수기 입력 대상)
    by_fx = float(X["us_bond"].tail(60).mean())
    j = pd.concat({"e": X["e_usd"], "f": X["swap"], "ds": X["d_swap"]}, axis=1, sort=True).dropna()

    e = econ_assets(X)
    return {"장부가 국내채권": pd.Series(by_kr, index=j.index),
            "시가 국내채권": e["국내채권"],
            "장부가 해외채권": by_fx + (1 - h) * j["e"] + h * j["f"] + h * tau * (-j["ds"]),
            "시가 해외채권": e["해외채권"],
            "국내주식": e["국내주식"], "해외주식": e["해외주식"],
            "대체투자": e["대체투자"], "단기자금": e["단기자금"]}


# ---------------------------------------------------------------------------
# 3) 기대수익 — 관측(채권·현금) / 가정(주식·대체)을 분리해 적는다
# ---------------------------------------------------------------------------
def expected_returns(S, erp_kr=ERP_KR, erp_gl=ERP_GL):
    now = {k: float(S[v].dropna().iloc[-1]) for k, v in {
        "kr3m": "info:한국_3m", "kr5y": "bb:한국_5y", "us_ytm": "info:UST_ALL_YTM",
        "us3m": "bb:미국_3m", "swap": "info:SMB_USDKRW_3M",
        "cpi": "bb:한국_core_CPI_yoy"}.items()}
    carry = HEDGE_RATIO * now["swap"]      # 헤지분에 붙는 스왑레이트 (음수면 비용)
    mu = {"국내채권": now["kr5y"], "해외채권": now["us_ytm"] + carry,
          "국내주식": now["kr3m"] + erp_kr,
          "해외주식": now["us3m"] + erp_gl + carry,
          "대체투자": now["cpi"] + ALT_ALPHA, "단기자금": now["kr3m"]}
    mu.update({"장부가 국내채권": mu["국내채권"], "시가 국내채권": mu["국내채권"],
               "장부가 해외채권": mu["해외채권"], "시가 해외채권": mu["해외채권"]})
    return mu, now


# ---------------------------------------------------------------------------
# 4) 최적화 — 밴드 제약 하 최소분산 / 목표수익. 브라우저에 그대로 옮길 방식.
# ---------------------------------------------------------------------------
def project(w, lo, hi, total):
    a, b = -2.0, 2.0
    for _ in range(200):
        m = (a + b) / 2
        if np.clip(w + m, lo, hi).sum() > total:
            b = m
        else:
            a = m
    return np.clip(w + (a + b) / 2, lo, hi)


def optimize(mu, cov, lo, hi, total, target=None, iters=8000):
    """투영 경사법. scipy 없이 numpy 만으로 — 같은 알고리즘을 app.js 로 옮긴다."""
    w = project(np.full(len(mu), total / len(mu)), lo, hi, total)
    lam = 0.0
    for _ in range(iters):
        grad = cov @ w - lam * mu
        w = project(w - 0.02 * grad / max(np.abs(grad).max(), 1e-12), lo, hi, total)
        if target is not None:
            lam = max(0.0, lam + 3.0 * (target - float(mu @ w)))
    return w


def stats(w, mu, cov):
    return float(mu @ w), float(math.sqrt(max(w @ cov @ w, 0)))


# ---------------------------------------------------------------------------
def analyze(title, rets, mix, mu_map, note, show=True):
    keys = list(mix)
    M = pd.DataFrame({k: rets[k] for k in keys}, index=None).dropna()
    mu = np.array([mu_map[k] for k in keys])
    cov = M.cov().values * 12 * 10000                     # 연율화, %² 단위
    vol = np.sqrt(np.diag(cov))
    w0 = np.array([mix[k] for k in keys]) / 100
    lo = np.array([BANDS[k][0] for k in keys]) / 100
    hi = np.array([BANDS[k][1] for k in keys]) / 100
    total = sum(mix.values()) / 100
    r0, s0 = stats(w0, mu, cov)
    wmv = optimize(mu, cov, lo, hi, total)
    wsr = optimize(mu, cov, lo, hi, total, target=r0)
    rmv, smv = stats(wmv, mu, cov)
    rsr, ssr = stats(wsr, mu, cov)

    if show:
        print(f"\n{'='*98}\n[{title}]  표본 {M.index[0]:%Y-%m} ~ {M.index[-1]:%Y-%m} "
              f"({len(M)}개월)\n{'='*98}\n{note}")
        print(f"\n{'자산군':<16}{'기대수익%':>10}{'위험%':>8}{'현재%':>8}{'밴드':>11}   출처")
        src = {"국내채권": "관측 — 한국 5년 YTM", "해외채권": "관측 — 미국 종합 YTM + 헤지캐리",
               "장부가 국내채권": "관측(북일드 입력 대상)", "시가 국내채권": "관측 — 한국 5년 YTM",
               "장부가 해외채권": "관측(북일드 입력 대상)", "시가 해외채권": "관측 — 미국 종합 YTM + 헤지캐리",
               "국내주식": "**가정** — 무위험 + ERP", "해외주식": "**가정** — 무위험 + ERP + 헤지캐리",
               "대체투자": "**가정** — CPI + α, 위험도 가정", "단기자금": "관측 — 한국 3개월"}
        for i, k in enumerate(keys):
            print(f"{k:<16}{mu[i]:>10.2f}{vol[i]:>8.2f}{mix[k]:>8.1f}"
                  f"{f'{BANDS[k][0]}~{BANDS[k][1]}':>11}   {src[k]}")
        print(f"\n상관행렬 (변동성 0인 자산은 상관이 정의되지 않아 '—')")
        C = M.corr()
        print(f"{'':<16}" + "".join(f"{k[:5]:>7}" for k in keys))
        for k in keys:
            row = "".join("      —" if not np.isfinite(C.loc[k, j]) else f"{C.loc[k, j]:>7.2f}"
                          for j in keys)
            print(f"{k:<16}{row}")
        print(f"\n현재 배분        기대수익 {r0:.2f}%   위험 {s0:.2f}%")
        print(f"  ① 위험 최소     기대수익 {rmv:.2f}%   위험 {smv:.2f}%   ({smv-s0:+.2f}%p)")
        print(f"  ② 수익 유지     기대수익 {rsr:.2f}%   위험 {ssr:.2f}%   ({ssr-s0:+.2f}%p)")
        print(f"\n  개선 방향 (② 같은 기대수익을 유지하며 위험만 줄이는 방향)")
        for i, k in enumerate(keys):
            d = wsr[i] * 100 - mix[k]
            if abs(d) >= 0.05:
                mark = ("▲" if d > 0 else "▼") * min(int(abs(d) / 2) + 1, 10)
                print(f"    {k:<16}{mix[k]:>6.1f} → {wsr[i]*100:>5.1f}   {d:>+6.1f}%p  {mark}")
    return wsr, r0, s0, ssr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True, type=Path)
    args = ap.parse_args()
    P.load_data_dir(args.data_dir)
    S = {k: v["s"] for k, v in P.SERIES.items()}
    X = blocks(S, P.warn)
    mu_map, now = expected_returns(S)

    print(f"\n{'='*98}\n기대수익 재료 — 관측된 것과 가정한 것을 구분한다\n{'='*98}")
    print(f"  [관측] 한국 3개월 {now['kr3m']:.2f}%  한국 5년 {now['kr5y']:.2f}%  "
          f"미국 종합 YTM {now['us_ytm']:.2f}%  미국 3개월 {now['us3m']:.2f}%")
    print(f"  [관측] 달러원 스왑레이트(3M) {now['swap']:+.2f}% → 헤지 {HEDGE_RATIO*100:.0f}% 적용 시 "
          f"{HEDGE_RATIO*now['swap']:+.2f}%p")
    print(f"  [관측] 한국 근원 CPI {now['cpi']:.2f}%")
    print(f"  [가정] ERP 국내 {ERP_KR:+.1f}%p · 해외 {ERP_GL:+.1f}%p, "
          f"대체 α {ALT_ALPHA:+.1f}%p(위험 {ALT_VOL:.0f}%), 대출금 {LOAN_YIELD:.1f}%(비중 {LOAN_WEIGHT:.0f}% 고정)")
    e = {"kospi": X["kospi"], "acwi": X["acwi"], "cash": X["cash"]}
    print(f"  [참고·기대수익에 쓰지 않음] 실현 초과수익 산술평균 "
          f"국내 {(e['kospi'].mean()-e['cash'].mean())*1200:+.1f}%p · "
          f"해외 {(e['acwi'].mean()-e['cash'].mean())*1200:+.1f}%p "
          f"— 19년 표본이고 ACWI 는 아직 PR 이라 배당이 빠져 있다")

    analyze("경제(시가) 관점", econ_assets(X), MIX_ECON, mu_map,
            "  전 자산 시가평가. 장부가/시가 구분이 없다 — 같은 채권의 경제적 가치 변동은 회계처리와 무관하다.\n"
            f"  대출금 {LOAN_WEIGHT:.0f}%(준고정)는 최적화에서 제외. 나머지 {sum(MIX_ECON.values()):.0f}%만 배분한다.")

    analyze("회계(손익) 관점", acct_assets(X), MIX_ACCT, mu_map,
            "  장부가 채권은 가격 변동이 손익에 안 잡힌다 → 변동성이 0(국내)·환율만(해외) 남는다.\n"
            "  이 관점만 보고 최적화하면 장부가로 쏠린다. 두 관점을 함께 봐야 하는 이유가 이것이다.")

    # ----- ERP 가정 민감도 — 가정이 답을 얼마나 흔드는지 -----
    print(f"\n{'='*98}\nERP 가정 민감도 (경제 관점, ② 수익 유지 해) — 가정이 답을 얼마나 흔드나\n{'='*98}")
    print(f"{'ERP(국내=해외)':<16}" + "".join(f"{k[:6]:>10}" for k in MIX_ECON) + f"{'기대수익':>10}{'위험':>8}")
    for erp in [3.0, 4.0, 5.0, 6.0, 7.0]:
        mu2, _ = expected_returns(S, erp, erp)
        w, r0, s0, ss = analyze("", econ_assets(X), MIX_ECON, mu2, "", show=False)
        print(f"{erp:>6.1f}%p        " + "".join(f"{v*100:>10.1f}" for v in w) + f"{r0:>10.2f}{ss:>8.2f}")
    print("\n  국내·해외 ERP 를 같게 두면 배분이 ERP 수준에 거의 반응하지 않는다 —")
    print("  주식 비중을 움직이는 것은 ERP 의 절대 수준이 아니라 국내 대 해외의 '차이'다.")
    print("  즉 논쟁해야 할 가정은 '주식이 몇 % 벌까'가 아니라 '국내와 해외 중 어느 쪽이 나은가'다.")


if __name__ == "__main__":
    main()
