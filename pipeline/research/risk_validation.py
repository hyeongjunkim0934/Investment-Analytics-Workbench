"""리스크 점수 정합성 검증 하네스 — 실현변동성·낙폭·절대수익률 대조 + 동적 λ 경제 백테스트.

    python pipeline/research/risk_validation.py --data-dir <data 저장소 경로>

CI 미실행, 파일을 쓰지 않는다(stdout 표만). 2026-09-08 사용자 제안문("리스크 지표 백테스팅
BM 설정") 의 체크리스트를 그대로 실측한다 — 요인·점수는 배포 코드(`risk.build`)에서, 최적화
엔진은 `risk_lambda_alloc.py`(app.js 복제) 에서 가져오고 여기서 정하는 것은 평가 설계뿐이다.

설계
  통계 검증(제안 §1) — 주간 점수(현재 위험 stress·잠재 위험 vuln) × 시장(KOSPI TR·S&P500 TR):
    · Realized_Vol_10d/20d = t 이후 10/20영업일 일간 로그수익률 표준편차(연율화 %) — 제안의 정의
    · |R10| = 향후 10영업일 수익률 절대값, DD_t = 동시대 낙폭(고점 대비), 추가낙폭 13주
    · 순위상관(spearman) · 교차상관 L=−8…+8주(+ = 점수가 앞섬) · **변동성 지속 기준선**
      (과거 10일 RV → 미래 RV)과 그 기준선을 뺀 부분상관(점수가 군집 이상을 더 아는가)
    · 상위 4분위 미래 RV 판별 AUC
    · 국면 분할 검정: ≥70 vs ≤30 의 미래 RV — Welch t(정규 근사 p) + **순환 이동 순열 p**
      (겹치는 창·자기상관 때문에 독립 t 의 p 는 과소 — 점수 열을 26주 이상 순환 이동해
      관계만 끊고 두 열의 자기상관은 보존)
    · 위기 매핑: 사건 창 11개에서 점수 최고·70 최초 돌파 주와 KOSPI 10일 최악일의 시차
  경제 백테스트(제안 §2) — 월별 리밸런스, 점수→λ 는 기존 로그 매핑(등급 한 칸당 ×10, 앵커
    점수 50↔λ 1 — risk_lambda_alloc.py 재사용, 발명 상수 0), μ·Σ 는 현재 CMA 고정(엔진 복제):
    · 전략: 정적 60/40(국내주식/국내채권 · 해외주식/국내채권) · 정적 MVO λ=1 · 동적 λ(현재/잠재)
    · 실현 수익률 = port.py 프록시(한국종합·미국종합·KOSPI TR·S&P TR·GSCI TR CME) + CD 3M 적립,
      달러 자산은 hb/he/h_alt 만큼 헤지(잔여 환노출만 달러원 — 캐리 무시), 대출형·지분형 → GSCI
    · 월말 점수 → 다음 달 비중(타이밍은 look-ahead 없음). **μ·Σ 가 현재 값이라 절대 성과는
      사후 정보 오염** — 같은 μ·Σ 를 쓰는 정적 MVO 와의 차이만 λ 타이밍 채널의 순효과다.
    · 지표: 연율 수익·변동성·샤프(CD 초과)·MDD·최장 회복·월평균 편측 턴오버·위기월 평균

실행 기록 (2026-09-08, 실데이터 483 시리즈, exit 0 — 문서 §5.1 추기가 정본):
  1. 통계 검증 (표본 외 주간 점수, 현재 위험 2009-01~2026-07 913주 · 잠재 위험 2006-03~ 1065주)
     현재 위험 vs KOSPI: ρ(점수, 미래 RV10) +0.500 · RV20 +0.505 · |R10| +0.229 · 동시낙폭 +0.741
       · AUC(RV10 상위¼) 0.761. **기준선 ρ(과거 RV10, 미래 RV10) = +0.525** — 점수와 같은 급.
       과거 RV 를 통제한 부분상관 +0.234(S&P +0.298) — 변동성 군집 이상의 정보는 있으나 작다.
       교차상관 봉우리 **L = −2주**(점수가 실현변동성을 2주 뒤따른다, S&P 도 −2) — 선행 없음.
       국면 검정 ≥70(88주) RV 25.9% vs ≤30(109주) 9.9%, Welch t 11.3, 순환순열 p 0.007
       (S&P 28.2 vs 8.4, p 0.000) — 제안의 t-검정 기준은 큰 폭으로 통과.
       ≥70 주는 동시 낙폭 평균 −26%·낙폭≥10% 안 100% 지만 **이후 13주 추가낙폭 −4.6% 는 전체 주
       평균 −5.5% 와 같다** — 높은 점수 뒤에 더 떨어지지 않는다(§5.1 경기순응 실측과 일치).
     잠재 위험: 미래 RV 와 **음의 상관**(KOSPI −0.17·S&P −0.40, AUC 0.39/0.27), 국면 검정 무차이
       (KOSPI p 0.76) — 조건부분산 척도가 아니라 축적 지표라 이 잣대가 맞지 않는다. 대신 ≥70 주
       이후 13주 추가낙폭 −8.8% vs 전체 −6.1%(KOSPI) — 방향은 「나중에 더 다친다」 쪽이나 S&P 는
       −5.6 vs −5.0 으로 미약. 위기 매핑에서 70 을 넘긴 사건이 하나도 없다(최고 68 — 2020-02-21·
       2024-07-19, 둘 다 폭락 **전**) → 이 층에 70 컷은 잘못된 눈금이다.
  2. 위기 매핑 (현재 위험, KOSPI 10일 최악일 기준): 70 돌파 시차 2010 +1주 · 2011 +0 · 2020 +1
     (03-13 → 최악 03-19) · 2022 +7(창이 43주라 5월 돌파·6월 최악) · 2025-04 0 / **미달** 2013(51)·
     2015(59)·2016(69)·2018(64)·2024-08(57). 2008 은 점수 표본이 2009-01 시작이라 판정 제외.
  3. 경제 백테스트 (2010-12~2026-08 189개월, 월별 리밸런스, μ·Σ 현재 CMA 고정 — 절대 성과는
     사후 정보 오염, 전략 간 차이만): 정적 MVO λ=1 샤프 0.36·MDD −23.1% vs **동적 λ(로그 매핑,
     현재 위험) 샤프 0.27·MDD −23.2%·연수익 −0.99%p·턴오버 2.95%p/월 → 샤프 −0.08**; 잠재 위험
     기준 −0.10. 정적 60/40(해외주식/국내채권) 0.89 · (국내주식/국내채권) 0.44. 위기월(국내주식
     −5% 미만 18개월) 평균: 정적 MVO −2.61% vs 동적 −2.06% — 방어는 0.5%p 얻고 나머지 171개월에서
     그 이상을 잃는다. 결론: **점수를 λ 다이얼로 쓰면 정적보다 나쁘다**(§5.1 ⓑ 미채택 유지).
"""
from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import bm            # noqa: E402
import common        # noqa: E402
import process as P  # noqa: E402
import risk          # noqa: E402
from risk_lambda_alloc import ASSETS, build_engine, lam_log, optimize_util  # noqa: E402

