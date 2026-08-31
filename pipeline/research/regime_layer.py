# -*- coding: utf-8 -*-
"""다자산 MSM 국면 레이어 vs 현행 스트레스 점수 — 오경보율 동일 조건 비교 (모델 랩).

2026-08-31 사용자 승인 실험("진행해줘"). 배경: regime_prototype.py 의 「S&P 폭락
8건 전부 선행」은 **적중만 세고 오경보를 안 센 수치**였다. 어떤 점수든 문턱을
낮추면 적중은 늘고 오경보도 는다 — 공정한 비교는 **같은 오경보율에서 누가 더
많이, 더 일찍 잡는가**다. 이 하네스가 그 비교를 한다.

    python pipeline/research/regime_layer.py --data-dir <data 저장소 경로>

설계 (하이브리드 아키텍처 결정용 — 연구만, 배포 없음):
  ① Layer B 후보 = 5개 시장 MSM 국면확률: 국내주식(KOSPI TR)·해외주식(S&P500 TR)·
     채권(미국종합 TR)·원자재(GSCI TR)·환율(달러원). **수익률형 계열만** — 스프레드·
     CDS·커브 같은 수준형/평균회귀형은 MSM 부적합이라 Layer A(백분위)에 남는다.
     걸음은 전부 walk-forward Filtered(재학습 4주·최초 156주 — regime_prototype 재사용,
     Smoothed 는 사후판정이라 실시간 비교에서 배제).
  ② 합성 국면 점수 둘: mean(5시장 평균 — 「몇 개 시장이 동시에 고변동 국면인가」,
     시장 폭 개념과 일치) / max(아무 시장이나 발작 — 조기성 우선, 오경보 대가).
  ③ 대조군 = 현행 현재위험 점수(risk.build 의 walk-forward IC가중 합성, 0~100).
     같은 주간 격자·같은 기간·같은 사건 목록으로 잰다.
  ④ 사건 = 10영업일 수익률 −10% 최초 돌파(간격 91일 초과 — PR#43 과 동일 규칙),
     주 패널 = KOSPI(기관 경보 기준 시장), 보조 패널 = S&P500.
  ⑤ 경보 회계: 경보 = 문턱 상향 돌파(에피소드 시작). 사건 ±8주 안에 사건이 없으면
     오경보(FP). 사건 쪽은 [사건−8주, 사건] 안 최초 경보 = 조기 적중(시차 = 주),
     ±8주 = 넓은 적중. 문턱을 훑어 (FP, 적중, 시차) 곡선을 만들고 FP 예산별로
     각 모델의 최선 문턱을 맞춰 나란히 놓는다.

주요 결과 (2026-08-31, 공통 평가 구간 2009-01 ~ 2026-07 · 약 17.5년 914주, 주간):
  시장별 ③ 이질성 검정(제안서 자체 기준): 해외주식 p=0.002 ✓ · 채권 p=0.016 ✓ ·
    원자재 p=0.004 ✓ / **국내주식 p=0.71 ✗ · 환율 p=0.17 ✗** — 5개 중 3개만 통과.
  중복도: spearman(합성 mean, 현행 점수) +0.60 · (합성 max, 현행) +0.18.
  ① KOSPI 패널(기관 경보 기준 시장, 사건 9건): **엄격~중간 FP 예산(FP ≤ 12건,
     연 0.7건 이하)에서 전부 현행 점수 우세** — 예 FP≤12: 현행 65점 7/9(중앙 +0주)
     vs 합성 mean 3/9. 합성이 앞서는 곳은 느슨한 예산뿐: FP 24건(연 1.4건)에서
     mean@0.40 이 8/9(+1주, 넓은적중 9/9)로 현행 최고치 7/9 를 사건 1건 넘어선다.
  ② S&P 패널(사건 7건)은 반대로 **mean 이 우세**: FP≤12 에서 5/7 vs 현행 3/7,
     FP≤24 에서 6/7(@0.45, FP22) vs 현행 최고 5/7. 현행이 놓치는 2015-08·2018-12
     (미국 국지 급락)를 mean 이 잡는다 — 다시장 국면 레이어의 실익은 해외 사건
     감지 쪽에 있다.
  ③ 시차 중앙값은 어느 합리적 운용점에서도 +0~+1주 — **다주(多週) 선행은 양쪽 다
     없다**(horizon_lead.py 의 「재료의 문제」 결론과 일치).
  ④ 프로토타입 「S&P 8/8 선행」의 실비용: 단일 S&P Filtered@0.8 = 경보 33건 중
     FP 21건(연 1.2건), 적중 시차 중앙값 +1주. 제안서 스펙 그대로의 합성 max@0.8 은
     KOSPI 패널에서 FP 31건에 조기적중 3/9 — 같은 FP 에서 현행 점수가 7/9 다.
  ⑤ 사건별 상세(대표 운용점): 2024-08-09(사용자가 무선행을 지적한 그 사건)는
     현행 누락 · mean 늦음 — **양쪽 다 조기경보 실패**. 2022-01-28 은 mean 만 +0주.
  결론(아키텍처 권고): **MSM 국면 레이어로 등급 판정(경보)을 대체할 근거 없음** —
    기관 기준 시장(KOSPI)에서 동일 오경보율 하 열세이고, KOSPI 는 제안서 자체의
    ③ 기준도 미달. 실익이 확인된 자리는 **해외 사건 감지 보강**(② — 현행이 놓치는
    미국 국지 급락)이라, 채택 여지는 ⓐ ③ 통과 3개 시장(해외주식·채권·원자재)의
    국면 라벨 참고 표시 ⓑ SAA λ_dynamic 입력 후보 — ⓑ는 현행 점수 정규화로도 갈음
    가능하다. 채택 형태는 사용자 결정 대기(연구만, 배포 없음).
"""

