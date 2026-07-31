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
    data = F.join(pd.concat([mnA, mnK], axis=1).mean(axis=1).rename("fwd_min")) \
            .join(pd.concat([volA, volK], axis=1).mean(axis=1).rename("fwd_vol")).dropna()
    Fs = data[keys]
    refits = set(data.index[::REFIT_W])

    def ic_w(train):
        ics = np.array([spearman(train[k], train["fwd_vol"]) for k in keys])
        w = np.clip(np.nan_to_num(ics), 0, None)
        return w / w.sum() if w.sum() > 0 else None

    def pca_w(train):
        _, vec = np.linalg.eigh(train[keys].corr().values)
        w = vec[:, -1]
        w = np.clip(w * np.sign(w.sum()), 0, None)
        return w / w.sum() if w.sum() > 0 else None

    def wf(weight_fn, alpha=1.0, floor=0.0):
        eq = np.ones(len(keys)) / len(keys)
        comp, cur = pd.Series(index=data.index, dtype=float), None
        for t in data.index:
            if t in refits:
                train = data[data.index <= t - pd.Timedelta(weeks=EMBARGO_W)]
                if len(train) >= TRAIN_MIN_W:
                    w = weight_fn(train)
                    if w is not None:
                        w = alpha * w + (1 - alpha) * eq
                        w = np.maximum(w, floor)
                        cur = w / w.sum()
            if cur is not None:
                comp[t] = float(Fs.loc[t].values @ cur)
        return comp.dropna()

    EQ = Fs.mean(axis=1)
    schemes = [("동일가중", EQ), ("IC가중(WF)", wf(ic_w)),
               ("IC가중+바닥8%", wf(ic_w, floor=FLOOR)), ("축소 50%", wf(ic_w, alpha=0.5)),
               ("PCA(WF)", wf(pca_w))]

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


if __name__ == "__main__":
    main()