MKT = {"KOSPI": "bb:한국_KOSPI_TR", "S&P500": "bb:미국_S&P500_TR"}
PROXY = {"국내채권": "bb:한국종합", "해외채권": "bb:미국종합", "국내주식": "bb:한국_KOSPI_TR",
         "해외주식": "bb:미국_S&P500_TR", "대체투자": "bb:S&P GSCI TR CME"}
CD_KEY, FX_KEY = "bb:한국_크레딧_CD_AAA_3m", "bb:달러원"
EPISODES = [("2008 GFC(리먼)", "2008-09-01", "2009-03-31"), ("2010 유럽 1차", "2010-04-15", "2010-07-15"),
            ("2011 미 강등", "2011-07-15", "2011-10-31"), ("2013 테이퍼", "2013-05-15", "2013-07-15"),
            ("2015 위안화", "2015-08-01", "2015-09-30"), ("2016 중국·유가", "2016-01-01", "2016-02-29"),
            ("2018 4Q", "2018-10-01", "2018-12-31"), ("2020 코로나", "2020-02-15", "2020-04-30"),
            ("2022 긴축", "2022-01-01", "2022-10-31"), ("2024-08 엔캐리", "2024-07-15", "2024-08-31"),
            ("2025-04 관세", "2025-03-15", "2025-04-30")]
HI, LO = 70.0, 30.0


def series(key: str) -> pd.Series:
    s = P.SERIES.get(key)
    if s is None:
        raise SystemExit(f"시리즈 없음: {key}")
    return s["s"].dropna().astype(float)