import argparse
import math
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import regime_prototype as RP  # noqa: E402
import common  # noqa: E402
import process as P  # noqa: E402
import risk  # noqa: E402

spearman = common.spearman

MARKETS = [
    ("국내주식", "bb:한국_KOSPI_TR"),
    ("해외주식", "bb:미국_S&P500_TR"),
    ("채권",     "bb:미국종합"),
    ("원자재",   "bb:S&P GSCI TR CME"),
    ("환율",     "bb:달러원"),
]
WND_W = 8            # 사건-경보 대응 창(주) — regime_prototype 의 ±8주와 동일
EVENT_GAP_D = 91     # 사건 분리 간격 — PR#43 규칙과 동일


def weekly_returns(px: pd.Series) -> pd.Series:
    wk = px.dropna().resample("W-FRI").last().dropna()
    return (wk.pct_change() * 100).dropna()


def wf_filtered(r: pd.Series) -> pd.Series:
    """walk-forward Filtered P(고변동 국면) — regime_prototype 의 루프 그대로."""
    rt = pd.Series(index=r.index, dtype=float)
    vals = r.values
    params, state = None, None
    for i in range(len(vals)):
        if i >= RP.TRAIN_MIN_W and (params is None or i % RP.REFIT_W == 0):
            params = RP.fit_msm(vals[:i], iters=25 if params else 120, init=params)
            f2, _, _ = RP.hamilton_filter(vals[:i], params["mu"], params["sig"],
                                          params["p11"], params["p22"])
            state = f2[-1]
        if params is not None:
            T = np.array([[params["p11"], 1 - params["p11"]],
                          [1 - params["p22"], params["p22"]]])
            d = RP._dens(np.array([vals[i]]), params["mu"], params["sig"])[0]
            num = (state @ T) * d
            state = num / num.sum()
            rt.iloc[i] = state[1]
    return rt.dropna()


def crash_events(px: pd.Series) -> list[pd.Timestamp]:
    wm = (px.dropna().pct_change(10) * 100).resample("W-FRI").min().dropna()
    out, last = [], None
    for d, v in wm[wm <= -10].items():
        if last is None or (d - last).days > EVENT_GAP_D:
            out.append(d)
        last = d
    return out


def alarm_starts(score: pd.Series, thr: float) -> list[pd.Timestamp]:
    above = (score >= thr).to_numpy()
    idx = score.index
    return [idx[i] for i in range(len(idx)) if above[i] and (i == 0 or not above[i - 1])]


def eval_alarms(score: pd.Series, thr: float, events: list[pd.Timestamp]) -> dict:
    """경보 회계. FP = ±WND_W주 안에 사건이 없는 경보. 조기 적중 = [e−W, e] 안 경보."""
    starts = alarm_starts(score, thr)
    wd = WND_W * 7
    fp = sum(1 for a in starts if not any(abs((e - a).days) <= wd for e in events))
    leads = []
    for e in events:
        cand = [a for a in starts if 0 <= (e - a).days <= wd]
        if cand:
            leads.append(round((e - min(cand)).days / 7))
    hit_any = sum(1 for e in events
                  if any(abs((e - a).days) <= wd for a in starts))
    years = (score.index[-1] - score.index[0]).days / 365.25
    return dict(thr=thr, n_alarm=len(starts), fp=fp, fp_yr=fp / years,
                hit_early=len(leads), leads=sorted(leads), hit_any=hit_any)


