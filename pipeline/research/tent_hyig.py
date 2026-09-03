# -*- coding: utf-8 -*-
"""텐트 팩터·HY−IG 격차 — 신규 후보 요인의 추가 IC 기여 검증 (2026-09-03 사용자 요청).

    python pipeline/research/tent_hyig.py --data-dir <data 저장소 경로>

CI 미실행 수동 하네스 — `wf_validation.py` 와 같은 위치·성격이며 **평가 설계를 그대로
승계**한다: 타깃 = 향후 1개월 실현변동성(KOSPI TR·ACWI 평균), 표본 외 2010~, walk-forward
IC가중(+바닥 8%)·엠바고 5주·재학습 4주·부분 커버리지 허용, IC/위기 AUC(−5%/−10%)/반분.
지표 산식도 배포 코드(`risk.Indicator` — 확장 백분위)를 그대로 쓴다. 여기서 새로 정하는
것은 **후보 요인의 원계열 정의**뿐이다.

후보 (전부 기존 보유 시리즈 — 신규 익스포트 0. 부호는 사전 선언, 결과로 사후 조정 안 함):
  ① HY−IG 격차   = 미국 하이일드 − 투자등급 스프레드 (mode hi — 격차 확대 = 위험)
  ② HY/IG 비율   = 하이일드 ÷ 투자등급 (수준 통제 변형, mode hi)
  ③ 곡률(미국)    = 2·f(3y1y) − f(1y1y) − f(5y1y) — IRS 포워드 스트립의 표준 나비
                   (Cochrane-Piazzesi 텐트의 무모수 근사. 사전 가설: 곡률↑ = 채권
                   위험프리미엄↑ = 스트레스 국면 → mode hi)
  ④ 곡률(한국)    = 같은 산식, 한국 IRS
  ⑤ 텐트(학습형)  = 미국 1y 포워드 6개(1y3m~5y1y)에 타깃을 walk-forward OLS 회귀한
                   적합값 — CP 원형의 재현. 같은 타깃을 학습하므로 **합성 증분 시험에는
                   넣지 않고 단독 IC·계수 형상(텐트인가)만 본다** (이중 학습 방지).

증분 시험: 채택 방식(요인 IC+바닥 8%) 6요인 합성 vs 후보를 더한 7요인 합성 — 같은 주간
격자에서 ΔIC·ΔAUC. 중복도(기존 합성·개별 요인과의 상관)를 함께 적는다 — §5.1 의 MSM
실험에서 VIX 상관 +0.81 이 채택을 막은 것과 같은 검사다.

실행 기록 (2026-09-03, 실데이터 483 시리즈 / 주간 격자 2005-12-30~2026-07-10, 표본 외
862주·위기주 −5% 138·−10% 33 — exit 0, 파이프라인 경고 13건 = 기존 기준선):
  기준 6요인 IC +0.575 · AUC5 0.615 · AUC10 0.638 · 반분 +0.662/+0.389. 증분은
  ① +HY−IG 격차 ΔIC **−0.049** — 기존 「스프레드 확대」와 상관 +0.69(중복)에 단독 IC 가
    전반 +0.576 → 후반 +0.070 으로 붕괴. IC가중이 전반 학습으로 12% 를 주는데 후반엔 잡음.
  ② +HY/IG 비율 ΔIC +0.008(잡음 수준 — 반분 부호 뒤집힘 −0.049/+0.243).
  ③ +곡률(미국) ΔIC −0.002. **사전 선언 부호(hi) 실패** — 단독 IC −0.228, 기존 커브
    요인과 상관 −0.79(사실상 커브의 역). 규약대로 사후 부호 조정은 하지 않았다.
  ④ +곡률(한국) ΔIC **+0.021** — 유일한 양의 기여(AUC5 0.620·AUC10 0.644·반분 양쪽 개선
    +0.680/+0.413), 중복 낮음(r 기준합성 −0.10 · 최대 요인상관 커브 −0.55). 다만 단독
    IC +0.115 로 약해 바닥 8% 가중(재정규화 후 7%)만 받는다 — 채택보다는 워치 감.
  ⑤ 페어(+HY−IG+곡률(미국)) ΔIC −0.058 로 최악. 텐트(학습형 WF-OLS)는 단독 IC +0.354
    (전반 +0.462/후반 +0.247, r 기준합성 +0.46)이나 마지막 계수가 텐트형이 아니다
    (1y3m −22.1 · 3y1y −29.1 등 교대 부호) — CP 텐트 재현 실패(원 논문 타깃은 채권
    초과수익, 여기는 주식 변동성이라 형상 이전이 성립하지 않았다). 무제약 6변수 회귀의
    적합값이라 그 자체를 요인으로 채택할 후보는 아니다.
  결론: 기존 6요인 대비 추가 IC 기여는 사실상 없음(채택 기각 방향, 곡률(한국)만 워치).
  채택 여부는 사용자 결정 — 요약은 HANDOVER §5.1.
"""

import argparse
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import common  # noqa: E402
import process as P  # noqa: E402
import risk as R  # noqa: E402