def window_stat(r: pd.Series, idx: pd.DatetimeIndex, k: int, fwd: bool, fn) -> pd.Series:
    arr = r.to_numpy()
    pos = r.index.searchsorted(idx, side="right")          # t 보다 뒤의 첫 관측
    out = []
    for p in pos:
        seg = arr[p:p + k] if fwd else arr[max(0, p - k):p]
        out.append(fn(seg) if len(seg) == k else np.nan)
    return pd.Series(out, index=idx, dtype=float)


def ann_vol(seg: np.ndarray) -> float:
    return float(np.std(seg, ddof=1) * math.sqrt(252) * 100)


def spearman(a: pd.Series, b: pd.Series) -> float:
    return float(common.spearman(a, b))


def partial_spearman(score: pd.Series, y: pd.Series, ctrl: pd.Series) -> float:
    j = pd.concat([score, y, ctrl], axis=1).dropna()
    if len(j) < 30:
        return float("nan")
    ry, rc = j.iloc[:, 1].rank(), j.iloc[:, 2].rank()
    b = np.polyfit(rc, ry, 1)
    resid = ry - np.polyval(b, rc)
    return float(common.spearman(j.iloc[:, 0], resid))


def norm_cdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def welch(a: np.ndarray, b: np.ndarray) -> tuple[float, float, float]:
    ma, mb = a.mean(), b.mean()
    va, vb = a.var(ddof=1) / len(a), b.var(ddof=1) / len(b)
    t = (ma - mb) / math.sqrt(va + vb)
    df = (va + vb) ** 2 / (va ** 2 / (len(a) - 1) + vb ** 2 / (len(b) - 1))
    p = 2 * (1 - norm_cdf(abs(t)))                          # df ≫ 30 → 정규 근사
    return float(t), float(df), float(p)


def shift_perm_p(score: pd.Series, y: pd.Series, n_rep: int, seed: int = 7) -> tuple[float, float]:
    """순환 이동 순열 검정 — 점수 열을 26주 이상 돌려 관계만 끊는다(두 열의 자기상관 보존)."""
    j = pd.concat([score, y], axis=1).dropna()
    s, v = j.iloc[:, 0].to_numpy(), j.iloc[:, 1].to_numpy()
    n = len(s)

    def diff(sv: np.ndarray) -> float:
        hi, lo = v[sv >= HI], v[sv <= LO]
        return float(hi.mean() - lo.mean()) if len(hi) >= 10 and len(lo) >= 10 else np.nan

    obs = diff(s)
    rng = np.random.default_rng(seed)
    cnt = tot = 0
    for _ in range(n_rep):
        k = int(rng.integers(26, n - 26))
        d = diff(np.roll(s, k))
        if np.isnan(d):
            continue
        tot += 1
        cnt += abs(d) >= abs(obs)
    return obs, (cnt / tot if tot else float("nan"))


def stat_block(name: str, score: pd.Series, level: pd.Series, reps: int) -> dict:
    r = np.log(level).diff().dropna()
    idx = score.index
    rv10, rv20 = window_stat(r, idx, 10, True, ann_vol), window_stat(r, idx, 20, True, ann_vol)
    past10 = window_stat(r, idx, 10, False, ann_vol)
    abs10 = window_stat(r, idx, 10, True, lambda seg: abs(math.expm1(seg.sum())) * 100)
    dd = (level / level.cummax() - 1) * 100
    dd_t = dd.reindex(idx, method="ffill")
    lvl_t = level.reindex(idx, method="ffill")
    extra = pd.Series([float(level.loc[t:t + pd.Timedelta(weeks=13)].min() / lvl_t.loc[t] - 1) * 100
                       for t in idx], index=idx)
    out = {"n": int(pd.concat([score, rv10], axis=1).dropna().shape[0])}
    out["rho_rv10"], out["rho_rv20"] = spearman(score, rv10), spearman(score, rv20)
    out["rho_abs10"], out["rho_dd"] = spearman(score, abs10), spearman(score, -dd_t)
    out["rho_extra"] = spearman(score, -extra)
    out["base_past"] = spearman(past10, rv10)
    out["partial"] = partial_spearman(score, rv10, past10)
    out["auc_q4"] = float(common.auc(score, rv10 >= rv10.quantile(0.75)))
    out["xcorr"] = {L: spearman(score, rv10.shift(-L)) for L in range(-8, 9)}
    j = pd.concat([score, rv10], axis=1).dropna()
    hi, lo = j[j.iloc[:, 0] >= HI].iloc[:, 1].to_numpy(), j[j.iloc[:, 0] <= LO].iloc[:, 1].to_numpy()
    out["n_hi"], out["n_lo"] = len(hi), len(lo)
    out["rv_hi"], out["rv_lo"] = (float(hi.mean()) if len(hi) else np.nan), (float(lo.mean()) if len(lo) else np.nan)
    if len(hi) >= 10 and len(lo) >= 10:
        out["t"], out["df"], out["p_welch"] = welch(hi, lo)
        out["diff"], out["p_perm"] = shift_perm_p(score, rv10, reps)
    # ≥70 주의 동시대 낙폭 · 추가 낙폭
    hiw = score[score >= HI].index
    out["hi_dd_mean"] = float(dd_t.reindex(hiw).mean()) if len(hiw) else np.nan
    out["hi_dd_share10"] = float((dd_t.reindex(hiw) <= -10).mean()) if len(hiw) else np.nan
    out["hi_extra"] = float(extra.reindex(hiw).mean()) if len(hiw) else np.nan
    out["all_extra"] = float(extra.mean())
    return out