def sweep(score: pd.Series, grid, events, label, mark=None):
    print(f"\n  — {label} 문턱 훑기 (사건 {len(events)}건 기준)")
    print(f"  {'문턱':>6} {'경보':>4} {'FP':>4} {'FP/년':>6} {'조기적중':>8} {'넓은적중':>8} {'시차 중앙값(주)':>14}")
    rows = []
    for thr in grid:
        ev = eval_alarms(score, thr, events)
        rows.append(ev)
        med = f"{np.median(ev['leads']):+.0f}" if ev["leads"] else "–"
        star = "  ◀" if mark is not None and abs(thr - mark) < 1e-9 else ""
        print(f"  {thr:>6g} {ev['n_alarm']:>4} {ev['fp']:>4} {ev['fp_yr']:>6.2f} "
              f"{ev['hit_early']:>4}/{len(events):<3} {ev['hit_any']:>4}/{len(events):<3} {med:>14}{star}")
    return rows


def best_at_budget(rows, budget):
    """FP ≤ budget 중 조기 적중 최대(동률 → 시차 중앙값 큰 쪽)."""
    ok = [r for r in rows if r["fp"] <= budget]
    if not ok:
        return None
    return max(ok, key=lambda r: (r["hit_early"],
                                  np.median(r["leads"]) if r["leads"] else -1, -r["fp"]))


