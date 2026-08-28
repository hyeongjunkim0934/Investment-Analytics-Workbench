# -*- coding: utf-8 -*-
"""리스크 합성 가중치 walk-forward 검증 하네스 (모델 랩 종자 코드).

2026-07 검증으로 '현재 위험 = IC가중 + 최소바닥 8%' 채택의 근거가 된 스크립트.
CI 빌드에는 포함되지 않으며, 데이터 갱신 후 수동으로 재검증할 때 실행한다.

    python pipeline/research/wf_validation.py --data-dir <data 저장소 경로>

방식 비교: 동일가중 / IC가중(WF) / IC가중+바닥 / 축소(shrinkage) / PCA(WF) / CISS형(간이)
평가: 표본 외(2010~) — 향후 1개월 실현변동성 순위상관(IC), 위기 판별 AUC(−5%/−10%),
기간 반분 안정성, 비중첩 월별 강건성. 모든 학습·정규화는 각 시점 이전 데이터만 사용.

**요인 정의는 이 파일에 없다.** 요인·지표·부호·백분위 산식은 전부 배포 코드
(`risk.derive_inputs` + `risk.factor_specs` 의 layer=="stress")에서 가져온다 —
예전처럼 여기에 STRESS 딕셔너리를 따로 적어 두면 한쪽만 고쳤을 때 "검증된
방법론"과 "실제 게시되는 점수"가 조용히 갈라진다. 상수(EMBARGO/REFIT/TRAIN/FLOOR)와
순위상관·AUC 산식도 각각 `risk`·`common` 에서 가져온다.
여기서 정하는 것은 **평가 설계**뿐이다: 합성 가중 방식, 타깃(향후 1개월 최저수익률·
실현변동성), 표본 외 구간, 반분 안정성.

주요 결과 (2026-07-27 기준 데이터):
    동일가중     IC +0.512  AUC5 0.602  AUC10 0.621
    IC가중(WF)  IC +0.604  AUC5 0.607  AUC10 0.638   (반분: +0.68 / +0.41)
    IC+바닥8%   IC +0.589  AUC5 0.609  AUC10 0.634   ← 채택 (커버리지 보험 비용 −0.015)
    PCA(WF)    IC +0.552  AUC5 0.599
    CISS형     IC +0.396  AUC5 0.577   (간이 구현 — 정식 일별 구현은 백로그)
교훈: 학습 표본에 2008이 없으면 학습 가중이 동일가중에 밀린다(첫 실행에서 확인).

지표 단위 IC 학습 (2026-08-25 추가, 환율 요인 이격 교체 후 데이터 기준):
    IC+바닥8%(요인, 채택)  IC +0.575  AUC5 0.615  AUC10 0.638  (반분 +0.66/+0.39)
    지표 IC(WF, 13개 평탄)  IC +0.580  AUC5 0.604  AUC10 0.647  (반분 +0.69/+0.43)
    지표 IC+바닥(질량 보존)  IC +0.571  AUC5 0.606  AUC10 0.643
    2단(요인 안 지표 IC →   IC +0.595  AUC5 0.612  AUC10 0.652  (반분 +0.67/+0.43)
        요인 IC+바닥 8%)    ← 전 지표 최상위권. 채택 대비 IC +0.020 · AUC10 +0.014
교훈 둘:
  ① 지표 13개 전부를 dropna 로 요구하면 늦개시 지표(카드채) 하나가 표본을
     2014-10부터로 잘라 2008·2011 이 학습에서 빠지고 지표 방식 전체가 무너져
     보인다(첫 실행 IC +0.43). 배포 코드처럼 부분 커버리지를 허용해야 공정하다.
  ② 학습된 요인 안 지표 가중은 대부분 50/50 근처(변동성 47/53, 낙폭 53/47,
     환율 48/52)다 — 현행 요인 안 동일가중은 이미 최적에 가깝고, 학습이 실제로
     바꾸는 곳은 커브(한국 10−3y 100%/미국 0%)와 CDS(독일 44%) 뿐이다.
     2단의 이득(+0.02)은 그 두 자리에서 온다. 채택 여부는 사용자 결정 대기.
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
# 배포 코드와 같은 상수를 쓴다 (risk.py 가 정본).
EMBARGO_W, REFIT_W = R.EMBARGO_W, R.REFIT_EVERY_W
TRAIN_MIN_W, FLOOR = R.TRAIN_MIN_W, R.FLOOR


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True, type=Path)
    args = ap.parse_args()
    P.load_data_dir(args.data_dir)
    S = {k: v["s"] for k, v in P.SERIES.items()}

    # ----- 요인 정의: 배포 코드에서 그대로 가져온다 -----
    D = R.derive_inputs(S)
    stress = [f for f in R.factor_specs(D) if f["layer"] == "stress"]
    kospi, acwi = D["kospi"], D["acwi"]
    print("요인(risk.factor_specs 에서 로드): "
          + " / ".join(f"{f['name']}({len(f['inds'])})" for f in stress))

    # Indicator.weekly() = transform(expanding_pctl(raw, MIN_DAILY), mode) 의 주별 마지막값.
    # 예전 이 파일에 있던 weekly_score() 와 같은 산식이며, 이제 정의는 한 곳뿐이다.
    F = pd.DataFrame({f["name"]: pd.concat([i.weekly() for i in f["inds"]], axis=1).mean(axis=1)
                      for f in stress}).dropna()
    keys = [f["name"] for f in stress]
    print(f"주별 요인 점수: {F.index[0].date()} ~ {F.index[-1].date()} ({len(F)}주)")

    # ----- 지표 단위 평탄화 (2026-08-25 — 지표 IC 학습 검증) -----
    # 요인 정의는 그대로 두고 지표 13개를 한 프레임에 편다. 요인 안 동일가중이
    # 만들던 암묵 가중(지표 수가 많은 요인일수록 지표당 발언권 축소)을 학습이
    # 대체할 수 있는지 본다. 바닥의 총 질량(6요인 × 8% = 48%)은 보존해 비교한다.
    ind_cols, ind_by_factor = [], {}
    ind_frame = {}
    for f in stress:
        cols = []
        for i in f["inds"]:
            name = f"{f['name']}·{i.label}"
            ind_frame[name] = i.weekly()
            cols.append(name)
        ind_by_factor[f["name"]] = cols
        ind_cols += cols
    # dropna() 로 13개 전부를 요구하면 늦개시 지표(카드채) 하나가 표본을 2014-10부터로
    # 잘라 2008·2011 이 학습에서 빠진다 — 배포 코드처럼 **부분 커버리지**를 허용한다
    # (미탄생 지표는 그 주의 합성에서 빼고 가중을 재정규화).
    I = pd.DataFrame(ind_frame)
    IND_FLOOR = FLOOR * len(keys) / len(ind_cols)
    born = {c: I[c].first_valid_index() for c in ind_cols}
    print(f"주별 지표 점수: {len(ind_cols)}개 (개시 {min(born.values()).date()} ~ "
          f"{max(born.values()).date()}) · 지표 바닥 {IND_FLOOR:.3f} "
          f"(총 질량 {FLOOR*len(keys):.0%} 보존) · 부분 커버리지 허용")

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
    data = F.join(tgt).dropna()
    # 지표 프레임은 요인 비교와 **같은 주**를 쓴다(같은 표본에서의 공정 비교) —
    # 셀 단위 결측만 부분 커버리지로 처리한다.
    dataI = I.reindex(data.index).join(data[["fwd_min", "fwd_vol"]])
    Fs = data[keys]
    refits = set(data.index[::REFIT_W])

    def ic_w_for(cols):
        def fn(train):
            ics = []
            for k in cols:
                pair = train[[k, "fwd_vol"]].dropna()
                ics.append(spearman(pair[k], pair["fwd_vol"]) if len(pair) >= 52 else 0.0)
            w = np.clip(np.nan_to_num(np.array(ics)), 0, None)
            return w / w.sum() if w.sum() > 0 else None
        return fn

    ic_w = ic_w_for(keys)

    def pca_w(train):
        _, vec = np.linalg.eigh(train[keys].corr().values)
        w = vec[:, -1]
        w = np.clip(w * np.sign(w.sum()), 0, None)
        return w / w.sum() if w.sum() > 0 else None

    last_w = {}   # 방식 이름 -> (cols, 마지막 재학습 가중) — 해석용

    def wf(weight_fn, alpha=1.0, floor=0.0, frame=None, cols=None, tag=None):
        frame = data if frame is None else frame
        cols = keys if cols is None else cols
        X = frame[cols]
        marks = set(frame.index[::REFIT_W])
        eq = np.ones(len(cols)) / len(cols)
        comp, cur = pd.Series(index=frame.index, dtype=float), None
        for t in frame.index:
            if t in marks:
                train = frame[frame.index <= t - pd.Timedelta(weeks=EMBARGO_W)]
                if len(train) >= TRAIN_MIN_W:
                    w = weight_fn(train)
                    if w is not None:
                        w = alpha * w + (1 - alpha) * eq
                        w = np.maximum(w, floor)
                        cur = w / w.sum()
            if cur is not None:
                v = X.loc[t]
                m = v.notna().values
                if m.any():
                    ww = cur[m]
                    comp[t] = float(v.values[m] @ (ww / ww.sum()))
        if tag and cur is not None:
            last_w[tag] = (cols, cur)
        return comp.dropna()

    def wf_two_stage():
        """요인 구조 유지 2단 학습 — 요인 안 지표 IC(무바닥, 전부 ≤0 이면 동일가중
        폴백) → 요인 점수 재구성 → 요인 IC + 바닥 8%(채택 방식과 동일)."""
        comp = pd.Series(index=dataI.index, dtype=float)
        marks = set(dataI.index[::REFIT_W])
        cur_iw, cur_fw = None, None
        for t in dataI.index:
            if t in marks:
                train = dataI[dataI.index <= t - pd.Timedelta(weeks=EMBARGO_W)]
                if len(train) >= TRAIN_MIN_W:
                    iw = {}
                    for fk, cols in ind_by_factor.items():
                        w = ic_w_for(cols)(train)
                        iw[fk] = w if w is not None else np.ones(len(cols)) / len(cols)
                    fac_tr = pd.DataFrame(
                        {fk: train[cols].values @ iw[fk] for fk, cols in ind_by_factor.items()},
                        index=train.index).join(train["fwd_vol"])
                    fw = ic_w_for(keys)(fac_tr)
                    if fw is not None:
                        fw = np.maximum(fw, FLOOR)
                        cur_iw, cur_fw = iw, fw / fw.sum()
            if cur_fw is not None:
                fac = []
                for fk, cols in ind_by_factor.items():
                    v = dataI.loc[t, cols]
                    m = v.notna().values
                    if m.any():
                        ww = cur_iw[fk][m]
                        fac.append(float(v.values[m] @ (ww / ww.sum())))
                    else:
                        fac.append(np.nan)
                fac = np.array(fac)
                fm = ~np.isnan(fac)
                if fm.any():
                    fw2 = cur_fw[fm]
                    comp[t] = float(fac[fm] @ (fw2 / fw2.sum()))
        if cur_iw is not None:
            last_w["2단(요인 안 지표 IC)"] = (
                [f"{fk}: " + " / ".join(f"{c.split('·', 1)[1]} {v:.0%}"
                                        for c, v in zip(cols, cur_iw[fk]))
                 for fk, cols in ind_by_factor.items()], cur_fw)
        return comp.dropna()

    EQ = Fs.mean(axis=1)
    schemes = [("동일가중", EQ), ("IC가중(WF)", wf(ic_w)),
               ("IC가중+바닥8%", wf(ic_w, floor=FLOOR)), ("축소 50%", wf(ic_w, alpha=0.5)),
               ("PCA(WF)", wf(pca_w)),
               # ----- 지표 단위 (2026-08-25) -----
               ("지표 동일가중", dataI[ind_cols].mean(axis=1)),
               ("지표 IC(WF)", wf(ic_w_for(ind_cols), frame=dataI, cols=ind_cols,
                                  tag="지표 IC(WF)")),
               ("지표 IC+바닥", wf(ic_w_for(ind_cols), frame=dataI, cols=ind_cols,
                                  floor=IND_FLOOR, tag="지표 IC+바닥")),
               ("지표 IC 축소50%", wf(ic_w_for(ind_cols), alpha=0.5,
                                    frame=dataI, cols=ind_cols)),
               ("2단(요인구조 유지)", wf_two_stage())]

    oos = data.index[data.index >= "2010-01-01"]
    flag5 = (data["fwd_min"] <= -5).astype(int)
    flag10 = (data["fwd_min"] <= -10).astype(int)
    print(f"표본 외: {oos[0].date()} ~ {oos[-1].date()} ({len(oos)}주) · "
          f"위기주 −5%/−10%: {int(flag5.loc[oos].sum())}/{int(flag10.loc[oos].sum())}\n")
    print(f"{'방식':<12} {'IC(변동성)':>10} {'AUC(−5%)':>9} {'AUC(−10%)':>9} {'전반':>7} {'후반':>7}")
    mid = oos[len(oos) // 2]
    for nm, c in schemes:
        idx = c.index.intersection(oos)
        halves = [spearman(c.loc[c.index.intersection(part)], data["fwd_vol"])
                  for part in (oos[oos <= mid], oos[oos > mid])]
        print(f"{nm:<12} {spearman(c.loc[idx], data['fwd_vol']):>+10.3f} "
              f"{auc(c.loc[idx], flag5.loc[idx]):>9.3f} {auc(c.loc[idx], flag10.loc[idx]):>9.3f} "
              f"{halves[0]:>+7.3f} {halves[1]:>+7.3f}")

    # ----- 해석 자료: 지표별 단독 IC(표본 외)와 마지막 재학습 가중 -----
    print("\n지표별 단독 IC (표본 외, 향후 1개월 실현변동성):")
    def solo_ic(c):
        pair = dataI.loc[dataI.index.intersection(oos), [c, "fwd_vol"]].dropna()
        return spearman(pair[c], pair["fwd_vol"])
    solo = sorted(((solo_ic(c), c) for c in ind_cols), reverse=True)
    for icv, c in solo:
        print(f"  {icv:+.3f}  {c}")
    for tag in ("지표 IC+바닥", "지표 IC(WF)"):
        if tag in last_w:
            cols, w = last_w[tag]
            print(f"\n{tag} — 마지막 재학습 가중:")
            for c, v in sorted(zip(cols, w), key=lambda x: -x[1]):
                print(f"  {v:6.1%}  {c}")
    if "2단(요인 안 지표 IC)" in last_w:
        lines, fw = last_w["2단(요인 안 지표 IC)"]
        print("\n2단 — 마지막 재학습 요인 가중:",
              " / ".join(f"{k} {v:.0%}" for k, v in zip(keys, fw)))
        print("2단 — 요인 안 지표 가중:")
        for ln in lines:
            print(f"  {ln}")


if __name__ == "__main__":
    main()