def episodes(score: pd.Series, level: pd.Series) -> list[dict]:
    r10 = (level / level.shift(10) - 1) * 100
    rows = []
    for nm, a, b in EPISODES:
        w = score.loc[a:b]
        seg = r10.loc[a:b]
        if len(w) == 0 or len(seg) == 0:
            rows.append({"ep": nm, "n": 0}); continue
        if score.index[0] > pd.Timestamp(a):                 # 점수 표본이 창 도중에 시작 — 시차는 절단 인공물
            rows.append({"ep": nm, "n": -1, "start": score.index[0].date()}); continue
        worst_d, worst = seg.idxmin(), float(seg.min())
        first70 = w[w >= HI]
        lead = (worst_d - first70.index[0]).days / 7 if len(first70) else None
        at = score.loc[:worst_d]
        rows.append({"ep": nm, "n": len(w), "max": float(w.max()), "max_d": w.idxmax().date(),
                     "worst": worst, "worst_d": worst_d.date(), "at_worst": float(at.iloc[-1]) if len(at) else np.nan,
                     "first70": first70.index[0].date() if len(first70) else None, "lead_w": lead})
    return rows


def monthly_returns(level: pd.Series) -> pd.Series:
    return level.resample("ME").last().pct_change().dropna()


def perf(ret: pd.Series, rf: pd.Series, W: np.ndarray | None) -> dict:
    ex = ret - rf.reindex(ret.index).fillna(0)
    lvl = (1 + ret).cumprod()
    dd = lvl / lvl.cummax() - 1
    # 최장 회복(개월): 고점 → 재돌파
    peak = lvl.cummax()
    under = (lvl < peak).astype(int)
    longest = cur = 0
    for u in under:
        cur = cur + 1 if u else 0
        longest = max(longest, cur)
    n = len(ret)
    out = {"cagr": float(lvl.iloc[-1] ** (12 / n) - 1) * 100, "vol": float(ret.std(ddof=1) * math.sqrt(12)) * 100,
           "sharpe": float(ex.mean() / ex.std(ddof=1) * math.sqrt(12)) if ex.std(ddof=1) > 0 else np.nan,
           "mdd": float(dd.min()) * 100, "recover_m": int(longest)}
    out["turn"] = float(np.abs(np.diff(W, axis=0)).sum(axis=1).mean() / 2 * 100) if W is not None and len(W) > 1 else 0.0
    return out