def event_detail(score, thr, events):
    """대표 운용점의 사건별 결과 — 어느 사건을 놓치는지가 집계보다 정보가 많다."""
    starts = alarm_starts(score, thr)
    wd = WND_W * 7
    parts = []
    for e in events:
        cand = [a for a in starts if 0 <= (e - a).days <= wd]
        if cand:
            parts.append(f"{e.date()} +{round((e - min(cand)).days / 7)}주")
        else:
            near = any(abs((e - a).days) <= wd for a in starts)
            parts.append(f"{e.date()} {'늦음' if near else '누락'}")
    print("      " + " · ".join(parts))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True, type=Path)
    args = ap.parse_args()
    t0 = time.time()
    P.load_data_dir(args.data_dir)

    # ---------- ① 시장별 walk-forward 국면확률 ----------
    print(f"\n{'='*80}\n[1] 시장별 2국면 MSM — 전체 표본 파라미터 + ③ 이질성 검정 + walk-forward")
    probs, ann = {}, math.sqrt(52)
    print(f"{'시장':>6} {'저변동 μ/σ(%/년)':>20} {'고변동 μ/σ(%/년)':>20} {'③ t-검정 p':>10} {'고변동 비중':>9}")
    for name, key in MARKETS:
        r = weekly_returns(P.get(key))
        m = RP.fit_msm(r.values)
        filt, pred, _ = RP.hamilton_filter(r.values, m["mu"], m["sig"], m["p11"], m["p22"])
        sm = RP.kim_smoother(filt, pred, m["p11"], m["p22"])
        lab = sm[:, 1] > 0.5
        tt = stats.ttest_ind(r.values[lab], r.values[~lab], equal_var=False)
        print(f"{name:>6} {m['mu'][0]*52:+7.1f}/{m['sig'][0]*ann:5.1f}"
              f"{'':>7} {m['mu'][1]*52:+7.1f}/{m['sig'][1]*ann:5.1f}{'':>7} "
              f"{tt.pvalue:>10.4f} {lab.mean():>8.0%}")
        probs[name] = wf_filtered(r)
        print(f"       walk-forward 가용: {probs[name].index[0].date()} ~ "
              f"{probs[name].index[-1].date()} ({len(probs[name])}주, {time.time()-t0:.0f}s 경과)")

    PB = pd.DataFrame(probs).dropna()
    comp_mean = PB.mean(axis=1)
    comp_max = PB.max(axis=1)

    # ---------- ② 현행 현재위험 점수 (walk-forward IC가중 합성) ----------
    print(f"\n[2] 현행 현재위험 점수 재구성 (risk.build — walk-forward IC가중, 배포 코드 그대로)")
    _, _, rw = risk.build(P.SERIES, lambda m: None)
    stress = rw["weekly"]["stress"].dropna()

    # 공통 평가 구간 — 세 점수를 같은 구간으로 자른다 (사건 목록도 여기서만)
    lo = max(comp_mean.index[0], stress.index[0])
    hi = min(comp_mean.index[-1], stress.index[-1])
    comp_mean, comp_max, stress = (s[(s.index >= lo) & (s.index <= hi)]
                                   for s in (comp_mean, comp_max, stress))
    print(f"공통 평가 구간: {lo.date()} ~ {hi.date()} ({len(comp_mean)}주 / stress {len(stress)}주)")

    pair = pd.concat([comp_mean, stress], axis=1, sort=True).dropna()
    print(f"중복도 — spearman(합성 mean, 현행 점수) = {spearman(pair.iloc[:,0], pair.iloc[:,1]):+.2f}")
    pair = pd.concat([comp_max, stress], axis=1, sort=True).dropna()
    print(f"         spearman(합성 max,  현행 점수) = {spearman(pair.iloc[:,0], pair.iloc[:,1]):+.2f}")

    # ---------- ③ 사건 패널 × 문턱 훑기 × FP 예산 매칭 ----------
    panels = []
    for pname, tr_key in [("KOSPI (기관 경보 기준 시장)", "bb:한국_KOSPI_TR"),
                          ("S&P500 (보조)", "bb:미국_S&P500_TR")]:
        pr = P.SERIES.get(tr_key.replace("_TR", "_PR"))
        base = (pr["s"] if pr is not None else P.get(tr_key)).dropna()
        evs = [e for e in crash_events(base)
               if lo + pd.Timedelta(weeks=WND_W) <= e <= hi]
        panels.append((pname, evs))

    grids = {
        "합성 mean": (comp_mean, np.round(np.arange(0.20, 0.96, 0.05), 2), None),
        "합성 max":  (comp_max,  np.round(np.arange(0.50, 0.96, 0.05), 2), 0.80),
        "현행 점수": (stress,    np.round(np.arange(30, 92.6, 2.5), 1), 75.0),
    }

    for pname, evs in panels:
        print(f"\n{'='*80}\n[3] 사건 패널: {pname} — 10영업일 −10% 최초 돌파 {len(evs)}건")
        print("   " + "  ".join(str(e.date()) for e in evs))
        all_rows = {}
        for label, (score, grid, mark) in grids.items():
            all_rows[label] = sweep(score, grid, evs, label, mark)

        print(f"\n  — FP 예산 매칭 (같은 오경보 수에서 조기 적중 최대 문턱)")
        print(f"  {'FP 예산':>7} " + "".join(f"{l:>26}" for l in all_rows))
        for budget in (0, 1, 2, 3, 5, 8, 12, 16, 20, 24, 28):
            cells = []
            for label, rows in all_rows.items():
                b = best_at_budget(rows, budget)
                if b is None:
                    cells.append(f"{'–':>26}")
                else:
                    med = f"{np.median(b['leads']):+.0f}" if b["leads"] else "–"
                    cells.append(f"{b['thr']:>6g}: {b['hit_early']}/{len(evs)} "
                                 f"(FP{b['fp']}, 중앙{med}주)".rjust(26))
            print(f"  {budget:>7} " + "".join(cells))

        print(f"\n  — 대표 운용점 상세 (각 모델의 FP ≤ 24 최선 문턱, 사건별)")
        for label, rows in all_rows.items():
            b = best_at_budget(rows, 24)
            if b is None:
                continue
            score = grids[label][0]
            print(f"    {label} @{b['thr']:g} (FP {b['fp']}):")
            event_detail(score, b["thr"], evs)

    # ---------- ④ 참고 — 프로토타입 8/8 의 오경보 재평가 (단일 시장 S&P @0.8) ----------
    print(f"\n{'='*80}\n[4] 참고: regime_prototype 의 「S&P 8/8 선행」에 오경보 회계를 적용하면")
    sp = probs["해외주식"]
    sp = sp[(sp.index >= lo) & (sp.index <= hi)]
    _, sp_evs = panels[1]
    ev = eval_alarms(sp, 0.8, sp_evs)
    med = f"{np.median(ev['leads']):+.0f}" if ev["leads"] else "–"
    print(f"  단일 S&P Filtered @0.8: 경보 {ev['n_alarm']}건 · FP {ev['fp']}건({ev['fp_yr']:.2f}/년) · "
          f"조기 적중 {ev['hit_early']}/{len(sp_evs)} · 시차 중앙값 {med}주")
    print(f"\n총 소요 {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