spearman, auc = common.spearman, common.auc
EMBARGO_W, REFIT_W = R.EMBARGO_W, R.REFIT_EVERY_W
TRAIN_MIN_W, FLOOR = R.TRAIN_MIN_W, R.FLOOR

FWD_TENORS = ["1y3m", "1y1y", "2y1y", "3y1y", "4y1y", "5y1y"]   # 1y 포워드 스트립


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True, type=Path)
    args = ap.parse_args()
    P.load_data_dir(args.data_dir)
    S = {k: v["s"] for k, v in P.SERIES.items()}
    g = lambda k: S.get(k)  # noqa: E731

    # ----- 기존 스트레스 6요인 (배포 정의 그대로) -----
    D = R.derive_inputs(S)
    stress = [f for f in R.factor_specs(D) if f["layer"] == "stress"]
    keys = [f["name"] for f in stress]
    F = pd.DataFrame({f["name"]: pd.concat([i.weekly() for i in f["inds"]], axis=1).mean(axis=1)
                      for f in stress}).dropna()

    # ----- 후보 원계열 → 배포와 같은 Indicator 점수 -----
    hy, ig = g("bb:미국_하이일드_스프레드"), g("bb:미국_투자등급_스프레드")
    fw_us = {t: g(f"bb:미국_IRS_{t}") for t in FWD_TENORS}
    fw_kr = {t: g(f"bb:한국_IRS_{t}") for t in FWD_TENORS}
    missing = [k for k, v in {"HY": hy, "IG": ig, **fw_us, **fw_kr}.items() if v is None]
    if missing:
        raise SystemExit(f"필요 시리즈 없음: {missing}")

    def curv(fw):
        return 2 * fw["3y1y"] - fw["1y1y"] - fw["5y1y"]

    cands = {
        "HY−IG 격차": R.Indicator("HY−IG 격차", (hy - ig).dropna(), "hi", "{:.2f}"),
        "HY/IG 비율": R.Indicator("HY/IG 비율", (hy / ig).dropna(), "hi", "{:.2f}"),
        "곡률(미국)": R.Indicator("곡률(미국)", curv(fw_us).dropna(), "hi", "{:.2f}"),
        "곡률(한국)": R.Indicator("곡률(한국)", curv(fw_kr).dropna(), "hi", "{:.2f}"),
    }
    C = pd.DataFrame({k: v.weekly() for k, v in cands.items()})

    # ----- 타깃 (wf_validation 과 동일 산식) -----
    kospi, acwi = D["kospi"], D["acwi"]

    def fwd(price):
        p = price.dropna()
        mn, vol = {}, {}
        for d in F.index:
            i = p.index.searchsorted(d, side="right")
            seg = p.iloc[i:i + 22]
            if len(seg) < 15 or i == 0:
                continue
            mn[d] = float(seg.min() / p.iloc[i - 1] - 1) * 100
            vol[d] = float(seg.pct_change().dropna().std() * math.sqrt(252) * 100)
        return pd.Series(mn), pd.Series(vol)

    mnA, volA = fwd(acwi)
    mnK, volK = fwd(kospi)
    tgt = pd.concat([pd.concat([mnA, mnK], axis=1).mean(axis=1).rename("fwd_min"),
                     pd.concat([volA, volK], axis=1).mean(axis=1).rename("fwd_vol")], axis=1)
    data = F.join(tgt).dropna()          # 기준 6요인 + 타깃이 있는 주
    data = data.join(C)                  # 후보는 부분 커버리지 허용(wf 가 셀 결측 처리)
    oos = data.index[data.index >= "2010-01-01"]
    flag5 = (data["fwd_min"] <= -5).astype(int)
    flag10 = (data["fwd_min"] <= -10).astype(int)
    print(f"주간 격자 {data.index[0].date()} ~ {data.index[-1].date()} ({len(data)}주) · "
          f"표본 외 {oos[0].date()}~ ({len(oos)}주) · 위기주 −5%/−10%: "
          f"{int(flag5.loc[oos].sum())}/{int(flag10.loc[oos].sum())}")

    # ----- walk-forward 합성 (wf_validation 의 wf 와 동일) -----
    def ic_w_for(cols):
        def fn(train):
            ics = []
            for k in cols:
                pair = train[[k, "fwd_vol"]].dropna()
                ics.append(spearman(pair[k], pair["fwd_vol"]) if len(pair) >= 52 else 0.0)
            w = np.clip(np.nan_to_num(np.array(ics)), 0, None)
            return w / w.sum() if w.sum() > 0 else None
        return fn

    last_w = {}

    def wf(cols, tag=None):
        X = data[cols]
        marks = set(data.index[::REFIT_W])
        weight_fn = ic_w_for(cols)
        comp, cur = pd.Series(index=data.index, dtype=float), None
        for t in data.index:
            if t in marks:
                train = data[data.index <= t - pd.Timedelta(weeks=EMBARGO_W)]
                if len(train) >= TRAIN_MIN_W:
                    w = weight_fn(train)
                    if w is not None:
                        w = np.maximum(w, FLOOR)
                        cur = w / w.sum()
            if cur is not None:
                v = X.loc[t]
                m = v.notna().values
                if m.any():
                    ww = cur[m]
                    comp[t] = float(v.values[m] @ (ww / ww.sum()))
        if tag and cur is not None:
            last_w[tag] = dict(zip(cols, cur))
        return comp.dropna()

    def score(comp):
        idx = comp.index.intersection(oos)
        mid = idx[len(idx) // 2]
        return (spearman(comp.loc[idx], data["fwd_vol"]),
                auc(comp.loc[idx], flag5.loc[idx]),
                auc(comp.loc[idx], flag10.loc[idx]),
                spearman(comp.loc[comp.index.intersection(idx[idx <= mid])], data["fwd_vol"]),
                spearman(comp.loc[comp.index.intersection(idx[idx > mid])], data["fwd_vol"]))

    base = wf(keys, tag="기준")
    rows = [("기준 6요인 (IC+바닥 8%)", score(base))]
    for ck in cands:
        rows.append((f"+ {ck}", score(wf(keys + [ck], tag=f"+{ck}"))))
    rows.append(("+ HY−IG + 곡률(미국)", score(wf(keys + ["HY−IG 격차", "곡률(미국)"], tag="+둘"))))

    print(f"\n{'합성':<26} {'IC':>7} {'AUC5':>6} {'AUC10':>6} {'전반':>7} {'후반':>7}")
    b = rows[0][1]
    for nm, s in rows:
        d = f"  (ΔIC {s[0]-b[0]:+.3f})" if nm != rows[0][0] else ""
        print(f"{nm:<26} {s[0]:>+7.3f} {s[1]:>6.3f} {s[2]:>6.3f} {s[3]:>+7.3f} {s[4]:>+7.3f}{d}")

    # ----- 단독 IC + 중복도 -----
    print(f"\n{'후보 (부호 사전 선언 hi)':<22} {'단독 IC':>8} {'전반':>7} {'후반':>7} "
          f"{'r(기준합성)':>10}  기존 요인 최대상관")
    for ck in list(cands) :
        s = data[ck].dropna()
        idx = s.index.intersection(oos)
        mid = idx[len(idx) // 2]
        ic = spearman(s.loc[idx], data["fwd_vol"])
        h1 = spearman(s.loc[idx[idx <= mid]], data["fwd_vol"])
        h2 = spearman(s.loc[idx[idx > mid]], data["fwd_vol"])
        rb = spearman(s.loc[idx], base.loc[base.index.intersection(idx)])
        rf = max(((abs(spearman(s.loc[idx], data[k].loc[idx])), k,
                   spearman(s.loc[idx], data[k].loc[idx])) for k in keys))
        print(f"{ck:<22} {ic:>+8.3f} {h1:>+7.3f} {h2:>+7.3f} {rb:>+10.2f}  "
              f"{rf[1]} {rf[2]:+.2f}")

    # ----- ⑤ 텐트(학습형) — walk-forward OLS, 단독 평가 전용 -----
    W6 = pd.DataFrame({t: fw_us[t].resample("W-FRI").last() for t in FWD_TENORS}) \
        .reindex(data.index)
    marks = set(data.index[::REFIT_W])
    fit, beta = pd.Series(index=data.index, dtype=float), None
    for t in data.index:
        if t in marks:
            tr_idx = data.index[data.index <= t - pd.Timedelta(weeks=EMBARGO_W)]
            tr = W6.loc[tr_idx].join(data["fwd_vol"]).dropna()
            if len(tr) >= TRAIN_MIN_W:
                X = np.column_stack([np.ones(len(tr)), tr[FWD_TENORS].values])
                beta = np.linalg.lstsq(X, tr["fwd_vol"].values, rcond=None)[0]
        if beta is not None and W6.loc[t].notna().all():
            fit[t] = float(beta[0] + W6.loc[t].values @ beta[1:])
    fit = fit.dropna()
    idx = fit.index.intersection(oos)
    mid = idx[len(idx) // 2]
    print(f"\n텐트(학습형·미국, WF-OLS): 단독 IC {spearman(fit.loc[idx], data['fwd_vol']):+.3f} "
          f"(전반 {spearman(fit.loc[idx[idx <= mid]], data['fwd_vol']):+.3f} / "
          f"후반 {spearman(fit.loc[idx[idx > mid]], data['fwd_vol']):+.3f}) · "
          f"r(기준합성) {spearman(fit.loc[idx], base.loc[base.index.intersection(idx)]):+.2f}")
    print("  마지막 재학습 계수 (만기순 — 가운데가 크면 텐트):")
    print("  " + " · ".join(f"{t} {b:+.2f}" for t, b in zip(FWD_TENORS, beta[1:])))

    # ----- 마지막 재학습 가중: 새 요인이 실제로 질량을 받는가 -----
    print("\n마지막 재학습 가중(바닥 8% 적용 후):")
    for tag, w in last_w.items():
        top = " / ".join(f"{k} {v:.0%}" for k, v in sorted(w.items(), key=lambda x: -x[1]))
        print(f"  {tag:<14} {top}")


if __name__ == "__main__":
    main()