def main() -> None:
    apr = argparse.ArgumentParser()
    apr.add_argument("--data-dir", required=True)
    apr.add_argument("--reps", type=int, default=2000)
    apr.add_argument("--iters", type=int, default=3000)
    args = apr.parse_args()
    warn = lambda m: None  # noqa: E731
    P.load_data_dir(Path(args.data_dir))
    _, _, rw = risk.build(P.SERIES, warn)
    layers = {"stress": ("현재 위험", rw["weekly"]["stress"].dropna()), "vuln": ("잠재 위험", rw["weekly"]["vuln"].dropna())}
    levels = {k: series(v) for k, v in MKT.items()}

    print("═══ 1. 통계 검증 — 점수 vs 미래 실현변동성·절대수익률·낙폭 (주간, 표본 외 점수) ═══")
    for lk, (lab, sc) in layers.items():
        print(f"\n[{lab}] {sc.index[0].date()} ~ {sc.index[-1].date()} · {len(sc)}주 · 점수 {sc.min():.0f}~{sc.max():.0f}")
        for mk, lvl in levels.items():
            o = stat_block(mk, sc, lvl, args.reps)
            print(f"  {mk:7s} n={o['n']:4d} │ ρ(점수, RV10) {o['rho_rv10']:+.3f} · RV20 {o['rho_rv20']:+.3f} · |R10| {o['rho_abs10']:+.3f}"
                  f" · 동시낙폭 {o['rho_dd']:+.3f} · 13주 추가낙폭 {o['rho_extra']:+.3f} · AUC(RV10 상위¼) {o['auc_q4']:.3f}")
            print(f"          기준선 ρ(과거RV10, 미래RV10) {o['base_past']:+.3f} → 부분상관(점수 | 과거RV) {o['partial']:+.3f}")
            xc = " ".join(f"{L:+d}:{v:+.2f}" for L, v in o["xcorr"].items() if L in (-8, -4, -2, -1, 0, 1, 2, 4, 8))
            pk = max(o["xcorr"], key=lambda L: o["xcorr"][L])
            print(f"          교차상관(+ = 점수 선행) {xc} → 봉우리 L={pk:+d}")
            if "t" in o:
                print(f"          국면 검정 ≥70({o['n_hi']}주) RV {o['rv_hi']:.1f}% vs ≤30({o['n_lo']}주) {o['rv_lo']:.1f}% · Welch t {o['t']:.1f} "
                      f"(df {o['df']:.0f}) p {o['p_welch']:.2g} · 순환순열 p {o['p_perm']:.3f}")
            else:
                print(f"          국면 검정 불가 — ≥70 {o['n_hi']}주 / ≤30 {o['n_lo']}주")
            print(f"          ≥70 주: 동시 낙폭 평균 {o['hi_dd_mean']:.1f}% · 낙폭≥10% 비중 {o['hi_dd_share10']*100:.0f}% · "
                  f"이후 13주 추가낙폭 {o['hi_extra']:+.1f}% (전체 주 평균 {o['all_extra']:+.1f}%)")

    print("\n═══ 2. 위기 매핑 — 사건 창 안 점수 최고·70 최초 돌파 vs KOSPI 10일 최악일 ═══")
    for lk, (lab, sc) in layers.items():
        print(f"\n[{lab}]  사건            n주  최고(일자)        최악 10일(일자)      최악일 점수  70돌파      시차(주, +=선행)")
        for e in episodes(sc, levels["KOSPI"]):
            if e["n"] == 0:
                print(f"  {e['ep']:14s} — 점수 없음"); continue
            if e["n"] == -1:
                print(f"  {e['ep']:14s} — 점수 표본이 {e['start']} 에 시작(walk-forward 예열) — 창 절단, 판정 제외"); continue
            lead = "—" if e["lead_w"] is None else f"{e['lead_w']:+.0f}"
            print(f"  {e['ep']:14s} {e['n']:3d}  {e['max']:5.0f} ({e['max_d']})  {e['worst']:6.1f}% ({e['worst_d']})   {e['at_worst']:5.0f}      "
                  f"{str(e['first70'] or '없음'):10s}  {lead}")

    print("\n═══ 3. 경제 백테스트 — 정적 60/40 · 정적 MVO(λ=1) · 동적 λ(로그 매핑) — 월별 리밸런스 ═══")
    mu, C, lo, hi, meta = build_engine(bm.build_cma(P.SERIES, warn), warn)
    print(f"  μ·Σ = 현재 CMA 고정(창 {meta['window']['key']}, {meta['window']['start']}~{meta['window']['end']}) · "
          f"hb/he/h_alt {meta['hb']:.0%}/{meta['he']:.0%}/{meta['h_alt']:.0%} — 절대 성과는 사후 정보 오염, 전략 간 차이만 읽을 것")
    fx = monthly_returns(series(FX_KEY))
    hedge = {"해외채권": meta["hb"], "해외주식": meta["he"], "대체투자": meta["h_alt"]}
    R = {}
    for a, key in PROXY.items():
        r = monthly_returns(series(key))
        if a in hedge:
            r = ((1 + r) * (1 + (1 - hedge[a]) * fx.reindex(r.index).fillna(0)) - 1)
        R[a] = r
    cd = series(CD_KEY).resample("ME").last()
    R["단기자금"] = (cd.shift(1) / 100 / 12).dropna()
    rets = pd.concat(R, axis=1, sort=True).dropna()
    rf = R["단기자금"]
    # CMA 7키 → 실현 프록시 6열 매핑(대출형·지분형 → 대체투자)
    col_of = {"국내채권": "국내채권", "해외채권": "해외채권", "국내주식": "국내주식", "해외주식": "해외주식",
              "대체투자(대출형)": "대체투자", "대체투자(지분형)": "대체투자", "단기자금": "단기자금"}
    cache: dict[float, np.ndarray] = {}

    def w_star(lam: float) -> np.ndarray:
        if lam not in cache:
            cache[lam] = optimize_util(mu, C, lo, hi, 1.0, lam, args.iters)
        return cache[lam]

    def to_cols(w7: np.ndarray) -> np.ndarray:
        v = np.zeros(len(rets.columns))
        for i, a in enumerate(ASSETS):
            v[list(rets.columns).index(col_of[a])] += w7[i]
        return v

    for lk, (lab, sc) in layers.items():
        m_sc = sc.resample("ME").last().dropna()
        # 월말 점수 → 다음 달 수익률: 점수 인덱스를 한 달 뒤로 민다
        sc_next = m_sc.copy(); sc_next.index = sc_next.index + pd.offsets.MonthEnd(1)
        common_idx = rets.index.intersection(sc_next.index)
        rr = rets.loc[common_idx]
        print(f"\n[{lab} 기준] {common_idx[0].date()} ~ {common_idx[-1].date()} · {len(common_idx)}개월")
        cols = list(rr.columns)
        strategies = {}
        w6040kr = np.array([0.4 if c == "국내채권" else 0.6 if c == "국내주식" else 0 for c in cols])
        w6040gl = np.array([0.4 if c == "국내채권" else 0.6 if c == "해외주식" else 0 for c in cols])
        strategies["정적 60/40 (국내주식/국내채권)"] = np.tile(w6040kr, (len(rr), 1))
        strategies["정적 60/40 (해외주식/국내채권)"] = np.tile(w6040gl, (len(rr), 1))
        strategies["정적 MVO λ=1"] = np.tile(to_cols(w_star(1.0)), (len(rr), 1))
        lams = [lam_log(float(v)) for v in sc_next.loc[common_idx].to_numpy()]
        strategies[f"동적 λ = 로그매핑({lab})"] = np.stack([to_cols(w_star(l)) for l in lams])
        crisis = rr["국내주식"] < -0.05
        print(f"  {'전략':30s} {'연수익':>7s} {'변동성':>7s} {'샤프':>6s} {'MDD':>7s} {'회복(월)':>8s} {'턴오버/월':>9s} {'위기월평균':>9s}")
        base = None
        for nm, W in strategies.items():
            pr = pd.Series((W * rr.to_numpy()).sum(axis=1), index=rr.index)
            o = perf(pr, rf, W)
            cm = float(pr[crisis].mean() * 100) if crisis.any() else np.nan
            print(f"  {nm:30s} {o['cagr']:6.2f}% {o['vol']:6.2f}% {o['sharpe']:6.2f} {o['mdd']:6.1f}% {o['recover_m']:8d} {o['turn']:8.2f}%p {cm:8.2f}%")
            if nm.startswith("정적 MVO"):
                base = o
        if base is not None:
            dyn = perf(pd.Series((strategies[f"동적 λ = 로그매핑({lab})"] * rr.to_numpy()).sum(axis=1), index=rr.index), rf,
                       strategies[f"동적 λ = 로그매핑({lab})"])
            print(f"  → 동적 − 정적 MVO: 샤프 {dyn['sharpe'] - base['sharpe']:+.2f} · MDD {dyn['mdd'] - base['mdd']:+.1f}%p · "
                  f"연수익 {dyn['cagr'] - base['cagr']:+.2f}%p · 턴오버 {dyn['turn']:.2f}%p/월 (λ 타이밍 채널의 순효과)")
        print(f"  (위기월 = 국내주식 프록시 월수익 −5% 미만 {int(crisis.sum())}개월)")


if __name__ == "__main__":
    main()
